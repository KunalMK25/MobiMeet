// Output guards: an LLM may phrase results but must never introduce or alter numbers.
export const extractNumbers = (text) =>
  (String(text).replace(/\bPerson \d+\b/g, '').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

export function allowedNumbers(...sources) {
  const set = new Set();
  for (const s of sources) for (const n of extractNumbers(typeof s === 'string' ? s : JSON.stringify(s))) set.add(n);
  return set;
}
export const unknownNumbers = (text, allowed) => extractNumbers(text).filter(n => !allowed.has(n));

// Names AND internal ids → "Person k" before text leaves the server; mapped back to names afterwards.
// `names` is {participantId: displayName}.
export function pseudonymise(names) {
  const entries = Object.entries(names);
  const to = new Map(), back = {};
  entries.forEach(([id, n], i) => { const label = `Person ${i + 1}`; to.set(id, label); to.set(n, label); back[label] = n; });
  const enc = (s) => [...to.entries()].sort((a, b) => b[0].length - a[0].length).reduce((acc, [k, v]) => acc.split(k).join(v), s);
  const dec = (s) => s.replace(/Person \d+/g, (m) => back[m] ?? m);
  return { enc, dec };
}
