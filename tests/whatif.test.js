import { GROUP_LIMITS } from '../src/config/Limits.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.js';
import { compareResults } from '../src/services/plans.js';

let E;
before(async () => { E = await makeEnv(); });
after(() => E.close());
const team = () => E.team({ origins: [E.metro('Whitefield'), E.metro('Challaghatta'), E.metro('Silk Institute')] });
const snapshot = async (gid) => JSON.stringify({
  g: (await E.db.query('SELECT status, selected_plan_id, updated_at FROM groups WHERE id=$1', [gid])).rows,
  p: (await E.db.query('SELECT id, status, version, input_hash FROM meetup_plans WHERE group_id=$1 ORDER BY version', [gid])).rows,
  m: (await E.db.query('SELECT user_id, origin_lat, origin_lon, agent_version FROM group_memberships WHERE group_id=$1 ORDER BY user_id', [gid])).rows,
});

test('scenarios never modify the group, its memberships or any plan (confirmed plan untouched)', async () => {
  const { owner, members, group } = await team();
  const plan = await E.plans.requestOptimization(owner, group.id); await E.plans.confirmPlan(owner, group.id, plan.id);
  const before = await snapshot(group.id);
  await E.plans.runScenario(members[0], group.id, { strategy: 'fastest' });
  await E.plans.runScenario(owner, group.id, { removeParticipantIds: [members[1].id] });
  await E.plans.runScenario(owner, group.id, { addParticipants: [{ displayName: 'Guest', origin: E.metro('Kengeri') }] });
  await E.plans.runScenario(owner, group.id, { overrides: [{ participantId: members[0].id, origin: E.metro('Hoodi') }] });
  assert.equal(await snapshot(group.id), before);
  assert.equal((await E.db.query('SELECT count(*)::int c FROM what_if_scenarios WHERE group_id=$1', [group.id])).rows[0].c, 4);
});
test('scenario result is comparable to the current plan', async () => {
  const { owner, group } = await team();
  const plan = await E.plans.requestOptimization(owner, group.id);
  const s = await E.plans.runScenario(owner, group.id, { strategy: 'fastest' });
  assert.equal(s.basePlanId, plan.id); assert.equal(s.comparison.comparable, true);
  assert.equal(s.comparison.base.strategy, 'balanced'); assert.equal(s.comparison.alternative.strategy, 'fastest');
  // 'fastest' cannot have a larger total time than 'balanced'
  assert.ok(s.comparison.deltas.totalTimeMin <= 0);
  assert.ok(s.comparison.deltas.maxBurdenMin >= 0);
});
test('removing a participant changes the participant set; fewer than two is rejected', async () => {
  const { owner, members, group } = await team();
  await E.plans.requestOptimization(owner, group.id);
  const s = await E.plans.runScenario(owner, group.id, { removeParticipantIds: [members[1].id] });
  assert.equal(s.result.recommended.journeys.length, 2);
  assert.equal(await E.code(E.plans.runScenario(owner, group.id, { removeParticipantIds: [members[0].id, members[1].id] })), 'NOT_READY');
});
test('adding guests: counted, named, validated, capped at the group size limit', async () => {
  const { owner, group } = await team();
  const s = await E.plans.runScenario(owner, group.id, { addParticipants: [{ displayName: 'Guest A', origin: E.metro('Hoodi') }] });
  assert.equal(s.result.recommended.journeys.length, 4);
  assert.ok(s.result.participants.some(p => p.displayName === 'Guest A'));
  assert.equal(await E.code(E.plans.runScenario(owner, group.id, { addParticipants: [{ origin: { stationId: 'stn_nope' } }] })), 'INVALID_INPUT');
  const many = Array.from({ length: GROUP_LIMITS.max }, (_, i) => ({ displayName: 'G' + i, origin: E.metro('Hoodi') }));   // 3 members + max guests > max
  assert.equal(await E.code(E.plans.runScenario(owner, group.id, { addParticipants: many })), 'INVALID_INPUT');
});
test('changing one origin in a scenario changes that participant’s journey only in the scenario', async () => {
  const { owner, members, group } = await team();
  const plan = await E.plans.requestOptimization(owner, group.id);
  const s = await E.plans.runScenario(owner, group.id, { overrides: [{ participantId: members[0].id, origin: E.metro('Kengeri') }], strategy: 'balanced' });
  assert.notDeepEqual(s.result.recommended.metrics, plan.result.recommended.metrics);
  assert.equal(await E.code(E.plans.runScenario(owner, group.id, { overrides: [{ participantId: members[0].id, hard: { maxTravelMinutes: -5 } }] })), 'INVALID_INPUT');
});
test('hard constraints in a scenario can make it infeasible (reported, not thrown)', async () => {
  const { owner, members, group } = await team();
  const s = await E.plans.runScenario(owner, group.id, { overrides: [{ participantId: members[0].id, hard: { maxTravelMinutes: 1 } }, { participantId: members[1].id, hard: { maxTravelMinutes: 1 } }] });
  assert.equal(s.result.recommended, null);
  assert.ok(s.result.warnings.includes('NO_FEASIBLE_CANDIDATE')); assert.equal(s.comparison.comparable, false);
});
test('authorisation: only members; scenarios of other groups are invisible', async () => {
  const a = await team(), b = await team();
  const out = await E.user('Out');
  assert.equal(await E.code(E.plans.runScenario(out, a.group.id, {})), 'NOT_FOUND');
  const s = await E.plans.runScenario(a.owner, a.group.id, {});
  assert.equal(await E.code(E.plans.listScenarios(out, a.group.id)), 'NOT_FOUND');
  assert.equal(await E.code(E.plans.compareScenarios(b.owner, b.group.id, [s.scenarioId])), 'NOT_FOUND'); // other group's id
  assert.equal((await E.plans.listScenarios(a.members[0], a.group.id)).length, 1);
});
test('compare table lists current plan and several scenarios side by side', async () => {
  const { owner, group } = await team();
  await E.plans.requestOptimization(owner, group.id);
  const ids = [];
  for (const strategy of ['fastest', 'cheapest', 'fewest_transfers']) ids.push((await E.plans.runScenario(owner, group.id, { strategy })).scenarioId);
  const t = await E.plans.compareScenarios(owner, group.id, ids);
  assert.equal(t.scenarios.length, 3); assert.equal(t.current.strategy, 'balanced');
  assert.ok(t.scenarios.every(r => r.totalTimeMin > 0 && r.maxBurdenMin > 0));
  assert.equal(await E.code(E.plans.compareScenarios(owner, group.id, [])), 'INVALID_INPUT');
  assert.equal(await E.code(E.plans.compareScenarios(owner, group.id, ['bad'])), 'NOT_FOUND');
});
test('scenario without any plan still works (no comparison)', async () => {
  const { owner, group } = await team();
  const s = await E.plans.runScenario(owner, group.id, {});
  assert.equal(s.basePlanId, null); assert.equal(s.comparison.comparable, false); assert.ok(s.result.recommended);
});
test('compareResults deltas are arithmetic on the stored metrics', () => {
  const m = (max, tot, cost, ix, jain) => ({ burden: { max, range: 0, jain }, time: { total: tot }, costTotal: cost, interchangeTotal: ix });
  const c = compareResults({ strategy: 'a', recommended: { id: 1, label: 'X', metrics: m(30, 90, 50, 1, 0.9) } }, { strategy: 'b', recommended: { id: 2, label: 'Y', metrics: m(35, 80, 40, 0, 0.8) } });
  assert.deepEqual(c.deltas, { maxBurdenMin: 5, totalTimeMin: -10, rangeMin: 0, costTotal: -10, interchanges: -1, jain: -0.1 });
  assert.equal(c.recommendedChanged, true);
});
