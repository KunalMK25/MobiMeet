// ═══════════════════════════════════════════════════════════
//  bike/candidates.js — bounded, deterministic candidate generation (spec §7.5)
//  Centroid / geometric median / pairwise midpoints / a ring around the centroid
//  only GENERATE candidates; the final choice is made on road-network journeys by
//  the fairness optimizer, never on straight-line geometry.
// ═══════════════════════════════════════════════════════════
import { haversineKm, offsetLatLon } from '../utils/geometry.js';
import { DomainError, ErrorCode } from '../domain/errors.js';

export const CANDIDATE_LIMITS = Object.freeze({ maxInitial: 24, maxSpreadKm: 60, ringBearings: 8 });
const r4 = (x) => Math.round(x * 1e4) / 1e4;
export const geoId = (lat, lon) => `geo_${r4(lat)}_${r4(lon)}`;
const mk = (lat, lon, kind) => ({ id: geoId(lat, lon), label: `${r4(lat)}, ${r4(lon)}`, lat: r4(lat), lon: r4(lon), kind });

export const centroid = (pts) => ({ lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lon: pts.reduce((a, p) => a + p.lon, 0) / pts.length });

// Weiszfeld's algorithm: the point minimising the SUM of straight-line distances.
export function geometricMedian(pts, iterations = 50) {
  let c = centroid(pts);
  for (let i = 0; i < iterations; i++) {
    let wx = 0, wy = 0, wsum = 0;
    for (const p of pts) {
      const d = Math.max(haversineKm(c.lat, c.lon, p.lat, p.lon), 1e-6);
      wx += p.lat / d; wy += p.lon / d; wsum += 1 / d;
    }
    c = { lat: wx / wsum, lon: wy / wsum };
  }
  return c;
}

export function generateBikeCandidates(origins, { maxInitial = CANDIDATE_LIMITS.maxInitial, maxSpreadKm = CANDIDATE_LIMITS.maxSpreadKm } = {}) {
  const c = centroid(origins);
  const spread = Math.max(...origins.map(o => haversineKm(c.lat, c.lon, o.lat, o.lon)));
  if (spread > maxSpreadKm) throw new DomainError(ErrorCode.INVALID_INPUT, `Origins are too far apart for a bike meetup (limit ${maxSpreadKm} km from the centre).`);
  const out = [mk(c.lat, c.lon, 'centroid')];
  const gm = geometricMedian(origins);
  out.push(mk(gm.lat, gm.lon, 'median'));
  for (let i = 0; i < origins.length; i++) for (let j = i + 1; j < origins.length; j++) {
    out.push(mk((origins[i].lat + origins[j].lat) / 2, (origins[i].lon + origins[j].lon) / 2, 'midpoint'));
  }
  const radius = Math.min(Math.max(spread * 0.5, 0.5), 8);
  for (let b = 0; b < CANDIDATE_LIMITS.ringBearings; b++) {
    const p = offsetLatLon(c.lat, c.lon, radius, b * (360 / CANDIDATE_LIMITS.ringBearings));
    out.push(mk(p.lat, p.lon, 'ring'));
  }
  return dedupe(out).slice(0, maxInitial);
}

// One bounded refinement step around the best candidates found so far.
export function refineCandidates(centres, radiusKm) {
  const out = [];
  for (const ctr of centres) for (let b = 0; b < CANDIDATE_LIMITS.ringBearings; b++) {
    const p = offsetLatLon(ctr.lat, ctr.lon, radiusKm, b * (360 / CANDIDATE_LIMITS.ringBearings) + 22.5);
    out.push(mk(p.lat, p.lon, 'refine'));
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}
