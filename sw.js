// MobiMeet service worker — offline app shell only.
// • Static files: stale-while-revalidate with a cache fallback (so the shell and the classic planner open offline).
// • /api/*: NEVER cached here (responses are private). Saved plans live in localStorage (see app/offline.js).
const CACHE = 'mobimeet-shell-v1';
const SHELL = ['/app/', '/app/index.html', '/app/app.css', '/app/main.js', '/app/api.js', '/app/dom.js', '/app/format.js', '/app/offline.js', '/app/origin.js', '/app/metroGeometry.js',
  '/app/views/auth.js', '/app/views/modeSelect.js', '/app/views/chat.js', '/src/config/Limits.js', '/app/views/coordination.js', '/app/views/dashboard.js', '/app/views/group.js', '/app/views/join.js', '/app/views/mapCanvas.js', '/app/views/metroMap.js', '/app/views/originPicker.js', '/app/views/plan.js', '/app/views/prefs.js', '/app/views/profile.js', '/app/views/whatif.js', '/'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(e.request);
    const net = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }));
});
