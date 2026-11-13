// Integrity of the BUNDLED venue snapshot, plus the project's own examples checked against the real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VENUE_CATALOGUE as C } from '../src/data/venue-catalogue.js';
import { CATEGORY_KEYS, searchCatalogue, assembleSuggestions, normalizeName } from '../src/venues/core.js';
import { inBengaluru } from '../src/venues/catalogueBuild.js';
import { ST } from '../src/data/stations.js';
import { createVenueService, createSnapshotProvider } from '../src/venues/venueService.js';

const at = (k) => ({ lat: ST[k].la, lon: ST[k].lo });

test('every catalogue entry is well-formed, in Bengaluru, uniquely identified, OSM-sourced — and carries NO ratings or hours', () => {
  assert.ok(C.venues.length >= 100, `catalogue has ${C.venues.length} confirmed venues`);
  assert.match(C.generatedAt, /^\d{4}-\d{2}-\d{2}$/); assert.match(C.attribution, /OpenStreetMap/); assert.match(C.source, /OpenStreetMap/);
  const ids = new Set();
  for (const v of C.venues) {
    assert.match(v.id, /^osm:(node|way|relation)\/\d+$/, v.name); assert.ok(!ids.has(v.id), `duplicate id ${v.id}`); ids.add(v.id);
    assert.ok(v.name && v.name.length > 1, 'name'); assert.ok(CATEGORY_KEYS.includes(v.category), `${v.name}: category ${v.category}`);
    assert.ok(Number.isFinite(v.lat) && Number.isFinite(v.lon) && inBengaluru(v.lat, v.lon), `${v.name} is outside Bengaluru`);
    assert.ok(v.osmClass && v.osmType && v.retrievedAt, `${v.name}: provenance fields`);
    for (const forbidden of ['rating', 'openingHours', 'phone', 'website']) assert.ok(!(forbidden in v), `${v.name} must not carry unverified ${forbidden}`);
  }
});
test('the catalogue spans every category the product promises', () => {
  const have = new Set(C.venues.map(v => v.category));
  for (const c of ['mall', 'restaurant', 'cafe', 'bar', 'entertainment', 'park', 'attraction']) assert.ok(have.has(c), `no ${c} in the catalogue`);
});
test('no identical venue is listed twice (same name at the same spot)', () => {
  const seen = new Map();
  for (const v of C.venues) { const k = `${normalizeName(v.name)}|${v.lat.toFixed(3)}|${v.lon.toFixed(3)}`; assert.ok(!seen.has(k), `${v.name} duplicated`); seen.set(k, 1); }
});
test('EXAMPLE — Central Silk Board: Koramangala destinations (Nexus Koramangala, pubs/bars) are within a 3 km catchment, across several categories', () => {
  const p = at('Central Silk Board');
  const out = assembleSuggestions([searchCatalogue(C, p, 3, ['all'])], { point: p, radiusKm: 3, categories: ['all'], limit: 60 });
  assert.ok(out.length >= 10, `only ${out.length} suggestions`); assert.ok(new Set(out.map(v => v.category)).size >= 4, 'categories');
  const nexus = out.find(v => /nexus/i.test(v.name) && /koramangala/i.test(v.name)); assert.ok(nexus, 'Nexus Koramangala is recommended'); assert.ok(nexus.distanceKm > 1.5 && nexus.distanceKm <= 3);
  assert.ok(out.some(v => v.category === 'bar' && /koramangala|bob|social/i.test(v.name)), 'a Koramangala pub/bar is suggested');
  assert.ok(out.every(v => v.distanceKm <= 3)); assert.ok(out.every((v, i) => i === 0 || out[i - 1].score >= v.score), 'ranked best-first');
  assert.equal(new Set(out.map(v => v.id)).size, out.length);
});
test('EXAMPLE — BTM Layout: nearby BTM / surrounding-area destinations in several categories', () => {
  const p = at('BTM Layout');
  const out = assembleSuggestions([searchCatalogue(C, p, 3, ['all'])], { point: p, radiusKm: 3, categories: ['all'], limit: 60 });
  assert.ok(out.length >= 6, `only ${out.length} suggestions`); assert.ok(new Set(out.map(v => v.category)).size >= 3);
  assert.ok(out.some(v => v.category === 'mall'), 'at least one mall'); assert.ok(out.every(v => v.distanceKm <= 3));
});
test('EXAMPLE — overlapping catchments: venues within range of BOTH Central Silk Board and BTM Layout are listed for each, with per-station distances', () => {
  const a = at('Central Silk Board'), b = at('BTM Layout');
  const A = searchCatalogue(C, a, 3, ['all']), B = searchCatalogue(C, b, 3, ['all']);
  const shared = A.filter(x => B.some(y => y.id === x.id)); assert.ok(shared.length >= 2, `only ${shared.length} shared venues`);
  for (const s of shared) { const x = A.find(v => v.id === s.id), y = B.find(v => v.id === s.id); assert.notEqual(x.distanceKm, y.distanceKm, `${s.name}: distance must be per-station`); }
});
test('through the service: radius is respected and the list says it came from the snapshot when live data is down', async () => {
  const svc = createVenueService({ live: { search: async () => { throw new Error('net'); } }, snapshot: createSnapshotProvider() });
  const r = await svc.search({ mode: 'METRO', ...at('Central Silk Board'), stationKey: 'Central Silk Board' }, { radiusKm: 3 });
  assert.equal(r.provenance, 'snapshot'); assert.equal(r.isFallback, true); assert.equal(r.snapshotDate, C.generatedAt);
  assert.ok(r.venues.length >= 10 && r.venues.every(v => v.provenance === 'snapshot' && v.distanceKm <= 3));
  const small = await svc.search({ mode: 'METRO', ...at('Central Silk Board') }, { radiusKm: 1.2 }); assert.ok(small.venues.length < r.venues.length);
});
test('coverage is stated honestly: report how many operational stations have snapshot venues within 3 km', () => {
  const stations = Object.keys(ST).filter(k => ST[k].op);
  const covered = stations.filter(k => searchCatalogue(C, at(k), 3, ['all']).length > 0).length;
  assert.ok(covered / stations.length >= 0.6, `snapshot covers ${covered}/${stations.length} stations`);   // gaps are filled by live data and listed by scripts/build-venue-catalogue.mjs
});
