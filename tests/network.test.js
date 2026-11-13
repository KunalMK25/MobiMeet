import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK, LINE_NAMES, isSectionActive, activeEdges, activeChains, activeSequence, activeLinesAt } from '../src/data/network.js';
import { ST } from '../src/data/stations.js';
import { buildGraph } from '../src/core/graph.js';
import { dijkstra } from '../src/core/dijkstra.js';
import { getPath, getDetailedPath, detectInterchanges } from '../src/core/routing.js';
import { findOptimal } from '../src/core/optimization.js';

const BEFORE = Date.parse('2026-11-12T12:00:00+05:30'); // the day before Pink Phase 1 is operational
const OPENING = Date.parse('2026-11-13T00:00:00+05:30'); // exact activation instant (project requirement: operational as of 13 Nov 2026)
const FAR = Date.parse('2030-01-01T00:00:00+05:30');     // underground section is still not 'open' by status
const net = (now) => buildGraph(now);

test('station counts per line match the published lists (2026-11-13)', () => {
  assert.equal(NETWORK.Purple.stations.length, 37);
  assert.equal(NETWORK.Green.stations.length, 32);
  assert.equal(NETWORK.Yellow.stations.length, 16);
  assert.equal(NETWORK.Pink.stations.length, 18);
});

test('no duplicate station within a line; every operational station has a record', () => {
  for (const l of LINE_NAMES) {
    const s = NETWORK[l].stations;
    assert.equal(new Set(s).size, s.length, `${l} has duplicate stations`);
  }
  for (const l of LINE_NAMES) for (const s of activeSequence(l, FAR)) {
    assert.ok(ST[s], `${l}: ${s} missing from ST`);
    assert.equal(typeof ST[s].la, 'number');
    assert.equal(typeof ST[s].lo, 'number');
  }
});

test('Green line order fixes: Sampige Road after Srirampura, Banashankari before JP Nagar, Vajarahalli included', () => {
  const g = NETWORK.Green.stations, i = (n) => g.indexOf(n);
  assert.ok(i('Srirampura') < i('Sampige Road') && i('Sampige Road') < i('Majestic'));
  assert.ok(i('Rajajinagar') < i('Kuvempu Road') && i('Kuvempu Road') < i('Srirampura'));
  assert.ok(i('RV Road') < i('Banashankari') && i('Banashankari') < i('JP Nagar') && i('JP Nagar') < i('Yelachenahalli'));
  assert.ok(i('Doddakallasandra') < i('Vajarahalli') && i('Vajarahalli') < i('Thalaghattapura'));
});

test('sections: contiguous coverage, provenance fields present, honest verification labels', () => {
  for (const l of LINE_NAMES) {
    const { stations, sections } = NETWORK[l];
    assert.equal(sections[0].from, stations[0]);
    assert.equal(sections.at(-1).to, stations.at(-1));
    sections.forEach((s, k) => {
      if (k) assert.equal(s.from, sections[k - 1].to, `${l} sections must share a boundary station`);
      assert.ok(stations.includes(s.from) && stations.includes(s.to));
      assert.ok(s.source && s.verifiedOn && ['official', 'secondary', 'unverified'].includes(s.verification));
      assert.notEqual(s.verification, 'official', 'nothing is marked official until checked against BMRCL');
    });
  }
});

test('section activation is time-driven and boundary-inclusive', () => {
  const pinkElevated = NETWORK.Pink.sections[0];
  assert.equal(isSectionActive(pinkElevated, OPENING - 1), false);
  assert.equal(isSectionActive(pinkElevated, OPENING), true);
  assert.equal(isSectionActive(NETWORK.Pink.sections[1], FAR), false);
});

test('Pink before opening: no Pink edges, no Pink nodes, stations unreachable', () => {
  assert.deepEqual(activeEdges('Pink', BEFORE), []);
  const n = net(BEFORE);
  assert.ok(!Object.keys(n.graph).some(id => id.endsWith('::Pink')));
  const d = dijkstra('Kalena Agrahara', n);
  assert.ok(!Number.isFinite(d.dist['Majestic'] ?? Infinity));
  assert.deepEqual(activeLinesAt('Jayadeva Hospital', BEFORE), ['Yellow']);
});

test('Pink after opening: elevated section only (6 stations), underground excluded', () => {
  assert.deepEqual(activeSequence('Pink', OPENING),
    ['Kalena Agrahara', 'Hulimavu', 'Bilekahalli IIMB', 'JP Nagar 4th Phase', 'Jayadeva Hospital', 'Tavarekere']);
  assert.equal(activeChains('Pink', OPENING).length, 1);
  const n = net(FAR);
  assert.ok(!('Dairy Circle::Pink' in n.graph));
  assert.ok(!n.graph['Tavarekere::Pink'].some(e => e.station === 'Dairy Circle'));
  assert.deepEqual(activeLinesAt('Jayadeva Hospital', OPENING).sort(), ['Pink', 'Yellow']);
});

test('Pink routes: same-line trip, interchange at Jayadeva, multi-interchange to Majestic', () => {
  const n = net(OPENING);
  const d = dijkstra('Kalena Agrahara', n);
  assert.equal(d.dist['Jayadeva Hospital'], 8);          // 4 hops x 2 min, no transfer
  assert.equal(d.ixCnt['Jayadeva Hospital'], 0);
  assert.equal(d.dist['BTM Layout'], 15);                // 8 + 5 (default transfer) + 2
  assert.equal(d.ixCnt['BTM Layout'], 1);
  assert.equal(d.dist['Majestic'], 35);                  // 8 +5 +4 (to RV Road) +4 (RV Road transfer) +14 (7 Green hops)
  assert.equal(d.ixCnt['Majestic'], 2);
  const detailed = getDetailedPath(d, 'Kalena Agrahara', 'Majestic');
  assert.deepEqual(detectInterchanges(detailed).map(x => x.station), ['Jayadeva Hospital', 'RV Road']);
  assert.deepEqual(getPath(d, 'Kalena Agrahara', 'Tavarekere').at(-1), 'Tavarekere');
});

test('Pink Line does not change pre-existing routes (regression)', () => {
  for (const now of [BEFORE, OPENING]) {
    const d = dijkstra('Whitefield', net(now));
    assert.equal(d.dist['Majestic'], 44);                 // 22 hops
    assert.equal(d.dist['Silk Institute'], 81);           // 44 + 7 (Majestic transfer) + 15 hops x 2
    assert.equal(d.ixCnt['Silk Institute'], 1);
    assert.equal(dijkstra('Hosahalli', net(now)).dist['Hosahalli'], 0);
  }
});

test('same-line routing never pays a transfer penalty', () => {
  const d = dijkstra('Madavara', net(BEFORE));
  assert.equal(d.dist['RV Road'], 46);                    // 23 Green hops, passing through Majestic
  assert.equal(d.ixCnt['RV Road'], 0);
});

test('optimizer is deterministic and returns an operational station', () => {
  const friends = ['Whitefield', 'Challaghatta', 'Silk Institute'];
  const a = findOptimal(friends), b = findOptimal(friends);
  assert.ok(a && ST[a.key].op);
  assert.equal(a.key, b.key);
  assert.deepEqual(a.costs, b.costs);
});

import { STATION_ID_BY_KEY, STATION_KEY_BY_ID, stationIdFor, stationKeyFor } from '../src/data/station-ids.js';

test('stable station IDs: unique, well-formed, cover every known station, round-trip', () => {
  const known = new Set([...Object.keys(ST), ...Object.values(NETWORK).flatMap(l => l.stations)]);
  for (const k of known) assert.ok(STATION_ID_BY_KEY[k], `no id for ${k}`);
  const ids = Object.values(STATION_ID_BY_KEY);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => /^stn_[a-z0-9_]+$/.test(id)));
  assert.equal(Object.keys(STATION_KEY_BY_ID).length, ids.length);
  assert.equal(stationKeyFor(stationIdFor('MG Road')), 'MG Road');
  assert.equal(stationIdFor('Nope'), null);
});
