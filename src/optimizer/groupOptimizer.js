// ═══════════════════════════════════════════════════════════
//  optimizer/groupOptimizer.js — transport-agnostic fairness optimizer
//
//  The Metro and Bike engines only supply (a) candidate locations and
//  (b) evaluate(participant, candidate) → journey. Everything else —
//  feasibility, hard constraints, group metrics, strategy ranking,
//  alternatives — is identical for both modes and is pure/deterministic.
//  No LLM, network or clock is touched here.
//
//  Journey shape (all numbers; null = unavailable, never invented):
//    { participantId, timeMin, burdenMin, cost, interchanges,
//      distanceKm, distanceIsLowerBound, detail }
//  burdenMin = timeMin + preference penalties (e.g. avoid-interchanges); fairness
//  metrics are computed on burdenMin, displayed times on timeMin.
// ═══════════════════════════════════════════════════════════
import { DomainError, ErrorCode } from '../domain/errors.js';
import { GROUP_LIMITS } from '../config/Limits.js';
import { groupMetrics, round1 } from './fairness.js';
import { STRATEGIES, Strategy, rankCandidates } from './strategies.js';

export const MIN_PARTICIPANTS = GROUP_LIMITS.min;
export const MAX_PARTICIPANTS = GROUP_LIMITS.max;

function checkConstraints(participant, journey) {
  const reasons = [];
  const h = participant.hardConstraints || {};
  if (h.maxTravelMinutes != null && journey.timeMin > h.maxTravelMinutes) reasons.push('MAX_TRAVEL_TIME');
  if (h.maxDistanceKm != null && journey.distanceKm != null && journey.distanceKm > h.maxDistanceKm) reasons.push('MAX_DISTANCE');
  return reasons;
}

export function candidateMetrics(journeys) {
  const burden = groupMetrics(journeys.map(j => j.burdenMin));
  const times = groupMetrics(journeys.map(j => j.timeMin));
  const costAvailable = journeys.every(j => j.cost != null);
  const longest = journeys.reduce((a, b) => (b.burdenMin > a.burdenMin ? b : a));
  return {
    burden, time: times,
    costTotal: costAvailable ? round1(journeys.reduce((a, j) => a + j.cost, 0)) : null,
    interchangeTotal: journeys.reduce((a, j) => a + (j.interchanges ?? 0), 0),
    longestParticipantId: longest.participantId,
  };
}

/**
 * @param {{participants:Array, candidates:Array<{id:string,label:string}>,
 *   evaluate:(p:Object,c:Object)=>(Object|null), strategy?:string, topK?:number}} args
 */
export function optimizeGroup({ participants, candidates, evaluate, strategy = Strategy.BALANCED, topK = 3 }) {
  if (!STRATEGIES.includes(strategy)) throw new DomainError(ErrorCode.INVALID_INPUT, `Unknown strategy: ${strategy}`);
  if (!Array.isArray(participants) || participants.length < MIN_PARTICIPANTS || participants.length > MAX_PARTICIPANTS) {
    throw new DomainError(ErrorCode.INVALID_INPUT, `A group needs ${MIN_PARTICIPANTS}-${MAX_PARTICIPANTS} participants.`);
  }
  const ids = participants.map(p => p.participantId);
  if (new Set(ids).size !== ids.length) throw new DomainError(ErrorCode.DUPLICATE_MEMBER, 'Duplicate participant.');

  const feasible = [], rejected = [];
  for (const cand of candidates) {
    const journeys = [];
    let reason = null;
    for (const p of participants) {
      const j = evaluate(p, cand);
      if (!j) { reason = { code: 'UNREACHABLE', participantId: p.participantId }; break; }
      const violated = checkConstraints(p, j);
      if (violated.length) { reason = { code: 'CONSTRAINT', participantId: p.participantId, constraints: violated }; break; }
      journeys.push({ ...j, participantId: p.participantId });
    }
    if (reason) { rejected.push({ id: cand.id, label: cand.label, reason }); continue; }
    feasible.push({ ...cand, journeys, metrics: candidateMetrics(journeys) });
  }

  const costAvailable = feasible.length > 0 && feasible.every(c => c.metrics.costTotal != null);
  const warnings = [];
  if (feasible.length && !costAvailable) warnings.push('COST_UNAVAILABLE');
  if (!feasible.length) return { strategy, feasibleCount: 0, ranked: [], recommended: null, alternatives: [], bestBy: {}, rejected, warnings: [...warnings, 'NO_FEASIBLE_CANDIDATE'], costAvailable };

  const ranked = rankCandidates(feasible, strategy, participants, { costAvailable });
  const bestBy = {};
  for (const s of STRATEGIES) {
    if (s === Strategy.CHEAPEST && !costAvailable) continue;
    bestBy[s] = rankCandidates(feasible, s, participants, { costAvailable })[0].id;
  }
  return {
    strategy, costAvailable, feasibleCount: feasible.length,
    recommended: ranked[0], alternatives: ranked.slice(1, 1 + topK),
    ranked, bestBy, rejected, warnings,
  };
}
