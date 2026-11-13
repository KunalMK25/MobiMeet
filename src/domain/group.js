import { GROUP_LIMITS } from '../config/Limits.js';
import { ErrorCode, fail } from './errors.js';
import { assertTransportMode, assertSameMode } from './transport.js';

export const GroupStatus = Object.freeze({
  DRAFT: 'draft', OPEN: 'open', OPTIMIZING: 'optimizing',
  PROPOSED: 'proposed', CONFIRMED: 'confirmed', CANCELLED: 'cancelled', EXPIRED: 'expired',
});

// Allowed lifecycle transitions (spec §4.3). Terminal states have no exits.
const TRANSITIONS = {
  draft: ['open', 'cancelled'],
  open: ['optimizing', 'cancelled', 'expired'],
  optimizing: ['proposed', 'open', 'cancelled'],
  proposed: ['confirmed', 'open', 'optimizing', 'cancelled', 'expired'],
  confirmed: ['open', 'cancelled'],   // reopening creates a new plan version; never silently overwrites
  cancelled: [],
  expired: [],
};

export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

export function assertTransition(from, to) {
  if (!canTransition(from, to)) fail(ErrorCode.BAD_TRANSITION, `Cannot move group from ${from} to ${to}.`);
}

// Statuses in which new participants may join / edit inputs.
const JOINABLE = new Set(['open']);
const MAX_PARTICIPANTS = GROUP_LIMITS.max;

export function validateNewGroup(input) {
  if (!input || typeof input !== 'object') fail(ErrorCode.INVALID_INPUT, 'Group details required.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80) fail(ErrorCode.INVALID_INPUT, 'Group name must be 1-80 characters.');
  assertTransportMode(input.mode);
  return { name, mode: input.mode, status: GroupStatus.DRAFT };
}

// The mode is fixed at creation; any later change is rejected (spec §5.2).
export function assertModeUnchanged(group, requestedMode) {
  if (requestedMode !== undefined && requestedMode !== group.mode) {
    fail(ErrorCode.MODE_LOCKED, 'The transport mode of a group cannot be changed.');
  }
}

export function assertCanJoin(group, memberships, candidate) {
  if (!JOINABLE.has(group.status)) fail(ErrorCode.GROUP_CLOSED, 'This group is not accepting participants.');
  if (memberships.length >= MAX_PARTICIPANTS) fail(ErrorCode.GROUP_CLOSED, 'This group is full.');
  if (memberships.some(m => m.userId === candidate.userId)) {
    fail(ErrorCode.DUPLICATE_MEMBER, 'Already a member of this group.');
  }
  assertSameMode(group.mode, candidate.mode);
  if (!candidate.origin) fail(ErrorCode.MISSING_ORIGIN, 'An origin is required to join.');
}

// Private group data is only visible to its members (spec §15, IDOR rule).
export function assertMember(memberships, userId) {
  if (!memberships.some(m => m.userId === userId && m.joinStatus !== 'removed')) {
    fail(ErrorCode.FORBIDDEN, 'Not authorized for this group.');
  }
}
export function assertOwner(group, userId) {
  if (group.ownerId !== userId) fail(ErrorCode.FORBIDDEN, 'Only the group owner can do this.');
}
