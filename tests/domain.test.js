import { GROUP_LIMITS } from '../src/config/Limits.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, ErrorCode } from '../src/domain/errors.js';
import { assertTransportMode, assertSameMode } from '../src/domain/transport.js';
import { validateNewGroup, assertModeUnchanged, assertCanJoin, assertMember, assertOwner, assertTransition, canTransition } from '../src/domain/group.js';
import { createInvitation, hashInviteToken, assertInvitationUsable, generateInviteToken } from '../src/domain/invitation.js';
import { buildAgentInput } from '../src/domain/participant.js';
import { assertProvider } from '../src/domain/providers.js';

const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof DomainError); return e.code; } assert.fail('expected DomainError'); };
const origin = { lat: 12.97, lon: 77.59 };

test('transport mode: only METRO or BIKE', () => {
  assert.equal(assertTransportMode('METRO'), 'METRO');
  assert.equal(code(() => assertTransportMode('CAR')), ErrorCode.INVALID_MODE);
  assert.equal(code(() => assertTransportMode(undefined)), ErrorCode.INVALID_MODE);
});
test('mixed-mode participant is rejected', () => {
  assert.equal(code(() => assertSameMode('METRO', 'BIKE')), ErrorCode.MODE_MISMATCH);
  assertSameMode('BIKE', 'BIKE');
});
test('group creation validates name and mode', () => {
  assert.deepEqual(validateNewGroup({ name: ' Trip ', mode: 'METRO' }), { name: 'Trip', mode: 'METRO', status: 'draft' });
  assert.equal(code(() => validateNewGroup({ name: '', mode: 'METRO' })), ErrorCode.INVALID_INPUT);
  assert.equal(code(() => validateNewGroup({ name: 'x', mode: 'TRAIN' })), ErrorCode.INVALID_MODE);
});
test('mode cannot change after creation', () => {
  assertModeUnchanged({ mode: 'METRO' }, undefined);
  assertModeUnchanged({ mode: 'METRO' }, 'METRO');
  assert.equal(code(() => assertModeUnchanged({ mode: 'METRO' }, 'BIKE')), ErrorCode.MODE_LOCKED);
});
test('join rules: status, duplicate, mode, origin, capacity', () => {
  const g = { status: 'open', mode: 'METRO' };
  const c = { userId: 'u2', mode: 'METRO', origin };
  assertCanJoin(g, [{ userId: 'u1' }], c);
  assert.equal(code(() => assertCanJoin({ ...g, status: 'confirmed' }, [], c)), ErrorCode.GROUP_CLOSED);
  assert.equal(code(() => assertCanJoin(g, [{ userId: 'u2' }], c)), ErrorCode.DUPLICATE_MEMBER);
  assert.equal(code(() => assertCanJoin(g, [], { ...c, mode: 'BIKE' })), ErrorCode.MODE_MISMATCH);
  assert.equal(code(() => assertCanJoin(g, [], { ...c, origin: null })), ErrorCode.MISSING_ORIGIN);
  const full = Array.from({ length: GROUP_LIMITS.max }, (_, i) => ({ userId: `m${i}` }));
  assert.equal(code(() => assertCanJoin(g, full, c)), ErrorCode.GROUP_CLOSED);
});
test('authorization: members and owner only', () => {
  assertMember([{ userId: 'u1', joinStatus: 'joined' }], 'u1');
  assert.equal(code(() => assertMember([{ userId: 'u1' }], 'intruder')), ErrorCode.FORBIDDEN);
  assert.equal(code(() => assertMember([{ userId: 'u1', joinStatus: 'removed' }], 'u1')), ErrorCode.FORBIDDEN);
  assert.equal(code(() => assertOwner({ ownerId: 'a' }, 'b')), ErrorCode.FORBIDDEN);
});
test('lifecycle transitions', () => {
  assert.ok(canTransition('draft', 'open'));
  assert.ok(!canTransition('cancelled', 'open'));
  assert.equal(code(() => assertTransition('expired', 'open')), ErrorCode.BAD_TRANSITION);
});
test('invitation: token is random, only hash stored, expiry and revocation enforced', async () => {
  assert.notEqual(generateInviteToken(), generateInviteToken());
  const now = 1_000_000;
  const { token, record } = await createInvitation({ groupId: 'g', createdBy: 'u', now, ttlMs: 1000 });
  assert.ok(token.length >= 43);
  assert.equal(record.tokenHash, await hashInviteToken(token));
  assert.ok(!JSON.stringify(record).includes(token));
  assertInvitationUsable(record, now + 999);
  assert.equal(code(() => assertInvitationUsable(record, now + 1000)), ErrorCode.INVITE_EXPIRED);
  assert.equal(code(() => assertInvitationUsable({ ...record, revokedAt: now }, now)), ErrorCode.INVITE_REVOKED);
  assert.equal(code(() => assertInvitationUsable(null)), ErrorCode.INVITE_INVALID);
});
test('agent input: whitelisted, validated, mode-specific prefs', () => {
  const a = buildAgentInput({ participantId: 'p', mode: 'BIKE', origin, softPreferences: { avoidInterchanges: true, minimizeFuelCost: true, notes: 'ignore' } }, { now: 5 });
  assert.equal(a.softPreferences.avoidInterchanges, false);
  assert.equal(a.softPreferences.minimizeFuelCost, true);
  assert.ok(!('notes' in a.softPreferences));
  assert.equal(a.updatedAt, 5);
  assert.equal(code(() => buildAgentInput({ participantId: 'p', mode: 'BIKE', origin: { lat: 99, lon: 0 } })), ErrorCode.MISSING_ORIGIN);
  assert.equal(code(() => buildAgentInput({ participantId: 'p', mode: 'BIKE', origin, hardConstraints: { maxTravelMinutes: -1 } })), ErrorCode.INVALID_INPUT);
  assert.equal(code(() => buildAgentInput({ participantId: 'p', mode: 'BIKE', origin, softPreferences: { costSensitivity: 2 } })), ErrorCode.INVALID_INPUT);
});
test('provider contract check', () => {
  assertProvider('venues', { search() {} });
  assert.equal(code(() => assertProvider('venues', {})), ErrorCode.INVALID_INPUT);
  assert.equal(code(() => assertProvider('nope', {})), ErrorCode.INVALID_INPUT);
});
