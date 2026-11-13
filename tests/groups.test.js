import { GROUP_LIMITS } from '../src/config/Limits.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb as createPgliteDb } from './testdb.js';
import { migrate } from '../src/db/migrate.js';
import { createAuthService } from '../src/services/auth.js';
import { createGroupService } from '../src/services/groups.js';
import { DomainError } from '../src/domain/errors.js';
import { stationIdFor } from '../src/data/station-ids.js';

let db, auth, groups, now = Date.parse('2026-11-13T10:00:00Z'), seq = 0;
before(async () => { db = await createPgliteDb(); await migrate(db); const clock = () => now; auth = createAuthService({ db, clock }); groups = createGroupService({ db, clock }); });
after(() => db.close());
const code = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof DomainError, String(e.stack)); return e.code; } assert.fail('expected rejection'); };
const user = async (name) => (await auth.register({ email: `${name}${++seq}@example.test`, password: 'correct horse battery', displayName: name }, { ip: `g${seq}` })).user;
const metroOrigin = (name) => ({ stationId: stationIdFor(name) });
const bikeOrigin = { lat: 12.95, lon: 77.6 };
const ready = async (mode = 'METRO') => {
  const owner = await user('Owner');
  const g = await groups.createGroup(owner, { name: 'Trip', mode, origin: mode === 'METRO' ? metroOrigin('Majestic') : bikeOrigin });
  return { owner, g };
};
const join = async (g, owner, who, origin) => {
  const inv = await groups.createInvitation(owner, g.id);
  return { inv, view: await groups.joinWithToken(who, inv.token, { origin }, { ip: 'j' + ++seq }) };
};

test('group without an owner origin stays draft; with origin it opens', async () => {
  const o = await user('O');
  const d = await groups.createGroup(o, { name: 'Draft', mode: 'BIKE' });
  assert.equal(d.status, 'draft');
  assert.equal(await code(groups.createInvitation(o, d.id)), 'NOT_READY');
  const opened = await groups.updateMyInput(o, d.id, { origin: bikeOrigin });
  assert.equal(opened.status, 'open');
  assert.ok((await groups.createInvitation(o, d.id)).token);
});
test('group creation validates name and mode; mode is locked afterwards', async () => {
  const o = await user('O');
  assert.equal(await code(groups.createGroup(o, { name: '', mode: 'METRO' })), 'INVALID_INPUT');
  assert.equal(await code(groups.createGroup(o, { name: 'x', mode: 'CAR' })), 'INVALID_MODE');
  const { owner, g } = await ready();
  assert.equal(await code(groups.updateGroup(owner, g.id, { mode: 'BIKE' })), 'MODE_LOCKED');
  assert.equal((await groups.updateGroup(owner, g.id, { name: 'Renamed', mode: 'METRO' })).name, 'Renamed');
});
test('invitation token: shown once, only a hash is stored, preview leaks name+mode only', async () => {
  const { owner, g } = await ready();
  const inv = await groups.createInvitation(owner, g.id);
  const stored = (await db.query('SELECT token_hash FROM group_invitations WHERE id=$1', [inv.invitationId])).rows[0].token_hash;
  assert.notEqual(stored, inv.token); assert.equal(stored.length, 64);
  assert.deepEqual(await groups.previewInvitation(inv.token), { groupName: 'Trip', mode: 'METRO', namedSeats: false, participants: [] });
  assert.ok(!JSON.stringify(await groups.listInvitations(owner, g.id)).includes(inv.token));
});
test('join: valid invitation adds a member; duplicate join and wrong-mode join are rejected', async () => {
  const { owner, g } = await ready();
  const friend = await user('Friend');
  const { inv, view } = await join(g, owner, friend, metroOrigin('Whitefield'));
  assert.equal(view.members.length, 2);
  assert.equal(await code(groups.joinWithToken(friend, inv.token, { origin: metroOrigin('Whitefield') }, { ip: 'd' })), 'DUPLICATE_MEMBER');
  const other = await user('Other');
  assert.equal(await code(groups.joinWithToken(other, inv.token, { mode: 'BIKE', origin: metroOrigin('Whitefield') }, { ip: 'm' })), 'MODE_MISMATCH');
  assert.equal(await code(groups.joinWithToken(other, inv.token, {}, { ip: 'n' })), 'MISSING_ORIGIN');
  assert.equal(await code(groups.joinWithToken(other, inv.token, { origin: { stationId: 'stn_nope' } }, { ip: 'o' })), 'INVALID_INPUT');
});
test('Metro group rejects a Pink Phase 2 (underground, unopened) station but accepts a Phase 1 station', async () => {
  const { owner, g } = await ready();
  const inv = await groups.createInvitation(owner, g.id);
  assert.equal(await code(groups.joinWithToken(await user('P'), inv.token, { origin: { stationId: stationIdFor('Dairy Circle') } }, { ip: 'p' })), 'INVALID_INPUT');   // Phase 2: not operational
  assert.equal((await groups.joinWithToken(await user('P1'), inv.token, { origin: { stationId: stationIdFor('Kalena Agrahara') } }, { ip: 'p1' })).members.length, 2);   // Phase 1: operational
});
test('invalid, expired, revoked and used-up invitations are rejected', async () => {
  const { owner, g } = await ready();
  assert.equal(await code(groups.previewInvitation('x'.repeat(43))), 'INVITE_INVALID');
  assert.equal(await code(groups.joinWithToken(await user('A'), 'short', { origin: bikeOrigin }, { ip: 'a1' })), 'INVITE_INVALID');
  const exp = await groups.createInvitation(owner, g.id, { ttlHours: 1 });
  now += 3600e3 + 1;
  assert.equal(await code(groups.previewInvitation(exp.token)), 'INVITE_EXPIRED');
  assert.equal(await code(groups.joinWithToken(await user('B'), exp.token, { origin: metroOrigin('Majestic') }, { ip: 'a2' })), 'INVITE_EXPIRED');
  const rev = await groups.createInvitation(owner, g.id);
  await groups.revokeInvitation(owner, g.id, rev.invitationId);
  assert.equal(await code(groups.joinWithToken(await user('C'), rev.token, { origin: metroOrigin('Majestic') }, { ip: 'a3' })), 'INVITE_REVOKED');
  const once = await groups.createInvitation(owner, g.id, { maxUses: 1 });
  await groups.joinWithToken(await user('D'), once.token, { origin: metroOrigin('Majestic') }, { ip: 'a4' });
  assert.equal(await code(groups.joinWithToken(await user('E'), once.token, { origin: metroOrigin('Majestic') }, { ip: 'a5' })), 'INVITE_INVALID');
  assert.equal(await code(groups.createInvitation(owner, g.id, { ttlHours: 1000 })), 'INVALID_INPUT');
  assert.equal(await code(groups.createInvitation(owner, g.id, { maxUses: 0 })), 'INVALID_INPUT');
});
test('IDOR: non-members cannot read, join-by-id, modify, invite, or remove — and cannot tell the group exists', async () => {
  const { owner, g } = await ready();
  const stranger = await user('Stranger');
  for (const fn of [() => groups.getGroup(stranger, g.id), () => groups.updateGroup(stranger, g.id, { name: 'x' }), () => groups.updateMyInput(stranger, g.id, { origin: bikeOrigin }),
    () => groups.createInvitation(stranger, g.id), () => groups.listInvitations(stranger, g.id), () => groups.removeMember(stranger, g.id, owner.id), () => groups.cancelGroup(stranger, g.id), () => groups.leaveGroup(stranger, g.id)]) {
    assert.equal(await code(fn()), 'NOT_FOUND');
  }
  assert.equal(await code(groups.getGroup(stranger, '00000000-0000-4000-8000-000000000000')), 'NOT_FOUND'); // same answer as a real group
  assert.equal(await code(groups.getGroup(stranger, 'not-a-uuid')), 'NOT_FOUND');
});
test('members are not owners: owner-only actions are FORBIDDEN for plain members', async () => {
  const { owner, g } = await ready();
  const m = await user('Member'); await join(g, owner, m, metroOrigin('Whitefield'));
  for (const fn of [() => groups.createInvitation(m, g.id), () => groups.listInvitations(m, g.id), () => groups.updateGroup(m, g.id, { name: 'x' }), () => groups.removeMember(m, g.id, owner.id), () => groups.cancelGroup(m, g.id)]) {
    assert.equal(await code(fn()), 'FORBIDDEN');
  }
  assert.equal(await code(groups.leaveGroup(owner, g.id)), 'FORBIDDEN');
});
test('privacy: a member never receives other members’ origins, labels or preferences', async () => {
  const { owner, g } = await ready('BIKE');
  const m = await user('Member'); await join(g, owner, m, { lat: 12.91234, lon: 77.55678, label: 'My secret home' });
  const mine = await groups.getGroup(m, g.id), theirs = await groups.getGroup(owner, g.id);
  const ownerRowSeenByM = mine.members.find(x => x.role === 'owner');
  assert.equal(ownerRowSeenByM.origin, undefined); assert.equal(ownerRowSeenByM.hasOrigin, true);
  assert.ok(mine.members.find(x => x.isMe).origin.lat);
  const blob = JSON.stringify(theirs);
  assert.ok(!blob.includes('12.91234') && !blob.includes('77.55678') && !blob.includes('My secret home'));
});
test('input updates bump the agent version and store a validated snapshot', async () => {
  const { owner, g } = await ready();
  const before = (await db.query('SELECT agent_version FROM group_memberships WHERE user_id=$1', [owner.id])).rows[0].agent_version;
  await groups.updateMyInput(owner, g.id, { softPrefs: { avoidInterchanges: true } });
  const row = (await db.query('SELECT agent_version, agent_snapshot FROM group_memberships WHERE user_id=$1', [owner.id])).rows[0];
  assert.equal(row.agent_version, before + 1); assert.equal(row.agent_snapshot.softPreferences.avoidInterchanges, true);
  assert.equal(await code(groups.updateMyInput(owner, g.id, { softPrefs: { costSensitivity: 9 } })), 'INVALID_INPUT');
  assert.equal(await code(groups.updateMyInput(owner, g.id, { mode: 'BIKE' })), 'MODE_MISMATCH');
});
test('leave, remove, no rejoin after removal; the group size limit', async () => {
  const { owner, g } = await ready();
  const a = await user('A'), b = await user('B');
  await join(g, owner, a, metroOrigin('Whitefield')); await join(g, owner, b, metroOrigin('Kengeri'));
  await groups.leaveGroup(a, g.id);
  assert.equal(await code(groups.getGroup(a, g.id)), 'NOT_FOUND');
  assert.equal((await join(g, owner, a, metroOrigin('Hoodi'))).view.members.length, 3); // can rejoin after leaving
  await groups.removeMember(owner, g.id, b.id);
  const inv = await groups.createInvitation(owner, g.id);
  assert.equal(await code(groups.joinWithToken(b, inv.token, { origin: metroOrigin('Kengeri') }, { ip: 'rj' })), 'FORBIDDEN');
  assert.equal(await code(groups.removeMember(owner, g.id, owner.id)), 'INVALID_INPUT');
  const max = GROUP_LIMITS.max, filler = await groups.createInvitation(owner, g.id, { maxUses: 50 });
  for (let i = 0; (await groups.getGroup(owner, g.id)).members.length < max; i++) await groups.joinWithToken(await user('F' + i), filler.token, { origin: metroOrigin('Majestic') }, { ip: 'c' + i });
  assert.equal((await groups.getGroup(owner, g.id)).members.length, max);
  assert.equal(await code(groups.joinWithToken(await user('Extra'), filler.token, { origin: metroOrigin('Majestic') }, { ip: 'cX' })), 'GROUP_CLOSED');
});
test('cancel closes the group and revokes every invitation', async () => {
  const { owner, g } = await ready();
  const inv = await groups.createInvitation(owner, g.id);
  await groups.cancelGroup(owner, g.id);
  assert.equal(await code(groups.previewInvitation(inv.token)), 'INVITE_REVOKED');
  assert.equal(await code(groups.updateMyInput(owner, g.id, { softPrefs: {} })), 'GROUP_CLOSED');
  assert.equal(await code(groups.cancelGroup(owner, g.id)), 'BAD_TRANSITION');
});
test('listGroups returns only my groups', async () => {
  const { owner } = await ready(); const x = await user('X');
  assert.ok((await groups.listGroups(owner)).length >= 1); assert.equal((await groups.listGroups(x)).length, 0);
});
