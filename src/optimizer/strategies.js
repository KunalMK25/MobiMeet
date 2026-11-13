// ═══════════════════════════════════════════════════════════
//  optimizer/strategies.js — transparent ranking strategies (pure)
//
//  Each strategy turns a feasible candidate's metrics into an ordered sort key
//  (lexicographic, lower is better). The final tie-break is always the stable
//  candidate ID, so identical inputs always give an identical ranking.
//
//  balanced           [max burden, total burden, total cost, total interchanges]
//                     "minimise the worst individual burden, then the group total"
//  fastest            [total burden, max burden, total cost, interchanges]
//  cheapest           [total cost, max burden, total burden, interchanges]
//  fewest_transfers   [total interchanges, max burden, total burden, total cost]
//  balanced_time_cost weighted sum of min-max-normalised metrics (weights below)
// ═══════════════════════════════════════════════════════════
import { minMaxNormaliser } from './fairness.js';

export const Strategy = Object.freeze({
  BALANCED: 'balanced',
  FASTEST: 'fastest',
  CHEAPEST: 'cheapest',
  FEWEST_TRANSFERS: 'fewest_transfers',
  BALANCED_TIME_COST: 'balanced_time_cost',
});
export const STRATEGIES = Object.freeze(Object.values(Strategy));

// Base weights for balanced_time_cost (sum = 1). Time weights are scaled by the
// group's mean timeSensitivity and the cost weight by mean costSensitivity (each 0..1,
// default 0.5), then all weights are renormalised to sum to 1.
export const BASE_WEIGHTS = Object.freeze({ max: 0.35, total: 0.25, cost: 0.25, ix: 0.15 });

export function sensitivityWeights(participants, costAvailable = true) {
  const mean = (f) => participants.reduce((a, p) => a + f(p), 0) / participants.length;
  const ts = mean(p => p.softPreferences?.timeSensitivity ?? 0.5);
  const cs = mean(p => p.softPreferences?.costSensitivity ?? 0.5);
  const sum = ts + cs;
  const timeF = sum === 0 ? 1 : (ts / sum) * 2;
  const costF = sum === 0 ? 1 : (cs / sum) * 2;
  const raw = { max: BASE_WEIGHTS.max * timeF, total: BASE_WEIGHTS.total * timeF, cost: costAvailable ? BASE_WEIGHTS.cost * costF : 0, ix: BASE_WEIGHTS.ix };
  const z = raw.max + raw.total + raw.cost + raw.ix;
  return { max: raw.max / z, total: raw.total / z, cost: raw.cost / z, ix: raw.ix / z };
}

const tuple = (c) => ({ max: c.metrics.burden.max, total: c.metrics.burden.total, cost: c.metrics.costTotal ?? 0, ix: c.metrics.interchangeTotal });

function cmpArrays(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Returns candidates sorted best-first, each annotated with {rank, sortKey, score?, scoreBreakdown?}.
export function rankCandidates(feasible, strategy, participants, { costAvailable = true } = {}) {
  if (!STRATEGIES.includes(strategy)) throw new Error(`Unknown strategy: ${strategy}`);
  if (strategy === Strategy.CHEAPEST && !costAvailable) throw new Error('cheapest strategy requires cost data');
  const withKey = feasible.map(c => ({ c, t: tuple(c) }));
  let annotate;
  if (strategy === Strategy.BALANCED_TIME_COST) {
    const w = sensitivityWeights(participants, costAvailable);
    const nMax = minMaxNormaliser(withKey.map(x => x.t.max));
    const nTot = minMaxNormaliser(withKey.map(x => x.t.total));
    const nCost = minMaxNormaliser(withKey.map(x => x.t.cost));
    const nIx = minMaxNormaliser(withKey.map(x => x.t.ix));
    annotate = ({ c, t }) => {
      const parts = { max: w.max * nMax(t.max), total: w.total * nTot(t.total), cost: w.cost * nCost(t.cost), ix: w.ix * nIx(t.ix) };
      const score = parts.max + parts.total + parts.cost + parts.ix;
      return { c, key: [Math.round(score * 1e9) / 1e9, t.max, t.total], score, scoreBreakdown: { weights: w, weighted: parts } };
    };
  } else {
    const order = {
      [Strategy.BALANCED]: (t) => [t.max, t.total, t.cost, t.ix],
      [Strategy.FASTEST]: (t) => [t.total, t.max, t.cost, t.ix],
      [Strategy.CHEAPEST]: (t) => [t.cost, t.max, t.total, t.ix],
      [Strategy.FEWEST_TRANSFERS]: (t) => [t.ix, t.max, t.total, t.cost],
    }[strategy];
    annotate = ({ c, t }) => ({ c, key: order(t) });
  }
  return withKey.map(annotate)
    .sort((a, b) => cmpArrays(a.key, b.key) || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0))
    .map((x, i) => ({ ...x.c, rank: i + 1, sortKey: x.key, ...(x.score !== undefined ? { score: x.score, scoreBreakdown: x.scoreBreakdown } : {}) }));
}
