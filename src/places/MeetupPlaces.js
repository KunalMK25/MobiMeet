// ═══════════════════════════════════════════════════════════
//  places/MeetupPlaces.js — nearby places for a METRO meetup station (Quick Metro planner)
//  A thin adapter: the same coordinate-based service the group app uses (venues/venueService.js), returned in the
//  classic planner's place shape. Falls back to the original curated lists only when nothing else is in range, and then
//  labels them SAMPLE. Results are cached per (station, radius) so switching the category chip never re-fetches.
// ═══════════════════════════════════════════════════════════
import { ST } from '../data/stations.js';
import { createVenueService } from '../venues/venueService.js';
import { categoryEmoji, RADIUS, clampRadius } from '../venues/core.js';
import { NEARBY_PLACE_PROVIDERS } from './PlacesService.js';

export const PROVENANCE_LABEL = Object.freeze({ live: 'Live OSM', cached: 'Cached', snapshot: 'Saved snapshot', sample: 'Sample' });

let service = null;
export const _setVenueServiceForTests = (s) => { service = s; _cache.clear(); };
const _cache = new Map();

const toPlace = (v) => ({
  name: v.name, category: v.category, latitude: v.lat, longitude: v.lon, rating: v.rating ?? null,
  distance: v.distanceKm, source: v.provenance, provenance: v.provenance, emoji: categoryEmoji(v.category),
  note: v.openingHours ? `hours: ${v.openingHours}` : '',
});

// → { places, meta:{ radiusKm, provenance, isFallback, fetchedAt, snapshotDate, warnings, counts, usedSample } }
export async function getMeetupPlaces(stationKey, { radiusKm = RADIUS.defaultKm, refresh = false } = {}) {
  const radius = clampRadius(radiusKm);
  const key = `${stationKey}|${radius}`;
  if (!refresh && _cache.has(key)) return _cache.get(key);
  const promise = (async () => {
    const st = ST[stationKey];
    if (!st) return { places: [], meta: { radiusKm: radius, provenance: 'snapshot', isFallback: true, warnings: ['UNKNOWN_STATION'], counts: {}, usedSample: false } };
    service ??= createVenueService();
    const res = await service.search({ mode: 'METRO', lat: st.la, lon: st.lo, stationKey }, { radiusKm: radius, categories: ['all'], limit: 60, refresh });
    let places = res.venues.map(toPlace), usedSample = false;
    if (!places.length) {                               // last resort: the original curated list for THIS station only, labelled sample
      const sample = await NEARBY_PLACE_PROVIDERS.static.getNearbyPlaces(stationKey, ['all']);
      places = sample.filter(p => p.distance <= radius).map(p => ({ ...p, source: 'sample', provenance: 'sample' }));
      usedSample = places.length > 0;
    }
    return { places, meta: { radiusKm: radius, provenance: usedSample ? 'sample' : res.provenance, isFallback: res.isFallback || usedSample, fetchedAt: res.fetchedAt, snapshotDate: res.snapshotDate,
      warnings: res.warnings, counts: res.counts, usedSample, attribution: res.attribution } };
  })();
  _cache.set(key, promise);
  promise.catch(() => _cache.delete(key));
  return promise;
}

// Plain-language description of where the list came from (shown above the places).
export function describeSource(meta) {
  const when = meta.fetchedAt ? new Date(meta.fetchedAt).toLocaleString() : null;
  const extra = meta.warnings?.includes('SNAPSHOT_DATA_INCLUDED') && meta.provenance !== 'snapshot' ? ' Some entries come from the saved snapshot.' : '';
  const few = meta.warnings?.includes('FEW_RESULTS') && meta.radiusKm < RADIUS.maxKm ? ' Few places in range — try a wider radius.' : '';
  switch (meta.provenance) {
    case 'live': return { tone: 'ok', text: `Live OpenStreetMap data${when ? ` · fetched ${when}` : ''}.${extra}${few}` };
    case 'cached': return { tone: 'warn', text: `Cached live data${when ? ` from ${when}` : ''} — may be slightly out of date.${extra}${few}` };
    case 'snapshot': return { tone: 'warn', text: `Live data is unavailable — showing a saved OpenStreetMap snapshot${meta.snapshotDate ? ` dated ${meta.snapshotDate}` : ''}. Places may have changed.${few}` };
    case 'sample': return { tone: 'warn', text: 'Live data and the saved snapshot have nothing in range — showing a few curated SAMPLE places that are not verified.' };
    default: return { tone: 'warn', text: 'Source unknown.' };
  }
}
