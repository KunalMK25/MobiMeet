import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.js';

let E;
before(async () => { E = await makeEnv(); });
after(() => E.close());
const metroTeam = () => E.team({ origins: [E.metro('Whitefield'), E.metro('Challaghatta'), E.metro('Silk Institute')] });

test('optimisation preconditions: owner only, group ready, ≥2 participants with origins', async () => {
  const o = await E.user('Solo');
  const draft = await E.groups.createGroup(o, { name: 'D', mode: 'METRO' });
  assert.equal(await E.code(E.plans.requestOptimization(o, draft.id)), 'NOT_READY');
  const solo = await E.groups.createGroup(o, { name: 'S', mode: 'METRO', origin: E.metro('Majestic') });
  assert.equal(await E.code(E.plans.requestOptimization(o, solo.id)), 'NOT_READY');   // one participant
  const { owner, members, group } = await metroTeam();
  assert.equal(await E.code(E.plans.requestOptimization(members[0], group.id)), 'FORBIDDEN');
  const stranger = await E.user('Stranger');
  assert.equal(await E.code(E.plans.requestOptimization(stranger, group.id)), 'NOT_FOUND');
  assert.equal(await E.code(E.plans.requestOptimization(owner, group.id, { strategy: 'nope' })), 'INVALID_INPUT'); // input validation reveals nothing about other groups
});
test('a participant without an origin blocks optimisation', async () => {
  const owner = await E.user('O'); const g = await E.groups.createGroup(owner, { name: 'X', mode: 'METRO', origin: E.metro('Majestic') });
  const inv = await E.groups.createInvitation(owner, g.id);
  await E.groups.joinWithToken(await E.user('M'), inv.token, { origin: E.metro('Hoodi') }, { ip: 'np' });
  await E.db.query(`UPDATE group_memberships SET origin_lat=NULL, origin_lon=NULL WHERE group_id=$1 AND role='member'`, [g.id]);
  assert.equal(await E.code(E.plans.requestOptimization(owner, g.id)), 'NOT_READY');
  assert.equal((await E.groups.getGroup(owner, g.id)).status, 'open'); // claim was rolled back / restored
});
test('Metro end-to-end: plan v1 is persisted, explained with names, and leaks no coordinates', async () => {
  const { owner, group } = await metroTeam();
  const plan = await E.plans.requestOptimization(owner, group.id, { strategy: 'balanced' });
  assert.equal(plan.version, 1); assert.equal(plan.status, 'proposed');
  assert.ok(plan.result.recommended.label); assert.equal(plan.result.recommended.journeys.length, 3);
  const g = await E.groups.getGroup(owner, group.id);
  assert.equal(g.status, 'proposed'); assert.equal(g.selectedPlanId, plan.id); assert.equal(g.plan.stale, false);
  const text = plan.result.explanation.lines.join(' ');
  assert.ok(/Owner|Member1|Member2/.test(text)); assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text));       // names, not uuids
  assert.ok(!/originLat|originLon/.test(JSON.stringify(plan.result)));
  const req = (await E.db.query(`SELECT status, input_hash FROM optimization_requests WHERE group_id=$1`, [group.id])).rows[0];
  assert.equal(req.status, 'succeeded'); assert.equal(req.input_hash, plan.inputHash);
});
test('same inputs → same hash and same recommendation (reproducible); new version appended', async () => {
  const { owner, group } = await metroTeam();
  const a = await E.plans.requestOptimization(owner, group.id), b = await E.plans.requestOptimization(owner, group.id);
  assert.equal(a.inputHash, b.inputHash); assert.equal(b.version, 2);
  assert.deepEqual(a.result.recommended.metrics, b.result.recommended.metrics);
  assert.equal(a.result.recommended.id, b.result.recommended.id);
});
test('changing an input makes the plan stale, reopens the group, and blocks confirming the old plan', async () => {
  const { owner, members, group } = await metroTeam();
  const plan = await E.plans.requestOptimization(owner, group.id);
  await E.groups.updateMyInput(members[0], group.id, { origin: E.metro('Kengeri') });
  const g = await E.groups.getGroup(owner, group.id);
  assert.equal(g.status, 'open'); assert.equal(g.plan.stale, true);
  assert.equal(await E.code(E.plans.confirmPlan(owner, group.id, plan.id)), 'CONFLICT');
});
test('confirm: owner only; double-confirm rejected; unknown plan; status transitions', async () => {
  const { owner, members, group } = await metroTeam();
  const plan = await E.plans.requestOptimization(owner, group.id);
  assert.equal(await E.code(E.plans.confirmPlan(members[0], group.id, plan.id)), 'FORBIDDEN');
  assert.equal(await E.code(E.plans.confirmPlan(owner, group.id, '00000000-0000-4000-8000-000000000000')), 'NOT_FOUND');
  const done = await E.plans.confirmPlan(owner, group.id, plan.id);
  assert.equal(done.status, 'confirmed'); assert.ok(done.confirmedAt);
  assert.equal((await E.groups.getGroup(owner, group.id)).status, 'confirmed');
  assert.equal(await E.code(E.plans.confirmPlan(owner, group.id, plan.id)), 'CONFLICT');
  // members can read the confirmed plan
  assert.equal((await E.plans.getPlan(members[1], group.id)).id, plan.id);
});
test('a confirmed plan is never silently overwritten: re-optimising proposes v2 while v1 stays confirmed until v2 is confirmed', async () => {
  const { owner, group } = await metroTeam();
  const v1 = await E.plans.requestOptimization(owner, group.id); await E.plans.confirmPlan(owner, group.id, v1.id);
  const v2 = await E.plans.requestOptimization(owner, group.id, { strategy: 'fastest' });
  let list = await E.plans.listPlans(owner, group.id);
  assert.deepEqual(list.map(p => [p.version, p.status]), [[2, 'proposed'], [1, 'confirmed']]);
  assert.equal(list[0].isSelected, true);
  await E.plans.confirmPlan(owner, group.id, v2.id);
  list = await E.plans.listPlans(owner, group.id);
  assert.deepEqual(list.map(p => [p.version, p.status]), [[2, 'confirmed'], [1, 'superseded']]);
  const v1row = (await E.db.query('SELECT result FROM meetup_plans WHERE id=$1', [v1.id])).rows[0];
  assert.equal(v1row.result.strategy, 'balanced'); // history intact
});
test('failure path: provider missing → request marked failed, group returns to open, error surfaced', async () => {
  const env = await makeEnv({ routing: null });
  const { owner, group } = await env.team({ mode: 'BIKE', origins: [{ lat: 12.9, lon: 77.55 }, { lat: 12.99, lon: 77.62 }] });
  assert.equal(await env.code(env.plans.requestOptimization(owner, group.id)), 'PROVIDER_UNAVAILABLE');
  assert.equal((await env.groups.getGroup(owner, group.id)).status, 'open');
  assert.equal((await env.db.query(`SELECT status, error_code FROM optimization_requests`)).rows[0].error_code, 'PROVIDER_UNAVAILABLE');
  await env.close();
});
test('a running optimisation blocks a second one; a stuck one (>5 min) can be retried', async () => {
  const { owner, group } = await metroTeam();
  await E.db.query(`UPDATE groups SET status='optimizing' WHERE id=$1`, [group.id]);
  await E.db.query(`INSERT INTO optimization_requests (group_id, requested_by, strategy, input_hash, status, created_at) VALUES ($1,$2,'balanced','x','running',$3)`, [group.id, owner.id, new Date(E.clock())]);
  assert.equal(await E.code(E.plans.requestOptimization(owner, group.id)), 'CONFLICT');
  E.advance(6 * 60 * 1000);
  assert.equal((await E.plans.requestOptimization(owner, group.id)).status, 'proposed');
});
test('Bike end-to-end through the service layer with fuel assumptions', async () => {
  const env = await makeEnv();
  const { owner, group } = await env.team({ mode: 'BIKE', origins: [{ lat: 12.90, lon: 77.55 }, { lat: 12.99, lon: 77.62 }, { lat: 13.02, lon: 77.52 }] });
  const plan = await env.plans.requestOptimization(owner, group.id, { fuel: { mileageKmPerLitre: 40, fuelPricePerLitre: 100, priceDate: '2026-11-13' } });
  assert.equal(plan.result.mode, 'BIKE'); assert.ok(plan.result.fuelAssumptions); assert.ok(plan.result.recommended.metrics.costTotal > 0);
  assert.ok(plan.result.warnings.includes('FUEL_IS_ESTIMATE')); assert.ok(plan.result.recommended.journeys.every(j => j.detail.geometry));
  assert.equal(await env.code(env.plans.requestOptimization(owner, group.id, { fuel: { mileageKmPerLitre: -1, fuelPricePerLitre: 100 } })), 'INVALID_INPUT');
  await env.close();
});
test('rate limit on optimisation requests: 20 per 10 minutes, then the window rolls over', async () => {
  const { owner, group } = await metroTeam();
  for (let i = 0; i < 20; i++) await E.plans.requestOptimization(owner, group.id);
  assert.equal(await E.code(E.plans.requestOptimization(owner, group.id)), 'RATE_LIMITED');
  E.advance(10 * 60 * 1000);
  assert.equal((await E.plans.requestOptimization(owner, group.id)).status, 'proposed');
});
test('venues: fetched for the recommended point, cached per plan, refreshable, members only', async () => {
  const { owner, members, group } = await metroTeam();
  const plan = await E.plans.requestOptimization(owner, group.id);
  const v = await E.plans.getPlanVenues(members[0], group.id, plan.id);
  assert.equal(v.cachedFromDatabase, undefined); assert.ok(v.venues.length >= 1); assert.equal(v.source, 'osm'); assert.equal(v.provenance, 'live'); assert.ok(v.venues.some(x => x.name === 'Test Cafe' && x.provenance === 'live'));
  assert.equal((await E.plans.getPlanVenues(owner, group.id, plan.id)).cachedFromDatabase, true);
  assert.equal((await E.plans.getPlanVenues(owner, group.id, plan.id, { refresh: true })).cachedFromDatabase, undefined);
  assert.equal((await E.plans.getPlanVenues(owner, group.id, plan.id, { radiusKm: 3 })).cachedFromDatabase, undefined);     // a different radius is a different query
  assert.equal((await E.plans.getPlanVenues(owner, group.id, plan.id, { radiusKm: 3 })).radiusKm, 3);
  assert.equal(await E.code(E.plans.getPlanVenues(await E.user('Out'), group.id, plan.id)), 'NOT_FOUND');
});

test('Bike plan gets a friendly area name from reverse geocoding; geocoder failure is non-fatal', async () => {
  for (const [geo, expect] of [[{ reverse: async () => ({ areaName: 'Test Road, Test Suburb' }) }, 'Test Road, Test Suburb'], [{ reverse: async () => { throw new Error('down'); } }, null]]) {
    const env = await makeEnv(); env.plansWithGeo = (await import('../src/services/plans.js')).createPlanService({ db: env.db, clock: env.clock, groups: env.groups, providers: { roadRouting: env.routing }, venues: env.venues, geocoder: geo });
    const { owner, group } = await env.team({ mode: 'BIKE', origins: [{ lat: 12.90, lon: 77.55 }, { lat: 12.99, lon: 77.62 }] });
    const plan = await env.plansWithGeo.requestOptimization(owner, group.id);
    assert.equal(plan.result.recommended.areaName, expect); assert.ok(plan.result.recommended.lat);
    await env.close();
  }
});

test('route strategy: validated, stored in the plan, part of the reproducibility hash and of stale detection, inherited by what-if', async () => {
  const { owner, group } = await metroTeam();
  assert.equal(await E.code(E.plans.requestOptimization(owner, group.id, { routeStrategy: 'scenic' })), 'INVALID_INPUT');
  const fast = await E.plans.requestOptimization(owner, group.id), cheap = await E.plans.requestOptimization(owner, group.id, { routeStrategy: 'lowest_fare' });
  assert.equal(fast.result.routeStrategy, 'fastest'); assert.equal(cheap.result.routeStrategy, 'lowest_fare');
  assert.notEqual(fast.inputHash, cheap.inputHash);                                       // different assumptions → different hash
  assert.equal((await E.groups.getGroup(owner, group.id)).plan.stale, false);              // staleness uses the stored route strategy
  assert.equal((await E.plans.confirmPlan(owner, group.id, cheap.id)).status, 'confirmed');
  assert.equal((await E.plans.runScenario(owner, group.id, {})).result.routeStrategy, 'lowest_fare');           // inherited from the current plan
  assert.equal((await E.plans.runScenario(owner, group.id, { routeStrategy: 'fewest_transfers' })).result.routeStrategy, 'fewest_transfers');
});
test('Bike plans have no route strategy and are unaffected by it', async () => {
  const env = await makeEnv(); const { owner, group } = await env.team({ mode: 'BIKE', origins: [{ lat: 12.90, lon: 77.55 }, { lat: 12.99, lon: 77.62 }] });
  const a = await env.plans.requestOptimization(owner, group.id), b = await env.plans.requestOptimization(owner, group.id, { routeStrategy: 'lowest_fare' });
  assert.equal(a.inputHash, b.inputHash); assert.equal(a.result.routeStrategy, null); await env.close();
});
