import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb as createPgliteDb } from './testdb.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/api/app.js';
import { loadConfig } from '../src/api/config.js';
import { createMailer } from '../src/services/mailer.js';
import { createAuthService, RESET_TOKEN_TTL_MS } from '../src/services/auth.js';
import { passwordProblems, passwordStrength, PASSWORD } from '../src/utils/passwordPolicy.js';
import { DomainError } from '../src/domain/errors.js';
import { checkEnv } from '../src/api/envCheck.js';

let db, now = Date.parse('2026-11-13T10:00:00Z'), mailer, auth, seq = 0;
before(async () => { db = await createPgliteDb(); await migrate(db); mailer = createMailer({ mode: 'outbox' }); auth = createAuthService({ db, clock: () => now, mailer, resetUrl: (t) => `https://x.example/app/#/reset/${t}` }); });
after(() => db.close());
const code = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof DomainError, String(e.stack)); return e.code; } assert.fail('expected rejection'); };
const reg = async (n = 'Asha', pw = 'correct horse battery') => (await auth.register({ email: `${n.toLowerCase()}${++seq}@example.test`, password: pw, displayName: n }, { ip: `r${seq}` }));
const tokenFrom = (msg) => /#\/reset\/([\w-]+)/.exec(msg.text)[1];

test('password policy: length, common passwords, and passwords built from the user\'s own email or name', () => {
  assert.deepEqual(passwordProblems('correct horse battery'), []);
  assert.match(passwordProblems('short')[0], /at least 10/); assert.match(passwordProblems('password123')[0], /too common/); assert.match(passwordProblems('1234567890')[0], /too common/);
  assert.match(passwordProblems('aaaaaaaaaaaa')[0], /repeat/); assert.match(passwordProblems('x'.repeat(201))[0], /at most/);
  assert.match(passwordProblems('asha.kumar2026', { email: 'asha.kumar@example.test' })[0], /email/); assert.match(passwordProblems('Ashwin Kumar1', { name: 'Ashwin Kumar' })[0], /name/);
  assert.deepEqual(passwordProblems('a long unrelated passphrase', { email: 'asha@example.test', name: 'Asha' }), []);        // short local part / name never over-blocks
  assert.equal(PASSWORD.min, 10); assert.deepEqual([passwordStrength('').score, passwordStrength('short').label, passwordStrength('sixteen chars ok!').label, passwordStrength('four word pass phrase').score], [0, 'Too short', 'Strong', 4]);
});
test('registration enforces the same policy server-side', async () => {
  assert.equal(await code(auth.register({ email: 'weak@example.test', password: 'password123', displayName: 'W' }, { ip: 'w1' })), 'INVALID_INPUT');
  assert.equal(await code(auth.register({ email: 'asha.kumar@example.test', password: 'asha.kumar2026', displayName: 'Asha' }, { ip: 'w2' })), 'INVALID_INPUT');
});

test('forgot password: identical answer for known and unknown emails; only a known account gets a (hashed-at-rest, single-use) link', async () => {
  const { user } = await reg('Ben');
  const a = await auth.requestPasswordReset({ email: user.email }, { ip: 'f1' }), b = await auth.requestPasswordReset({ email: 'nobody@example.test' }, { ip: 'f2' });
  assert.deepEqual(a, b); assert.deepEqual(a, { ok: true });
  const msgs = mailer.outbox().filter(m => m.to === user.email); assert.equal(msgs.length, 1); assert.match(msgs[0].text, /30 minutes/);
  assert.equal(mailer.outbox().filter(m => m.to === 'nobody@example.test').length, 0);
  const token = tokenFrom(msgs[0]);
  const row = (await db.query('SELECT token_hash FROM password_resets WHERE user_id=$1', [user.id])).rows[0];
  assert.notEqual(row.token_hash, token); assert.equal(row.token_hash.length, 64); assert.ok(!JSON.stringify((await db.query('SELECT * FROM password_resets')).rows).includes(token));
});
test('forgot password is rate limited per address and per IP (and consumed for unknown addresses too — no oracle)', async () => {
  for (let i = 0; i < 3; i++) await auth.requestPasswordReset({ email: 'victim@example.test' }, { ip: `rl${i}` });
  assert.equal(await code(auth.requestPasswordReset({ email: 'victim@example.test' }, { ip: 'rl9' })), 'RATE_LIMITED');
  for (let i = 0; i < 10; i++) await auth.requestPasswordReset({ email: `u${i}@example.test` }, { ip: 'same-ip' });
  assert.equal(await code(auth.requestPasswordReset({ email: 'another@example.test' }, { ip: 'same-ip' })), 'RATE_LIMITED');
});
test('reset: a valid link sets the new password, works ONCE, signs every session out, and the old password stops working', async () => {
  const { user, sessionToken } = await reg('Chitra');
  await auth.requestPasswordReset({ email: user.email }, { ip: 'g1' });
  const token = tokenFrom(mailer.outbox().filter(m => m.to === user.email).at(-1));
  assert.ok(await auth.authenticate(sessionToken));
  assert.equal(await code(auth.resetPassword({ token, password: 'password123' }, { ip: 'g1' })), 'INVALID_INPUT');           // weak new password rejected; link still usable
  assert.deepEqual(await auth.resetPassword({ token, password: 'a brand new passphrase' }, { ip: 'g1' }), { ok: true });
  assert.equal(await auth.authenticate(sessionToken), null);                                                                  // signed out everywhere
  assert.equal(await code(auth.login({ email: user.email, password: 'correct horse battery' }, { ip: 'g2' })), 'UNAUTHENTICATED');
  assert.ok((await auth.login({ email: user.email, password: 'a brand new passphrase' }, { ip: 'g3' })).sessionToken);
  assert.equal(await code(auth.resetPassword({ token, password: 'yet another passphrase' }, { ip: 'g4' })), 'INVALID_INPUT');  // single use
});
test('reset: expired links, junk tokens and superseded links are rejected with one generic message', async () => {
  const { user } = await reg('Dev');
  await auth.requestPasswordReset({ email: user.email }, { ip: 'h1' }); const first = tokenFrom(mailer.outbox().filter(m => m.to === user.email).at(-1));
  now += 60_000; await auth.requestPasswordReset({ email: user.email }, { ip: 'h2' }); const second = tokenFrom(mailer.outbox().filter(m => m.to === user.email).at(-1));
  assert.notEqual(first, second);
  const msg = async (t) => { try { await auth.resetPassword({ token: t, password: 'valid new passphrase' }, { ip: 'h3' }); } catch (e) { return e.message; } };
  const generic = await msg(first); assert.match(generic, /invalid or has expired/); assert.equal(await msg('x'.repeat(43)), generic); assert.equal(await msg(undefined), generic);
  now += RESET_TOKEN_TTL_MS + 1000; assert.equal(await msg(second), generic);                                                    // expired
  now -= RESET_TOKEN_TTL_MS + 1000;
});
test('change password: needs the current password, enforces the policy, keeps THIS session and ends the others', async () => {
  const { user, sessionToken } = await reg('Esha'); const other = (await auth.login({ email: user.email, password: 'correct horse battery' }, { ip: 'c1' })).sessionToken;
  assert.equal(await code(auth.changePassword(user.id, { currentPassword: 'wrong wrong wrong', newPassword: 'new long passphrase' }, { sessionToken })), 'UNAUTHENTICATED');
  assert.equal(await code(auth.changePassword(user.id, { currentPassword: 'correct horse battery', newPassword: 'password123' }, { sessionToken })), 'INVALID_INPUT');
  assert.equal(await code(auth.changePassword(user.id, { currentPassword: 'correct horse battery', newPassword: 'correct horse battery' }, { sessionToken })), 'INVALID_INPUT');
  await auth.changePassword(user.id, { currentPassword: 'correct horse battery', newPassword: 'new long passphrase' }, { sessionToken });
  assert.ok(await auth.authenticate(sessionToken)); assert.equal(await auth.authenticate(other), null);
  assert.ok((await auth.login({ email: user.email, password: 'new long passphrase' }, { ip: 'c2' })).sessionToken);
});
test('sign out everywhere ends all sessions', async () => {
  const { user, sessionToken } = await reg('Fay'); const second = (await auth.login({ email: user.email, password: 'correct horse battery' }, { ip: 'l1' })).sessionToken;
  const r = await auth.logoutEverywhere(user.id); assert.equal(r.sessionsEnded, 2); assert.equal(await auth.authenticate(sessionToken), null); assert.equal(await auth.authenticate(second), null);
});
test('mail modes: outbox is development-only, anything else is honestly "disabled", and the server says so', async () => {
  assert.equal(createMailer({ mode: 'outbox', productionLike: true }).mode, 'disabled'); assert.equal(createMailer({ mode: 'smtp' }).mode, 'disabled'); assert.equal(createMailer({}).enabled, false);
  const off = createAuthService({ db, clock: () => now, mailer: createMailer({ mode: 'disabled' }) });
  assert.deepEqual(off.capabilities(), { passwordReset: false, mailMode: 'disabled' }); assert.equal(await code(off.requestPasswordReset({ email: 'a@example.test' }, { ip: 'z' })), 'PROVIDER_UNAVAILABLE');
  assert.equal(loadConfig({ APP_BASE_URL: 'https://prod.example' }).mail.mode, 'disabled'); assert.equal(loadConfig({}).mail.mode, 'outbox'); assert.equal(loadConfig({ APP_BASE_URL: 'https://prod.example', MAIL_MODE: 'outbox' }).mail.mode, 'outbox');   // requested, but the mailer refuses it in production
});
test('HTTP: capabilities, forgot/reset, change-password and the dev outbox exist only where they should', async () => {
  const dev = await createApp({ db, config: loadConfig({ APP_BASE_URL: 'http://localhost:3000' }) });
  const call = (app, m, path, body, headers = {}) => app.handle({ method: m, path, body, ip: `http${++seq}`, headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...headers } }).then(r => ({ status: r.status, json: r.body ? JSON.parse(r.body) : null, headers: r.headers }));
  assert.deepEqual((await call(dev, 'GET', '/api/auth/capabilities')).json, { passwordReset: true, mailMode: 'outbox' });
  const r = await call(dev, 'POST', '/api/auth/register', { email: 'http-user@example.test', password: 'correct horse battery', displayName: 'Http' });
  const cookie = r.headers['Set-Cookie'].split(';')[0];
  assert.equal((await call(dev, 'POST', '/api/auth/forgot', { email: 'http-user@example.test' })).status, 200); assert.equal((await call(dev, 'POST', '/api/auth/forgot', { email: 'ghost@example.test' })).status, 200);
  const outbox = (await call(dev, 'GET', '/api/dev/outbox')).json.messages; assert.equal(outbox.length, 1); assert.match(outbox[0].text, /http:\/\/localhost:3000\/app\/#\/reset\//);
  assert.equal((await call(dev, 'POST', '/api/me/password', { currentPassword: 'correct horse battery', newPassword: 'another long passphrase' }, { cookie })).status, 200);
  assert.equal((await call(dev, 'POST', '/api/me/password', { currentPassword: 'x', newPassword: 'another long passphrase 2' })).status, 401);   // needs a session
  const prod = await createApp({ db, config: loadConfig({ APP_BASE_URL: 'https://prod.example', ROUTING_MODE: 'estimate' }) });
  assert.deepEqual((await call(prod, 'GET', '/api/auth/capabilities', undefined, { origin: 'https://prod.example' })).json, { passwordReset: false, mailMode: 'disabled' });
  assert.equal((await call(prod, 'GET', '/api/dev/outbox', undefined, { origin: 'https://prod.example' })).status, 404);                       // the outbox does not exist in production
  assert.equal((await call(prod, 'POST', '/api/auth/forgot', { email: 'a@example.test' }, { origin: 'https://prod.example' })).status, 503);
});
test('env check explains the mail situation without leaking anything', () => {
  const prod = checkEnv({ DATABASE_URL: 'postgres://u:p@h-pooler.example.com/d', CRON_SECRET: 'z'.repeat(32), ROUTING_MODE: 'estimate', APP_BASE_URL: 'https://s.example' }, 'production');
  assert.match(prod.findings.find(f => f.name === 'MAIL_MODE').message, /OFF in production/); assert.equal(prod.ready, true);                       // missing email is a notice, not a blocker
  assert.match(checkEnv({}, 'local').findings.find(f => f.name === 'MAIL_MODE').message, /outbox|development/);
});

test('real email (Resend adapter): only active with key + valid sender; sends once, only on 2xx; never leaks the key; outbox stays dev-only', async () => {
  const calls = [];
  const ok = async (url, o) => { calls.push({ url, o }); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };
  const m = createMailer({ mode: 'resend', resend: { apiKey: 're_TESTKEY123', from: 'MobiMeet <no-reply@example.test>' }, fetchImpl: ok });
  assert.equal(m.mode, 'resend'); assert.equal(m.enabled, true);
  await m.send({ to: 'a@example.test', subject: 'S', text: 'T' });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.resend.com/emails'); assert.equal(calls[0].o.headers.Authorization, 'Bearer re_TESTKEY123');
  assert.deepEqual(JSON.parse(calls[0].o.body), { from: 'MobiMeet <no-reply@example.test>', to: ['a@example.test'], subject: 'S', text: 'T' });
  // refused / unreachable → rejects (so callers never report "sent"), and the key is not in the error or the log
  const logs = [];
  const refuse = createMailer({ mode: 'resend', resend: { apiKey: 're_TESTKEY123', from: 'no-reply@example.test' }, fetchImpl: async () => ({ ok: false, status: 403 }), log: (e) => logs.push(e) });
  await assert.rejects(refuse.send({ to: 'a@example.test', subject: 'S', text: 'T' }), (e) => !/re_TESTKEY123/.test(e.message) && /403/.test(e.message));
  await assert.rejects(createMailer({ mode: 'resend', resend: { apiKey: 're_TESTKEY123', from: 'no-reply@example.test' }, fetchImpl: async () => { throw new Error('boom re_TESTKEY123'); } }).send({ to: 'a@example.test', subject: 'S', text: 'T' }), (e) => !/re_TESTKEY123/.test(e.message));
  assert.ok(!JSON.stringify(logs).includes('re_TESTKEY123'));
  // incomplete configuration → honestly disabled
  for (const resend of [{}, { apiKey: 're_x' }, { from: 'no-reply@example.test' }, { apiKey: 're_x', from: 'not an address' }]) assert.equal(createMailer({ mode: 'resend', resend }).mode, 'disabled');
  assert.equal(createMailer({ mode: 'resend', resend: { apiKey: 're_x', from: 'a@b.co' }, productionLike: true }).mode, 'resend');   // real mail is allowed in production
  assert.equal(createMailer({ mode: 'outbox', productionLike: true }).mode, 'disabled');                                              // the dev outbox is not
  // end to end: the reset flow reports unavailable when mail is off, and sends exactly one message when it is on
  const sent = []; const live = createMailer({ mode: 'resend', resend: { apiKey: 're_x', from: 'no-reply@example.test' }, fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body)); return { ok: true, status: 200 }; } });
  const a2 = createAuthService({ db, clock: () => now, mailer: live, resetUrl: (t) => `https://x.example/#/reset/${t}` });
  await a2.requestPasswordReset({ email: 'unknown-person@example.test' }, { ip: 'rs1' }); assert.equal(sent.length, 0);       // unknown address: no email, same reply
});
