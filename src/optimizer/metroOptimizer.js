import { DomainError, ErrorCode } from '../domain/errors.js';
import { assertSameMode, TransportMode } from '../domain/transport.js';
import { optimizeGroup } from './groupOptimizer.js';
import { createMetroEngine } from './metroEngine.js';
import { Strategy } from './strategies.js';
import { buildExplanation } from './explain.js';

export const METRO_ESTIMATE_WARNINGS = Object.freeze([
  'FARE_IS_STOP_COUNT_ESTIMATE',      // BMRCL fares are not modelled per-distance here
  'TIMES_ARE_SCHEDULE_ESTIMATES',     // flat minutes/hop + fixed transfer allowance; no live train data
  'WALKING_IS_STRAIGHT_LINE_ESTIMATE',
  'STEP_FREE_DATA_UNAVAILABLE',       // reported only when a participant requires it
]);

// participants: validated agent inputs (domain/participant.js buildAgentInput output).
export function optimizeMetroGroup(participants, { strategy = Strategy.BALANCED, now = Date.now(), topK = 3, routeStrategy = 'fastest' } = {}) {
  for (const p of participants) assertSameMode(TransportMode.METRO, p.mode);
  const engine = createMetroEngine({ now, routeStrategy });
  const result = optimizeGroup({ participants, candidates: engine.candidates, evaluate: engine.evaluate, strategy, topK });
  const warnings = [...result.warnings, 'FARE_IS_STOP_COUNT_ESTIMATE', 'TIMES_ARE_SCHEDULE_ESTIMATES'];
  if (participants.some(p => p.origin.stationId === undefined)) warnings.push('WALKING_IS_STRAIGHT_LINE_ESTIMATE');
  if (participants.some(p => p.hardConstraints?.requiresStepFreeAccess)) warnings.push('STEP_FREE_DATA_UNAVAILABLE');
  const out = { mode: TransportMode.METRO, computedFor: now, routeStrategy, ...result, warnings };
  out.explanation = result.recommended ? buildExplanation(out, participants) : null;
  return out;
}
export { DomainError, ErrorCode };
