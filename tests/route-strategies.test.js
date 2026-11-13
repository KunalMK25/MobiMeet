import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK } from '../src/data/network.js';
import { ST } from '../src/data/stations.js';
import { stationIdFor } from '../src/data/station-ids.js';
import { createMetroEngine, ROUTE_STRATEGIES } from '../src/optimizer/metroEngine.js';
import { optimizeMetroGroup } from '../src/optimizer/metroOptimizer.js';
import { realPathCost, getDetailedPath } from '../src/core/routing.js';
import { buildGraph } from '../src/core/graph.js';
import { dijkstra } from '../src/core/dijkstra.js';
import { buildAgentInput } from '../src/domain/participant.js';
import { validateRouteStrategy } from '../src/services/validation.js';

const NOW = Date.parse('2026-11-13T12:00:00+05:30');
const P = (k, id = 'p') => buildAgentInput({ participantId: id, mode: 'METRO', origin: { lat: ST[k].la, lon: ST[k].lo, stationId: stationIdFor(k) } });
const run = (a, b, rs, now = NOW) => { const e = createMetroEngine({ now, routeStrategy: rs }); return e.evaluate(P(a), e.candidates.find(c => c.key === b)); };

test('today the network is a tree (unique routes), so every strategy returns the identical journey', () => {
  for (const [a, b] of [['Whitefield', 'Silk Institute'], ['Kengeri', 'Bommasandra'], ['Majestic', 'Hoodi']]) {
    const [f, t, l] = ['fastest', 'fewest_transfers', 'lowest_fare'].map(s => run(a, b, s));
    assert.deepEqual([t.timeMin, t.interchanges, t.cost], [f.timeMin, f.interchanges, f.cost]); assert.deepEqual([l.timeMin, l.interchanges, l.cost], [f.timeMin, f.interchanges, f.cost]);
  }
});
test('reported minutes are always the REAL cost of the chosen path (equal to Dijkstra for "fastest")', () => {
  const net = buildGraph(NOW);
  for (const [a, b] of [['Whitefield', 'Silk Institute'], ['Challaghatta', 'Bommasandra']]) {
    const d = dijkstra(a, net); assert.equal(run(a, b, 'fastest').timeMin, d.dist[b]);
    assert.equal(realPathCost(getDetailedPath(d, a, b)), d.dist[b]);
  }
});
test('unknown route strategy is rejected by the engine and by input validation', () => {
  assert.throws(() => createMetroEngine({ now: NOW, routeStrategy: 'scenic' }), /Unknown route strategy/);
  assert.throws(() => validateRouteStrategy('scenic'), /Unknown route strategy/); assert.equal(validateRouteStrategy(undefined), 'fastest');
  assert.deepEqual(Object.keys(ROUTE_STRATEGIES), ['fastest', 'fewest_transfers', 'lowest_fare']);
});

describe('with the Pink underground section hypothetically open (a network with a cycle)', () => {
// ── a FUTURE network with a cycle (Pink underground open), built by temporarily adding the missing station records ──
  const ADDED = [['Dairy Circle', 12.9390, 77.6030], ['Lakkasandra', 12.9440, 77.6000], ['Langford Town', 12.9540, 77.5970], ['National Military School', 12.9640, 77.6000]];
  let savedStatus; const FAR = Date.parse('2030-01-01T00:00:00Z');
  before(() => { savedStatus = NETWORK.Pink.sections[1].status; NETWORK.Pink.sections[1].status = 'open'; for (const [n, la, lo] of ADDED) ST[n] = { la, lo, li: 'Pink', co: '#ec4899', op: 0 }; });
  after(() => { NETWORK.Pink.sections[1].status = savedStatus; for (const [n] of ADDED) delete ST[n]; });

  test('with an alternative route available, strategies make different, correctly-ordered trade-offs', () => {
    const stations = ['Indiranagar', 'Whitefield', 'Kengeri', 'Hoodi', 'Lakkasandra', 'Jayadeva Hospital', 'Ragigudda', 'BTM Layout', 'Majestic', 'Bommasandra', 'Silk Institute'];
    let fareBetter = 0, pairs = 0;
    for (const a of stations) for (const b of stations) {
      if (a === b) continue; pairs++;
      const f = run(a, b, 'fastest', FAR), t = run(a, b, 'fewest_transfers', FAR), l = run(a, b, 'lowest_fare', FAR);
      assert.ok(f.timeMin <= t.timeMin && f.timeMin <= l.timeMin, `${a}→${b}: fastest must be fastest`);
      assert.ok(t.interchanges <= f.interchanges && t.interchanges <= l.interchanges, `${a}→${b}: fewest_transfers must have the fewest`);
      assert.ok(l.detail.stopCount <= f.detail.stopCount && l.detail.stopCount <= t.detail.stopCount, `${a}→${b}: lowest_fare must travel the fewest stops`);
      assert.ok(l.cost <= f.cost && l.cost <= t.cost, `${a}→${b}: lowest_fare must be the cheapest`);
      if (l.detail.stopCount < f.detail.stopCount) fareBetter++;
    }
    assert.ok(pairs > 100); assert.ok(fareBetter >= 1, 'at least one pair where lowest_fare really differs');
    const k = (s) => run('Kengeri', 'Jayadeva Hospital', s, FAR);
    assert.ok(k('lowest_fare').detail.stopCount < k('fastest').detail.stopCount && k('lowest_fare').timeMin > k('fastest').timeMin);   // cheaper-by-stops but slower: a genuine trade-off
  });
  test('the group optimiser carries the route strategy into its result', () => {
    const r = optimizeMetroGroup([P('Kengeri', 'a'), P('Indiranagar', 'b')], { now: FAR, routeStrategy: 'lowest_fare' });
    assert.equal(r.routeStrategy, 'lowest_fare'); assert.ok(r.recommended.journeys.every(j => j.detail.routeStrategy === 'lowest_fare'));
    assert.equal(optimizeMetroGroup([P('Kengeri', 'a'), P('Indiranagar', 'b')], { now: FAR }).routeStrategy, 'fastest');
  });

});
