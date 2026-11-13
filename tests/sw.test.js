// Executes the real sw.js in a sandbox with mocked ServiceWorker globals (a real registration cannot be observed in CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadSw({ network = {}, cachedUrls = [] } = {}) {
  const listeners = {}, store = new Map(cachedUrls.map(u => [u, new Response(`cached:${u}`)])), fetched = [];
  const cache = { add: async (u) => { if (network[u] === 'fail') throw new Error('x'); store.set(u, new Response(`pre:${u}`)); }, match: async (req) => store.get(typeof req === 'string' ? req : req.url.replace('http://localhost', '')) ?? store.get(req.url) ?? undefined,
    put: async (req, res) => { store.set(req.url.replace('http://localhost', ''), res); } };
  const caches = { open: async () => cache, keys: async () => ['mobimeet-shell-v0', 'mobimeet-shell-v1', 'other'], delete: async (k) => { caches.deleted.push(k); return true; }, deleted: [] };
  const self = { addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting: async () => { self.skipped = true; }, clients: { claim: async () => { self.claimed = true; } } };
  const ctx = { self, caches, location: { origin: 'http://localhost' }, URL, Response, Promise, fetch: async (req) => { fetched.push(req.url); if (network.offline) throw new Error('offline'); return new Response('net:' + req.url); } };
  vm.runInNewContext(readFileSync('sw.js', 'utf8'), ctx);
  const dispatch = async (type, extra = {}) => { let p; listeners[type]({ ...extra, waitUntil: (x) => { p = x; }, respondWith: (x) => { p = x; extra.__responded = true; } }); return p && await p; };
  return { listeners, store, caches, self, fetched, dispatch };
}
const req = (path, method = 'GET', origin = 'http://localhost') => ({ url: origin + path, method });

test('install precaches the shell tolerantly (one failing file does not abort) and activates immediately', async () => {
  const sw = loadSw({ network: { '/app/app.css': 'fail' } });
  await sw.dispatch('install');
  assert.ok(sw.store.has('/app/main.js') && sw.store.has('/app/') && sw.store.has('/')); assert.ok(!sw.store.has('/app/app.css')); assert.equal(sw.self.skipped, true);
});
test('activate removes old caches only, then claims clients', async () => {
  const sw = loadSw(); await sw.dispatch('activate');
  assert.deepEqual(sw.caches.deleted.sort(), ['mobimeet-shell-v0', 'other']); assert.equal(sw.self.claimed, true);
});
test('API responses, non-GET requests and cross-origin requests are never intercepted or cached', async () => {
  const sw = loadSw();
  for (const r of [req('/api/groups'), req('/api/me'), req('/app/main.js', 'POST'), req('/x.js', 'GET', 'https://evil.example')]) {
    const e = { request: r }; sw.listeners.fetch({ ...e, respondWith: () => { e.__responded = true; } }); assert.ok(!e.__responded, `${r.method} ${r.url} must pass through`);
  }
  assert.ok(![...sw.store.keys()].some(k => k.startsWith('/api')));
});
test('static files: cached copy is served instantly and refreshed in the background; offline falls back to cache, then to 503', async () => {
  const sw = loadSw({ cachedUrls: ['/app/main.js'] });
  const hit = await sw.dispatch('fetch', { request: req('/app/main.js') }); assert.equal(await hit.text(), 'cached:/app/main.js');
  await new Promise(r => setTimeout(r, 5)); assert.ok(sw.fetched.includes('http://localhost/app/main.js'), 'background revalidation happened');
  const miss = await sw.dispatch('fetch', { request: req('/app/new.js') }); assert.equal(await miss.text(), 'net:http://localhost/app/new.js');
  const off = loadSw({ network: { offline: true } }); const res = await off.dispatch('fetch', { request: req('/app/unknown.js') });
  assert.equal(res.status, 503);
});
