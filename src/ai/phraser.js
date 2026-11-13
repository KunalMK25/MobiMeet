// ═══════════════════════════════════════════════════════════
//  ai/phraser.js — optional LLM re-phrasing of the DECISION explanation.
//  Input is the deterministic explanation (facts + lines). The LLM may only reword;
//  the reply is rejected (→ deterministic text) if it contains any number that is not
//  in the facts, is empty, too long, or the call fails. Names are pseudonymised first.
// ═══════════════════════════════════════════════════════════
import { allowedNumbers, unknownNumbers, pseudonymise } from './guard.js';

const SYSTEM = `You rewrite meetup-planner explanations for a friendly group chat. Rules: use ONLY the facts given; copy every number exactly as written; do not add, round, convert or compute any number; do not invent places or reasons; keep it under 120 words; plain text, no markdown headings.`;

export async function phraseExplanation(explanation, llm, { names = {} } = {}) {
  const deterministic = { lines: explanation.lines, source: 'deterministic' };
  if (!llm) return { ...deterministic, reason: 'LLM_NOT_CONFIGURED' };
  const { enc, dec } = pseudonymise(names);
  const payload = enc(JSON.stringify({ facts: explanation.facts, lines: explanation.lines }));
  try {
    const raw = await llm.complete({ system: SYSTEM, messages: [{ role: 'user', content: `Rewrite these results as a short, friendly explanation:\n${payload}` }], maxTokens: 300 });
    const text = dec(raw).trim();
    if (!text || text.length > 1200) return { ...deterministic, reason: 'LLM_OUTPUT_REJECTED' };
    const bad = unknownNumbers(enc(text), allowedNumbers(enc(payload)));
    if (bad.length) return { ...deterministic, reason: 'LLM_INTRODUCED_NUMBERS' };
    return { lines: [text], source: 'llm', provider: llm.name };
  } catch { return { ...deterministic, reason: 'LLM_UNAVAILABLE' }; }
}
