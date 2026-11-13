import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb as createPgliteDb } from './testdb.js';
import { migrate } from '../src/db/migrate.js';
import { MIGRATIONS } from '../src/db/migrations.js';

let db;
before(async () => { db = await createPgliteDb(); await migrate(db); });
after(async () => { await db.close(); });

const mkUser = async (e) => (await db.query(`INSERT INTO users (email, display_name, password_hash) VALUES ($1,'U','x') RETURNING id`, [e])).rows[0].id;
const mkGroup = async (owner, mode = 'METRO') => (await db.query(`INSERT INTO groups (owner_id, name, mode) VALUES ($1,'G',$2) RETURNING id`, [owner, mode])).rows[0].id;

test('migrations are idempotent and recorded', async () => {
  assert.deepEqual(await migrate(db), []);
  assert.equal((await db.query('SELECT count(*)::int c FROM schema_migrations')).rows[0].c, MIGRATIONS.length);
  assert.deepEqual((await db.query('SELECT id FROM schema_migrations ORDER BY id')).rows.map(r => r.id), MIGRATIONS.map(m => m.id).sort());
});
test('emails are unique case-insensitively', async () => {
  await mkUser('a@example.test');
  await assert.rejects(mkUser('A@Example.test'), /unique/i);
});
test('group mode is constrained and immutable at the database level', async () => {
  const u = await mkUser('o1@example.test');
  await assert.rejects(db.query(`INSERT INTO groups (owner_id,name,mode) VALUES ($1,'x','CAR')`, [u]), /check/i);
  const g = await mkGroup(u);
  await assert.rejects(db.query(`UPDATE groups SET mode='BIKE' WHERE id=$1`, [g]), /immutable/);
});
test('a membership cannot have a transport mode different from its group', async () => {
  const u = await mkUser('o2@example.test'), m = await mkUser('m2@example.test');
  const g = await mkGroup(u, 'METRO');
  await assert.rejects(db.query(`INSERT INTO group_memberships (group_id, transport_mode, user_id, role) VALUES ($1,'BIKE',$2,'member')`, [g, m]), /foreign key/i);
  await db.query(`INSERT INTO group_memberships (group_id, transport_mode, user_id, role) VALUES ($1,'METRO',$2,'member')`, [g, m]);
  await assert.rejects(db.query(`INSERT INTO group_memberships (group_id, transport_mode, user_id, role) VALUES ($1,'METRO',$2,'member')`, [g, m]), /unique/i); // duplicate member
});
test('origin must be both lat and lon, within range', async () => {
  const u = await mkUser('o3@example.test'); const g = await mkGroup(u);
  const ins = (lat, lon) => db.query(`INSERT INTO group_memberships (group_id, transport_mode, user_id, role, origin_lat, origin_lon) VALUES ($1,'METRO',$2,'owner',$3,$4)`, [g, u, lat, lon]);
  await assert.rejects(ins(12.9, null), /check/i);
  await assert.rejects(ins(91, 77), /check/i);
});
test('transactions roll back atomically', async () => {
  const before = (await db.query('SELECT count(*)::int c FROM users')).rows[0].c;
  await assert.rejects(db.tx(async (t) => { await t.query(`INSERT INTO users (email, display_name, password_hash) VALUES ('rb@example.test','U','x')`); throw new Error('boom'); }), /boom/);
  assert.equal((await db.query('SELECT count(*)::int c FROM users')).rows[0].c, before);
});
test('plan versions are unique per group', async () => {
  const u = await mkUser('o4@example.test'); const g = await mkGroup(u);
  const ins = (v) => db.query(`INSERT INTO meetup_plans (group_id, version, strategy, input_hash, result, created_by) VALUES ($1,$2,'balanced','h','{}',$3)`, [g, v, u]);
  await ins(1); await ins(2);
  await assert.rejects(ins(2), /unique/i);
});

test('connection strings are hardened: remote hosts get verify-full, local ones are left alone, nothing else changes', async () => {
  const { hardenConnectionString: h } = await import('../src/db/client.js');
  assert.match(h('postgresql://u:p@ep-x-pooler.region.aws.neon.tech/db?sslmode=require&channel_binding=require'), /sslmode=verify-full/);
  assert.match(h('postgresql://u:p@ep-x.region.aws.neon.tech/db'), /sslmode=verify-full/);                       // no sslmode at all → TLS verified
  assert.match(h('postgresql://u:p@ep-x.region.aws.neon.tech/db?sslmode=verify-ca'), /sslmode=verify-full/);
  assert.equal(h('postgresql://u:p@localhost:5432/db'), 'postgresql://u:p@localhost:5432/db');                    // local dev: untouched
  assert.equal(h('postgresql://u:p@127.0.0.1:54329/postgres?sslmode=disable'), 'postgresql://u:p@127.0.0.1:54329/postgres?sslmode=disable');
  assert.equal(h('not a url'), 'not a url');
  const u = new URL(h('postgresql://user:pw@host.example/db?sslmode=require&channel_binding=require')); assert.equal(u.username, 'user'); assert.equal(u.password, 'pw'); assert.equal(u.searchParams.get('channel_binding'), 'require');
});
