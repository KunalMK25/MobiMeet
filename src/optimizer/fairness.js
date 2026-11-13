// ═══════════════════════════════════════════════════════════
//  optimizer/fairness.js — group fairness metrics (pure)
//
//  Inputs are per-participant "burden" values (minutes). Definitions:
//    mean, min, max, range (= max − min), total (= Σ)
//    stdDev  — POPULATION standard deviation (the group IS the population)
//    jain    — Jain's fairness index  J = (Σx)² / (n · Σx²), in (0, 1].
//              1 = everyone bears an identical burden; 1/n = one person bears it all.
//              Chosen because it is scale-free, bounded and standard for fairness
//              of resource allocation. It describes spread only; it does NOT prove
//              the outcome is "fair" in any wider sense.
//  Edge cases: n = 0 → all zeros, jain = 1; all-zero burdens → jain = 1.
// ═══════════════════════════════════════════════════════════

export const round1 = (x) => Math.round(x * 10) / 10;

export function groupMetrics(values) {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, min: 0, max: 0, range: 0, total: 0, stdDev: 0, jain: 1 };
  const total = values.reduce((a, b) => a + b, 0);
  const mean = total / n;
  const max = Math.max(...values), min = Math.min(...values);
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const sumSq = values.reduce((a, v) => a + v * v, 0);
  return {
    n, total: round1(total), mean: round1(mean), min: round1(min), max: round1(max),
    range: round1(max - min), stdDev: round1(Math.sqrt(variance)),
    jain: sumSq === 0 ? 1 : Math.round((total * total) / (n * sumSq) * 1000) / 1000,
  };
}

// Min-max normalisation across a candidate set; a constant metric normalises to 0
// (it cannot discriminate between candidates, so it must not influence the score).
export function minMaxNormaliser(values) {
  const lo = Math.min(...values), hi = Math.max(...values);
  return (x) => (hi === lo ? 0 : (x - lo) / (hi - lo));
}
