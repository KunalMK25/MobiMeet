import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOsrmProvider, RoutingError } from '../src/bike/osrmProvider.js';
import { estimateFuelCost, validateFuelAssumptions } from '../src/bike/fuel.js';
import { generateBikeCandidates, geometricMedian, centroid, refineCandidates } from '../src/bike/candidates.js';
import { optimizeBikeGroup } from '../src/bike/bikeOptimizer.js';
import { buildAgentInput } from '../src/domain/participant.js';
import { haversineKm } from '../src/utils/geometry.js';

// ── mock fetch helpers (synthetic data only; no network, no real locations) ──
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const provider = (fetchImpl, extra = {}) => createOsrmProvider({ fetchImpl, minIntervalMs: 0, ...extra });

test('OSRM route: lon,lat order in URL, unit conversion, geometry flipped to [lat,lon], honesty metadata', async () => {
  let url;
  const p = provider(async (u) => { url = u; return jsonRes({ code: 'Ok', routes: [{ distance: 12345, duration: 600, geometry: { coordinates: [[77.6, 12.9], [77.7, 13.0]] } }] }); }, { now: () => 1000 });
  const r = await p.route({ lat: 12.9, lon: 77.6 }, { lat: 13.0, lon: 77.7 });
  assert.match(url, /\/route\/v1\/driving\/77\.6,12\.9;77\.7,13\?overview=simplified&geometries=geojson$/);
  assert.equal(r.distanceKm, 12.35); assert.equal(r.durationMin, 10);
  assert.deepEqual(r.geometry, [[12.9, 77.6], [13.0, 77.7]]);
  assert.equal(r.trafficAware, false); assert.equal(r.provider, 'osrm'); assert.equal(r.fetchedAt, 1000);
});
test('OSRM matrix: sources/destinations indices and null (no route) cells', async () => {
  let url;
  const p = provider(async (u) => { url = u; return jsonRes({ code: 'Ok', durations: [[60, null]], distances: [[1000, null]], destinations: [{ location: [77.6, 12.9], distance: 4.2 }, null] }); });
  const m = await p.matrix([{ lat: 1, lon: 2 }], [{ lat: 3, lon: 4 }, { lat: 5, lon: 6 }]);
  assert.match(url, /sources=0&destinations=1;2&annotations=duration,distance$/);
  assert.deepEqual(m.durationsMin, [[1, null]]); assert.deepEqual(m.distanceKm, [[1, null]]);
  assert.deepEqual(m.snappedDestinations[0], { lat: 12.9, lon: 77.6, snapDistanceM: 4.2 }); assert.equal(m.snappedDestinations[1], null);
});
test('OSRM: identical requests are served from cache; TTL expiry refetches', async () => {
  let calls = 0, t = 0;
  const p = provider(async () => { calls++; return jsonRes({ code: 'Ok', routes: [{ distance: 1000, duration: 60 }] }); }, { now: () => t, cacheTtlMs: 100 });
  const a = { lat: 12.9, lon: 77.6 }, b = { lat: 12.95, lon: 77.65 };
  await p.route(a, b); const second = await p.route(a, b);
  assert.equal(calls, 1); assert.equal(second.cached, true);
  t = 500; await p.route(a, b); assert.equal(calls, 2);
});
test('OSRM: retries 5xx/429 once then succeeds; gives up after retries; does not retry 4xx or NoRoute', async () => {
  let n = 0;
  const flaky = provider(async () => (++n === 1 ? jsonRes({}, 503) : jsonRes({ code: 'Ok', routes: [{ distance: 1000, duration: 60 }] })));
  assert.equal((await flaky.route({ lat: 1, lon: 1 }, { lat: 2, lon: 2 })).distanceKm, 1); assert.equal(n, 2);
  let m = 0;
  const down = provider(async () => { m++; return jsonRes({}, 503); });
  await assert.rejects(down.route({ lat: 1, lon: 1 }, { lat: 2, lon: 2 }), RoutingError); assert.equal(m, 2);
  let k = 0;
  const bad = provider(async () => { k++; return jsonRes({ code: 'NoRoute' }); });
  await assert.rejects(bad.route({ lat: 1, lon: 1 }, { lat: 2, lon: 2 }), /NoRoute/); assert.equal(k, 1);
  let q = 0;
  const forbidden = provider(async () => { q++; return jsonRes({}, 403); });
  await assert.rejects(forbidden.route({ lat: 1, lon: 1 }, { lat: 2, lon: 2 })); assert.equal(q, 1);
});
test('OSRM: a hung request is aborted by the timeout', async () => {
  const hang = provider((u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))), { timeoutMs: 20, retries: 0 });
  await assert.rejects(hang.route({ lat: 1, lon: 1 }, { lat: 2, lon: 2 }), /timed out/);
});

test('fuel formula and strict missing-data behaviour', () => {
  const fuel = { mileageKmPerLitre: 40, fuelPricePerLitre: 100 };
  assert.equal(estimateFuelCost(20, fuel), 50);
  assert.equal(estimateFuelCost(0, fuel), 0);
  assert.equal(estimateFuelCost(20, null), null);
  assert.equal(estimateFuelCost(20, { mileageKmPerLitre: 40 }), null);
  assert.equal(estimateFuelCost(20, { mileageKmPerLitre: 0, fuelPricePerLitre: 100 }), null);
  assert.equal(estimateFuelCost(-1, fuel), null);
  assert.equal(validateFuelAssumptions(fuel).priceDate, null); // never invents a price date
});

const O = [{ lat: 12.90, lon: 77.55 }, { lat: 12.99, lon: 77.62 }, { lat: 13.02, lon: 77.52 }];
test('candidates: deterministic, deduped, bounded, include centroid; spread guard', () => {
  const a = generateBikeCandidates(O), b = generateBikeCandidates(O);
  assert.deepEqual(a, b);
  assert.ok(a.length <= 24 && new Set(a.map(c => c.id)).size === a.length);
  const c = centroid(O);
  assert.equal(a[0].kind, 'centroid'); assert.ok(haversineKm(a[0].lat, a[0].lon, c.lat, c.lon) < 0.02);
  assert.throws(() => generateBikeCandidates([{ lat: 12.9, lon: 77.5 }, { lat: 28.6, lon: 77.2 }]), /too far apart/);
  assert.ok(refineCandidates([a[0]], 0.5).length === 8);
});
test('geometric median of collinear points is the middle one', () => {
  const m = geometricMedian([{ lat: 12.9, lon: 77.5 }, { lat: 12.95, lon: 77.5 }, { lat: 13.0, lon: 77.5 }]);
  assert.ok(Math.abs(m.lat - 12.95) < 1e-3);
});

// Test-only stand-in for a routing provider (NOT shipped): straight-line × 1.3 at 30 km/h.
const fakeProvider = (opts = {}) => ({
  name: 'fake', calls: { matrix: 0, route: 0 },
  async matrix(srcs, dsts) {
    this.calls.matrix++;
    if (opts.failMatrix) throw new RoutingError('down', { retryable: true });
    const d = srcs.map(s => dsts.map(t => (opts.unreachable?.(t) ? null : Math.round(haversineKm(s.lat, s.lon, t.lat, t.lon) * 1.3 * 100) / 100)));
    return { distanceKm: d, durationsMin: d.map(r => r.map(x => (x == null ? null : Math.round(x / 30 * 600) / 10))), provider: 'fake', profile: 'driving', fetchedAt: 1, cached: false };
  },
  async route(a, b) { this.calls.route++; if (opts.failRoute) throw new RoutingError('x'); return { geometry: [[a.lat, a.lon], [b.lat, b.lon]] }; },
});
const people = (n = 3) => O.slice(0, n).map((o, i) => buildAgentInput({ participantId: `p${i + 1}`, mode: 'BIKE', origin: o }));

test('Bike: recommendation uses road-provider journeys, is reproducible, and minimises worst burden', async () => {
  const r1 = await optimizeBikeGroup(people(), { provider: fakeProvider(), now: 5 });
  const r2 = await optimizeBikeGroup(people(), { provider: fakeProvider(), now: 5 });
  assert.deepEqual(r1, r2);
  assert.equal(r1.mode, 'BIKE');
  assert.ok(r1.recommended.journeys.every(j => j.detail.quality === 'provider' && j.detail.geometry?.length === 2));
  assert.equal(r1.recommended.metrics.burden.max, Math.min(...r1.ranked.map(c => c.metrics.burden.max)));
  assert.ok(r1.routing.candidatesEvaluated > 12);                 // initial + refinement round
  assert.ok(r1.warnings.includes('TRAFFIC_NOT_REAL_TIME'));
  assert.ok(!r1.warnings.includes('FUEL_IS_ESTIMATE'));            // no fuel assumptions supplied
  assert.equal(r1.recommended.metrics.costTotal, null);            // so no cost is invented
});
test('Bike: refinement round never makes the recommendation worse', async () => {
  const r = await optimizeBikeGroup(people(), { provider: fakeProvider() });
  const initialBest = Math.min(...r.ranked.filter(c => c.kind !== 'refine').map(c => c.metrics.burden.max));
  assert.ok(r.recommended.metrics.burden.max <= initialBest);
});
test('Bike: fuel assumptions produce labelled cost estimates and enable cheapest strategy', async () => {
  const fuel = { mileageKmPerLitre: 40, fuelPricePerLitre: 100, priceSource: 'user-supplied', priceDate: '2026-11-13' };
  const r = await optimizeBikeGroup(people(), { provider: fakeProvider(), fuel, strategy: 'cheapest' });
  assert.ok(r.warnings.includes('FUEL_IS_ESTIMATE'));
  assert.equal(r.fuelAssumptions.priceDate, '2026-11-13');
  const j = r.recommended.journeys[0];
  assert.equal(j.cost, Math.round(j.distanceKm / 40 * 100 * 100) / 100);
  assert.equal(r.recommended.metrics.costTotal, Math.min(...r.ranked.map(c => c.metrics.costTotal)));
  await assert.rejects(optimizeBikeGroup(people(), { provider: fakeProvider(), strategy: 'cheapest' }), /requires cost/);
});
test('Bike: provider outage degrades to a labelled straight-line fallback (no geometry, no refinement)', async () => {
  const fp = fakeProvider({ failMatrix: true });
  const r = await optimizeBikeGroup(people(), { provider: fp });
  assert.ok(r.warnings.includes('ROUTING_FALLBACK'));
  assert.ok(r.recommended.journeys.every(j => j.detail.quality === 'fallback' && j.detail.geometry === null));
  assert.equal(fp.calls.route, 0); assert.equal(fp.calls.matrix, 1);
});
test('Bike: geometry failure is reported, not fatal', async () => {
  const r = await optimizeBikeGroup(people(), { provider: fakeProvider({ failRoute: true }) });
  assert.ok(r.warnings.includes('ROUTE_GEOMETRY_UNAVAILABLE')); assert.ok(r.recommended);
});
test('Bike: candidates with no road route are rejected, others still win', async () => {
  const centre = centroid(O);
  const r = await optimizeBikeGroup(people(), { provider: fakeProvider({ unreachable: (t) => haversineKm(t.lat, t.lon, centre.lat, centre.lon) < 0.05 }) });
  assert.ok(r.rejected.some(x => x.reason.code === 'UNREACHABLE'));
  assert.ok(r.recommended);
});
test('Bike: mixed-mode participant and bad provider are rejected up front', async () => {
  const metro = buildAgentInput({ participantId: 'm', mode: 'METRO', origin: O[0] });
  await assert.rejects(optimizeBikeGroup([...people(2), metro], { provider: fakeProvider() }), /match the group/);
  await assert.rejects(optimizeBikeGroup(people(), { provider: {} }), /missing/);
});
test('Bike: hard max-distance constraint uses real route distance', async () => {
  const ps = people().map((p, i) => i === 0 ? buildAgentInput({ participantId: 'p1', mode: 'BIKE', origin: O[0], hardConstraints: { maxDistanceKm: 1 } }) : p);
  const r = await optimizeBikeGroup(ps, { provider: fakeProvider() });
  assert.equal(r.recommended, null);
  assert.ok(r.warnings.includes('NO_FEASIBLE_CANDIDATE'));
});
