// ═══════════════════════════════════════════════════════════
//  venues/core.js — shared, pure venue logic (browser + server; no I/O, no DOM)
//
//  Principles:
//   • CATCHMENTS COME FROM COORDINATES. A venue is "near" a station iff its distance to that station is within the
//     radius — it is never assigned to a single station, so a venue 1.8 km from two stations appears for both.
//   • Nothing is invented: ratings/opening hours exist only if a source supplied them.
//   • Every result carries its PROVENANCE ('live' | 'cached' | 'snapshot' | 'sample') so the UI can say what it is.
// ═══════════════════════════════════════════════════════════
import { haversineKm } from '../utils/geometry.js';

export const RADIUS = Object.freeze({ defaultKm: 2.5, minKm: 0.5, maxKm: 5, optionsKm: [1, 2, 2.5, 3, 5] });
export const clampRadius = (r, fallback = RADIUS.defaultKm) => {
  const n = Number(r);
  return Number.isFinite(n) && n > 0 ? Math.min(RADIUS.maxKm, Math.max(RADIUS.minKm, n)) : fallback;
};

// label/emoji for the UI; osm = tag pairs for live queries; weight = relevance when no preference is stated.
export const VENUE_CATEGORIES = Object.freeze({
  mall:          { label: 'Malls',                   emoji: '🛍️', weight: 1.00, osm: [['shop', 'mall']] },
  restaurant:    { label: 'Restaurants',             emoji: '🍽️', weight: 0.90, osm: [['amenity', 'restaurant'], ['amenity', 'food_court']] },
  cafe:          { label: 'Cafés',                   emoji: '☕',  weight: 0.90, osm: [['amenity', 'cafe']] },
  bar:           { label: 'Pubs & bars',             emoji: '🍻', weight: 0.85, osm: [['amenity', 'bar'], ['amenity', 'pub'], ['amenity', 'biergarten']] },
  club:          { label: 'Clubs & nightlife',       emoji: '🪩', weight: 0.80, osm: [['amenity', 'nightclub']] },
  entertainment: { label: 'Entertainment',           emoji: '🎳', weight: 0.85, osm: [['amenity', 'cinema'], ['amenity', 'theatre'], ['leisure', 'bowling_alley'], ['leisure', 'amusement_arcade'], ['leisure', 'escape_game']] },
  park:          { label: 'Parks & lakes',           emoji: '🌳', weight: 0.75, osm: [['leisure', 'park'], ['leisure', 'garden']] },
  attraction:    { label: 'Sights & other places',   emoji: '📍', weight: 0.70, osm: [['tourism', 'attraction'], ['tourism', 'museum'], ['tourism', 'gallery']] },
});
export const CATEGORY_KEYS = Object.freeze(Object.keys(VENUE_CATEGORIES));
export const categoryLabel = (k) => VENUE_CATEGORIES[k]?.label ?? 'Other';
export const categoryEmoji = (k) => VENUE_CATEGORIES[k]?.emoji ?? '📍';

// Which category does a set of OSM tags belong to? (first match in this priority wins)
const PRIORITY = ['mall', 'club', 'bar', 'cafe', 'restaurant', 'entertainment', 'park', 'attraction'];
export function classifyOsmTags(tags = {}) {
  for (const c of PRIORITY) if (VENUE_CATEGORIES[c].osm.some(([k, v]) => tags[k] === v)) return c;
  return null;
}
export function normalizeCategories(cats) {
  if (!Array.isArray(cats) || !cats.length || cats.includes('all')) return CATEGORY_KEYS;
  const ok = cats.filter(c => CATEGORY_KEYS.includes(c));
  return ok.length ? ok : CATEGORY_KEYS;
}

export const normalizeName = (n) => String(n ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|bengaluru|bangalore)\b/g, ' ').replace(/\s+/g, ' ').trim();

export function withDistance(venues, point) {
  return venues.map(v => ({ ...v, distanceKm: v.lat != null && v.lon != null ? Math.round(haversineKm(point.lat, point.lon, v.lat, v.lon) * 100) / 100 : (v.distanceKm ?? null) }));
}

const editDistance = (a, b) => { const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[n]; };
// Same name, tolerating a typo or a different spelling ("Ameoba"/"Amoeba"): ≤1 edit for names of 8+ characters, ≤2 for 14+ (short names must match exactly).
export const sameName = (a, b) => { const x = normalizeName(a), y = normalizeName(b); if (x === y) return true; const len = Math.min(x.length, y.length); return len >= 8 && editDistance(x, y) <= (len >= 14 ? 2 : 1); };

// Remove duplicates: identical ids, or the same (typo-tolerant) name within `sameSpotM` metres (e.g. a venue mapped as both a
// node and a building outline). The first occurrence wins, so pass the preferred source first.
export function dedupeVenues(list, { sameSpotM = 150 } = {}) {
  const out = [], byId = new Set();
  for (const v of list) {
    if (v.id && byId.has(v.id)) continue;
    const dup = out.find(o => sameName(o.name, v.name) && (o.lat == null || v.lat == null || haversineKm(o.lat, o.lon, v.lat, v.lon) * 1000 <= sameSpotM));
    if (dup) { if (dup.openingHours == null && v.openingHours != null) dup.openingHours = v.openingHours; continue; }
    if (v.id) byId.add(v.id);
    out.push(v);
  }
  return out;
}

// Score ∈ [0,1]: proximity 0.60 · category relevance 0.30 · has verifiable detail (opening hours) 0.10.
export function rankVenues(venues, { preferredCategories = [], radiusKm = RADIUS.defaultKm } = {}) {
  const prefer = preferredCategories.length && !preferredCategories.includes('all') ? new Set(preferredCategories) : null;
  const score = (v) => {
    const prox = v.distanceKm == null ? 0.4 : Math.max(0, 1 - v.distanceKm / radiusKm);
    const rel = prefer ? (prefer.has(v.category) ? 1 : 0.2) : (VENUE_CATEGORIES[v.category]?.weight ?? 0.6);
    return Math.round((0.6 * prox + 0.3 * rel + 0.1 * (v.openingHours ? 1 : 0)) * 1000) / 1000;
  };
  return venues.map(v => ({ ...v, score: score(v) }))
    .sort((a, b) => b.score - a.score || (a.distanceKm ?? 99) - (b.distanceKm ?? 99) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Return several useful suggestions across categories instead of 30 of the same kind: take the best by score but cap each
// category, then top up from the remainder if the list is still short.
export function diversify(ranked, { limit = 30, perCategory = Math.max(3, Math.ceil(limit / 3)) } = {}) {
  const taken = [], counts = {}, rest = [];
  for (const v of ranked) {
    if (taken.length >= limit) break;
    if ((counts[v.category] ?? 0) < perCategory) { taken.push(v); counts[v.category] = (counts[v.category] ?? 0) + 1; } else rest.push(v);
  }
  for (const v of rest) { if (taken.length >= limit) break; taken.push(v); }
  return taken.sort((a, b) => b.score - a.score || (a.distanceKm ?? 99) - (b.distanceKm ?? 99));
}

// Venues from a coordinate catalogue within `radiusKm` of `point`, in the requested categories.
export function searchCatalogue(catalogue, point, radiusKm, categories) {
  const want = new Set(normalizeCategories(categories));
  return withDistance(catalogue.venues.filter(v => want.has(v.category)), point).filter(v => v.distanceKm <= radiusKm);
}

// Combine result sets (preferred source first), dedupe, rank, diversify. Used by both the server and the Quick planner.
export function assembleSuggestions(sets, { point, radiusKm, categories, limit = 30 }) {
  const want = new Set(normalizeCategories(categories));
  const merged = dedupeVenues(sets.flat().filter(v => want.has(v.category)));
  const near = withDistance(merged, point).filter(v => v.distanceKm == null || v.distanceKm <= radiusKm);
  return diversify(rankVenues(near, { preferredCategories: categories, radiusKm }), { limit });
}
