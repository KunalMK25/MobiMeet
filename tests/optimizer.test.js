import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupMetrics, minMaxNormaliser } from '../src/optimizer/fairness.js';
import { optimizeGroup } from '../src/optimizer/groupOptimizer.js';
import { sensitivityWeights } from '../src/optimizer/strategies.js';
import { optimizeMetroGroup } from '../src/optimizer/metroOptimizer.js';
import { findAccessStations } from '../src/optimizer/metroEngine.js';
import { buildGraph } from '../src/core/graph.js';
import { buildAgentInput } from '../src/domain/participant.js';
import { stationIdFor } from '../src/data/station-ids.js';
import { ST } from '../src/data/stations.js';

const NOW = Date.parse('2026-11-13T12:00:00+05:30');
const P = (id, key, extra = {}) => buildAgentInput({ participantId: id, mode: 'METRO', origin: { lat: ST[key].la, lon: ST[key].lo, stationId: stationIdFor(key) }, ...extra });

test('groupMetrics: values, jain bounds and edge cases', () => {
  const m = groupMetrics([10, 20, 30]);
  assert.deepEqual([m.mean, m.min, m.max, m.range, m.total], [20, 10, 30, 20, 60]);
  assert.equal(m.stdDev, 8.2);
  assert.equal(m.jain, 0.857); // 60² / (3 · 1400)
  assert.equal(groupMetrics([15, 15, 15]).jain, 1);
  assert.equal(groupMetrics([]).jain, 1);
  assert.equal(groupMetrics([0, 0]).jain, 1);
  assert.equal(groupMetrics([40, 0, 0, 0]).jain, 0.25); // 1/n: one person bears everything
});
test('minMaxNormaliser: constant metric normalises to 0', () => {
  const n = minMaxNormaliser([5, 5]); assert.equal(n(5), 0);
  const k = minMaxNormaliser([0, 10]); assert.equal(k(5), 0.5);
});

// A hand-checkable synthetic problem: 3 candidates, 2 people.
const people = [{ participantId: 'a' }, { participantId: 'b' }];
const table = { X: { a: 10, b: 40 }, Y: { a: 30, b: 30 }, Z: { a: 5, b: 70 } };
const cand = ['X', 'Y', 'Z'].map(id => ({ id, label: id }));
const ev = (p, c) => ({ timeMin: table[c.id][p.participantId], burdenMin: table[c.id][p.participantId], cost: table[c.id][p.participantId] / 10, interchanges: 0, distanceKm: null });

test('balanced minimises the worst burden (Y), fastest minimises total (X)', () => {
  assert.equal(optimizeGroup({ participants: people, candidates: cand, evaluate: ev, strategy: 'balanced' }).recommended.id, 'Y');
  assert.equal(optimizeGroup({ participants: people, candidates: cand, evaluate: ev, strategy: 'fastest' }).recommended.id, 'X');
  assert.equal(optimizeGroup({ participants: people, candidates: cand, evaluate: ev, strategy: 'cheapest' }).recommended.id, 'X');
});
test('tie-breaking is by candidate id and deterministic', () => {
  const tie = () => ({ timeMin: 20, burdenMin: 20, cost: 2, interchanges: 0, distanceKm: null });
  const r = optimizeGroup({ participants: people, candidates: [{ id: 'B', label: 'B' }, { id: 'A', label: 'A' }], evaluate: tie });
  assert.deepEqual(r.ranked.map(c => c.id), ['A', 'B']);
});
test('hard constraints and unreachable candidates are rejected with reasons', () => {
  const ps = [{ participantId: 'a', hardConstraints: { maxTravelMinutes: 40 } }, { participantId: 'b' }];
  const r = optimizeGroup({ participants: ps, candidates: [...cand, { id: 'U', label: 'U' }], evaluate: (p, c) => (c.id === 'U' ? null : ev(p, c)), strategy: 'balanced' });
  assert.equal(r.rejected.find(x => x.id === 'U').reason.code, 'UNREACHABLE');
  assert.equal(r.recommended.id, 'Y');
  const none = optimizeGroup({ participants: [{ participantId: 'a', hardConstraints: { maxTravelMinutes: 1 } }, { participantId: 'b' }], candidates: cand, evaluate: ev });
  assert.equal(none.recommended, null); assert.ok(none.warnings.includes('NO_FEASIBLE_CANDIDATE'));
});
test('missing cost: cost left out of balanced_time_cost, cheapest unavailable', () => {
  const noCost = (p, c) => ({ ...ev(p, c), cost: null });
  const r = optimizeGroup({ participants: people, candidates: cand, evaluate: noCost, strategy: 'balanced_time_cost' });
  assert.ok(r.warnings.includes('COST_UNAVAILABLE'));
  assert.equal(r.recommended.scoreBreakdown.weights.cost, 0);
  assert.ok(!('cheapest' in r.bestBy));
  assert.throws(() => optimizeGroup({ participants: people, candidates: cand, evaluate: noCost, strategy: 'cheapest' }));
});
test('group size and duplicate participants are validated', () => {
  assert.throws(() => optimizeGroup({ participants: [people[0]], candidates: cand, evaluate: ev }), /needs 2-12/);
  assert.throws(() => optimizeGroup({ participants: [people[0], people[0]], candidates: cand, evaluate: ev }));
});
test('sensitivity weights sum to 1 and shift toward the stated preference', () => {
  const costly = sensitivityWeights([{ softPreferences: { costSensitivity: 0.9, timeSensitivity: 0.1 } }]);
  const timely = sensitivityWeights([{ softPreferences: { costSensitivity: 0.1, timeSensitivity: 0.9 } }]);
  for (const w of [costly, timely]) assert.ok(Math.abs(w.max + w.total + w.cost + w.ix - 1) < 1e-12);
  assert.ok(costly.cost > timely.cost && timely.max > costly.max);
});

test('Metro: end-to-end group is deterministic and reproducible', () => {
  const ps = [P('p1', 'Whitefield'), P('p2', 'Challaghatta'), P('p3', 'Silk Institute')];
  const a = optimizeMetroGroup(ps, { now: NOW }), b = optimizeMetroGroup(ps, { now: NOW });
  assert.deepEqual(a, b);
  assert.ok(a.recommended && a.recommended.journeys.length === 3);
  assert.ok(a.recommended.journeys.every(j => j.detail.access.approx === false && j.detail.access.walkMin === 0));
  assert.ok(a.explanation.lines.length >= 3);
  assert.ok(a.explanation.limitations.length >= 2);
});
test('Metro: balanced recommendation has the smallest max burden of all feasible candidates', () => {
  const ps = [P('p1', 'Whitefield'), P('p2', 'Kengeri'), P('p3', 'Yelachenahalli'), P('p4', 'Bommasandra')];
  const r = optimizeMetroGroup(ps, { now: NOW });
  const best = Math.min(...r.ranked.map(c => c.metrics.burden.max));
  assert.equal(r.recommended.metrics.burden.max, best);
});
test('Metro: coordinate origin evaluates several access stations, not just the nearest', () => {
  const net = buildGraph(NOW);
  const acc = findAccessStations({ lat: 12.9784, lon: 77.6408 }, net); // near Indiranagar
  assert.ok(acc.length >= 2 && acc.every(a => a.approx));
  assert.equal(acc[0].station, 'Indiranagar');
  assert.ok(acc.every((a, i) => i === 0 || a.distanceKm >= acc[i - 1].distanceKm));
});
test('Metro: far-away origin is flagged, not silently mapped', () => {
  const acc = findAccessStations({ lat: 13.5, lon: 77.0 }, buildGraph(NOW));
  assert.equal(acc.length, 1); assert.equal(acc[0].farFromNetwork, true);
});
test('Metro: a station that is not operational yet (Pink Phase 1 the day before activation) is rejected', () => {
  const DAY_BEFORE = Date.parse('2026-11-12T12:00:00+05:30');
  assert.throws(() => optimizeMetroGroup([P('p1', 'Kalena Agrahara'), P('p2', 'Majestic')], { now: DAY_BEFORE }), /not currently operational/);
  assert.ok(optimizeMetroGroup([P('p1', 'Kalena Agrahara'), P('p2', 'Majestic')], { now: NOW }).recommended);   // operational on 13 Nov
});
test('Metro: Pink participants route through Jayadeva once open', () => {
  const OPEN = Date.parse('2026-11-14T06:00:00+05:30');
  const r = optimizeMetroGroup([P('p1', 'Kalena Agrahara'), P('p2', 'Majestic')], { now: OPEN });
  const j = r.recommended.journeys.find(x => x.participantId === 'p1');
  const atMajestic = r.ranked.find(c => c.label === 'Majestic').journeys.find(x => x.participantId === 'p1');
  assert.deepEqual(atMajestic.detail.linesUsed, ['Pink', 'Yellow', 'Green']);
  assert.deepEqual(atMajestic.detail.interchangeStations, ['Jayadeva Hospital', 'RV Road']);
  assert.equal(atMajestic.timeMin, 35); // matches the hand-computed Dijkstra route in network.test.js
  assert.equal(j.participantId, 'p1');
});
test('Metro: a mixed-mode participant is rejected', () => {
  const bike = buildAgentInput({ participantId: 'b', mode: 'BIKE', origin: { lat: 12.97, lon: 77.59 } });
  assert.throws(() => optimizeMetroGroup([P('p1', 'Majestic'), bike], { now: NOW }), /match the group/);
});
test('Metro: same-station participants pay no fare and no time', () => {
  const r = optimizeMetroGroup([P('p1', 'MG Road'), P('p2', 'MG Road')], { now: NOW });
  assert.equal(r.recommended.label, 'MG Road');
  assert.equal(r.recommended.metrics.costTotal, 0);
});
test('Metro: avoidInterchanges raises burden only when transfers are used', () => {
  const plain = [P('p1', 'Whitefield'), P('p2', 'Silk Institute')];
  const avoid = [P('p1', 'Whitefield', { softPreferences: { avoidInterchanges: true } }), P('p2', 'Silk Institute', { softPreferences: { avoidInterchanges: true } })];
  const a = optimizeMetroGroup(plain, { now: NOW }), b = optimizeMetroGroup(avoid, { now: NOW });
  assert.ok(b.recommended.metrics.interchangeTotal <= a.recommended.metrics.interchangeTotal);
});
