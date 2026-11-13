// ═══════════════════════════════════════════════════════════
//  bike/bikeOptimizer.js — Bike group optimisation over ROAD-NETWORK journeys
//  Flow: generate candidates → one matrix request → fairness optimiser →
//  ONE bounded refinement round around the top two → route geometry for the
//  recommendation only. All arithmetic is deterministic; the provider only
//  supplies distances/durations. On provider failure, journeys fall back to a
//  clearly-labelled straight-line estimate (never presented as road data).
// ═══════════════════════════════════════════════════════════
import { DomainError, ErrorCode } from '../domain/errors.js';
import { assertSameMode, TransportMode } from '../domain/transport.js';
import { assertProvider } from '../domain/providers.js';
import { haversineKm } from '../utils/geometry.js';
import { optimizeGroup } from '../optimizer/groupOptimizer.js';
import { Strategy } from '../optimizer/strategies.js';
import { buildExplanation } from '../optimizer/explain.js';
import { round1 } from '../optimizer/fairness.js';
import { generateBikeCandidates, refineCandidates } from './candidates.js';
import { estimateFuelCost, validateFuelAssumptions } from './fuel.js';

import { ESTIMATE } from './estimateProvider.js';
export const FALLBACK = ESTIMATE;   // one source of truth for the straight-line assumptions

export async function optimizeBikeGroup(participants, { provider, fuel = null, strategy = Strategy.BALANCED, now = Date.now(), topK = 3, maxSpreadKm } = {}) {
  assertProvider('roadRouting', provider);
  // A provider that is deliberately disabled (misconfiguration, e.g. public demo in production) must fail loudly;
  // graceful straight-line degradation is only for transient outages of a configured provider.
  if (provider.disabled) throw new DomainError(ErrorCode.PROVIDER_UNAVAILABLE, provider.reason);
  for (const p of participants) assertSameMode(TransportMode.BIKE, p.mode);
  const fuelCfg = validateFuelAssumptions(fuel);
  const warnings = ['TRAFFIC_NOT_REAL_TIME'];
  if (fuelCfg) warnings.push('FUEL_IS_ESTIMATE');
  const origins = participants.map(p => p.origin);

  // cell[candidateId][participantIndex] = {distanceKm, durationMin, quality}
  const cells = new Map();
  const meta = { provider: provider.name ?? 'unknown', trafficAware: false, fallbackCandidates: 0 };

  async function fill(cands) {
    if (!cands.length) return;
    let m = null;
    try {
      m = await provider.matrix(origins, cands);
      Object.assign(meta, { provider: m.provider ?? meta.provider, profile: m.profile, fetchedAt: m.fetchedAt, cached: m.cached });
    } catch { m = null; }
    cands.forEach((c, j) => {
      const row = origins.map((o, i) => {
        const d = m?.distanceKm?.[i]?.[j], t = m?.durationsMin?.[i]?.[j];
        if (m && d != null && t != null) return { distanceKm: d, durationMin: t, quality: provider.estimated ? 'fallback' : 'provider' };
        if (m) return null; // provider answered: no road route to this candidate
        const straight = haversineKm(o.lat, o.lon, c.lat, c.lon);
        const dist = round1(straight * FALLBACK.detourFactor);
        return { distanceKm: dist, durationMin: round1(dist / FALLBACK.speedKmh * 60), quality: 'fallback' };
      });
      if (!m || provider.estimated) meta.fallbackCandidates++;
      cells.set(c.id, row);
    });
  }

  const evaluate = (p, cand) => {
    const idx = participants.indexOf(p);
    const cell = cells.get(cand.id)?.[idx];
    if (!cell) return null;
    return {
      timeMin: cell.durationMin, burdenMin: cell.durationMin,
      cost: estimateFuelCost(cell.distanceKm, fuelCfg),
      interchanges: 0, distanceKm: cell.distanceKm, distanceIsLowerBound: false,
      detail: { mode: 'BIKE', distanceKm: cell.distanceKm, durationMin: cell.durationMin, quality: cell.quality, geometry: null },
    };
  };

  const initial = generateBikeCandidates(origins, { maxSpreadKm });
  await fill(initial);
  let all = initial;
  let result = optimizeGroup({ participants, candidates: all, evaluate, strategy, topK });

  if (result.feasibleCount > 0 && meta.fallbackCandidates === 0) {
    const top = result.ranked.slice(0, 2);
    const refined = refineCandidates(top, Math.max(0.3, Math.min(2, top[0].metrics.time.max / 40)))
      .filter(c => !cells.has(c.id));
    if (refined.length) { await fill(refined); all = [...initial, ...refined]; result = optimizeGroup({ participants, candidates: all, evaluate, strategy, topK }); }
  }
  if (meta.fallbackCandidates > 0) warnings.push('ROUTING_FALLBACK');
  if (provider.estimated && result.recommended) {          // straight lines, labelled — never presented as road routes
    result.recommended.journeys.forEach((j, i) => { j.detail.geometry = [[origins[i].lat, origins[i].lon], [result.recommended.lat, result.recommended.lon]]; j.detail.geometryKind = 'straight-line'; });
  }

  // Geometry for the recommendation only (bounded: ≤ participants.length requests).
  if (result.recommended && meta.fallbackCandidates === 0) {
    const rec = result.recommended;
    let geomFailed = false;
    for (let i = 0; i < participants.length; i++) {
      try {
        const r = await provider.route(origins[i], { lat: rec.lat, lon: rec.lon });
        rec.journeys[i].detail.geometry = r.geometry;
      } catch { geomFailed = true; }
    }
    if (geomFailed) warnings.push('ROUTE_GEOMETRY_UNAVAILABLE');
  }

  const out = {
    mode: TransportMode.BIKE, computedFor: now, ...result, warnings: [...result.warnings, ...warnings],
    routing: { ...meta, mode: provider.estimated ? 'estimate' : 'service', candidatesEvaluated: all.length },
    fuelAssumptions: fuelCfg,
  };
  out.explanation = result.recommended ? buildExplanation(out, participants) : null;
  return out;
}
export { DomainError, ErrorCode };
