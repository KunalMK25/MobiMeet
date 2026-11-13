import { ErrorCode, fail } from './errors.js';
import { assertTransportMode } from './transport.js';

// Structured, validated participant-agent input (spec §9.3). Free-form text
// never reaches the optimizer: only whitelisted, typed fields survive.
const inRange = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

export function validateOrigin(o) {
  if (!o || !inRange(o.lat, -90, 90) || !inRange(o.lon, -180, 180)) {
    fail(ErrorCode.MISSING_ORIGIN, 'A valid origin (lat/lon) is required.');
  }
  return { lat: o.lat, lon: o.lon, ...(typeof o.stationId === 'string' ? { stationId: o.stationId } : {}) };
}

const optionalPositive = (v, name) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(ErrorCode.INVALID_INPUT, `${name} must be a positive number.`);
  return v;
};
const sensitivity = (v, name) => {
  if (v === undefined) return 0.5;
  if (!inRange(v, 0, 1)) fail(ErrorCode.INVALID_INPUT, `${name} must be between 0 and 1.`);
  return v;
};

export function buildAgentInput(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') fail(ErrorCode.INVALID_INPUT, 'Participant input required.');
  if (typeof raw.participantId !== 'string' || !raw.participantId) fail(ErrorCode.INVALID_INPUT, 'participantId required.');
  assertTransportMode(raw.mode);
  const hard = raw.hardConstraints || {};
  const soft = raw.softPreferences || {};
  const input = {
    participantId: raw.participantId,
    mode: raw.mode,
    origin: validateOrigin(raw.origin),
    hardConstraints: {
      maxTravelMinutes: optionalPositive(hard.maxTravelMinutes, 'maxTravelMinutes'),
      maxDistanceKm: optionalPositive(hard.maxDistanceKm, 'maxDistanceKm'),
      requiresStepFreeAccess: hard.requiresStepFreeAccess === true,
    },
    softPreferences: {
      costSensitivity: sensitivity(soft.costSensitivity, 'costSensitivity'),
      timeSensitivity: sensitivity(soft.timeSensitivity, 'timeSensitivity'),
      // Metro-only / Bike-only preferences are ignored for the other mode.
      avoidInterchanges: raw.mode === 'METRO' ? soft.avoidInterchanges === true : false,
      minimizeFuelCost: raw.mode === 'BIKE' ? soft.minimizeFuelCost === true : false,
    },
    version: Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    updatedAt: now,
  };
  input.dataCompleteness = 1; // origin validated above; extended as optional fields are added
  return input;
}
