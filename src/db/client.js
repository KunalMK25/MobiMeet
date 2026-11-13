// ═══════════════════════════════════════════════════════════
//  db/client.js — one tiny interface over two Postgres drivers:
//    db.query(text, params) → {rows}
//    db.exec(sql)           → run multi-statement SQL (migrations)
//    db.tx(async t => ...)  → transaction; t has the same query/exec
//  Production/preview use `pg` (DATABASE_URL, a PERSONAL database you provision).
//  Local dev and tests use PGlite (real Postgres compiled to WASM, in-process).
//  All application SQL is parameterised ($1, $2…) — never string-built.
// ═══════════════════════════════════════════════════════════

export async function createPgliteDb({ dataDir } = {}) {
  const { PGlite } = await import('@electric-sql/pglite'); // dev dependency only
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  let chain = Promise.resolve(); // PGlite is single-connection: serialise top-level work
  const wrap = (runner) => ({
    query: async (text, params = []) => { const r = await runner.query(text, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; },
    exec: async (sql) => { await runner.exec(sql); },
  });
  const base = wrap(pg);
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  return {
    kind: 'pglite',
    query: (t, p) => serial(() => base.query(t, p)),
    exec: (s) => serial(() => base.exec(s)),
    tx: (fn) => serial(() => pg.transaction(async (trx) => fn(wrap(trx)))),
    close: () => pg.close(),
  };
}

// Make TLS explicit and strict: any non-local host must be reached over TLS with the certificate verified. `require`/`prefer`/`verify-ca`
// are what managed providers print in their URLs; the pg driver currently treats them as verify-full and warns that this will change,
// so we state verify-full ourselves. Plain `sslmode=disable` on a remote host is left alone (the provider refuses it anyway).
export function hardenConnectionString(url) {
  let u; try { u = new URL(url); } catch { return url; }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  const mode = u.searchParams.get('sslmode');
  if (!local && (mode === null || ['require', 'prefer', 'verify-ca'].includes(mode))) u.searchParams.set('sslmode', 'verify-full');
  return u.toString();
}

export async function createPgDb({ connectionString, max = 3, ssl, statementTimeoutMs = 30000 } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const { default: pgmod } = await import('pg');
  // Serverless-friendly: few connections per instance, short idle time, bounded connect and statement time (the function limit is 60 s).
  const pool = new pgmod.Pool({ connectionString: hardenConnectionString(connectionString), max, ssl, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000, statement_timeout: statementTimeoutMs });
  const wrap = (c) => ({
    query: async (text, params = []) => { const r = await c.query(text, params); return { rows: r.rows, rowCount: r.rowCount }; },
    exec: async (sql) => { await c.query(sql); },
  });
  return {
    kind: 'pg',
    ...wrap(pool),
    tx: async (fn) => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const out = await fn(wrap(c)); await c.query('COMMIT'); return out; }
      catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
      finally { c.release(); }
    },
    close: () => pool.end(),
  };
}
