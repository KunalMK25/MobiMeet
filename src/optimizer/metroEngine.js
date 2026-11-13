// ═══════════════════════════════════════════════════════════
//  optimizer/metroEngine.js — Metro journeys for the group optimizer
//
//  Access stations (spec §6.4). A participant's origin is a coordinate, not a
//  station. Method (documented, deterministic):
//    1. If the origin carries a stationId, that exact station is used (walk 0).
//    2. Otherwise the ACCESS.maxStations nearest ACTIVE stations within
//       ACCESS.maxRadiusKm (great-circle) are all evaluated; the nearest one is
//       NOT assumed to be best — each is routed and the fastest door-to-station
//       total wins (ties: station key). If none is within the radius, the single
//       nearest is used and flagged FAR_FROM_NETWORK.
//    3. Walking time = distance × detourFactor ÷ walkSpeed. This is an
//       ESTIMATE (no pedestrian routing) and every result is labelled approx.
//  Metro leg = existing line-aware Dijkstra (graph interchange penalties).
//  Fare = existing stop-count slab model (an estimate, ₹); 0 when no ride needed.
//  maxDistanceKm uses straight-line origin→candidate distance, which is a LOWER
//  bound of travel distance, so it only rejects what is certainly too far.
// ═══════════════════════════════════════════════════════════
import { ST } from '../data/stations.js';
import { stationIdFor, stationKeyFor } from '../data/station-ids.js';
import { buildGraph } from '../core/graph.js';
import { dijkstra } from '../core/dijkstra.js';
import { getRouteDetail, realPathCost } from '../core/routing.js';
import { haversineKm } from '../utils/geometry.js';
import { round1 } from './fairness.js';
import { DomainError, ErrorCode } from '../domain/errors.js';

export const ACCESS = Object.freeze({ maxStations: 3, maxRadiusKm: 5, walkSpeedKmh: 4.5, detourFactor: 1.3 });
// How each person's route is CHOSEN. Reported time/fare are always the real values of the chosen path.
//   fastest           — minimum travel time (default)
//   fewest_transfers  — transfers are penalised ×100 when choosing the path (time is the tie-breaker)
//   lowest_fare       — fare grows with stops travelled, so stops are minimised and transfers are almost free (×0.01,
//                       so a pointless transfer is never chosen on a tie)
export const ROUTE_STRATEGIES = Object.freeze({ fastest: 1, fewest_transfers: 100, lowest_fare: 0.01 });
export const INTERCHANGE_AVOIDANCE_PENALTY_MIN = 3; // extra burden per transfer when avoidInterchanges is set

export function findAccessStations(origin, network, opts = ACCESS) {
  const active = Object.keys(network.stationLines).filter(k => ST[k]).sort();
  if (origin.stationId) {
    const key = stationKeyFor(origin.stationId);
    if (!key || !network.stationLines[key]) throw new DomainError(ErrorCode.INVALID_INPUT, 'Origin station is not currently operational.');
    return [{ station: key, distanceKm: 0, walkMin: 0, approx: false, farFromNetwork: false }];
  }
  const withDist = active.map(k => ({ station: k, distanceKm: haversineKm(origin.lat, origin.lon, ST[k].la, ST[k].lo) }))
    .sort((a, b) => a.distanceKm - b.distanceKm || (a.station < b.station ? -1 : 1));
  const near = withDist.filter(x => x.distanceKm <= opts.maxRadiusKm).slice(0, opts.maxStations);
  const chosen = near.length ? near : withDist.slice(0, 1);
  return chosen.map(x => ({
    ...x, walkMin: round1((x.distanceKm * opts.detourFactor) / opts.walkSpeedKmh * 60),
    approx: true, farFromNetwork: !near.length,
  }));
}

export function createMetroEngine({ now = Date.now(), routeStrategy = 'fastest', network: given } = {}) {
  if (!(routeStrategy in ROUTE_STRATEGIES)) throw new DomainError(ErrorCode.INVALID_INPUT, `Unknown route strategy: ${routeStrategy}`);
  const network = given ?? buildGraph(now);                                                   // real costs: defines what exists
  const pathNet = routeStrategy === 'fastest' ? network : buildGraph(now, { interchangeScale: ROUTE_STRATEGIES[routeStrategy] }); // steers path choice
  const dCache = new Map();
  const dFrom = (k) => { if (!dCache.has(k)) dCache.set(k, dijkstra(k, pathNet)); return dCache.get(k); };

  const candidates = Object.keys(network.stationLines).filter(k => ST[k]).sort()
    .map(k => ({ id: stationIdFor(k), key: k, label: k, lat: ST[k].la, lon: ST[k].lo, lines: [...network.stationLines[k]].sort() }));

  const accessCache = new Map();
  const accessFor = (p) => {
    const ck = p.participantId;
    if (!accessCache.has(ck)) accessCache.set(ck, findAccessStations(p.origin, network));
    return accessCache.get(ck);
  };

  function evaluate(p, cand) {
    let best = null;
    for (const a of accessFor(p)) {
      const d = dFrom(a.station);
      const chosen = d.dist[cand.key];
      if (chosen === undefined || !Number.isFinite(chosen)) continue;
      const rd = getRouteDetail(a.station, cand.key, d);
      const metroMin = realPathCost(rd.detailed);
      const timeMin = round1(a.walkMin + metroMin);
      if (!best || timeMin < best.timeMin || (timeMin === best.timeMin && a.station < best.detail.access.station)) {
        const burden = round1(timeMin + (p.softPreferences?.avoidInterchanges ? INTERCHANGE_AVOIDANCE_PENALTY_MIN * rd.interchangeCount : 0));
        best = {
          timeMin, burdenMin: burden,
          cost: rd.stopCount === 0 ? 0 : rd.fare.normal,
          interchanges: rd.interchangeCount,
          distanceKm: round1(haversineKm(p.origin.lat, p.origin.lon, cand.lat, cand.lon)),
          distanceIsLowerBound: true,
          detail: {
            mode: 'METRO',
            routeStrategy,
            access: { station: a.station, stationId: stationIdFor(a.station), distanceKm: round1(a.distanceKm), walkMin: a.walkMin, approx: a.approx, farFromNetwork: a.farFromNetwork },
            metroMin: round1(metroMin), stopCount: rd.stopCount, path: rd.path, linesUsed: rd.linesUsed,
            interchangeStations: rd.interchangeStations, fareSmart: rd.stopCount === 0 ? 0 : rd.fare.smart,
          },
        };
      }
    }
    return best;
  }
  return { candidates, evaluate, network };
}
