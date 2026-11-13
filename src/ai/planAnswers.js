// Deterministic Q&A over a stored plan result (no LLM, no network). Returns null when it cannot answer.
const f = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
export function answerFromPlan(result, message, nameOf = (id) => id) {
  const q = String(message).toLowerCase();
  const rec = result?.recommended;
  if (!rec) return 'There is no recommended meetup yet. Run the optimisation first.';
  const e = result.explanation?.facts;
  const js = rec.journeys;
  const longest = js.reduce((a, b) => (b.burdenMin > a.burdenMin ? b : a));
  if (/why|reason|how.*(pick|choose|chose|select)/.test(q)) return result.explanation.lines.slice(0, 3).join(' ');
  if (/longest|far(thest)?|worst|most/.test(q) && /travel|journey|time|far/.test(q)) return `${nameOf(longest.participantId)} has the longest journey: ${f(longest.timeMin)} min.`;
  if (/cost|fare|fuel|cheap|price|₹|rupee/.test(q)) return rec.metrics.costTotal != null ? `The group's total estimated cost is ₹${f(rec.metrics.costTotal)} (an estimate).` : 'Cost is not available for this plan (no fuel assumptions were provided).';
  if (/fair|balance|spread|range/.test(q)) return `Journey range is ${f(rec.metrics.burden.range)} min between the longest and shortest; Jain fairness index ${rec.metrics.burden.jain} (1 = perfectly even).`;
  if (/alternativ|other option|instead|second/.test(q)) return e?.alternatives?.length ? e.alternatives.map(a => `${a.label}: longest journey ${a.maxBurdenDelta >= 0 ? '+' : ''}${f(a.maxBurdenDelta)} min, total ${a.totalBurdenDelta >= 0 ? '+' : ''}${f(a.totalBurdenDelta)} min`).join('; ') + '.' : 'No alternatives were feasible.';
  if (/interchange|transfer|change/.test(q)) return `${rec.metrics.interchangeTotal} interchange(s) across the group.`;
  if (/where|which station|meet|location|point/.test(q)) return `The recommended meetup is ${rec.label}.`;
  if (/limit|accura|reliab|estimate|trust|real.?time|traffic/.test(q)) return (result.explanation.limitations ?? []).join(' ') || 'Figures are computed estimates.';
  return null;
}
