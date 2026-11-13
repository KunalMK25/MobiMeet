// Test database selector. Default: embedded Postgres (PGlite). Set TEST_DATABASE_URL to run the same tests through the real `pg`
// driver against a Postgres SERVER. That database's `public` schema is DROPPED and recreated for every test environment, so it also
// requires TEST_DATABASE_ALLOW_RESET=true — point it only at a throw-away database, never at data you care about.
// Use `node --test --test-concurrency=1 …` because test files then share one database.
import { createPgliteDb, createPgDb } from '../src/db/client.js';

export async function createTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createPgliteDb();
  if (process.env.TEST_DATABASE_ALLOW_RESET !== 'true') throw new Error('TEST_DATABASE_URL is set: the tests DROP the public schema. Set TEST_DATABASE_ALLOW_RESET=true to confirm this is a throw-away database.');
  const db = await createPgDb({ connectionString: url, max: 1, ssl: process.env.TEST_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  return db;
}
