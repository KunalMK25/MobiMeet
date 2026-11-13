import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDotenv, loadDotenv } from '../src/api/dotenv.js';
import { checkEnv, formatReport } from '../src/api/envCheck.js';
import { loadConfig } from '../src/api/config.js';

test('dotenv parser: comments, quotes, inline comments, blanks, export prefix, no over-eager parsing of values', () => {
  const p = parseDotenv(`# comment\nA=1\nB="two words" # trailing\nC='x#y'\nD=\nexport E=5   # note\nF=http://h/path#frag\nbad line\n  G = spaced  \n`);
  assert.deepEqual(p, { A: '1', B: 'two words', C: 'x#y', D: '', E: '5', F: 'http://h/path#frag', G: 'spaced' });
});
test('loadDotenv: never overrides existing variables, ignores blanks, returns names only, tolerates a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-env-')); const f = join(dir, '.env');
  writeFileSync(f, 'KEEP=from-file\nNEW=value-from-file\nEMPTY=\n');
  const env = { KEEP: 'from-shell' }; const r = loadDotenv(f, env);
  assert.deepEqual(env, { KEEP: 'from-shell', NEW: 'value-from-file' }); assert.deepEqual(r, { loaded: true, keys: ['NEW'] });
  assert.deepEqual(loadDotenv(join(dir, 'nope'), {}), { loaded: false, keys: [] });
});

const SECRET = ['sk', 'ant', 'SUPERSECRETVALUE1234567890'].join('-');   // fake; assembled so the repo-wide secret scanner never sees a key-shaped literal
test('env check never leaks values; reports local as ready with nothing set', () => {
  const r = checkEnv({ ANTHROPIC_API_KEY: SECRET, DATABASE_URL: ['postgres://u', 'hunter2pw@db.example.com/x'].join(':'), CRON_SECRET: 'a'.repeat(40) }, 'production');
  const text = formatReport(r); assert.ok(!text.includes('SUPERSECRET') && !text.includes('hunter2pw') && !text.includes('a'.repeat(40)));
  assert.equal(checkEnv({}, 'local').ready, true); assert.match(formatReport(checkEnv({}, 'local')), /embedded database/);
});
test('production readiness: database, cron secret and a routing choice are required; the message explains why', () => {
  const r = checkEnv({}, 'production'); const names = r.findings.filter(f => f.level === 'missing').map(f => f.name);
  assert.deepEqual(names.sort(), ['CRON_SECRET', 'DATABASE_URL', 'ROUTING_MODE']); assert.equal(r.ready, false);
  const ok = checkEnv({ DATABASE_URL: 'postgres://u:p@ep-x-pooler.example.com/db', CRON_SECRET: 'z'.repeat(32), ROUTING_MODE: 'estimate', APP_BASE_URL: 'https://site.example' }, 'production');
  assert.equal(ok.ready, true); assert.match(formatReport(ok), /pooled connection/);
});
test('warnings catch the common beginner mistakes', () => {
  const lv = (env, name) => checkEnv(env, 'production').findings.find(f => f.name === name)?.level;
  assert.equal(lv({ DATABASE_URL: 'postgres://USER:PASSWORD@HOST:5432/DBNAME' }, 'DATABASE_URL'), 'warn');   // placeholder left in
  assert.equal(lv({ DATABASE_URL: 'mysql://x' }, 'DATABASE_URL'), 'warn');
  assert.equal(lv({ ANTHROPIC_API_KEY: 'abc' }, 'ANTHROPIC_API_KEY'), 'warn'); assert.equal(lv({ OPENAI_API_KEY: 'abc' }, 'OPENAI_API_KEY'), 'warn');
  assert.equal(lv({ ANTHROPIC_API_KEY: SECRET, OPENAI_API_KEY: 'sk-abc' }, 'LLM_PROVIDER'), 'warn');                 // both keys, no choice
  assert.equal(lv({ ALLOW_PUBLIC_OSRM_IN_PRODUCTION: 'true' }, 'ALLOW_PUBLIC_OSRM_IN_PRODUCTION'), 'warn');
  assert.equal(lv({ CRON_SECRET: 'short' }, 'CRON_SECRET'), 'warn'); assert.equal(lv({ ROUTING_MODE: 'banana' }, 'ROUTING_MODE'), 'warn');
  assert.equal(lv({ APP_BASE_URL: 'http://x.example' }, 'APP_BASE_URL'), 'warn');
});
test('on Vercel the app URL and the preview origins are derived automatically', () => {
  const c = loadConfig({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'mm-abc.vercel.app', VERCEL_BRANCH_URL: 'mm-git-b.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'site.vercel.app' });
  assert.equal(c.appBaseUrl, 'https://mm-abc.vercel.app'); assert.deepEqual([...c.extraOrigins].sort(), ['https://mm-git-b.vercel.app', 'https://site.vercel.app']);
  const prod = loadConfig({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: 'mm-abc.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'site.vercel.app' });
  assert.equal(prod.appBaseUrl, 'https://site.vercel.app'); assert.equal(loadConfig({ APP_BASE_URL: 'https://mine.example', VERCEL_URL: 'x.vercel.app' }).appBaseUrl, 'https://mine.example');
  assert.equal(loadConfig({}).appBaseUrl, 'http://localhost:3000'); assert.equal(loadConfig({ DATABASE_URL: 'a', DATABASE_URL_UNPOOLED: 'b' }).migrationUrl, 'b');
});
test('a preview deployment accepts requests from its own (changing) URL but still rejects foreign origins', async () => {
  const { createPgliteDb } = await import('../src/db/client.js'); const { migrate } = await import('../src/db/migrate.js'); const { createApp } = await import('../src/api/app.js');
  const db = await createPgliteDb(); await migrate(db);
  const app = await createApp({ db, config: loadConfig({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'mm-abc.vercel.app', ROUTING_MODE: 'estimate' }) });
  const reg = (origin) => app.handle({ method: 'POST', path: '/api/auth/register', ip: origin, headers: { 'content-type': 'application/json', origin }, body: { email: `${Math.random().toString(36).slice(2)}@example.test`, password: 'correct horse battery', displayName: 'P' } });
  assert.equal((await reg('https://mm-abc.vercel.app')).status, 200); assert.equal((await reg('https://evil.example')).status, 403);
  assert.match((await reg('https://mm-abc.vercel.app')).headers['Set-Cookie'], /; Secure/);
  assert.equal(JSON.parse((await app.handle({ method: 'GET', path: '/api/health', headers: {} })).body).routing, 'estimate');
  await db.close();
});

test('Groq key: format hint, provider choice, model note — and the value is never printed', () => {
  const G = ['gsk', 'SECRETSECRETSECRET'].join('_');
  const r = checkEnv({ GROQ_API_KEY: G }, 'local'); const t = formatReport(r);
  assert.ok(!t.includes('SECRETSECRET')); assert.equal(r.findings.find(f => f.name === 'GROQ_API_KEY').level, 'ok'); assert.match(t, /openai\/gpt-oss-20b \(default\)/); assert.match(t, /llm:check/);
  assert.equal(checkEnv({ GROQ_API_KEY: 'abc' }, 'local').findings.find(f => f.name === 'GROQ_API_KEY').level, 'warn');
  assert.equal(checkEnv({ GROQ_API_KEY: G, OPENAI_API_KEY: 'sk-x' }, 'local').findings.find(f => f.name === 'LLM_PROVIDER').level, 'warn');
  assert.equal(checkEnv({ GROQ_API_KEY: G, LLM_PROVIDER: 'groq' }, 'local').findings.some(f => f.level === 'warn'), false);
  assert.equal(checkEnv({ LLM_PROVIDER: 'groq' }, 'local').findings.find(f => f.name === 'LLM_PROVIDER').level, 'warn');       // names a provider with no key
  assert.equal(loadConfig({ GROQ_API_KEY: G, GROQ_MODEL: 'llama-3.3-70b-versatile' }).llm.groqModel, 'llama-3.3-70b-versatile');
});
