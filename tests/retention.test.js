import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.js';
import { createRetentionService, RETENTION } from '../src/services/retention.js';

let E, R;
before(async () => { E = await makeEnv(); R = createRetentionService({ db: E.db, clock: E.clock }); });
after(() => E.close());
const DAY = 86400e3;
const team = () => E.team({ origins: [E.metro('Whitefield'), E.metro('Challaghatta')] });
const age = (gid, days) => E.db.query(`UPDATE groups SET updated_at = $2 WHERE id = $1`, [gid, new Date(E.clock() - days * DAY)]);
const exists = async (gid) => (await E.db.query('SELECT 1 FROM groups WHERE id=$1', [gid])).rows.length === 1;

test('inactive open groups expire (invitations revoked); recent ones are untouched', async () => {
  const stale = await team(), fresh = await team();
  const inv = await E.groups.createInvitation(stale.owner, stale.group.id);
  await age(stale.group.id, RETENTION.inactiveDays + 1);
  const r = await R.runMaintenance();
  assert.ok(r.expiredGroups >= 1);
  assert.equal((await E.db.query('SELECT status FROM groups WHERE id=$1', [stale.group.id])).rows[0].status, 'expired');
  assert.equal(await E.code(E.groups.previewInvitation(inv.token)), 'INVITE_REVOKED');
  assert.equal((await E.db.query('SELECT status FROM groups WHERE id=$1', [fresh.group.id])).rows[0].status, 'open');
});
test('closed groups are deleted after the closed window with ALL their location data; confirmed groups after the longer window', async () => {
  const closed = await team(); await E.plans.requestOptimization(closed.owner, closed.group.id); await E.groups.cancelGroup(closed.owner, closed.group.id);
  const conf = await team(); const p = await E.plans.requestOptimization(conf.owner, conf.group.id); await E.plans.confirmPlan(conf.owner, conf.group.id, p.id);
  await E.db.query('UPDATE groups SET selected_plan_id=NULL WHERE id=$1', [closed.group.id]);  // simulate a cancelled group that still has plan history
  await age(closed.group.id, RETENTION.closedDays + 1); await age(conf.group.id, RETENTION.confirmedDays - 1);
  await R.runMaintenance();
  assert.equal(await exists(closed.group.id), false); assert.equal(await exists(conf.group.id), true);
  for (const t of ['group_memberships', 'meetup_plans', 'group_invitations', 'optimization_requests']) assert.equal((await E.db.query(`SELECT count(*)::int c FROM ${t} WHERE group_id=$1`, [closed.group.id])).rows[0].c, 0, `${t} purged`);
  await age(conf.group.id, RETENTION.confirmedDays + 1); await E.db.query('UPDATE groups SET selected_plan_id=NULL WHERE id=$1', [conf.group.id]);
  await R.runMaintenance(); assert.equal(await exists(conf.group.id), false);
});
test('maintenance purges expired sessions, old audit events and rate-limit rows', async () => {
  const u = await E.user('Sess');
  await E.db.query(`UPDATE sessions SET expires_at = $2 WHERE user_id=$1`, [u.id, new Date(E.clock() - DAY)]);
  await E.db.query(`INSERT INTO audit_events (event_type, created_at) VALUES ('old', $1), ('recent', $2)`, [new Date(E.clock() - 400 * DAY), new Date(E.clock())]);
  const r = await R.runMaintenance();
  assert.ok(r.deletedSessions >= 1); assert.equal(r.deletedAuditEvents, 1);
  assert.equal((await E.db.query(`SELECT count(*)::int c FROM audit_events WHERE event_type='recent'`)).rows[0].c, 1);
});
test('owner can purge a cancelled group immediately; not before cancelling; not someone else’s', async () => {
  const t = await team();
  assert.equal(await E.code(R.purgeGroup(t.owner, t.group.id)), 'CONFLICT');
  assert.equal(await E.code(R.purgeGroup(t.members[0], t.group.id)), 'NOT_FOUND');
  await E.groups.cancelGroup(t.owner, t.group.id);
  assert.equal(await E.code(R.purgeGroup(t.members[0], t.group.id)), 'NOT_FOUND');
  assert.deepEqual(await R.purgeGroup(t.owner, t.group.id), { ok: true }); assert.equal(await exists(t.group.id), false);
});
test('account deletion: needs the password, wipes starting points/sessions/profile, anonymises, cancels owned groups', async () => {
  const t = await team(); const member = t.members[0];
  assert.equal(await E.code(R.deleteAccount(member, 'wrong wrong wrong')), 'UNAUTHENTICATED');
  await R.deleteAccount(member, 'correct horse battery');
  const m = (await E.db.query('SELECT join_status, origin_lat, origin_station_id, agent_snapshot FROM group_memberships WHERE user_id=$1', [member.id])).rows[0];
  assert.deepEqual(m, { join_status: 'left', origin_lat: null, origin_station_id: null, agent_snapshot: null });
  const u = (await E.db.query('SELECT email, display_name, password_hash FROM users WHERE id=$1', [member.id])).rows[0];
  assert.match(u.email, /^deleted-.*@invalid\.example$/); assert.equal(u.display_name, 'Deleted user'); assert.equal(u.password_hash, '!');
  assert.equal((await E.db.query('SELECT count(*)::int c FROM sessions WHERE user_id=$1', [member.id])).rows[0].c, 0);
  assert.equal(await E.code(E.auth.login({ email: member.email, password: 'correct horse battery' }, { ip: 'del' })), 'UNAUTHENTICATED');
  await R.deleteAccount(t.owner, 'correct horse battery');
  assert.equal((await E.db.query('SELECT status FROM groups WHERE id=$1', [t.group.id])).rows[0].status, 'cancelled');
  assert.equal(await E.code(E.groups.getGroup(t.owner, t.group.id)), 'NOT_FOUND');
});
test('audit events never contain coordinates or secrets', async () => {
  const rows = (await E.db.query('SELECT detail FROM audit_events')).rows.map(r => JSON.stringify(r.detail)).join(' ');
  assert.ok(!/lat|lon|origin|password|token|secret/i.test(rows));
});
