import { MIGRATIONS } from './migrations.js';

// db: {query(text, params) -> {rows}, tx(fn)}. Idempotent; each migration runs in its own transaction.
export async function migrate(db, migrations = MIGRATIONS) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query('SELECT id FROM schema_migrations')).rows.map(r => r.id));
  const applied = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await db.tx(async (t) => {
      await t.exec(m.sql);
      await t.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
    });
    applied.push(m.id);
  }
  return applied;
}
