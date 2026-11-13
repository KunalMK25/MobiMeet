// ═══════════════════════════════════════════════════════════
//  agents/participantAgent.js — the logical agent for ONE participant
//
//  A deterministic component (no LLM required). It receives only the
//  membership's authorised group-specific inputs — never the user's profile,
//  other members' data, or free-form text — and produces the validated,
//  versioned structure the coordinator hands to the optimiser.
//  Optional LLM-assisted preference parsing (ai/preferenceParser.js) runs BEFORE
//  this stage and can only produce whitelisted numeric/boolean fields.
// ═══════════════════════════════════════════════════════════
import { buildAgentInput } from '../domain/participant.js';
import { DomainError, ErrorCode } from '../domain/errors.js';

export const COST_FOCUS_FLOOR = 0.8; // minimizeFuelCost raises the participant's cost sensitivity to at least this

// membership: {userId, transportMode, originLat, originLon, originStationId, softPrefs, hardConstraints, agentVersion}
export function buildParticipantAgent(membership, { now = Date.now() } = {}) {
  if (membership.originLat == null || membership.originLon == null) {
    throw new DomainError(ErrorCode.MISSING_ORIGIN, 'Participant has not provided an origin.');
  }
  const soft = { ...(membership.softPrefs || {}) };
  if (membership.transportMode === 'BIKE' && soft.minimizeFuelCost) {
    soft.costSensitivity = Math.max(soft.costSensitivity ?? 0.5, COST_FOCUS_FLOOR);
  }
  const origin = { lat: membership.originLat, lon: membership.originLon, ...(membership.originStationId && membership.transportMode === 'METRO' ? { stationId: membership.originStationId } : {}) };
  const input = buildAgentInput({
    participantId: membership.userId, mode: membership.transportMode, origin,
    hardConstraints: membership.hardConstraints || {}, softPreferences: soft,
    version: Math.max(1, membership.agentVersion || 1),
  }, { now });
  // Data completeness: origin is mandatory; stated preferences and constraints make the agent better informed.
  const stated = Object.keys(soft).length + Object.keys(membership.hardConstraints || {}).length;
  input.dataCompleteness = stated > 0 ? 1 : 0.6;
  return input;
}
