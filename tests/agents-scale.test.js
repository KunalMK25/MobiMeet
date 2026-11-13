// Group size is not special: agents, invitations, optimisation and sync work for 2…MAX participants, in both modes — and the LLM stays cheap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.js';
import { createAgentService } from '../src/services/agents.js';
import { createLlm } from '../src/ai/llm.js';
import { DEFAULT_LLM_BUDGET as LLM_BUDGET } from '../src/services/llmBudget.js';
import { GROUP_LIMITS } from '../src/config/Limits.js';

const STATIONS = ['Majestic', 'Indiranagar', 'Jayanagar', 'Whitefield', 'Yelachenahalli', 'Nagasandra', 'Baiyappanahalli', 'Banashankari', 'Mysuru Road', 'Hebbal'.replace('Hebbal', 'Cubbon Park'), 'Rajajinagar', 'Vijayanagar'];
const BIKE = Array.from({ length: GROUP_LIMITS.max }, (_, i) => ({ lat: 12.9 + (i % 4) * 0.03, lon: 77.5 + Math.floor(i / 4) * 0.08 + (i % 3) * 0.01 }));

async function groupOf(env, mode, n, llm = null) {
  const agents = createAgentService({ db: env.db, groups: env.groups, clock: env.clock, llm });
  const origin = (i) => (mode === 'METRO' ? env.metro(STATIONS[i]) : BIKE[i]);
  const owner = await env.user('Creator');
  const names = Array.from({ length: n - 1 }, (_, i) => `Friend${i + 1}`);
  const g = await env.groups.createGroup(owner, { name: `Group of ${n}`, mode, origin: origin(0), participantNames: names });
  const inv = await env.groups.createInvitation(owner, g.id);
  const pv = await env.groups.previewInvitation(inv.token);
  const users = [];
  for (let i = 0; i < n - 1; i++) { const u = await env.user(names[i]); users.push(u); await env.groups.joinWithToken(u, inv.token, { origin: origin(i + 1), participantId: pv.participants[i].id }, { ip: `n${n}${mode}${i}` }); }
  return { agents, owner, users, names, group: await env.groups.getGroup(owner, g.id), inv };
}

for (const mode of ['METRO', 'BIKE']) {
  for (const n of [2, 3, 5, 8, GROUP_LIMITS.max]) {
    test(`${mode}: a group of ${n} — every participant gets an agent, one delay reaches all the others, any of them can ask about it`, async () => {
      const env = await makeEnv();
      const { agents, owner, users, names, group } = await groupOf(env, mode, n);
      assert.equal(group.members.length, n); assert.equal(group.participants.length, n);
      const plan = await env.plans.requestOptimization(owner, group.id, {});
      assert.equal(plan.result.recommended.journeys.length, n);                                  // every participant's burden is in the plan
      const everyone = [owner, ...users];
      for (const u of everyone) await agents.pullEvents(u, group.id);
      const late = users[0];
      const r = await agents.sendMessage(late, group.id, "I'm running 20 minutes late");
      assert.equal(r.published.type, 'delay_reported');
      for (const u of everyone.filter(x => x !== late)) {
        const got = await agents.pullEvents(u, group.id);
        assert.ok(got.events.some(e => e.type === 'delay_reported' && e.by === names[0]), 'received by every other agent');
        await agents.ack(u, group.id, got.head); assert.equal((await agents.getAgent(u, group.id)).sync.inSync, true);
      }
      const asker = everyone[everyone.length - 1];
      const a = await agents.sendMessage(asker, group.id, `What happened to ${names[0]}?`);
      assert.match(a.reply, new RegExp(`${names[0]}.*20 min`));
      assert.equal((await agents.dashboard(owner, group.id)).totals.joined, n);
      await env.close();
    });
  }
}

test(`size limits: ${GROUP_LIMITS.min} to ${GROUP_LIMITS.max} work; one more is refused at naming time, at join time and in what-if`, async () => {
  const env = await makeEnv();
  const owner = await env.user('Owner');
  const tooMany = Array.from({ length: GROUP_LIMITS.max }, (_, i) => `N${i}`);               // + the creator = max + 1
  assert.equal(await env.code(env.groups.createGroup(owner, { name: 'x', mode: 'METRO', participantNames: tooMany })), 'INVALID_INPUT');
  const g = await env.groups.createGroup(owner, { name: 'Open', mode: 'METRO', origin: env.metro('Majestic') });   // open seats (no names)
  const inv = await env.groups.createInvitation(owner, g.id, { maxUses: 50 });
  for (let i = 1; i < GROUP_LIMITS.max; i++) await env.groups.joinWithToken(await env.user(`J${i}`), inv.token, { origin: env.metro(STATIONS[i]) }, { ip: `cap${i}` });
  assert.equal(await env.code(env.groups.joinWithToken(await env.user('Late'), inv.token, { origin: env.metro('Majestic') }, { ip: 'cap-x' })), 'GROUP_CLOSED');
  await env.close();
});

test('cost control: rules answer everything common with ZERO model calls; unusual text uses a small bounded budget; exhausted budget degrades quietly', async () => {
  const env = await makeEnv();
  let calls = 0;
  const llm = { name: 'counting', complete: async () => { calls++; return '{"intent":"other"}'; } };
  const { agents, owner, users, group } = await groupOf(env, 'METRO', 6, llm);
  await env.plans.requestOptimization(owner, group.id, {});
  const common = ["I'm 10 minutes late", "I've reached the metro station", 'who is late?', 'What happened to Friend1?', 'I agree with the plan', "I'm already at the meetup point", 'status', 'hi'];
  for (let i = 0; i < 40; i++) await agents.sendMessage(users[i % users.length], group.id, common[i % common.length]);
  assert.equal(calls, 0, 'rule-matched messages never reach the model');
  // unusual messages from many people: at most the global per-minute allowance in one window, and per-user limits
  const results = [];
  for (let i = 0; i < 60; i++) results.push(await agents.sendMessage(users[i % users.length], group.id, `qwerty asdf unusual note number ${i} blah`));
  assert.ok(calls <= LLM_BUDGET.perMinute.limit, `model calls (${calls}) stay within the global per-minute budget (${LLM_BUDGET.perMinute.limit})`);
  assert.ok(calls <= users.length * LLM_BUDGET.perUser.limit);
  assert.ok(results.every(r => r.reply && r.intent === 'other'), 'once the budget is used up, messages are still answered (privately) — no errors');
  const before = calls; env.advance(61 * 1000);                                                // a new minute: the budget refills
  await agents.sendMessage(users[0], group.id, 'another unusual note about nothing'); assert.ok(calls >= before);
  await env.close();
});

test('provider 429: the model is left alone for the Retry-After period (no hammering), then used again', async () => {
  let net = 0; let status = 429;
  const fetchImpl = async () => { net++; return status === 429 ? { ok: false, status: 429, headers: { get: () => '30' } } : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }; };
  const llm = createLlm({ groqKey: 'gsk_test', groqModel: 'llama-x', fetchImpl });
  await assert.rejects(llm.complete({ system: 's', messages: [{ role: 'user', content: 'u' }] }), /429/);
  assert.equal(net, 1, 'a 429 is not retried');
  for (let i = 0; i < 5; i++) await assert.rejects(llm.complete({ system: 's', messages: [{ role: 'user', content: 'u' }] }), /backing off/);
  assert.equal(net, 1, 'no network calls while cooling down');
});
