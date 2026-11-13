// ═══════════════════════════════════════════════════════════
//  services/plans.js — optimisation requests, plan versions, confirmation,
//  venues for a plan, and WHAT-IF scenarios.
//  Invariants:
//   • Plans are append-only versions. A confirmed plan is never edited or deleted;
//     confirming a newer plan marks the old one 'superseded' (history kept).
//   • Re-optimising after confirmation creates a NEW proposed version; the confirmed
//     plan stays confirmed until the group explicitly confirms the new one.
//   • What-if scenarios are stored in their own table and never touch groups/plans.
// ═══════════════════════════════════════════════════════════
import { DomainError, ErrorCode, fail } from '../domain/errors.js';
import { GroupStatus, assertTransition } from '../domain/group.js';
import { runCoordinator, prepareParticipants, inputHash } from '../agents/coordinator.js';
import { validateStrategy, validateRouteStrategy, validateFuel, validateHard, validatePrefs, validateOriginInput, validateText, requireUuid } from './validation.js';
import { consume } from './rateLimit.js';
import { audit } from './audit.js';
import { GROUP_LIMITS } from '../config/Limits.js';
const MAX_PARTICIPANTS = GROUP_LIMITS.max;
import { emit } from './events.js';
import { EventType } from '../domain/agentIntents.js';
import { clampRadius, normalizeCategories } from '../venues/core.js';

const STUCK_AFTER_MS = 5 * 60 * 1000;
const FRESH_VENUES_MS = 24 * 60 * 60 * 1000;

const candOut = (c) => ({ id: c.id, label: c.label, areaName: c.areaName ?? null, lat: c.lat, lon: c.lon, kind: c.kind, lines: c.lines, rank: c.rank, score: c.score, scoreBreakdown: c.scoreBreakdown, metrics: c.metrics, journeys: c.journeys });
const candSummary = (c) => ({ id: c.id, label: c.label, rank: c.rank, metrics: c.metrics });

export function compactResult(coord, names) {
  const r = coord.result;
  const byId = Object.fromEntries(r.ranked.map(c => [c.id, c]));
  return {
    mode: r.mode, strategy: r.strategy, routeStrategy: r.routeStrategy ?? null, computedFor: r.computedFor, feasibleCount: r.feasibleCount, costAvailable: r.costAvailable,
    recommended: r.recommended ? candOut(r.recommended) : null, alternatives: r.alternatives.map(candOut),
    ranking: r.ranked.slice(0, 10).map(candSummary),
    bestBy: Object.fromEntries(Object.entries(r.bestBy).map(([k, id]) => [k, candSummary(byId[id])])),
    rejectedCount: r.rejected.length, rejectedSample: r.rejected.slice(0, 20),
    warnings: r.warnings, explanation: r.explanation, routing: r.routing ?? null, fuelAssumptions: r.fuelAssumptions ?? null,
    participants: Object.entries(names).map(([userId, displayName]) => ({ userId, displayName })),
  };
}

export function compareResults(base, alt) {
  if (!base?.recommended || !alt?.recommended) return { comparable: false };
  const b = base.recommended.metrics, a = alt.recommended.metrics;
  const d = (x, y) => (x == null || y == null ? null : Math.round((x - y) * 10) / 10);
  return {
    comparable: true, recommendedChanged: base.recommended.id !== alt.recommended.id,
    base: { label: base.recommended.label, strategy: base.strategy }, alternative: { label: alt.recommended.label, strategy: alt.strategy },
    deltas: { maxBurdenMin: d(a.burden.max, b.burden.max), totalTimeMin: d(a.time.total, b.time.total), rangeMin: d(a.burden.range, b.burden.range),
      costTotal: d(a.costTotal, b.costTotal), interchanges: a.interchangeTotal - b.interchangeTotal, jain: Math.round((a.burden.jain - b.burden.jain) * 1000) / 1000 },
  };
}

export function createPlanService({ db, clock = Date.now, groups, providers = {}, venues = null, geocoder = null }) {
  const names = (members) => Object.fromEntries(members.filter(m => m.joinStatus === 'joined').map(m => [m.userId, m.displayName]));
  const planRow = (r) => ({ id: r.id, groupId: r.group_id, version: r.version, status: r.status, strategy: r.strategy, inputHash: r.input_hash, result: r.result, createdBy: r.created_by, confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at, createdAt: r.created_at });

  return {
    async requestOptimization(user, groupId, { strategy, fuel, routeStrategy } = {}) {
      await consume(db, { key: `optimize:${user.id}`, limit: 20, windowSec: 600, now: clock() });
      const strat = validateStrategy(strategy);
      const fuelCfg = validateFuel(fuel);
      const routeStrat = validateRouteStrategy(routeStrategy);
      // 1) claim the group (short transaction)
      const claim = await db.tx(async (t) => {
        const { group, me } = await groups.loadForMember(t, user.id, groupId, { lock: true });
        if (me.role !== 'owner') fail(ErrorCode.FORBIDDEN, 'Only the group owner can request optimisation.');
        if ([GroupStatus.DRAFT, GroupStatus.CANCELLED, GroupStatus.EXPIRED].includes(group.status)) fail(ErrorCode.NOT_READY, 'This group is not ready for optimisation.');
        if (group.status === GroupStatus.OPTIMIZING) {
          const run = (await t.query(`SELECT created_at FROM optimization_requests WHERE group_id=$1 AND status='running' ORDER BY created_at DESC LIMIT 1`, [group.id])).rows[0];
          if (run && clock() - new Date(run.created_at).getTime() < STUCK_AFTER_MS) fail(ErrorCode.CONFLICT, 'An optimisation is already running.');
        } else {
          if (group.status === GroupStatus.CONFIRMED) { assertTransition(group.status, GroupStatus.OPEN); await t.query(`UPDATE groups SET status='open' WHERE id=$1`, [group.id]); group.status = GroupStatus.OPEN; }
          assertTransition(group.status, GroupStatus.OPTIMIZING);
          await t.query(`UPDATE groups SET status='optimizing', updated_at=now() WHERE id=$1`, [group.id]);
        }
        const members = await groups.loadMembers(t, group.id);
        const req = (await t.query(`INSERT INTO optimization_requests (group_id, requested_by, strategy, input_hash, status) VALUES ($1,$2,$3,'pending','running') RETURNING id`, [group.id, user.id, strat])).rows[0];
        return { group, members, requestId: req.id };
      });

      // 2) compute outside any transaction (may call external routing)
      let coord;
      try {
        coord = await runCoordinator({ group: claim.group, members: claim.members, strategy: strat, routeStrategy: routeStrat, fuel: claim.group.mode === 'BIKE' ? fuelCfg : null, providers, now: clock(), names: names(claim.members) });
      } catch (e) {
        await db.tx(async (t) => {
          await t.query(`UPDATE optimization_requests SET status='failed', error_code=$2, finished_at=now() WHERE id=$1`, [claim.requestId, e.code ?? 'INTERNAL']);
          await t.query(`UPDATE groups SET status=$2, updated_at=now() WHERE id=$1 AND status='optimizing'`, [claim.group.id, GroupStatus.OPEN]);
          await audit(t, { actorId: user.id, groupId: claim.group.id, type: 'optimization.failed', detail: { code: e.code ?? 'INTERNAL' } });
        });
        throw e;
      }

      // Friendly area name for a Bike meetup point (one reverse lookup; failure is non-fatal).
      const rec0 = coord.result.recommended;
      if (geocoder && claim.group.mode === 'BIKE' && rec0) { try { rec0.areaName = (await geocoder.reverse(rec0.lat, rec0.lon)).areaName; } catch { /* keep coordinates */ } }

      // 3) persist the new version
      return db.tx(async (t) => {
        const result = compactResult(coord, names(claim.members));
        const v = (await t.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM meetup_plans WHERE group_id=$1', [claim.group.id])).rows[0].v;
        const plan = planRow((await t.query(
          `INSERT INTO meetup_plans (group_id, request_id, version, strategy, input_hash, result, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [claim.group.id, claim.requestId, v, strat, coord.inputHash, JSON.stringify(result), user.id])).rows[0]);
        await t.query(`UPDATE optimization_requests SET status='succeeded', input_hash=$2, finished_at=now() WHERE id=$1`, [claim.requestId, coord.inputHash]);
        const next = result.recommended ? GroupStatus.PROPOSED : GroupStatus.OPEN;
        await t.query(`UPDATE groups SET status=$2, selected_plan_id=$3, updated_at=now() WHERE id=$1`, [claim.group.id, next, result.recommended ? plan.id : null]);
        if (result.recommended) await emit(t, { groupId: claim.group.id, type: EventType.PLAN_PROPOSED, payload: { version: v } });
        await audit(t, { actorId: user.id, groupId: claim.group.id, type: 'optimization.succeeded', detail: { version: v, strategy: strat } });
        return plan;
      });
    },

    async confirmPlan(user, groupId, planId) {
      return db.tx(async (t) => {
        const { group, me } = await groups.loadForMember(t, user.id, groupId, { lock: true });
        if (me.role !== 'owner') fail(ErrorCode.FORBIDDEN, 'Only the group owner can confirm a plan.');
        const plan = (await t.query('SELECT * FROM meetup_plans WHERE id=$1 AND group_id=$2 FOR UPDATE', [requireUuid(planId, 'Plan'), group.id])).rows[0];
        if (!plan) fail(ErrorCode.NOT_FOUND, 'Plan not found.');
        if (plan.status !== 'proposed') fail(ErrorCode.CONFLICT, 'Only a proposed plan can be confirmed.');
        if (group.selectedPlanId !== plan.id || group.status !== GroupStatus.PROPOSED) fail(ErrorCode.CONFLICT, 'This plan is no longer current. Re-run the optimisation.');
        const members = await groups.loadMembers(t, group.id);
        const parts = prepareParticipants(group, members, { now: 0 });
        const fresh = inputHash({ mode: group.mode, strategy: plan.strategy, participants: parts, fuel: group.mode === 'BIKE' ? plan.result.fuelAssumptions ?? null : null, routeStrategy: plan.result.routeStrategy ?? 'fastest' });
        if (fresh !== plan.input_hash) fail(ErrorCode.CONFLICT, 'Participant inputs changed since this plan was computed. Re-run the optimisation.');
        const prev = (await t.query(`SELECT id FROM meetup_plans WHERE group_id=$1 AND status='confirmed' FOR UPDATE`, [group.id])).rows[0];
        if (prev) await t.query(`UPDATE meetup_plans SET status='superseded' WHERE id=$1`, [prev.id]);
        assertTransition(group.status, GroupStatus.CONFIRMED);
        const done = planRow((await t.query(`UPDATE meetup_plans SET status='confirmed', confirmed_by=$2, confirmed_at=$3, supersedes_plan_id=$4 WHERE id=$1 RETURNING *`, [plan.id, user.id, new Date(clock()), prev?.id ?? null])).rows[0]);
        await t.query(`UPDATE groups SET status='confirmed', selected_plan_id=$2, updated_at=now() WHERE id=$1`, [group.id, plan.id]);
        await emit(t, { groupId: group.id, type: EventType.PLAN_CONFIRMED, payload: { version: plan.version } });
        await audit(t, { actorId: user.id, groupId: group.id, type: 'plan.confirmed', detail: { version: plan.version } });
        return done;
      });
    },

    async listPlans(user, groupId) {
      return db.tx(async (t) => {
        const { group } = await groups.loadForMember(t, user.id, groupId);
        const rows = (await t.query('SELECT id, version, status, strategy, created_at, confirmed_at, result->\'recommended\'->>\'label\' AS recommended FROM meetup_plans WHERE group_id=$1 ORDER BY version DESC', [group.id])).rows;
        return rows.map(r => ({ id: r.id, version: r.version, status: r.status, strategy: r.strategy, recommended: r.recommended, createdAt: r.created_at, confirmedAt: r.confirmed_at, isSelected: r.id === group.selectedPlanId }));
      });
    },

    async getPlan(user, groupId, planId) {
      return db.tx(async (t) => {
        const { group } = await groups.loadForMember(t, user.id, groupId);
        const id = planId ? requireUuid(planId, 'Plan') : group.selectedPlanId;
        if (!id) fail(ErrorCode.NOT_FOUND, 'No plan yet.');
        const r = (await t.query('SELECT * FROM meetup_plans WHERE id=$1 AND group_id=$2', [id, group.id])).rows[0];
        if (!r) fail(ErrorCode.NOT_FOUND, 'Plan not found.');
        return planRow(r);
      });
    },

    // Venues around the plan's meetup point (cached per plan for 24 h; refresh=true forces a lookup).
    async getPlanVenues(user, groupId, planId, { refresh = false, categories = ['all'], radiusKm } = {}) {
      if (!venues) fail(ErrorCode.PROVIDER_UNAVAILABLE, 'Venue discovery is not configured.');
      const plan = await this.getPlan(user, groupId, planId);
      const rec = plan.result.recommended;
      if (!rec) fail(ErrorCode.NOT_FOUND, 'This plan has no recommended location.');
      const cats = normalizeCategories(Array.isArray(categories) ? categories.filter(c => typeof c === 'string').slice(0, 12) : ['all']);
      const radius = clampRadius(radiusKm, clampRadius(venues.defaultRadiusKm));
      const cached = (await db.query('SELECT * FROM plan_venues WHERE plan_id=$1', [plan.id])).rows[0];
      const sameQuery = cached && JSON.stringify(cached.venues.categories) === JSON.stringify(cats) && cached.venues.radiusKm === radius;
      // A stored list is reused for 24 h — but never one that came from the offline snapshot (retry live data instead).
      if (sameQuery && !refresh && cached.venues.provenance !== 'snapshot' && clock() - new Date(cached.fetched_at).getTime() < FRESH_VENUES_MS) return { ...cached.venues, cachedFromDatabase: true, storedAt: cached.fetched_at };
      const out = await venues.search({ mode: plan.result.mode, lat: rec.lat, lon: rec.lon, stationKey: plan.result.mode === 'METRO' ? rec.label : null }, { radiusKm: radius, categories: cats, refresh });
      const payload = { ...out, categories: cats, planId: plan.id };
      await db.query(`INSERT INTO plan_venues (plan_id, source, is_fallback, venues, fetched_at) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (plan_id) DO UPDATE SET source=$2, is_fallback=$3, venues=$4, fetched_at=$5`, [plan.id, out.source, out.isFallback, JSON.stringify(payload), new Date(clock())]);
      return payload;
    },

    // ── what-if ──────────────────────────────────────────
    async runScenario(user, groupId, def = {}) {
      await consume(db, { key: `whatif:${user.id}`, limit: 30, windowSec: 600, now: clock() });
      const { group, members, basePlan } = await db.tx(async (t) => {
        const { group } = await groups.loadForMember(t, user.id, groupId);
        if ([GroupStatus.CANCELLED, GroupStatus.EXPIRED].includes(group.status)) fail(ErrorCode.GROUP_CLOSED, 'This group is closed.');
        const members = await groups.loadMembers(t, group.id);
        const bp = group.selectedPlanId ? (await t.query('SELECT * FROM meetup_plans WHERE id=$1', [group.selectedPlanId])).rows[0] : null;
        return { group, members, basePlan: bp && planRow(bp) };
      });
      const strategy = validateStrategy(def.strategy ?? basePlan?.strategy);
      const fuel = validateFuel(def.fuel ?? (group.mode === 'BIKE' ? basePlan?.result?.fuelAssumptions : undefined));
      const routeStrategy = validateRouteStrategy(def.routeStrategy ?? basePlan?.result?.routeStrategy);
      const remove = new Set((def.removeParticipantIds ?? []).map(String));
      const overrides = new Map((def.overrides ?? []).map(o => [String(o.participantId), o]));
      let hypo = members.filter(m => m.joinStatus === 'joined' && !remove.has(m.userId)).map(m => {
        const o = overrides.get(m.userId); if (!o) return m;
        const origin = o.origin !== undefined ? validateOriginInput(o.origin, { mode: group.mode }) : null;
        return { ...m, ...(origin ? { originLat: origin.lat, originLon: origin.lon, originStationId: origin.stationId ?? null, originLabel: origin.label ?? null } : {}),
          softPrefs: o.softPrefs !== undefined ? validatePrefs(o.softPrefs) : m.softPrefs, hardConstraints: o.hard !== undefined ? validateHard(o.hard) : m.hardConstraints };
      });
      (def.addParticipants ?? []).forEach((a, i) => {
        const o = validateOriginInput(a.origin, { mode: group.mode });
        hypo.push({ userId: `hypothetical-${i + 1}`, joinStatus: 'joined', transportMode: group.mode, originLat: o.lat, originLon: o.lon, originStationId: o.stationId ?? null,
          softPrefs: validatePrefs(a.softPrefs ?? {}), hardConstraints: validateHard(a.hard ?? {}), agentVersion: 1, displayName: validateText(a.displayName ?? `Guest ${i + 1}`, { max: 40, what: 'Guest name' }) });
      });
      if (hypo.length > MAX_PARTICIPANTS || (def.addParticipants?.length ?? 0) > MAX_PARTICIPANTS - 1) fail(ErrorCode.INVALID_INPUT, `A scenario supports at most ${MAX_PARTICIPANTS} participants.`);
      const coord = await runCoordinator({ group, members: hypo, strategy, routeStrategy, fuel: group.mode === 'BIKE' ? fuel : null, providers, now: clock(), names: names(hypo) });
      const result = compactResult(coord, names(hypo));
      const comparison = compareResults(basePlan?.result, result);
      const stored = (await db.query(`INSERT INTO what_if_scenarios (group_id, created_by, base_plan_id, definition, result) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
        [group.id, user.id, basePlan?.id ?? null, JSON.stringify({ strategy, removeParticipantIds: [...remove], overrides: [...overrides.keys()], addCount: def.addParticipants?.length ?? 0 }), JSON.stringify({ result, comparison })])).rows[0];
      await audit(db, { actorId: user.id, groupId: group.id, type: 'whatif.run' });
      return { scenarioId: stored.id, createdAt: stored.created_at, result, comparison, basePlanId: basePlan?.id ?? null };
    },

    async listScenarios(user, groupId) {
      return db.tx(async (t) => {
        const { group } = await groups.loadForMember(t, user.id, groupId);
        const rows = (await t.query('SELECT id, created_by, base_plan_id, definition, result, created_at FROM what_if_scenarios WHERE group_id=$1 ORDER BY created_at DESC LIMIT 50', [group.id])).rows;
        return rows.map(r => ({ id: r.id, createdBy: r.created_by, basePlanId: r.base_plan_id, definition: r.definition, createdAt: r.created_at,
          recommended: r.result.result.recommended?.label ?? null, strategy: r.result.result.strategy, comparison: r.result.comparison }));
      });
    },

    async compareScenarios(user, groupId, ids) {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5) fail(ErrorCode.INVALID_INPUT, 'Provide 1-5 scenario ids.');
      return db.tx(async (t) => {
        const { group } = await groups.loadForMember(t, user.id, groupId);
        const rows = (await t.query('SELECT id, result FROM what_if_scenarios WHERE group_id=$1 AND id = ANY($2::uuid[])', [group.id, ids.map(i => requireUuid(i, 'Scenario'))])).rows;
        if (rows.length !== new Set(ids).size) fail(ErrorCode.NOT_FOUND, 'Scenario not found.');
        const basePlan = group.selectedPlanId ? (await t.query('SELECT result FROM meetup_plans WHERE id=$1', [group.selectedPlanId])).rows[0] : null;
        const row = (r) => { const x = r.result.result; const m = x.recommended?.metrics; return { id: r.id, strategy: x.strategy, recommended: x.recommended?.label ?? null, maxBurdenMin: m?.burden.max ?? null, totalTimeMin: m?.time.total ?? null, costTotal: m?.costTotal ?? null, interchanges: m?.interchangeTotal ?? null, jain: m?.burden.jain ?? null }; };
        const bm = basePlan?.result.recommended?.metrics;
        return { current: basePlan ? { recommended: basePlan.result.recommended?.label, strategy: basePlan.result.strategy, maxBurdenMin: bm?.burden.max, totalTimeMin: bm?.time.total, costTotal: bm?.costTotal, interchanges: bm?.interchangeTotal, jain: bm?.burden.jain } : null, scenarios: rows.map(row) };
      });
    },
  };
}
export { DomainError };
