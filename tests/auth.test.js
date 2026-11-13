import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb as createPgliteDb } from './testdb.js';
import { migrate } from '../src/db/migrate.js';
import { createAuthService, SESSION_TTL_MS } from '../src/services/auth.js';
import { hashPassword, verifyPassword } from '../src/services/crypto.js';
import { DomainError } from '../src/domain/errors.js';

let db, auth, now = Date.parse('2026-11-13T10:00:00Z');
before(async () => { db = await createPgliteDb(); await migrate(db); auth = createAuthService({ db, clock: () => now }); });
after(() => db.close());
const code = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof DomainError, String(e)); return e.code; } assert.fail('expected rejection'); };
const reg = (n = 1, extra = {}) => auth.register({ email: `user${n}@example.test`, password: 'correct horse battery', displayName: `User ${n}`, ...extra }, { ip: `ip${n}` });

test('passwords are hashed with scrypt, salted, and verified in constant shape', async () => {
  const a = await hashPassword('secret-passphrase'), b = await hashPassword('secret-passphrase');
  assert.notEqual(a, b); assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.ok(await verifyPassword('secret-passphrase', a)); assert.ok(!(await verifyPassword('wrong', a)));
  assert.ok(!(await verifyPassword('x', 'garbage')));
});
test('register creates user + session; plaintext password is never stored', async () => {
  const { user, sessionToken } = await reg(1);
  assert.equal(user.email, 'user1@example.test'); assert.ok(sessionToken.length >= 43);
  const row = (await db.query('SELECT password_hash FROM users WHERE id=$1', [user.id])).rows[0];
  assert.ok(!row.password_hash.includes('correct horse')); 
  const s = (await db.query('SELECT token_hash FROM sessions')).rows;
  assert.ok(s.every(r => r.token_hash !== sessionToken && r.token_hash.length === 64)); // only a hash is stored
  assert.equal((await auth.authenticate(sessionToken)).id, user.id);
});
test('register validation and duplicate email (case-insensitive)', async () => {
  assert.equal(await code(auth.register({ email: 'bad', password: 'correct horse battery', displayName: 'x' })), 'INVALID_INPUT');
  assert.equal(await code(auth.register({ email: 'a@example.test', password: 'short', displayName: 'x' })), 'INVALID_INPUT');
  assert.equal(await code(auth.register({ email: 'a@example.test', password: 'correct horse battery', displayName: '' })), 'INVALID_INPUT');
  assert.equal(await code(auth.register({ email: 'USER1@example.test', password: 'correct horse battery', displayName: 'dup' }, { ip: 'z' })), 'CONFLICT');
});
test('login: success, wrong password and unknown email give the same error', async () => {
  const ok = await auth.login({ email: 'user1@example.test', password: 'correct horse battery' }, { ip: 'l1' });
  assert.ok(ok.sessionToken);
  const wrong = await code(auth.login({ email: 'user1@example.test', password: 'nope nope nope' }, { ip: 'l2' }));
  const unknown = await code(auth.login({ email: 'ghost@example.test', password: 'nope nope nope' }, { ip: 'l3' }));
  assert.equal(wrong, 'UNAUTHENTICATED'); assert.equal(unknown, 'UNAUTHENTICATED');
});
test('login is rate limited per account and per IP', async () => {
  for (let i = 0; i < 10; i++) await code(auth.login({ email: 'victim@example.test', password: 'x' }, { ip: `rl${i}` }));
  assert.equal(await code(auth.login({ email: 'victim@example.test', password: 'x' }, { ip: 'rlz' })), 'RATE_LIMITED');
  now += 16 * 60 * 1000; // window rolls over
  assert.equal(await code(auth.login({ email: 'victim@example.test', password: 'x' }, { ip: 'rly' })), 'UNAUTHENTICATED');
});
test('sessions: logout revokes, expiry enforced, junk tokens rejected', async () => {
  const { sessionToken } = await reg(2);
  assert.ok(await auth.authenticate(sessionToken));
  await auth.logout(sessionToken);
  assert.equal(await auth.authenticate(sessionToken), null);
  const { sessionToken: t2 } = await reg(3);
  now += SESSION_TTL_MS + 1000;
  assert.equal(await auth.authenticate(t2), null);
  assert.equal(await auth.authenticate('junk'), null); assert.equal(await auth.authenticate(undefined), null);
});
test('profile update validates and persists', async () => {
  const { user } = await reg(4);
  await auth.updateProfile(user.id, { displayName: 'New Name', defaultPrefs: { costSensitivity: 0.7, evil: 1 }, savedPlaces: [{ label: 'Home', lat: 12.9, lon: 77.6 }] });
  const p = await auth.getProfile(user.id);
  assert.equal(p.displayName, 'New Name'); assert.deepEqual(p.defaultPrefs, { costSensitivity: 0.7 }); assert.equal(p.savedPlaces.length, 1);
  assert.equal(await code(auth.updateProfile(user.id, { defaultPrefs: { costSensitivity: 5 } })), 'INVALID_INPUT');
  assert.equal(await code(auth.updateProfile(user.id, { savedPlaces: [{ label: 'x', lat: 999, lon: 0 }] })), 'INVALID_INPUT');
});
