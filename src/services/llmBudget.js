// ═══════════════════════════════════════════════════════════
//  services/llmBudget.js — keeps LLM use cheap and under the provider's limits, for every group size.
//  The deterministic rules answer almost everything; the model is only a fallback for text they cannot understand. On top of
//  that every model call must first reserve BOTH request slots and an estimated token amount from shared counters that live in
//  the database (so they hold across all serverless instances):
//     requests:  per user · per group · all users per minute · all users per day
//     tokens:    all users per minute · all users per day          (reserved up-front from a conservative estimate)
//  A refused reservation uses nothing up; the caller simply uses its deterministic fallback. llm.js adds a last line of defence:
//  after an HTTP 429 the provider is left alone for its Retry-After period.
//  Every limit is configurable (LLM_MAX_*), see budgetFromEnv. Defaults sit below Groq's free limits for openai/gpt-oss-20b
//  (30 req/min, 1 000 req/day, 8 000 tokens/min, 200 000 tokens/day — verify yours in the Groq console).
// ═══════════════════════════════════════════════════════════
import { reserve, release } from './rateLimit.js';

export const DEFAULT_LLM_BUDGET = Object.freeze({
  perUser: { limit: 12, windowSec: 600 },
  perGroup: { limit: 60, windowSec: 3600 },
  perMinute: { limit: 10, windowSec: 60 },
  perDay: { limit: 300, windowSec: 86400 },
  tokensPerMinute: { limit: 6000, windowSec: 60 },
  tokensPerDay: { limit: 150000, windowSec: 86400 },
});

// Conservative per-call reservations (measured on gpt-oss-20b: prompt ≈ 170–1 100 tokens, completion ≈ 50–220 incl. hidden reasoning).
export const LLM_TOKEN_ESTIMATE = Object.freeze({ agent: 700, chat: 1600, notes: 700, phrase: 1000 });

const ENV = { perUser: 'LLM_MAX_PER_USER_10MIN', perGroup: 'LLM_MAX_PER_GROUP_HOUR', perMinute: 'LLM_MAX_PER_MINUTE', perDay: 'LLM_MAX_PER_DAY', tokensPerMinute: 'LLM_MAX_TOKENS_PER_MINUTE', tokensPerDay: 'LLM_MAX_TOKENS_PER_DAY' };
export const LLM_BUDGET_ENV_NAMES = Object.freeze(Object.values(ENV));

// Positive integers only; anything else keeps the safe default.
export function budgetFromEnv(env = {}) {
  const out = {};
  for (const [k, name] of Object.entries(ENV)) {
    const n = Number(env[name]);
    out[k] = { ...DEFAULT_LLM_BUDGET[k], ...(Number.isInteger(n) && n > 0 ? { limit: n } : {}) };
  }
  return Object.freeze(out);
}

// → true if a model call may be made now. Never throws; a database problem means "no model call".
export async function reserveLlmCall(db, { userId, groupId = null, now, estTokens = LLM_TOKEN_ESTIMATE.agent, budget = DEFAULT_LLM_BUDGET }) {
  const plan = [
    ['llm:global:min', budget.perMinute, 1], ['llm:global:day', budget.perDay, 1],
    ['llm:tok:min', budget.tokensPerMinute, estTokens], ['llm:tok:day', budget.tokensPerDay, estTokens],
    [`llm:user:${userId}`, budget.perUser, 1], ...(groupId ? [[`llm:group:${groupId}`, budget.perGroup, 1]] : []),
  ];
  const taken = [];
  try {
    for (const [key, w, amount] of plan) {
      if (!(await reserve(db, { key, limit: w.limit, windowSec: w.windowSec, now, amount }))) throw new Error('budget');
      taken.push([key, w, amount]);
    }
    return true;
  } catch {
    for (const [key, w, amount] of taken) await release(db, { key, windowSec: w.windowSec, now, amount }).catch(() => {});
    return false;
  }
}
