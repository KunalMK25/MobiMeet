// ═══════════════════════════════════════════════════════════
//  optimizer/explain.js — DECISION explanation (why the optimizer chose X)
//
//  Built only from the optimizer's own numbers. `facts` is the machine-readable
//  truth; `lines` is a deterministic English rendering. An LLM may re-phrase
//  `lines` for tone, but numbers always come from `facts` and the LLM output is
//  validated against them (see ai/phraser.js). This is separate from any MODEL
//  explanation (SHAP) of an ML prediction — see ARCHITECTURE.md (no model is shipped).
// ═══════════════════════════════════════════════════════════
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const STRATEGY_TEXT = {
  balanced: 'Balanced/Fair (minimise the longest individual journey, then the group total)',
  fastest: 'Fastest (minimise total group travel time)',
  cheapest: 'Cheapest (minimise total estimated cost)',
  fewest_transfers: 'Fewest transfers',
  balanced_time_cost: 'Balanced time/cost (normalised weighted score)',
};
export const WARNING_TEXT = {
  FARE_IS_STOP_COUNT_ESTIMATE: 'Fares are estimates from stop-count slabs, not live BMRCL fares.',
  TIMES_ARE_SCHEDULE_ESTIMATES: 'Times are schedule-style estimates (no live train or traffic data).',
  WALKING_IS_STRAIGHT_LINE_ESTIMATE: 'Walking to the first station is a straight-line estimate.',
  STEP_FREE_DATA_UNAVAILABLE: 'Step-free access data is unavailable, so that requirement was not applied.',
  COST_UNAVAILABLE: 'Cost is unavailable for some journeys, so cost was left out of the ranking.',
  NO_FEASIBLE_CANDIDATE: 'No candidate satisfied every participant constraint.',
  TRAFFIC_NOT_REAL_TIME: 'Road durations come from the routing provider and are not real-time traffic.',
  FUEL_IS_ESTIMATE: 'Fuel cost is an estimate based on the stated mileage and fuel price assumptions.',
  ROUTING_FALLBACK: 'Road distances are straight-line estimates (no routing service was available or configured), not real road routes.',
};

export function buildExplanation(result, participants, names = {}) {
  const rec = result.recommended;
  const nm = (id) => names[id] || id;
  const js = rec.journeys;
  const longest = js.reduce((a, b) => (b.burdenMin > a.burdenMin ? b : a));
  const shortest = js.reduce((a, b) => (b.burdenMin < a.burdenMin ? b : a));
  const m = rec.metrics;

  const compare = (alt) => ({
    label: alt.label,
    maxBurdenDelta: Math.round((alt.metrics.burden.max - m.burden.max) * 10) / 10,
    totalBurdenDelta: Math.round((alt.metrics.burden.total - m.burden.total) * 10) / 10,
    costDelta: m.costTotal != null && alt.metrics.costTotal != null ? Math.round((alt.metrics.costTotal - m.costTotal) * 10) / 10 : null,
  });
  const alternatives = result.alternatives.map(compare);
  const byId = Object.fromEntries(result.ranked.map(c => [c.id, c]));
  const fastest = byId[result.bestBy.fastest], cheapest = result.bestBy.cheapest ? byId[result.bestBy.cheapest] : null;

  const facts = {
    strategy: result.strategy, recommended: rec.label, feasibleCount: result.feasibleCount, rejectedCount: result.rejected.length,
    longest: { participantId: longest.participantId, burdenMin: longest.burdenMin, timeMin: longest.timeMin },
    shortest: { participantId: shortest.participantId, burdenMin: shortest.burdenMin, timeMin: shortest.timeMin },
    rangeMin: m.burden.range, jain: m.burden.jain, totalTimeMin: m.time.total, costTotal: m.costTotal,
    interchangeTotal: m.interchangeTotal, alternatives,
    fastest: fastest && fastest.id !== rec.id ? { label: fastest.label, ...compare(fastest) } : null,
    cheapest: cheapest && cheapest.id !== rec.id ? { label: cheapest.label, ...compare(cheapest) } : null,
  };

  const lines = [];
  lines.push(`Recommended meetup: ${rec.label} using the ${STRATEGY_TEXT[result.strategy]} strategy, chosen from ${result.feasibleCount} feasible candidate(s).`);
  lines.push(`Longest journey: ${nm(longest.participantId)} at ${fmt(longest.timeMin)} min; shortest: ${nm(shortest.participantId)} at ${fmt(shortest.timeMin)} min (range ${fmt(m.burden.range)} min, Jain fairness index ${m.burden.jain}).`);
  lines.push(`Group total: ${fmt(m.time.total)} min${m.costTotal != null ? `, estimated cost ₹${fmt(m.costTotal)}` : ''}, ${m.interchangeTotal} interchange(s) in total.`);
  if (facts.fastest) {
    const f = facts.fastest;
    lines.push(`${f.label} would change total time by ${fmt(f.totalBurdenDelta)} min but the longest journey by ${fmt(f.maxBurdenDelta)} min.`);
  }
  if (facts.cheapest) lines.push(`${facts.cheapest.label} would change estimated cost by ${facts.cheapest.costDelta != null ? '₹' + fmt(facts.cheapest.costDelta) : 'an unknown amount'} and the longest journey by ${fmt(facts.cheapest.maxBurdenDelta)} min.`);
  for (const a of alternatives) lines.push(`Alternative ${a.label}: longest journey ${a.maxBurdenDelta >= 0 ? '+' : ''}${fmt(a.maxBurdenDelta)} min, total ${a.totalBurdenDelta >= 0 ? '+' : ''}${fmt(a.totalBurdenDelta)} min versus the recommendation.`);
  const limits = [...new Set(result.warnings)].map(w => WARNING_TEXT[w]).filter(Boolean);
  return { facts, lines, limitations: limits };
}
