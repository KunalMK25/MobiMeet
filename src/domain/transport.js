import { ErrorCode, fail } from './errors.js';

// Exactly two mutually exclusive modes (spec §1.1).
export const TransportMode = Object.freeze({ METRO: 'METRO', BIKE: 'BIKE' });
export const TRANSPORT_MODES = Object.freeze(Object.values(TransportMode));

export const isTransportMode = (m) => TRANSPORT_MODES.includes(m);

export function assertTransportMode(m) {
  if (!isTransportMode(m)) fail(ErrorCode.INVALID_MODE, 'Transport mode must be METRO or BIKE.');
  return m;
}

// Every participant must use the group's mode; mixed groups are invalid.
export function assertSameMode(groupMode, participantMode) {
  assertTransportMode(groupMode);
  assertTransportMode(participantMode);
  if (groupMode !== participantMode) {
    fail(ErrorCode.MODE_MISMATCH, 'Participant transport mode must match the group transport mode.');
  }
}
