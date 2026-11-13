import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb as createPgliteDb } from './testdb.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/api/app.js';
import { createHandler, parseCookies, MAX_BODY_BYTES } from '../src/api/http.js';
import { loadConfig } from '../src/api/config.js';
import { createChatService } from '../src/ai/chat.js';
import { createVenueService, createOverpassProvider } from '../src/venues/venueService.js';
import { stationIdFor } from '../src/data/station-ids.js';
import { fakeRouting } from './helpers.js';

import { liveVenuesFetch } from './helpers.js';
const OK_VENUES = liveVenuesFetch('Cafe');
let db, app, seq = 0;
before(async () => {
  db = await createPgliteDb(); await migrate(db);
  app = await createApp({ db, config: loadConfig({ APP_BASE_URL: 'http://localhost:3000' }), providers: { roadRouting: fakeRouting() },
    venues: createVenueService({ live: createOverpassProvider({ fetchImpl: OK_VENUES }) }),
    chat: ({ db, groups, plans, config }) => createChatService({ db, groups, plans, config, llm: null }) });
});
after(() => db.close());

function client(extraHeaders = {}) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const [p, qs] = path.split('?');
    const res = await app.handle({ method, path: p, query: Object.fromEntries(new URLSearchParams(qs ?? '')), body, ip: `10.0.0.${++seq % 250}`,
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...(cookie ? { cookie } : {}), ...extraHeaders, ...headers } });
    const sc = res.headers['Set-Cookie']; if (sc) cookie = sc.startsWith('mm_session=;') ? '' : sc.split(';')[0];
    return { status: res.status, headers: res.headers, json: res.body ? JSON.parse(res.body) : null, raw: res.body };
  };
  call.cookie = () => cookie;
  return call;
}
const signup = async (name) => { const c = client(); const r = await c('POST', '/api/auth/register', { email: `${name}${++seq}@example.test`, password: 'correct horse battery', displayName: name }); assert.equal(r.status, 200, r.raw); return { c, user: r.json.user }; };
const metro = (n) => ({ stationId: stationIdFor(n) });

test('public endpoints and security headers on every response', async () => {
  const c = client();
  const h = await c('GET', '/api/health'); assert.equal(h.status, 200);
  for (const [k, v] of Object.entries({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' })) assert.equal(h.headers[k], v);
  assert.ok(h.headers['Content-Security-Policy'].includes("default-src 'none'")); assert.ok(h.headers['X-Request-Id']);
  const s = await c('GET', '/api/stations');
  const PINK_OPEN = Date.parse('2026-11-13T00:00:00+05:30');
  assert.equal(s.json.stations.length, 83 + (Date.now() >= PINK_OPEN ? 5 : 0));   // 83 on Purple/Green/Yellow; +5 Pink Phase 1 stations (Jayadeva is already counted)
  assert.ok(s.json.stations.every(x => x.id.startsWith('stn_')));
  assert.equal(s.json.stations.some(x => x.name === 'Kalena Agrahara'), Date.now() >= PINK_OPEN);
  assert.ok(!s.json.stations.some(x => ['Dairy Circle', 'Nagawara'].includes(x.name)), 'Phase 2 must never be listed');
  const nf = await c('GET', '/api/nope'); assert.equal(nf.status, 404); assert.equal(nf.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal((await c('DELETE', '/api/health')).status, 400);          // known path, wrong method
});
test('auth: HttpOnly SameSite cookie, session works, logout revokes, junk cookie rejected', async () => {
  const { c, user } = await signup('Asha');
  const set = (await c('POST', '/api/auth/login', { email: user.email, password: 'correct horse battery' })).headers['Set-Cookie'];
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/); assert.match(set, /Path=\//); assert.ok(!/Secure/.test(set)); // http dev
  assert.equal((await c('GET', '/api/me')).json.profile.email, user.email);
  const raw = (await c('GET', '/api/me')).raw; assert.ok(!/password|hash/i.test(raw));
  assert.equal((await c('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 401);
  assert.equal((await client()('GET', '/api/me', undefined, { cookie: 'mm_session=garbage' })).status, 401);
  assert.equal((await client()('POST', '/api/auth/login', { email: user.email, password: 'wrong wrong wrong' })).status, 401);
});
test('cookies are Secure when the app URL is https', async () => {
  const sec = await createApp({ db, config: loadConfig({ APP_BASE_URL: 'https://mobimeet.example' }), providers: { roadRouting: fakeRouting() } });
  const r = await sec.handle({ method: 'POST', path: '/api/auth/register', body: { email: `s${++seq}@example.test`, password: 'correct horse battery', displayName: 'S' }, ip: 'x', headers: { 'content-type': 'application/json', origin: 'https://mobimeet.example' } });
  assert.match(r.headers['Set-Cookie'], /; Secure/);
});
test('CSRF defences: cross-origin / cross-site / wrong content-type are rejected; GET is unaffected', async () => {
  const { c } = await signup('Csrf');
  assert.equal((await c('POST', '/api/groups', { name: 'x', mode: 'METRO' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await c('POST', '/api/groups', { name: 'x', mode: 'METRO' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await c('POST', '/api/groups', { name: 'x', mode: 'METRO' }, { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await c('POST', '/api/groups', { name: 'x', mode: 'METRO' }, { 'sec-fetch-site': 'same-origin' })).status, 201);
  assert.equal((await c('GET', '/api/groups', undefined, { origin: 'https://evil.example' })).status, 200);
});
test('oversized / malformed bodies are rejected', async () => {
  const { c } = await signup('Big');
  assert.equal((await c('POST', '/api/groups', 'raw string')).status, 400);
  assert.equal((await c('POST', '/api/groups', { name: 'x', mode: 'METRO' }, { 'content-length': String(MAX_BODY_BYTES + 1) })).status, 400);
  assert.equal((await c('POST', '/api/groups', { name: 'x', mode: ['METRO'] })).status, 400);
});
test('unexpected errors become a generic 500 with no internals', async () => {
  const h = createHandler({ routes: [{ method: 'GET', path: '/api/boom', auth: false, handler: () => { throw new Error('secret db password leaked'); } }], auth: {}, config: { appBaseUrl: 'http://localhost:3000' } });
  const r = await h({ method: 'GET', path: '/api/boom', headers: {} });
  assert.equal(r.status, 500); assert.ok(!r.body.includes('secret')); assert.equal(JSON.parse(r.body).error.code, 'INTERNAL');
});

test('full Metro journey over HTTP: create → invite → preview → join → optimise → read → confirm → venues → what-if → chat', async () => {
  const owner = await signup('Owner'), friend = await signup('Friend'), third = await signup('Third');
  const created = await owner.c('POST', '/api/groups', { name: 'Saturday', mode: 'METRO', origin: metro('Whitefield') });
  assert.equal(created.status, 201); const gid = created.json.group.id; assert.equal(created.json.group.status, 'open');
  const inv = await owner.c('POST', `/api/groups/${gid}/invitations`, { ttlHours: 24 });
  assert.equal(inv.status, 201); const token = inv.json.token;
  const prev = await client()('POST', '/api/invitations/preview', { token });                      // not logged in
  assert.deepEqual(prev.json.invitation, { groupName: 'Saturday', mode: 'METRO', namedSeats: false, participants: [] });
  assert.equal((await client()('POST', '/api/invitations/join', { token, origin: metro('Kengeri') })).status, 401);
  assert.equal((await friend.c('POST', '/api/invitations/join', { token, origin: metro('Kengeri') })).status, 200);
  assert.equal((await third.c('POST', '/api/invitations/join', { token, origin: metro('Silk Institute') })).status, 200);
  const dup = await friend.c('POST', '/api/invitations/join', { token, origin: metro('Kengeri') }); assert.equal(dup.status, 409);

  assert.equal((await friend.c('POST', `/api/groups/${gid}/optimize`, {})).status, 403);          // not the owner
  const opt = await owner.c('POST', `/api/groups/${gid}/optimize`, { strategy: 'balanced' });
  assert.equal(opt.status, 200, opt.raw); const planId = opt.json.plan.id;
  const seen = await friend.c('GET', `/api/groups/${gid}/plans/current`);
  assert.equal(seen.json.plan.id, planId); assert.ok(seen.json.plan.result.recommended.journeys.length === 3);
  assert.ok(!/origin_lat|originLat/.test(seen.raw));
  assert.equal((await friend.c('POST', `/api/groups/${gid}/plans/${planId}/confirm`, {})).status, 403);
  assert.equal((await owner.c('POST', `/api/groups/${gid}/plans/${planId}/confirm`, {})).json.plan.status, 'confirmed');
  const v = await friend.c('GET', `/api/groups/${gid}/plans/current/venues?categories=cafe`);
  assert.equal(v.status, 200); assert.ok(v.json.venues.venues.length >= 1); assert.match(v.json.venues.attribution, /OpenStreetMap/);
  const w = await friend.c('POST', `/api/groups/${gid}/whatif`, { strategy: 'fastest' });
  assert.equal(w.status, 201); assert.equal(w.json.comparison.comparable, true);
  const cmp = await friend.c('POST', `/api/groups/${gid}/whatif/compare`, { ids: [w.json.scenarioId] });
  assert.equal(cmp.json.scenarios.length, 1);
  const ch = await friend.c('POST', '/api/chat', { groupId: gid, message: 'why this station?' });
  assert.equal(ch.json.source, 'deterministic');
  assert.equal((await friend.c('GET', `/api/groups/${gid}/plans`)).json.plans.length, 1);
  const list = await friend.c('GET', '/api/groups'); assert.equal(list.json.groups[0].memberCount, 3);
});
test('IDOR over HTTP: a stranger cannot read, join by id, optimise, confirm, or compare anything', async () => {
  const owner = await signup('O2'), stranger = await signup('S2');
  const gid = (await owner.c('POST', '/api/groups', { name: 'Private', mode: 'METRO', origin: metro('Majestic') })).json.group.id;
  for (const [m, p, b] of [['GET', `/api/groups/${gid}`], ['PATCH', `/api/groups/${gid}`, { name: 'x' }], ['PUT', `/api/groups/${gid}/me`, { origin: metro('Hoodi') }], ['POST', `/api/groups/${gid}/optimize`, {}],
    ['GET', `/api/groups/${gid}/plans`], ['GET', `/api/groups/${gid}/plans/current`], ['POST', `/api/groups/${gid}/whatif`, {}], ['GET', `/api/groups/${gid}/invitations`], ['POST', '/api/chat', { groupId: gid, message: 'hi' }]]) {
    const r = await stranger.c(m, p, b); assert.equal(r.status, 404, `${m} ${p} → ${r.status}`);
  }
  assert.equal((await stranger.c('GET', '/api/groups/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await owner.c('GET', `/api/groups/${gid}`)).status, 200);
});
test('mixed-mode joins are rejected over HTTP; group mode cannot be changed', async () => {
  const owner = await signup('O3'), friend = await signup('F3');
  const gid = (await owner.c('POST', '/api/groups', { name: 'Bikes', mode: 'BIKE', origin: { lat: 12.95, lon: 77.6 } })).json.group.id;
  const token = (await owner.c('POST', `/api/groups/${gid}/invitations`, {})).json.token;
  const mixed = await friend.c('POST', '/api/invitations/join', { token, mode: 'METRO', origin: metro('Majestic') });
  assert.equal(mixed.status, 409); assert.equal(mixed.json.error.code, 'MODE_MISMATCH');
  assert.equal((await friend.c('POST', '/api/invitations/join', { token, origin: metro('Majestic') })).status, 400); // station origin invalid for BIKE
  assert.equal((await owner.c('PATCH', `/api/groups/${gid}`, { mode: 'METRO' })).json.error.code, 'MODE_LOCKED');
});
test('full Bike journey over HTTP with fuel assumptions and route geometry', async () => {
  const owner = await signup('BO'), friend = await signup('BF');
  const gid = (await owner.c('POST', '/api/groups', { name: 'Ride', mode: 'BIKE', origin: { lat: 12.90, lon: 77.55 } })).json.group.id;
  const token = (await owner.c('POST', `/api/groups/${gid}/invitations`, {})).json.token;
  await friend.c('POST', '/api/invitations/join', { token, origin: { lat: 12.99, lon: 77.62 }, softPrefs: { minimizeFuelCost: true } });
  const opt = await owner.c('POST', `/api/groups/${gid}/optimize`, { fuel: { mileageKmPerLitre: 40, fuelPricePerLitre: 100, priceDate: '2026-11-13' } });
  assert.equal(opt.status, 200, opt.raw);
  const rec = opt.json.plan.result.recommended;
  assert.equal(opt.json.plan.result.mode, 'BIKE'); assert.ok(rec.journeys.every(j => j.detail.geometry.length >= 2 && j.cost > 0));
  const v = await friend.c('GET', `/api/groups/${gid}/plans/current/venues`);
  assert.equal(v.json.venues.radiusKm, 2.5);
});
test('API rate limits return 429 with Retry-After', async () => {
  const c = client(); let last;
  for (let i = 0; i < 12; i++) last = await c('POST', '/api/auth/register', { email: `rl${i}@example.test`, password: 'correct horse battery', displayName: 'R' }, {});
  const env = []; for (let i = 0; i < 12; i++) env.push((await app.handle({ method: 'POST', path: '/api/auth/register', ip: '9.9.9.9', body: { email: `ip${i}@example.test`, password: 'correct horse battery', displayName: 'R' }, headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' } })));
  assert.equal(env[10].status, 429); assert.equal(env[10].headers['Retry-After'], '60');
  assert.ok(last);
});
test('cookie parser tolerates junk', () => {
  assert.deepEqual(parseCookies('a=1; mm_session=abc%20d; bad; =x'), { a: '1', mm_session: 'abc d' });
  assert.deepEqual(parseCookies('mm_session=%E0%A4%A; ok=1'), { ok: '1' });
});

import { adaptRequest } from '../api/index.js';
test('Vercel adapter: restores the original API path from the rewrite parameter and strips it from the query', () => {
  const r = adaptRequest({ method: 'GET', url: '/api/index?__path=groups%2F123%2Fplans&refresh=1', headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: {} });
  assert.equal(r.path, '/api/groups/123/plans'); assert.deepEqual(r.query, { refresh: '1' }); assert.equal(r.ip, '203.0.113.9');
  assert.equal(adaptRequest({ method: 'GET', url: '/api/index?__path=health', headers: {}, socket: {} }).path, '/api/health');
  assert.equal(adaptRequest({ method: 'GET', url: '/api/health', headers: {}, socket: { remoteAddress: '1.1.1.1' } }).path, '/api/health');
  assert.equal(adaptRequest({ method: 'POST', url: '/api/x', headers: {}, socket: {}, body: 'raw' }).body, 'raw'); // string bodies are passed on and rejected by the pipeline
});
test('vercel.json keeps the original deployment settings and adds API + CSP only for /app', async () => {
  const { readFileSync } = await import('node:fs');
  const v = JSON.parse(readFileSync('vercel.json', 'utf8'));
  assert.equal(v.buildCommand, 'npm run build'); assert.equal(v.outputDirectory, 'dist'); assert.equal(v.framework, null); assert.equal(v.cleanUrls, true);
  assert.deepEqual(v.rewrites, [{ source: '/api/:path*', destination: '/api/index?__path=:path*' }]);
  const all = v.headers.find(x => x.source === '/(.*)').headers.map(h => h.key);
  for (const k of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) assert.ok(all.includes(k), `original header ${k} preserved`);
  const csp = v.headers.find(x => x.source === '/app/(.*)').headers[0].value;
  assert.ok(/script-src 'self'/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp));
  assert.ok(!v.headers.some(x => x.source === '/(.*)' && x.headers.some(h => h.key === 'Content-Security-Policy')), 'classic page must not receive the strict CSP');
});

test('maintenance endpoint: hidden unless CRON_SECRET matches; account/group deletion over HTTP', async () => {
  const withSecret = await createApp({ db, config: loadConfig({ APP_BASE_URL: 'http://localhost:3000', CRON_SECRET: 'test-cron-secret' }), providers: { roadRouting: fakeRouting() } });
  const call = (a, headers) => a.handle({ method: 'GET', path: '/api/maintenance', ip: 'c', headers });
  assert.equal((await call(withSecret, {})).status, 404);
  assert.equal((await call(withSecret, { authorization: 'Bearer wrong' })).status, 404);
  const ok = await call(withSecret, { authorization: 'Bearer test-cron-secret' }); assert.equal(ok.status, 200); assert.ok('expiredGroups' in JSON.parse(ok.body));
  assert.equal((await call(app, { authorization: 'Bearer test-cron-secret' })).status, 404);          // secret not configured → feature off
  const { c } = await signup('Gone');
  const g = (await c('POST', '/api/groups', { name: 'Tmp', mode: 'METRO', origin: metro('Majestic') })).json.group.id;
  assert.equal((await c('DELETE', `/api/groups/${g}`)).status, 409);                                    // must cancel first
  await c('POST', `/api/groups/${g}/cancel`, {}); assert.equal((await c('DELETE', `/api/groups/${g}`)).status, 200);
  assert.equal((await c('DELETE', '/api/me', { password: 'nope nope nope' })).status, 401);
  assert.equal((await c('DELETE', '/api/me', { password: 'correct horse battery' })).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 401);
});

test('GET /api/session: 200 with user:null when signed out, the user when signed in (no 401 noise for the web app)', async () => {
  const anon = await client()('GET', '/api/session'); assert.equal(anon.status, 200); assert.equal(anon.json.user, null);
  const { c, user } = await signup('Sess'); const r = await c('GET', '/api/session'); assert.equal(r.json.user.id, user.id);
  assert.ok(!/password|hash/i.test(r.raw));
});
