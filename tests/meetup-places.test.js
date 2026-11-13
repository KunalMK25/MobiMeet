import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getMeetupPlaces, describeSource, _setVenueServiceForTests, PROVENANCE_LABEL } from '../src/places/MeetupPlaces.js';
import { NEARBY_PLACE_PROVIDERS } from '../src/places/PlacesService.js';

const venue = (id, name, category, distanceKm, provenance = 'live') => ({ id, name, category, lat: 12.9, lon: 77.6, distanceKm, provenance, rating: null, openingHours: null });
const fakeService = (venues, extra = {}) => { const calls = []; return { calls, search: async (target, opts) => { calls.push({ target, opts }); return { venues, provenance: 'live', isFallback: false, fetchedAt: 1000, snapshotDate: '2026-11-13', warnings: [], counts: {}, attribution: '© OSM', ...extra }; } }; };
beforeEach(() => _setVenueServiceForTests(null));

test('returns the classic place shape (latitude/longitude/distance/source/emoji) built from the shared service', async () => {
  const svc = fakeService([venue('a', 'Nexus Koramangala', 'mall', 2.3), venue('b', 'Toit', 'bar', 1.1)]); _setVenueServiceForTests(svc);
  const { places, meta } = await getMeetupPlaces('Central Silk Board', { radiusKm: 3 });
  assert.deepEqual(places.map(p => p.name), ['Nexus Koramangala', 'Toit']);
  for (const p of places) for (const f of ['name', 'category', 'latitude', 'longitude', 'distance', 'source', 'provenance', 'emoji', 'note']) assert.ok(p[f] !== undefined, `missing ${f}`);
  assert.equal(places[0].distance, 2.3); assert.equal(meta.radiusKm, 3); assert.equal(meta.provenance, 'live');
  assert.deepEqual(svc.calls[0].opts, { radiusKm: 3, categories: ['all'], limit: 60, refresh: false }); assert.equal(svc.calls[0].target.stationKey, 'Central Silk Board'); assert.equal(svc.calls[0].target.mode, 'METRO');
});
test('cached per (station, radius): switching the category chip never refetches, but a new radius does', async () => {
  const svc = fakeService([venue('a', 'A', 'cafe', 1)]); _setVenueServiceForTests(svc);
  await getMeetupPlaces('MG Road', { radiusKm: 2.5 }); await getMeetupPlaces('MG Road', { radiusKm: 2.5 }); assert.equal(svc.calls.length, 1);
  await getMeetupPlaces('MG Road', { radiusKm: 3 }); assert.equal(svc.calls.length, 2);
  await getMeetupPlaces('MG Road', { radiusKm: 2.5, refresh: true }); assert.equal(svc.calls.length, 3); assert.equal(svc.calls[2].opts.refresh, true);   // refresh reaches the live layer
  await getMeetupPlaces('Indiranagar', { radiusKm: 2.5 }); assert.equal(svc.calls.length, 4);
});
test('REGRESSION: a station with no curated list never shows ANOTHER station’s places (the old MG Road substitution)', async () => {
  const none = await NEARBY_PLACE_PROVIDERS.static.getNearbyPlaces('Kengeri', ['all']);
  assert.deepEqual(none, []);
  _setVenueServiceForTests(fakeService([]));
  const { places, meta } = await getMeetupPlaces('Kengeri', { radiusKm: 2.5 });
  assert.deepEqual(places, []); assert.equal(meta.usedSample, false);
});
test('curated SAMPLE places are a last resort: used only when nothing else is in range, within the radius, and labelled "sample"', async () => {
  _setVenueServiceForTests(fakeService([]));
  const { places, meta } = await getMeetupPlaces('Central Silk Board', { radiusKm: 2.5 });
  assert.ok(places.length > 0 && places.every(p => p.provenance === 'sample' && p.distance <= 2.5)); assert.equal(meta.provenance, 'sample'); assert.equal(meta.usedSample, true); assert.equal(meta.isFallback, true);
  assert.match(describeSource(meta).text, /SAMPLE/);
  _setVenueServiceForTests(fakeService([venue('a', 'Real', 'cafe', 1)]));
  assert.ok((await getMeetupPlaces('Central Silk Board', { radiusKm: 2.5 })).places.every(p => p.provenance !== 'sample'));   // never mixed in when real data exists
});
test('the source description distinguishes live, cached and snapshot data in plain language', () => {
  assert.equal(describeSource({ provenance: 'live', fetchedAt: 1, radiusKm: 2.5, warnings: [] }).tone, 'ok');
  const cached = describeSource({ provenance: 'cached', fetchedAt: 1, radiusKm: 2.5, warnings: [] }); assert.equal(cached.tone, 'warn'); assert.match(cached.text, /Cached/);
  const snap = describeSource({ provenance: 'snapshot', snapshotDate: '2026-11-13', radiusKm: 2.5, warnings: ['FEW_RESULTS'] }); assert.match(snap.text, /unavailable.*snapshot dated 2026-11-13/); assert.match(snap.text, /wider radius/);
  assert.match(describeSource({ provenance: 'live', radiusKm: 2.5, warnings: ['SNAPSHOT_DATA_INCLUDED'] }).text, /saved snapshot/);
  assert.ok(!/wider radius/.test(describeSource({ provenance: 'live', radiusKm: 5, warnings: ['FEW_RESULTS'] }).text));   // already at the maximum
  assert.deepEqual(Object.keys(PROVENANCE_LABEL).sort(), ['cached', 'live', 'sample', 'snapshot']);
});
test('unknown stations and radius extremes are handled', async () => {
  _setVenueServiceForTests(fakeService([venue('a', 'A', 'cafe', 1)]));
  const u = await getMeetupPlaces('Not A Station', {}); assert.deepEqual(u.places, []); assert.ok(u.meta.warnings.includes('UNKNOWN_STATION'));
  const svc = fakeService([]); _setVenueServiceForTests(svc); await getMeetupPlaces('MG Road', { radiusKm: 99 }); assert.equal(svc.calls[0].opts.radiusKm, 5);
});
