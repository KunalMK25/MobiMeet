import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fmt, minutes, rupees, deltaText, ago, projector } from '../app/format.js';
import { parseCoordinate, stationOrigin, describeOrigin } from '../app/origin.js';
import { createPlanCache, STALE_AFTER_MS } from '../app/offline.js';

test('formatting: numbers, money, minutes; null is never shown as 0', () => {
  assert.equal(fmt(12), '12'); assert.equal(fmt(12.34), '12.3'); assert.equal(fmt(null), '—');
  assert.equal(minutes(null), '—'); assert.equal(minutes(7.5), '7.5 min');
  assert.equal(rupees(null), 'n/a'); assert.equal(rupees(40), '₹40'); assert.equal(rupees(40.5), '₹40.50');
});
test('deltaText uses words and arrows, not just colour', () => {
  assert.equal(deltaText(-3.5), '▼ −3.5 min (better)'); assert.equal(deltaText(2), '▲ +2 min (worse)');
  assert.equal(deltaText(0), 'no change'); assert.equal(deltaText(null), 'n/a');
  assert.equal(deltaText(-10, '₹'), '▼ −₹10 (better)'); assert.equal(deltaText(5, 'min', { lowerIsBetter: false }), '▲ +5 min (better)');
});
test('ago()', () => { assert.equal(ago(0, 30e3), 'just now'); assert.equal(ago(0, 5 * 60e3), '5 min ago'); assert.equal(ago(0, 3 * 3600e3), '3 h ago'); assert.equal(ago(0, 2 * 86400e3), '2 d ago'); });
test('projector keeps every point inside the canvas with padding and preserves orientation (north is up)', () => {
  const pts = [[12.90, 77.50], [13.00, 77.70], [12.95, 77.60]];
  const P = projector(pts, 640, 360, 24);
  for (const p of pts) { const [x, y] = P(p); assert.ok(x >= 24 - 1e-6 && x <= 616 + 1e-6 && y >= 24 - 1e-6 && y <= 336 + 1e-6); }
  assert.ok(P([13.0, 77.6])[1] < P([12.9, 77.6])[1]);   // higher latitude → smaller y
  assert.ok(P([12.95, 77.7])[0] > P([12.95, 77.5])[0]); // larger longitude → larger x
  const single = projector([[12.9, 77.5]], 100, 100); assert.ok(single([12.9, 77.5]).every(Number.isFinite)); // degenerate: one point
});
test('origin parsing: validates numbers, ranges and the Bengaluru service area', () => {
  assert.deepEqual(parseCoordinate('12.9716', '77.5946'), { origin: { lat: 12.9716, lon: 77.5946 } });
  for (const [a, b] of [['', '77'], ['abc', '77'], ['91', '77'], ['12.9', '181'], ['28.6', '77.2'], ['12.9', '77.0']]) assert.ok(parseCoordinate(a, b).error, `${a},${b}`);
  const stations = [{ id: 'stn_mg_road', name: 'MG Road' }];
  assert.deepEqual(stationOrigin(stations, ' mg road '), { origin: { stationId: 'stn_mg_road', label: 'MG Road' } });
  assert.ok(stationOrigin(stations, 'Nowhere').error);
  assert.equal(describeOrigin(null), 'Not set'); assert.equal(describeOrigin({ lat: 12.97164, lon: 77.59456 }), '12.9716, 77.5946'); assert.equal(describeOrigin({ label: 'Home' }), 'Home');
});
// Minimal standards-shaped Storage (length/key/getItem/setItem/removeItem).
function storageMock() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _m: m };
}
test('saved-plan cache: timestamped, flags staleness, tolerates corrupt data and storage failure, clears only its own keys on sign-out', () => {
  let t = 1000; const st = storageMock(); const c = createPlanCache(st, () => t);
  assert.equal(c.load('g1'), null);
  assert.ok(c.save('g1', { id: 'p' })); const fresh = c.load('g1');
  assert.equal(fresh.savedAt, 1000); assert.equal(fresh.stale, false); assert.equal(fresh.plan.id, 'p');
  t += STALE_AFTER_MS + 1; assert.equal(c.load('g1').stale, true);
  st.setItem('mm.plan.bad', '{not json'); assert.equal(c.load('bad'), null);
  st.setItem('other.app', 'keep'); c.save('g2', {});
  c.clearAll(); assert.deepEqual([...st._m.keys()], ['other.app']);
  assert.equal(createPlanCache({ setItem() { throw new Error('quota'); }, getItem() { throw new Error('x'); } }).save('g', {}), false);
});
test('service worker precache list covers every file in app/ (offline shell is complete)', () => {
  const sw = readFileSync('sw.js', 'utf8'); const listed = new Set([...sw.matchAll(/'(\/app\/[^']*)'/g)].map(m => m[1]));
  const walk = (d) => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]);
  for (const f of walk('app')) { const u = '/' + f; assert.ok(listed.has(u), `sw.js does not precache ${u}`); }
  assert.ok(/pathname\.startsWith\('\/api\/'\)\) return/.test(sw), 'service worker must never touch /api responses');
});
test('no innerHTML / eval / document.write anywhere in the web app', () => {
  const walk = (d) => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]);
  for (const f of walk('app').filter(x => x.endsWith('.js'))) { const s = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(s), `${f} uses an unsafe sink`); }
});

import { routePoints, fitTransform, boundsOf } from '../app/metroGeometry.js';
test('metro map geometry: unknown stations are skipped, bounds crop to the trip, transform keeps points inside the canvas', () => {
  const pos = { A: { x: 100, y: 100 }, B: { x: 300, y: 200 } };
  assert.deepEqual(routePoints(['A', 'Z', 'B'], pos), [pos.A, pos.B]); assert.deepEqual(routePoints(undefined, pos), []);
  const b = boundsOf([pos.A, pos.B], 50); assert.deepEqual(b, { x0: 50, y0: 50, w: 300, h: 200 });
  assert.deepEqual(boundsOf([], 50), { x0: 0, y0: 0, w: 1000, h: 1000 });
  assert.deepEqual(boundsOf([{ x: 5, y: 5 }], 50), { x0: 0, y0: 0, w: 55, h: 55 });                 // clamped to the grid
  const fit = fitTransform(b.w, b.h, 640, 420, 12);
  for (const p of [pos.A, pos.B]) { const [x, y] = fit({ x: p.x - b.x0, y: p.y - b.y0 }); assert.ok(x >= 12 - 1e-9 && x <= 628 + 1e-9 && y >= 12 - 1e-9 && y <= 408 + 1e-9); }
});
