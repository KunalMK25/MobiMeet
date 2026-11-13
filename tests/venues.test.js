import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverpassProvider, createSnapshotProvider, createVenueService, VENUE_DEFAULTS } from '../src/venues/venueService.js';
import { createGeocoder, BENGALURU_VIEWBOX } from '../src/geo/geocoder.js';

const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const osm = { elements: [
  { type: 'node', id: 1, lat: 12.971, lon: 77.595, tags: { name: 'Cafe One', amenity: 'cafe', opening_hours: 'Mo-Su 08:00-22:00' } },
  { type: 'way', id: 2, center: { lat: 12.975, lon: 77.60 }, tags: { name: 'Green Park', leisure: 'park' } },
  { type: 'node', id: 3, lat: 12.97, lon: 77.59, tags: { amenity: 'cafe' } },                       // unnamed → dropped
  { type: 'node', id: 4, lat: 12.97, lon: 77.59, tags: { name: 'Odd', amenity: 'dentist' } },      // unknown category → dropped
  { type: 'node', id: 5, lat: 12.972, lon: 77.592, tags: { name: 'Neon Room', amenity: 'nightclub' } },
  { type: 'node', id: 6, lat: 12.973, lon: 77.593, tags: { name: 'Bowl City', leisure: 'bowling_alley' } },
] };
const P = { lat: 12.97, lon: 77.59 };
const cat = (venues, generatedAt = '2026-01-01') => ({ generatedAt, venues });
const sv = (id, name, category, lat, lon) => ({ id, name, category, lat, lon });

test('Overpass: parses nodes and ways into the new categories (clubs, entertainment, parks…), never invents ratings', async () => {
  let url;
  const p = createOverpassProvider({ fetchImpl: async (u) => { url = u; return res(osm); }, now: () => 5 });
  const r = await p.search(P, 2, ['all']);
  assert.deepEqual(r.venues.map(v => `${v.name}:${v.category}`).sort(), ['Bowl City:entertainment', 'Cafe One:cafe', 'Green Park:park', 'Neon Room:club']);
  const cafe = r.venues.find(v => v.name === 'Cafe One');
  assert.equal(cafe.rating, null); assert.equal(cafe.ratingSource, null); assert.equal(cafe.openingHours, 'Mo-Su 08:00-22:00'); assert.equal(cafe.provenance, 'live');
  assert.ok(cafe.distanceKm > 0.5 && cafe.distanceKm < 0.6);
  const q = decodeURIComponent(url); assert.match(q, /around:2000,12\.97,77\.59/); assert.match(q, /"amenity"="nightclub"/); assert.match(q, /"amenity"="cinema"/); assert.match(q, /\["name"\]/);
});
test('Overpass: honours the category filter, caches identical queries as "cached", retries once on 5xx/429, surfaces other errors', async () => {
  let n = 0;
  const p = createOverpassProvider({ fetchImpl: async () => { n++; return res(osm); }, now: () => 0 });
  const only = await p.search(P, 2, ['club']); assert.deepEqual(only.venues.map(v => v.name), ['Neon Room']);
  const again = await p.search(P, 2, ['club']); assert.equal(n, 1); assert.equal(again.cached, true); assert.ok(again.venues.every(v => v.provenance === 'cached'));
  let m = 0;
  assert.equal((await createOverpassProvider({ retryDelayMs: 0, fetchImpl: async () => (++m === 1 ? res({}, 502) : res(osm)) }).search(P, 2)).venues.length, 4); assert.equal(m, 2);
  let k = 0; await assert.rejects(createOverpassProvider({ retryDelayMs: 0, fetchImpl: async () => { k++; return res({}, 502); } }).search(P, 2), /502/); assert.equal(k, 2);
  let q = 0; await assert.rejects(createOverpassProvider({ retryDelayMs: 0, fetchImpl: async () => { q++; return res({}, 400); } }).search(P, 2), /400/); assert.equal(q, 1);
});
test('refresh bypasses the live cache (an explicit "search again" must never be answered from cache)', async () => {
  let n = 0; const p = createOverpassProvider({ fetchImpl: async () => { n++; return res(osm); }, now: () => 0 });
  await p.search(P, 2, ['all']); assert.equal((await p.search(P, 2, ['all'])).cached, true); assert.equal(n, 1);
  const fresh = await p.search(P, 2, ['all'], { refresh: true }); assert.equal(n, 2); assert.ok(fresh.cached !== true && fresh.venues.every(v => v.provenance === 'live'));
  const svc = createVenueService({ live: p, snapshot: createSnapshotProvider({ catalogue: cat([]) }) });
  assert.equal((await svc.search({ mode: 'METRO', ...P }, { radiusKm: 2 })).provenance, 'cached');            // same query as the primed one → served from cache, labelled
  assert.equal((await svc.search({ mode: 'METRO', ...P }, { radiusKm: 2, refresh: true })).provenance, 'live');
});
test('snapshot provider: coordinate-based, dated, labelled "snapshot", no ratings or hours', () => {
  const s = createSnapshotProvider({ catalogue: cat([sv('osm:node/9', 'Snap Mall', 'mall', 12.975, 77.595), sv('osm:node/10', 'Far Place', 'park', 13.2, 77.8)], '2026-11-13') });
  const r = s.search(P, 2, ['all']);
  assert.deepEqual(r.venues.map(v => v.name), ['Snap Mall']); assert.equal(r.venues[0].provenance, 'snapshot'); assert.equal(r.venues[0].rating, null); assert.equal(r.venues[0].openingHours, null);
  assert.equal(s.generatedAt, '2026-11-13'); assert.deepEqual(s.search(P, 0.1, ['all']).venues, []);
});
test('service: live results merged with snapshot — duplicates removed (live wins), per-venue provenance, counts, attribution', async () => {
  const snapshot = createSnapshotProvider({ catalogue: cat([sv('osm:node/1', 'Cafe One', 'cafe', 12.971, 77.595), sv('osm:node/50', 'Snap Mall', 'mall', 12.973, 77.594)]) });
  const svc = createVenueService({ live: createOverpassProvider({ fetchImpl: async () => res(osm) }), snapshot });
  const r = await svc.search({ mode: 'METRO', ...P, stationKey: 'MG Road' }, {});
  assert.equal(r.provenance, 'live'); assert.equal(r.isFallback, false); assert.equal(r.radiusKm, VENUE_DEFAULTS.radiusKm);
  assert.equal(r.venues.filter(v => v.name === 'Cafe One').length, 1); assert.equal(r.venues.find(v => v.name === 'Cafe One').provenance, 'live');
  assert.equal(r.venues.find(v => v.name === 'Snap Mall').provenance, 'snapshot'); assert.ok(r.warnings.includes('SNAPSHOT_DATA_INCLUDED'));
  assert.ok(r.venues.every(v => v.distanceKm != null && v.distanceKm <= r.radiusKm)); assert.match(r.attribution, /OpenStreetMap/);
  assert.equal(r.counts.club, 1); assert.equal(r.center.label, 'MG Road');
  assert.equal(new Set(r.venues.map(v => v.id)).size, r.venues.length);
});
test('service: when live data is unavailable the snapshot is used and clearly labelled (never presented as live)', async () => {
  const snapshot = createSnapshotProvider({ catalogue: cat([sv('s1', 'A', 'cafe', 12.971, 77.591), sv('s2', 'B', 'mall', 12.972, 77.592), sv('s3', 'C', 'bar', 12.973, 77.593), sv('s4', 'D', 'park', 12.974, 77.594), sv('s5', 'E', 'club', 12.975, 77.595)], '2026-11-13') });
  const r = await createVenueService({ live: { search: async () => { throw new Error('net'); } }, snapshot }).search({ mode: 'BIKE', ...P }, {});
  assert.equal(r.provenance, 'snapshot'); assert.equal(r.isFallback, true); assert.equal(r.snapshotDate, '2026-11-13');
  assert.ok(r.warnings.includes('LIVE_VENUES_UNAVAILABLE')); assert.ok(r.venues.every(v => v.provenance === 'snapshot')); assert.equal(r.venues.length, 5);
  assert.ok(!r.warnings.includes('FEW_RESULTS'));
});
test('service: a slow live source cannot hold the list hostage — after the deadline the snapshot is shown, labelled, and a late live failure is harmless', async () => {
  const snapshot = createSnapshotProvider({ catalogue: cat([sv('s1', 'Saved Cafe', 'cafe', 12.971, 77.591)], '2026-11-13') });
  let finish; const slow = { search: () => new Promise((resolve, reject) => { finish = reject; }) };       // never answers in time
  const t0 = Date.now(); const r = await createVenueService({ live: slow, snapshot, liveDeadlineMs: 30 }).search({ mode: 'METRO', ...P }, {});
  assert.ok(Date.now() - t0 < 1000, 'returned promptly'); assert.equal(r.provenance, 'snapshot'); assert.equal(r.isFallback, true); assert.ok(r.warnings.includes('LIVE_VENUES_TIMED_OUT')); assert.deepEqual(r.venues.map(v => v.name), ['Saved Cafe']);
  finish(new Error('late failure'));                                                                    // must not crash the process (unhandled rejection)
  await new Promise(rr => setTimeout(rr, 10));
  const fast = await createVenueService({ live: { search: async () => ({ venues: [{ id: 'l', name: 'Live Cafe', category: 'cafe', lat: 12.971, lon: 77.591, distanceKm: 0.2, provenance: 'live' }], fetchedAt: 1 }) }, snapshot, liveDeadlineMs: 50 }).search({ mode: 'METRO', ...P }, {});
  assert.equal(fast.provenance, 'live'); assert.ok(!fast.warnings.includes('LIVE_VENUES_TIMED_OUT'));
});
test('service: radius is configurable (default, per-request, clamped); too few results → hint to widen', async () => {
  const snapshot = createSnapshotProvider({ catalogue: cat([sv('n', 'Near', 'cafe', 12.972, 77.592), sv('f', 'Mid', 'cafe', 12.985, 77.605)]) });   // ≈0.3 km and ≈2.1 km away
  const down = { search: async () => { throw new Error('x'); } };
  const mk = (defaultRadiusKm) => createVenueService({ live: down, snapshot, defaultRadiusKm });
  assert.equal((await mk(undefined).search({ mode: 'METRO', ...P }, {})).radiusKm, 2.5);
  assert.equal((await mk(3).search({ mode: 'METRO', ...P }, {})).radiusKm, 3);                                       // configured default
  const wide = await mk(1).search({ mode: 'METRO', ...P }, { radiusKm: 3 }); assert.equal(wide.radiusKm, 3); assert.equal(wide.venues.length, 2);   // per-request override
  const tight = await mk(1).search({ mode: 'METRO', ...P }, {}); assert.equal(tight.venues.length, 1); assert.ok(tight.warnings.includes('FEW_RESULTS'));
  assert.equal((await mk(2.5).search({ mode: 'BIKE', ...P }, { radiusKm: 50 })).radiusKm, 5); assert.equal((await mk(2.5).search({ mode: 'BIKE', ...P }, { radiusKm: 0.01 })).radiusKm, 0.5);
  assert.ok(!(await mk(2.5).search({ mode: 'METRO', ...P }, { radiusKm: 5 })).warnings.includes('FEW_RESULTS'));      // already at the maximum
});
test('overlapping catchments: the same venue appears for two nearby stations, each with its OWN distance', async () => {
  const snapshot = createSnapshotProvider({ catalogue: cat([sv('mid', 'Midway Mall', 'mall', 12.9122, 77.6168)]) });
  const svc = createVenueService({ live: { search: async () => { throw new Error('x'); } }, snapshot });
  const csb = await svc.search({ mode: 'METRO', lat: 12.9174, lon: 77.6227 }, {}), btm = await svc.search({ mode: 'METRO', lat: 12.9072, lon: 77.6101 }, {});
  assert.deepEqual([csb.venues.map(v => v.id), btm.venues.map(v => v.id)], [['mid'], ['mid']]);
  assert.notEqual(csb.venues[0].distanceKm, btm.venues[0].distanceKm);
});
test('categories: filter by one or several; unknown names fall back to everything', async () => {
  const svc = createVenueService({ live: createOverpassProvider({ fetchImpl: async () => res(osm) }), snapshot: createSnapshotProvider({ catalogue: cat([]) }) });
  assert.deepEqual((await svc.search({ mode: 'METRO', ...P }, { categories: ['club', 'park'] })).venues.map(v => v.category).sort(), ['club', 'park']);
  assert.equal((await svc.search({ mode: 'METRO', ...P }, { categories: ['bogus'] })).venues.length, 4);
});

test('geocoder: bounded to Bengaluru, validated, cached, errors become PROVIDER_UNAVAILABLE', async () => {
  let url, n = 0;
  const g = createGeocoder({ minIntervalMs: 0, fetchImpl: async (u) => { url = u; n++; return res([{ display_name: 'Indiranagar, Bengaluru', lat: '12.97', lon: '77.64' }, { display_name: 'bad', lat: 'x', lon: 'y' }]); } });
  const r = await g.search('  Indiranagar   metro ');
  assert.deepEqual(r.results, [{ label: 'Indiranagar, Bengaluru', lat: 12.97, lon: 77.64 }]);
  assert.match(url, /bounded=1/); assert.ok(decodeURIComponent(url).includes(BENGALURU_VIEWBOX)); assert.match(r.attribution, /OpenStreetMap/);
  assert.equal((await g.search('indiranagar metro')).cached, true); assert.equal(n, 1);
  await assert.rejects(g.search('ab'), /3-120/);
  await assert.rejects(createGeocoder({ minIntervalMs: 0, fetchImpl: async () => res({}, 500) }).search('Koramangala'), /unavailable/);
});
test('geocoder reverse: builds an area name, caches, validates, and maps failures', async () => {
  let url, n = 0;
  const g = createGeocoder({ minIntervalMs: 0, fetchImpl: async (u) => { url = u; n++; return res({ address: { road: '100 Feet Road', suburb: 'Indiranagar' } }); } });
  assert.equal((await g.reverse(12.97, 77.64)).areaName, '100 Feet Road, Indiranagar'); assert.match(url, /\/reverse\?/);
  assert.equal((await g.reverse(12.97, 77.64)).cached, true); assert.equal(n, 1);
  await assert.rejects(g.reverse(NaN, 1), /Valid coordinates/);
  await assert.rejects(createGeocoder({ minIntervalMs: 0, fetchImpl: async () => res({}, 500) }).reverse(12.9, 77.5), /unavailable/);
  assert.equal((await createGeocoder({ minIntervalMs: 0, fetchImpl: async () => res({ address: {} }) }).reverse(12.9, 77.5)).areaName, null);
});
