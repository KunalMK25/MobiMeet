#!/usr/bin/env node
// Run the whole test suite against a REAL PostgreSQL database (the production `pg` path).
//   TEST_DATABASE_URL in .env must point at a DISPOSABLE database/branch — the tests DROP its `public` schema each time.
// Safety rails (all enforced here, before anything connects):
//   • TEST_DATABASE_URL must be set, and must NOT be the same server/database as DATABASE_URL / DATABASE_URL_UNPOOLED.
//   • Only the host name and database are ever printed — never the user, password or full URL.
import { spawnSync } from 'node:child_process';
import { loadDotenv } from '../src/api/dotenv.js';
loadDotenv('.env');
const parse = (u) => { try { const x = new URL(u); return { host: x.hostname.replace(/-pooler(?=\.)/, ''), db: x.pathname.replace(/^\//, '') }; } catch { return null; } };
const t = parse(process.env.TEST_DATABASE_URL ?? '');
if (!t) { console.error('TEST_DATABASE_URL is missing or not a valid postgres:// URL (put it in .env — a separate Neon branch, never your app database).'); process.exit(2); }
for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
  const a = process.env[name] ? parse(process.env[name]) : null;
  if (a && a.host === t.host && a.db === t.db) { console.error(`Refusing: TEST_DATABASE_URL points at the same database as ${name}. The tests ERASE their database. Create a separate Neon branch for tests.`); process.exit(2); }
}
console.log(`Running the suite against disposable database "${t.db}" on ${t.host} (its public schema is wiped for each test environment)…`);
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2).length ? process.argv.slice(2) : ['tests/']], { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_ALLOW_RESET: 'true' } });
process.exit(r.status ?? 1);
