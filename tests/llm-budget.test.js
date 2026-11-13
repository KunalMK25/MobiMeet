// Request-count AND token budgets, per user / group / minute / day, configurable, shared through the database (i.e. across instances).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.js';
import { loadConfig } from '../src/api/config.js';
import { budgetFromEnv, reserveLlmCall, DEFAULT_LLM_BUDGET, LLM_TOKEN_ESTIMATE, LLM_BUDGET_ENV_NAMES } from '../src/services/llmBudget.js';
import { createAgentService } from '../src/services/agents.js';
import { purgeOld } from '../src/services/rateLimit.js';

test('limits come from environment variables; bad values keep the safe default', () => {
  assert.deepEqual(budgetFromEnv({}), DEFAULT_LLM_BUDGET);
  const b = budgetFromEnv({ LLM_MAX_PER_MINUTE: '3', LLM_MAX_PER_DAY: '50', LLM_MAX_TOKENS_PER_MINUTE: '2000', LLM_MAX_TOKENS_PER_DAY: '40000', LLM_MAX_PER_USER_10MIN: '4', LLM_MAX_PER_GROUP_HOUR: '9' });
  assert.deepEqual([b.perMinute.limit, b.perDay.limit, b.tokensPerMinute.limit, b.tokensPerDay.limit, b.perUser.limit, b.perGroup.limit], [3, 50, 2000, 40000, 4, 9]);
  assert.deepEqual([b.perMinute.windowSec, b.perDay.windowSec, b.tokensPerDay.windowSec], [60, 86400, 86400]);
  for (const bad of ['0', '-5', 'abc', '1.5', '']) assert.equal(budgetFromEnv({ LLM_MAX_PER_MINUTE: bad }).perMinute.limit, DEFAULT_LLM_BUDGET.perMinute.limit);
  assert.equal(loadConfig({ LLM_MAX_PER_DAY: '77' }).llm.budget.perDay.limit, 77);                 // reaches the running app through the config
  assert.equal(LLM_BUDGET_ENV_NAMES.length, 6);
  assert.ok(DEFAULT_LLM_BUDGET.tokensPerMinute.limit <= 8000 && DEFAULT_LLM_BUDGET.tokensPerDay.limit <= 200000 && DEFAULT_LLM_BUDGET.perMinute.limit <= 30 && DEFAULT_LLM_BUDGET.perDay.limit <= 1000, 'defaults sit under the Groq free limits for gpt-oss-20b');
});

test('request-count caps: per minute and per day (a day cap survives the hourly purge); the next window refills', async () => {
  const env = await makeEnv();
  const budget = budgetFromEnv({ LLM_MAX_PER_MINUTE: '3', LLM_MAX_PER_DAY: '5', LLM_MAX_PER_USER_10MIN: '100', LLM_MAX_PER_GROUP_HOUR: '100', LLM_MAX_TOKENS_PER_MINUTE: '100000', LLM_MAX_TOKENS_PER_DAY: '1000000' });
  const ask = (i = 1) => reserveLlmCall(env.db, { userId: `u${i}`, groupId: 'g', now: env.clock(), budget });
  assert.deepEqual([await ask(1), await ask(2), await ask(3), await ask(4)], [true, true, true, false]);         // 3 per minute across ALL users
  env.advance(61e3); assert.deepEqual([await ask(5), await ask(6), await ask(7)], [true, true, false]);          // 5 per day in total
  env.advance(2 * 3600e3); await purgeOld(env.db, env.clock());                                                      // the hourly purge must not forget today's count
  assert.equal(await ask(8), false, 'still over the daily cap');
  env.advance(25 * 3600e3); assert.equal(await ask(9), true, 'a new day starts fresh');
  await env.close();
});

test('token caps: a call that does not fit is refused WITHOUT using any budget; smaller calls still fit; per minute and per day', async () => {
  const env = await makeEnv();
  const budget = budgetFromEnv({ LLM_MAX_TOKENS_PER_MINUTE: '2500', LLM_MAX_TOKENS_PER_DAY: '4000', LLM_MAX_PER_MINUTE: '100', LLM_MAX_PER_DAY: '1000' });
  const call = (est) => reserveLlmCall(env.db, { userId: 'u', groupId: 'g', now: env.clock(), estTokens: est, budget });
  assert.equal(await call(LLM_TOKEN_ESTIMATE.chat), true);                    // 1600 of 2500
  assert.equal(await call(LLM_TOKEN_ESTIMATE.chat), false);                   // 3200 > 2500: refused …
  assert.equal(await call(LLM_TOKEN_ESTIMATE.agent), true);                   // … and did not eat the budget: 1600 + 700 = 2300 fits
  assert.equal(await call(LLM_TOKEN_ESTIMATE.agent), false);                  // 3000 > 2500
  env.advance(61e3); assert.equal(await call(LLM_TOKEN_ESTIMATE.chat), true); // new minute: 2300 + 1600 = 3900 of 4000 per day
  env.advance(61e3); assert.equal(await call(LLM_TOKEN_ESTIMATE.agent), false, 'the daily token cap (4000) holds across minutes');
  assert.equal(await reserveLlmCall(env.db, { userId: 'u', now: env.clock(), estTokens: 99999, budget }), false, 'a single call larger than the cap is never allowed');
  await env.close();
});

test('a refusal on a later check gives back what was already reserved (no leaked budget)', async () => {
  const env = await makeEnv();
  const budget = budgetFromEnv({ LLM_MAX_PER_USER_10MIN: '1', LLM_MAX_PER_MINUTE: '5', LLM_MAX_PER_DAY: '5' });
  const now = env.clock();
  assert.equal(await reserveLlmCall(env.db, { userId: 'a', now, budget }), true);
  for (let i = 0; i < 10; i++) assert.equal(await reserveLlmCall(env.db, { userId: 'a', now, budget }), false);  // refused by the per-user cap …
  for (const u of ['b', 'c', 'd', 'e']) assert.equal(await reserveLlmCall(env.db, { userId: u, now, budget }), true); // … without having consumed the shared minute/day budget
  assert.equal(await reserveLlmCall(env.db, { userId: 'f', now, budget }), false);                                    // 5 per minute reached exactly
  await env.close();
});

test('the budget is shared across application instances (two services, one database) and applies to agent classification', async () => {
  const env = await makeEnv();
  const { owner, members, group } = await env.team({ origins: [env.metro('Majestic'), env.metro('Indiranagar'), env.metro('Jayanagar')] });
  let calls = 0; const llm = { name: 'count', complete: async () => { calls++; return '{"intent":"other"}'; } };
  const budget = budgetFromEnv({ LLM_MAX_PER_MINUTE: '4', LLM_MAX_PER_DAY: '1000', LLM_MAX_PER_USER_10MIN: '100', LLM_MAX_TOKENS_PER_MINUTE: '100000' });
  const instanceA = createAgentService({ db: env.db, groups: env.groups, clock: env.clock, llm, budget });
  const instanceB = createAgentService({ db: env.db, groups: env.groups, clock: env.clock, llm, budget });
  void owner;
  for (let i = 0; i < 6; i++) await (i % 2 ? instanceA : instanceB).sendMessage(members[i % 2], group.id, `qwerty asdf unusual message number ${i} here`);
  assert.equal(calls, 4, 'two instances together made exactly the configured 4 calls per minute');
  await env.close();
});
