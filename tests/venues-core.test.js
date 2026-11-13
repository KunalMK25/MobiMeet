import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameName, RADIUS, clampRadius, classifyOsmTags, normalizeCategories, normalizeName, dedupeVenues, rankVenues, diversify, searchCatalogue, assembleSuggestions, withDistance, CATEGORY_KEYS } from '../src/venues/core.js';

const P = { lat: 12.9174, lon: 77.6227 };                          // ≈ Central Silk Board
const v = (id, name, category, lat, lon, extra = {}) => ({ id, name, category, lat, lon, ...extra });

test('radius is configurable and clamped (default ≈ 2.5 km; 2–3 km are valid presets)', () => {
  assert.equal(RADIUS.defaultKm, 2.5); assert.ok(RADIUS.optionsKm.includes(2) && RADIUS.optionsKm.includes(3));
  assert.equal(clampRadius(3), 3); assert.equal(clampRadius('2'), 2); assert.equal(clampRadius(99), RADIUS.maxKm); assert.equal(clampRadius(0.01), RADIUS.minKm);
  assert.equal(clampRadius('abc'), RADIUS.defaultKm); assert.equal(clampRadius(-1), RADIUS.defaultKm); assert.equal(clampRadius(undefined, 1), 1);
});
test('categories cover malls, restaurants, cafés, pubs, clubs, entertainment, parks and other places', () => {
  assert.deepEqual([...CATEGORY_KEYS].sort(), ['attraction', 'bar', 'cafe', 'club', 'entertainment', 'mall', 'park', 'restaurant']);
  assert.equal(classifyOsmTags({ amenity: 'nightclub' }), 'club'); assert.equal(classifyOsmTags({ amenity: 'pub' }), 'bar'); assert.equal(classifyOsmTags({ shop: 'mall', amenity: 'restaurant' }), 'mall');
  assert.equal(classifyOsmTags({ amenity: 'cinema' }), 'entertainment'); assert.equal(classifyOsmTags({ leisure: 'bowling_alley' }), 'entertainment'); assert.equal(classifyOsmTags({ amenity: 'dentist' }), null);
  assert.deepEqual(normalizeCategories(['all']), CATEGORY_KEYS); assert.deepEqual(normalizeCategories(['cafe', 'bogus']), ['cafe']); assert.deepEqual(normalizeCategories(['bogus']), CATEGORY_KEYS); assert.deepEqual(normalizeCategories(undefined), CATEGORY_KEYS);
});
test('dedupe: same id, or same normalised name at the same spot — but not the same name far apart (two branches)', () => {
  assert.equal(normalizeName('The Social — Koramangala!'), normalizeName('social koramangala'));
  const list = [v('osm:node/1', 'Nexus Mall', 'mall', 12.9345, 77.6113), v('osm:way/9', 'NEXUS  Mall', 'mall', 12.9346, 77.6114, { openingHours: '10-22' }),
    v('osm:node/1', 'Nexus Mall', 'mall', 12.9345, 77.6113), v('osm:node/2', 'Toit', 'bar', 12.97, 77.64), v('osm:node/3', 'Toit', 'bar', 13.0, 77.55)];
  const out = dedupeVenues(list);
  assert.deepEqual(out.map(o => o.id), ['osm:node/1', 'osm:node/2', 'osm:node/3']);         // duplicates dropped, the distant branch kept
  assert.equal(out[0].openingHours, '10-22');                                                  // the duplicate's extra detail is kept
});
test('dedupe tolerates spelling variants of the same place (Ameoba/Amoeba) but not different places with similar names far apart or short names', () => {
  assert.ok(sameName('Ameoba Bowling Alley', 'Amoeba Bowling Alley')); assert.ok(sameName('Nexus Mall', 'nexus  mall')); assert.ok(!sameName('Toit', 'Toit Brewpub')); assert.ok(!sameName('Cafe A', 'Cafe B')); assert.ok(!sameName('Social', 'Cocial Club'));
  const out = dedupeVenues([v('1', 'Ameoba Bowling Alley', 'entertainment', 12.97, 77.6), v('2', 'Amoeba Bowling Alley', 'entertainment', 12.9702, 77.6001), v('3', 'Amoeba Bowling Alley', 'entertainment', 13.05, 77.7)]);
  assert.deepEqual(out.map(x => x.id), ['1', '3']);       // the near-identical neighbour merged; the same name 10 km away is a different branch
});
test('overlapping catchments: a venue between two stations is found from BOTH (coordinates, never one-station ownership)', () => {
  const csb = { lat: 12.9174, lon: 77.6227 }, btm = { lat: 12.9072, lon: 77.6101 };            // ≈ 1.8 km apart
  const nexus = v('osm:n/1', 'Midway Mall', 'mall', 12.9122, 77.6168);    // sits between the two stations
  const cat = { venues: [nexus, v('osm:n/2', 'Far Cafe', 'cafe', 13.05, 77.75)] };
  const a = searchCatalogue(cat, csb, 3, ['all']), b = searchCatalogue(cat, btm, 3, ['all']);
  assert.deepEqual(a.map(x => x.id), ['osm:n/1']); assert.deepEqual(b.map(x => x.id), ['osm:n/1']);
  assert.ok(a[0].distanceKm < 3 && b[0].distanceKm < 3 && a[0].distanceKm !== b[0].distanceKm);  // distance is per-station
  assert.deepEqual(searchCatalogue(cat, csb, 0.5, ['all']), []);                                 // radius is respected
  assert.deepEqual(searchCatalogue(cat, csb, 3, ['cafe']), []);                                  // category filter is respected
});
test('ranking: nearer first, preferred category boosted, deterministic ties; diversity prevents one category swamping the list', () => {
  const venues = withDistance([v('a', 'A', 'bar', 12.9180, 77.6230), v('b', 'B', 'cafe', 12.9180, 77.6230), v('c', 'C', 'cafe', 12.9300, 77.6300)], P);
  const ranked = rankVenues(venues, { preferredCategories: ['cafe'], radiusKm: 3 }).map(x => x.id);
  assert.equal(ranked[0], 'b');                                           // same spot as 'a', but the preferred category wins
  assert.ok(ranked.indexOf('a') < ranked.indexOf('c'));                   // proximity dominates: a near off-preference bar beats a far café
  assert.deepEqual(rankVenues(venues, { preferredCategories: ['cafe'], radiusKm: 3 }).map(x => x.id), ranked);
  assert.deepEqual(rankVenues(venues, { radiusKm: 3 }).map(x => x.id), rankVenues([...venues].reverse(), { radiusKm: 3 }).map(x => x.id));
  const many = Array.from({ length: 20 }, (_, i) => v('r' + i, 'Rest' + i, 'restaurant', 12.9174 + i * 0.0001, 77.6227)).concat([v('m1', 'Mall', 'mall', 12.93, 77.63), v('k1', 'Club', 'club', 12.93, 77.63), v('p1', 'Park', 'park', 12.93, 77.63)]);
  const ranked20 = rankVenues(withDistance(many, P), { radiusKm: 3 });
  const six = diversify(ranked20, { limit: 6 });                       // cap = 3 per category: 3 restaurants + the 3 minorities
  assert.equal(six.length, 6); assert.deepEqual(six.map(x => x.category).sort(), ['club', 'mall', 'park', 'restaurant', 'restaurant', 'restaurant']);
  const nine = diversify(ranked20, { limit: 9 });                      // only 6 distinct venues fit the caps → topped up, minorities still included
  assert.equal(nine.length, 9); assert.ok(['mall', 'club', 'park'].every(c => nine.some(x => x.category === c)), 'the minority categories are represented');
  assert.equal(diversify(rankVenues(withDistance(many.slice(0, 4), P), {}), { limit: 10 }).length, 4);   // fewer than the cap: just returns them
});
test('assembleSuggestions: merges sources (first wins), dedupes, filters by radius/category, never returns a venue twice', () => {
  const live = [v('osm:n/1', 'Nexus Koramangala', 'mall', 12.9345, 77.6113, { provenance: 'live' })];
  const snap = [v('osm:n/1', 'Nexus Koramangala', 'mall', 12.9345, 77.6113, { provenance: 'snapshot' }), v('osm:n/5', 'Toit', 'bar', 12.97, 77.64, { provenance: 'snapshot' })];
  const out = assembleSuggestions([live, snap], { point: P, radiusKm: 3, categories: ['all'] });
  assert.deepEqual(out.map(x => x.id), ['osm:n/1']);                  // Toit is >3 km away
  assert.equal(out[0].provenance, 'live');                            // preferred source kept
  assert.equal(assembleSuggestions([live, snap], { point: P, radiusKm: 7, categories: ['bar'] }).length, 1);
});
