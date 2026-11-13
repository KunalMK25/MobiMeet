#!/usr/bin/env node
// Apply pending migrations to DATABASE_URL (your personal Postgres). Usage: DATABASE_URL=... npm run db:migrate
import { createPgDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/api/config.js';
import { loadDotenv } from '../src/api/dotenv.js';
loadDotenv('.env');                       // never overrides variables already set in the shell
const cfg = loadConfig();
if (!cfg.migrationUrl) { console.error('Set DATABASE_URL (or DATABASE_URL_UNPOOLED) in .env first.'); process.exit(1); }
const db = await createPgDb({ connectionString: cfg.migrationUrl, ssl: cfg.databaseSsl, max: 1 });
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
await db.close();
