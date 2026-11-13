// ═══════════════════════════════════════════════════════════
//  venues/venueService.js — nearby venue discovery for a meetup point (Metro station or Bike location)
//
//  Sources, in order of trust (each venue carries its own `provenance`):
//    live      — OpenStreetMap Overpass, fetched just now                         (best; ODbL attribution)
//    cached    — an earlier live result served from the in-memory cache            (age shown via fetchedAt)
//    snapshot  — the bundled, OSM-confirmed catalogue (data/venue-catalogue.js)    (dated; always available)
//  Live and snapshot results are MERGED (live first), de-duplicated, ranked by proximity + relevance and diversified
//  across categories. Catchments are computed from coordinates (core.js), so one venue can serve several stations.
//  Nothing is invented: ratings/opening hours appear only if a source supplied them.
// ═══════════════════════════════════════════════════════════
import { haversineKm } from '../utils/geometry.js';
import { VENUE_CATALOGUE } from '../data/venue-catalogue.js';
import { RADIUS, clampRadius, VENUE_CATEGORIES, categoryEmoji, normalizeCategories, classifyOsmTags, searchCatalogue, assembleSuggestions, rankVenues } from './core.js';

export const VENUE_DEFAULTS = Object.freeze({ radiusKm: RADIUS.defaultKm, maxRadiusKm: RADIUS.maxKm, limit: 30, fewResultsBelow: 5 });
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';
export { rankVenues };

export function createOverpassProvider({ fetchImpl = globalThis.fetch, endpoint = 'https://overpass-api.de/api/interpreter', timeoutMs = 12000, now = Date.now, cacheTtlMs = 60 * 60 * 1000, retryDelayMs = 1500 } = {}) {
  const cache = new Map();
  return {
    name: 'osm-overpass',
    async search(point, radiusKm, categories = ['all'], { refresh = false } = {}) {
      const cats = normalizeCategories(categories);
      const pairs = cats.flatMap(c => VENUE_CATEGORIES[c].osm);
      const r = Math.round(radiusKm * 1000);
      const clauses = pairs.map(([k, v]) => ['node', 'way'].map(el => `${el}["${k}"="${v}"]["name"](around:${r},${point.lat},${point.lon});`).join('')).join('');
      const query = `[out:json][timeout:15];(${clauses});out center 120;`;
      const url = `${endpoint}?data=${encodeURIComponent(query)}`;
      const hit = cache.get(url);
      if (!refresh && hit && now() - hit.at < cacheTtlMs) return { ...hit.value, cached: true, venues: hit.value.venues.map(v => ({ ...v, provenance: 'cached' })) };
      let res;
      for (let attempt = 0; attempt < 2; attempt++) {       // one bounded retry: the public instance is often at capacity
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try { res = await fetchImpl(url, { signal: ctl.signal, headers: { 'User-Agent': 'MobiMeet-dev/0.1', Accept: 'application/json' } }); }
        finally { clearTimeout(timer); }
        if (res.status !== 429 && res.status < 500) break;
        if (attempt === 0 && retryDelayMs) await new Promise(rr => setTimeout(rr, retryDelayMs));
      }
      if (!res.ok) throw new Error(`Overpass status ${res.status}`);
      const data = await res.json();
      const venues = (data.elements || []).filter(e => e.tags?.name).map(e => {
        const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
        const category = classifyOsmTags(e.tags);
        if (lat == null || lon == null || !category || !cats.includes(category)) return null;
        return { id: `osm:${e.type}/${e.id}`, name: e.tags.name, category, lat, lon, distanceKm: Math.round(haversineKm(point.lat, point.lon, lat, lon) * 100) / 100,
          rating: null, ratingSource: null, openingHours: e.tags.opening_hours ?? null, provenance: 'live' };
      }).filter(Boolean);
      const value = { venues, fetchedAt: now() };
      cache.set(url, { at: now(), value });
      return value;
    },
  };
}

// The bundled snapshot: dated, OSM-confirmed, coordinate-based (so overlapping station catchments work).
export function createSnapshotProvider({ catalogue = VENUE_CATALOGUE } = {}) {
  return {
    name: 'snapshot', generatedAt: catalogue.generatedAt,
    search(point, radiusKm, categories = ['all']) {
      return { venues: searchCatalogue(catalogue, point, radiusKm, categories).map(v => ({ ...v, rating: null, ratingSource: null, openingHours: null, provenance: 'snapshot' })), fetchedAt: Date.parse(catalogue.generatedAt) || null };
    },
  };
}

// liveDeadlineMs: how long a user waits for live data. After that the saved snapshot is shown immediately (the live request keeps
// running and fills the cache for the next search) — a slow or dead live source must never hold the list hostage.
export function createVenueService({ live = createOverpassProvider(), snapshot = createSnapshotProvider(), defaultRadiusKm = VENUE_DEFAULTS.radiusKm, liveDeadlineMs = 6000, now = Date.now } = {}) {
  return {
    defaultRadiusKm,
    // target: {mode, lat, lon, stationKey?}; opts: {radiusKm?, categories?, limit?}
    async search(target, { radiusKm, categories = ['all'], limit = VENUE_DEFAULTS.limit, refresh = false } = {}) {
      const radius = clampRadius(radiusKm, clampRadius(defaultRadiusKm));
      const point = { lat: target.lat, lon: target.lon };
      const warnings = [];
      let liveRes = null;
      try {
        let timer;
        const deadline = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('deadline'), { deadline: true })), liveDeadlineMs); });
        const pending = live.search(point, radius, categories, { refresh });
        pending.catch(() => {});                                   // a late failure after the deadline must not become an unhandled rejection
        try { liveRes = await Promise.race([pending, deadline]); } finally { clearTimeout(timer); }
      } catch (e) { warnings.push(e.deadline ? 'LIVE_VENUES_TIMED_OUT' : 'LIVE_VENUES_UNAVAILABLE'); }
      const snap = snapshot.search(point, radius, categories);
      const liveVenues = liveRes?.venues ?? [];
      const venues = assembleSuggestions([liveVenues, snap.venues], { point, radiusKm: radius, categories, limit });
      const liveUsed = venues.some(v => v.provenance === 'live' || v.provenance === 'cached');
      const provenance = !liveRes ? 'snapshot' : (liveRes.cached ? 'cached' : 'live');
      if (liveRes && !liveVenues.length) warnings.push('NO_LIVE_VENUES_FOUND');
      if (venues.some(v => v.provenance === 'snapshot')) warnings.push('SNAPSHOT_DATA_INCLUDED');
      if (venues.length < VENUE_DEFAULTS.fewResultsBelow && radius < RADIUS.maxKm) warnings.push('FEW_RESULTS');
      return {
        radiusKm: radius, center: { ...point, label: target.stationKey ?? null },
        provenance, isFallback: !liveRes, source: liveUsed ? 'osm' : 'snapshot',
        fetchedAt: liveRes?.fetchedAt ?? snap.fetchedAt ?? now(), snapshotDate: snapshot.generatedAt ?? null,
        attribution: OSM_ATTRIBUTION, warnings, counts: countByCategory(venues), venues,
        categoryLabels: Object.fromEntries(Object.entries(VENUE_CATEGORIES).map(([k, v]) => [k, { label: v.label, emoji: v.emoji }])),
      };
    },
  };
}
const countByCategory = (vs) => vs.reduce((a, v) => ((a[v.category] = (a[v.category] ?? 0) + 1), a), {});
export { categoryEmoji };
