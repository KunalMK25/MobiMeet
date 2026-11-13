import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoutingProvider, isProductionLike, isPublicDemo } from '../src/bike/routingFactory.js';
import { loadConfig } from '../src/api/config.js';
import { assertProvider } from '../src/domain/providers.js';

const cfg = (env) => loadConfig({ APP_BASE_URL: 'http://localhost:3000', ...env });
const ok = (b) => ({ ok: true, status: 200, json: async () => b });

test('production-like detection: https and not localhost', () => {
  assert.equal(isProductionLike('https://mobimeet.example'), true);
  for (const u of ['http://localhost:3000', 'https://localhost', 'http://mobimeet.example', 'https://app.localhost', 'garbage']) assert.equal(isProductionLike(u), false, u);
  assert.equal(isPublicDemo('https://router.project-osrm.org'), true); assert.equal(isPublicDemo('https://osrm.internal.example'), false);
});
test('development: the public demo is allowed and labelled "demo"', () => {
  const r = createRoutingProvider(cfg({}).routing, { appBaseUrl: 'http://localhost:3000' });
  assert.equal(r.status, 'demo'); assertProvider('roadRouting', r.provider);
});
test('production-like + public demo → refused with a clear error, never silently used', async () => {
  const c = cfg({ APP_BASE_URL: 'https://mobimeet.example' });
  const r = createRoutingProvider(c.routing, { appBaseUrl: c.appBaseUrl });
  assert.equal(r.status, 'disabled'); assert.equal(r.provider.name, 'disabled');
  await assert.rejects(r.provider.matrix([], []), /development-only/);
  const forced = cfg({ APP_BASE_URL: 'https://mobimeet.example', ALLOW_PUBLIC_OSRM_IN_PRODUCTION: 'true' });
  assert.equal(createRoutingProvider(forced.routing, { appBaseUrl: forced.appBaseUrl }).status, 'demo');   // only with an explicit opt-in
});
test('production with its own OSRM: configured, no enforced spacing when set to 0, API key sent as a server-side header', async () => {
  const c = cfg({ APP_BASE_URL: 'https://mobimeet.example', ROUTING_PROVIDER_URL: 'https://osrm.internal.example', ROUTING_MIN_INTERVAL_MS: '0', ROUTING_API_KEY: 'k123' });
  assert.equal(c.routing.minIntervalMs, 0);
  let seen; const r = createRoutingProvider(c.routing, { appBaseUrl: c.appBaseUrl, fetchImpl: async (u, o) => { seen = { u, h: o.headers }; return ok({ code: 'Ok', routes: [{ distance: 1000, duration: 60 }] }); } });
  assert.equal(r.status, 'configured');
  await r.provider.route({ lat: 12.9, lon: 77.5 }, { lat: 12.95, lon: 77.6 });
  assert.match(seen.u, /^https:\/\/osrm\.internal\.example\/route\/v1\/driving\//); assert.equal(seen.h.Authorization, 'Bearer k123');
  const custom = cfg({ ROUTING_PROVIDER_URL: 'https://gw.example', ROUTING_API_KEY: 'abc', ROUTING_API_KEY_HEADER: 'X-Api-Key' });
  let h2; await createRoutingProvider(custom.routing, { appBaseUrl: custom.appBaseUrl, fetchImpl: async (u, o) => { h2 = o.headers; return ok({ code: 'Ok', routes: [{ distance: 1, duration: 1 }] }); } }).provider.route({ lat: 1, lon: 1 }, { lat: 2, lon: 2 });
  assert.equal(h2['X-Api-Key'], 'abc'); assert.equal(h2.Authorization, undefined);
});
test('a deliberately disabled provider fails the Bike optimisation loudly (config error), unlike a transient outage which degrades', async () => {
  const { makeEnv } = await import('./helpers.js');
  const env = await makeEnv({ routing: createRoutingProvider(cfg({ APP_BASE_URL: 'https://mobimeet.example' }).routing, { appBaseUrl: 'https://mobimeet.example' }).provider });
  const { owner, group } = await env.team({ mode: 'BIKE', origins: [{ lat: 12.9, lon: 77.55 }, { lat: 12.99, lon: 77.62 }] });
  assert.equal(await env.code(env.plans.requestOptimization(owner, group.id)), 'PROVIDER_UNAVAILABLE');
  assert.equal((await env.groups.getGroup(owner, group.id)).status, 'open');   // group restored, request recorded as failed
  await env.close();
});
test('health reports the routing status without revealing any URL', async () => {
  const { createPgliteDb } = await import('../src/db/client.js'); const { migrate } = await import('../src/db/migrate.js'); const { createApp } = await import('../src/api/app.js');
  const db = await createPgliteDb(); await migrate(db);
  for (const [env, expected] of [[{}, 'demo'], [{ APP_BASE_URL: 'https://mobimeet.example' }, 'disabled'], [{ APP_BASE_URL: 'https://mobimeet.example', ROUTING_PROVIDER_URL: 'https://osrm.internal.example' }, 'configured']]) {
    const app = await createApp({ db, config: cfg(env) });
    const r = await app.handle({ method: 'GET', path: '/api/health', headers: {} });
    assert.deepEqual(JSON.parse(r.body), { ok: true, routing: expected }); assert.ok(!r.body.includes('osrm'));
  }
  await db.close();
});

import { createEstimateProvider, ESTIMATE } from '../src/bike/estimateProvider.js';
import { optimizeBikeGroup } from '../src/bike/bikeOptimizer.js';
import { haversineKm } from '../src/utils/geometry.js';
import { buildAgentInput } from '../src/domain/participant.js';

test('ROUTING_MODE=estimate is an explicit opt-in, works with no service, and is reported as "estimate"', async () => {
  const c = cfg({ APP_BASE_URL: 'https://mobimeet.example', ROUTING_MODE: 'estimate' });
  const r = createRoutingProvider(c.routing, { appBaseUrl: c.appBaseUrl, fetchImpl: async () => { throw new Error('no network may be used'); } });
  assert.equal(r.status, 'estimate'); assert.equal(r.provider.estimated, true);
  assert.equal(createRoutingProvider(cfg({ ROUTING_MODE: 'banana' }).routing, {}).status, 'disabled');   // typos fail closed, never silently fall back
});
test('estimate provider: straight-line × detour at a fixed speed; geometry is the straight segment; nothing is called "traffic-aware"', async () => {
  const p = createEstimateProvider({ now: () => 7 }); const a = { lat: 12.90, lon: 77.55 }, b = { lat: 12.99, lon: 77.62 };
  const direct = haversineKm(a.lat, a.lon, b.lat, b.lon), km = Math.round(direct * ESTIMATE.detourFactor * 100) / 100;
  const r = await p.route(a, b); assert.equal(r.distanceKm, km); assert.equal(r.durationMin, Math.round(km / ESTIMATE.speedKmh * 600) / 10);
  assert.deepEqual(r.geometry, [[a.lat, a.lon], [b.lat, b.lon]]); assert.equal(r.trafficAware, false); assert.equal(r.fetchedAt, 7);
  const m = await p.matrix([a, b], [a, b]); assert.equal(m.distanceKm[0][0], 0); assert.equal(m.distanceKm[0][1], km); assert.equal(m.distanceKm[1][0], km);
});
test('Bike optimisation in estimate mode: labelled everywhere, straight-line geometry, no refinement, reproducible', async () => {
  const ps = [[12.90, 77.55], [12.99, 77.62], [13.02, 77.52]].map(([lat, lon], i) => buildAgentInput({ participantId: `p${i}`, mode: 'BIKE', origin: { lat, lon } }));
  const a = await optimizeBikeGroup(ps, { provider: createEstimateProvider({ now: () => 1 }), now: 1 }), b = await optimizeBikeGroup(ps, { provider: createEstimateProvider({ now: () => 1 }), now: 1 });
  assert.deepEqual(a, b);
  assert.ok(a.warnings.includes('ROUTING_FALLBACK')); assert.equal(a.routing.mode, 'estimate'); assert.equal(a.routing.candidatesEvaluated, a.ranked.length);   // initial candidates only
  assert.ok(a.recommended.journeys.every(j => j.detail.quality === 'fallback' && j.detail.geometryKind === 'straight-line' && j.detail.geometry.length === 2));
  assert.ok(a.explanation.limitations.some(l => /straight-line estimates/.test(l)));
});
