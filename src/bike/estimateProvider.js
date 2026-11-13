// ═══════════════════════════════════════════════════════════
//  bike/estimateProvider.js — "estimate" routing: NO external service, NO cost, explicitly labelled
//  Distance = straight-line × detour factor; duration = distance ÷ assumed speed. These are NOT road routes.
//  It exists so Bike mode can run in a deployment that has no routing service (yet), but only when the owner
//  opts in with ROUTING_MODE=estimate — it is never selected silently. Everything it produces is flagged
//  (`estimated: true` → journey quality 'fallback', warning ROUTING_FALLBACK, banner in the UI).
// ═══════════════════════════════════════════════════════════
import { haversineKm } from '../utils/geometry.js';

export const ESTIMATE = Object.freeze({ detourFactor: 1.35, speedKmh: 25 });
const r2 = (x) => Math.round(x * 100) / 100, r1 = (x) => Math.round(x * 10) / 10;
const leg = (a, b) => { const d = r2(haversineKm(a.lat, a.lon, b.lat, b.lon) * ESTIMATE.detourFactor); return { distanceKm: d, durationMin: r1(d / ESTIMATE.speedKmh * 60) }; };

export function createEstimateProvider({ now = Date.now } = {}) {
  const meta = () => ({ provider: 'estimate', profile: 'straight-line-estimate', trafficAware: false, fetchedAt: now(), cached: false });
  return {
    name: 'estimate', estimated: true,
    async matrix(sources, dests) {
      const rows = sources.map(s => dests.map(d => leg(s, d)));
      return { distanceKm: rows.map(r => r.map(x => x.distanceKm)), durationsMin: rows.map(r => r.map(x => x.durationMin)), snappedDestinations: dests.map(() => null), ...meta() };
    },
    async route(a, b) { return { ...leg(a, b), geometry: [[a.lat, a.lon], [b.lat, b.lon]], ...meta() }; },
  };
}
