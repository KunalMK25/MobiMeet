// ═══════════════════════════════════════════════════════════
//  ai/chat.js — authenticated, plan-grounded assistant
//  1) deterministic answer from the stored plan; 2) otherwise the LLM, with the plan facts
//  (names pseudonymised, NO coordinates) as its only data; 3) otherwise a helpful fallback.
//  The LLM never computes routes, fares or fairness. Numeric claims it makes that are not in the
//  plan facts are flagged. Rate-limited per user.
// ═══════════════════════════════════════════════════════════
import { createLlm } from './llm.js';
import { answerFromPlan } from './planAnswers.js';
import { allowedNumbers, unknownNumbers, pseudonymise } from './guard.js';
import { phraseExplanation } from './phraser.js';
import { parsePreferenceText } from './preferenceParser.js';
import { consume } from '../services/rateLimit.js';
import { reserveLlmCall, DEFAULT_LLM_BUDGET, LLM_TOKEN_ESTIMATE } from '../services/llmBudget.js';
import { DomainError, ErrorCode } from '../domain/errors.js';

const SYSTEM = (facts) => `You are MobiBot inside MobiMeet, a group meetup planner for Bengaluru. Answer questions about THIS group's plan using ONLY the JSON below. Never invent numbers, stations or routes; if the data does not contain the answer, say so. Do not perform routing, fare or fairness calculations. Keep replies short.\n\nPlan data:\n${facts}`;

const phraseCache = new Map();
export function createChatService({ db, groups, plans, config, llm = createLlm(config?.llm ?? {}), clock = Date.now }) {
  const budget = config?.llm?.budget ?? DEFAULT_LLM_BUDGET;
  return {
    llmEnabled: !!llm, llm,
    // Suggest structured preferences from a free-text note (never applied automatically).
    async parseNotes(user, { groupId, text } = {}) {
      await groups.getGroup(user, groupId);                       // membership check
      await consume(db, { key: `parse:${user.id}`, limit: 20, windowSec: 600, now: clock() });
      const ok = llm && await reserveLlmCall(db, { userId: user.id, groupId, now: clock(), estTokens: LLM_TOKEN_ESTIMATE.notes, budget });
      const out = await parsePreferenceText(text, ok ? llm : null);
      return llm && !ok ? { ...out, reason: 'LLM_BUSY' } : out;
    },
    // Optional friendlier wording of the decision explanation; numbers are verified or the deterministic text is returned.
    async phrase(user, { groupId, planId } = {}) {
      const plan = await plans.getPlan(user, groupId, planId);
      await consume(db, { key: `phrase:${user.id}`, limit: 20, windowSec: 600, now: clock() });
      const names = Object.fromEntries(plan.result.participants.map(p => [p.userId, p.displayName]));
      if (!plan.result.explanation) return { lines: [], source: 'deterministic' };
      const key = `${plan.id}`; const hit = phraseCache.get(key);
      if (hit && clock() - hit.at < 6 * 3600e3) return hit.value;                       // the same plan is only ever re-worded once per instance
      const ok = llm && await reserveLlmCall(db, { userId: user.id, groupId, now: clock(), estTokens: LLM_TOKEN_ESTIMATE.phrase, budget });
      const value = await phraseExplanation(plan.result.explanation, ok ? llm : null, { names });
      if (llm && !ok) value.reason = 'LLM_BUSY';
      if (value.source === 'llm') { if (phraseCache.size > 200) phraseCache.clear(); phraseCache.set(key, { at: clock(), value }); }
      return value;
    },
    async ask(user, { groupId, message } = {}) {
      const text = typeof message === 'string' ? message.trim() : '';
      if (!text || text.length > 500) throw new DomainError(ErrorCode.INVALID_INPUT, 'Message must be 1-500 characters.');
      await consume(db, { key: `chat:${user.id}`, limit: 20, windowSec: 600, now: clock() });
      if (!groupId) return { reply: 'Open a group to ask about its plan.', source: 'fallback' };
      const plan = await plans.getPlan(user, groupId).catch((e) => { if (e.code === ErrorCode.NOT_FOUND) return null; throw e; });
      if (!plan) { await groups.getGroup(user, groupId); return { reply: 'There is no plan yet. Ask the group owner to run the optimisation.', source: 'fallback' }; }
      const names = Object.fromEntries(plan.result.participants.map(p => [p.userId, p.displayName]));
      const nameOf = (id) => names[id] ?? 'A participant';
      const direct = answerFromPlan(plan.result, text, nameOf);
      if (direct) return { reply: direct, source: 'deterministic', planVersion: plan.version };
      if (!llm) return { reply: 'I can answer questions about why this spot was chosen, the longest journey, cost, fairness, alternatives and limitations. (The AI assistant for open questions is not configured.)', source: 'fallback' };
      const { enc, dec } = pseudonymise(names);
      const facts = enc(JSON.stringify({ strategy: plan.result.strategy, recommended: plan.result.recommended.label, explanation: plan.result.explanation, metrics: plan.result.recommended.metrics, alternatives: plan.result.alternatives.map(a => ({ label: a.label, metrics: a.metrics })), warnings: plan.result.warnings }));
      if (!(await reserveLlmCall(db, { userId: user.id, groupId, now: clock(), estTokens: LLM_TOKEN_ESTIMATE.chat, budget }))) return { reply: 'The AI assistant is busy right now. Try asking about the longest journey, cost, fairness or alternatives.', source: 'fallback' };
      try {
        const raw = await llm.complete({ system: SYSTEM(facts), messages: [{ role: 'user', content: enc(text) }], maxTokens: 300 });
        const reply = dec(raw);
        const unknown = unknownNumbers(enc(reply), allowedNumbers(facts, text));
        return { reply: unknown.length ? `${reply}\n\n(Some figures here are not from your plan data and are unverified.)` : reply, source: 'llm', planVersion: plan.version, unverifiedNumbers: unknown.length > 0 };
      } catch { return { reply: 'The AI assistant is unavailable right now. Try asking about the longest journey, cost, fairness or alternatives.', source: 'fallback' }; }
    },
  };
}
