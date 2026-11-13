// ═══════════════════════════════════════════════════════════
//  venues/catalogueBuild.js — decide whether an OpenStreetMap search result really IS the venue we looked for.
//  Used by scripts/build-venue-catalogue.mjs. Pure and unit-tested. A seed that OSM cannot confirm is DROPPED —
//  coordinates are never guessed.
// ═══════════════════════════════════════════════════════════
import { normalizeName } from './core.js';

export const BENGALURU_BBOX = Object.freeze({ south: 12.70, north: 13.25, west: 77.30, east: 77.90 });
export const inBengaluru = (lat, lon) => lat >= BENGALURU_BBOX.south && lat <= BENGALURU_BBOX.north && lon >= BENGALURU_BBOX.west && lon <= BENGALURU_BBOX.east;

// OSM {class → allowed types}. '*' = any type of that class.
const OK = {
  mall: { shop: ['mall', 'department_store'], building: ['retail', 'commercial', 'mall', 'yes'], amenity: ['marketplace'], landuse: ['retail'] },
  restaurant: { amenity: ['restaurant', 'fast_food', 'food_court', 'cafe'] },
  cafe: { amenity: ['cafe', 'ice_cream', 'restaurant', 'fast_food'], shop: ['bakery', 'coffee', 'pastry'] },
  bar: { amenity: ['bar', 'pub', 'biergarten', 'restaurant', 'nightclub'] },
  club: { amenity: ['nightclub', 'bar', 'pub', 'restaurant', 'events_venue'] },
  entertainment: { amenity: ['cinema', 'theatre', 'arts_centre', 'events_venue'], leisure: ['bowling_alley', 'amusement_arcade', 'escape_game', 'sports_centre', 'water_park', 'miniature_golf', 'stadium', 'pitch'], tourism: ['theme_park', 'attraction', 'zoo', 'aquarium'], building: ['yes', 'retail', 'public', 'civic'] },
  park: { leisure: ['park', 'garden', 'nature_reserve', 'recreation_ground'], natural: ['water', 'wood'], landuse: ['recreation_ground', 'forest'], water: ['*'], boundary: ['protected_area'], tourism: ['attraction'] },
  // attraction: tourism types are listed explicitly so hotels / guest houses can never qualify as a "sight"
  attraction: { tourism: ['attraction', 'museum', 'gallery', 'aquarium', 'zoo', 'theme_park', 'artwork', 'viewpoint'], historic: ['*'], amenity: ['place_of_worship', 'marketplace', 'arts_centre', 'townhall', 'courthouse'], building: ['*'], leisure: ['park', 'garden'], man_made: ['*'], shop: ['mall', 'marketplace'] },
};
const STOP = new Set(['the', 'and', 'of', 'in', 'at', 'bengaluru', 'bangalore', 'restaurant', 'cafe', 'mall', 'bar', 'pub', 'road', 'main', 'cross', 'layout']);
const tokens = (s) => normalizeName(s).split(' ').filter(t => t.length > 2 && !STOP.has(t));

// Roads are valid ONLY for seeds explicitly marked as streets (a shopping/eating street), never as a stand-in for a building.
const STREET_TYPES = ['pedestrian', 'residential', 'tertiary', 'secondary', 'living_street', 'primary'];
export function typeAccepted(category, osmClass, osmType, { street = false } = {}) {
  if (osmClass === 'highway') return street && category === 'attraction' && STREET_TYPES.includes(osmType);
  const allowed = OK[category]?.[osmClass];
  return !!allowed && (allowed.includes('*') || allowed.includes(osmType));
}

// True when at least three quarters of the distinctive words of the SEED NAME (text before the first comma) appear in the
// result's own name: 1 word → that word; 2 → both; 3 → all three; 4 → three. So "Atal Bihari Botanical Garden" can never
// stand in for "Lalbagh Botanical Garden" just because two of three words are shared.
export function nameMatches(seedQuery, result) {
  const want = tokens(String(seedQuery).split(',')[0]);
  if (!want.length) return false;
  const have = new Set(tokens(`${result.name ?? ''} ${String(result.display_name ?? '').split(',')[0]}`));
  const hit = want.filter(t => have.has(t)).length;
  return hit / want.length >= 0.75;
}

// Returns a catalogue entry or null. `r` is a Nominatim jsonv2 result.
export function acceptResult(seed, r, retrievedAt) {
  const lat = Number(r.lat), lon = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inBengaluru(lat, lon)) return null;
  if (!typeAccepted(seed.cat, r.category ?? r.class, r.type, { street: seed.street === true })) return null;
  if (!nameMatches(seed.q, r)) return null;
  return {
    id: `osm:${r.osm_type}/${r.osm_id}`, name: String(r.name || seed.q.split(',')[0]).trim(), category: seed.cat,
    lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, osmClass: r.category ?? r.class, osmType: r.type, retrievedAt,
  };
}
