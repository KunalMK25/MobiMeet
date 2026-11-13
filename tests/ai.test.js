import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.js';
import { createLlm, LlmError } from '../src/ai/llm.js';
import { extractNumbers, allowedNumbers, unknownNumbers, pseudonymise } from '../src/ai/guard.js';
import { phraseExplanation } from '../src/ai/phraser.js';
import { parsePreferenceText } from '../src/ai/preferenceParser.js';
import { createChatService } from '../src/ai/chat.js';
import { answerFromPlan } from '../src/ai/planAnswers.js';

const fakeLlm = (reply) => ({ name: 'fake', calls: [], async complete(req) { this.calls.push(req); if (reply instanceof Error) throw reply; return typeof reply === 'function' ? reply(req) : reply; } });
const res = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });

test('createLlm: null without keys; picks the configured provider; sends keys only server-side headers', async () => {
  assert.equal(createLlm({}), null); assert.equal(createLlm({ provider: 'anthropic' }), null);
  let seen;
  const a = createLlm({ anthropicKey: 'k-test', anthropicModel: 'm', fetchImpl: async (u, o) => { seen = { u, o }; return res({ content: [{ text: 'hi' }] }); } });
  assert.equal(await a.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] }), 'hi');
  assert.match(seen.u, /api\.anthropic\.com/); assert.equal(seen.o.headers['x-api-key'], 'k-test');
  assert.ok(!JSON.parse(seen.o.body).messages.some(m => m.content.includes('k-test')));
  const o = createLlm({ openaiKey: 'k2', openaiModel: 'm', fetchImpl: async () => res({ choices: [{ message: { content: 'yo' } }] }) });
  assert.equal(o.name, 'openai'); assert.equal(await o.complete({ system: 's', messages: [] }), 'yo');
});
test('createLlm: retries once on 5xx, fails after, no retry on 4xx, caps tokens', async () => {
  let n = 0, body;
  const flaky = createLlm({ anthropicKey: 'k', fetchImpl: async (u, o) => { body = JSON.parse(o.body); return ++n === 1 ? res({}, 503) : res({ content: [{ text: 'ok' }] }); } });
  assert.equal(await flaky.complete({ system: 's', messages: [], maxTokens: 99999 }), 'ok'); assert.equal(n, 2); assert.equal(body.max_tokens, 800);
  let m = 0;
  await assert.rejects(createLlm({ anthropicKey: 'k', fetchImpl: async () => { m++; return res({}, 401); } }).complete({ system: 's', messages: [] }), LlmError); assert.equal(m, 1);
  await assert.rejects(createLlm({ anthropicKey: 'k', fetchImpl: async () => res({ content: [] }) }).complete({ system: 's', messages: [] }), /Empty/);
});
test('guard: number extraction ignores "Person n", pseudonymisation round-trips', () => {
  assert.deepEqual(extractNumbers('Person 2 travels 35.5 min and pays ₹40'), [35.5, 40]);
  const allowed = allowedNumbers({ a: 35.5 }, 'cost 40');
  assert.deepEqual(unknownNumbers('35.5 and 41', allowed), [41]);
  const { enc, dec } = pseudonymise({ u1: 'Asha', u2: 'Ben' });
  assert.equal(enc('u1 then Ben'), 'Person 1 then Person 2');
  assert.equal(enc('Asha meets Ben'), 'Person 1 meets Person 2'); assert.equal(dec('Person 1 is first'), 'Asha is first');
});

const explanation = { facts: { recommended: 'Majestic', rangeMin: 12 }, lines: ['Recommended meetup: Majestic. Range 12 min. Asha 40 min.'], limitations: [] };
test('phraser: accepts a faithful rewrite; pseudonymises names in the prompt', async () => {
  const llm = fakeLlm((req) => { assert.ok(!req.messages[0].content.includes('Asha')); return 'Person 1 has a 40 min trip and the range is 12 min — Majestic works.'; });
  const out = await phraseExplanation(explanation, llm, { names: { u1: 'Asha' } });
  assert.equal(out.source, 'llm'); assert.match(out.lines[0], /^Asha has a 40 min trip/);
});
test('phraser: rejects invented numbers, empty/oversized output, failures, and missing LLM → deterministic text', async () => {
  for (const [reply, reason] of [['Majestic saves 15 min', 'LLM_INTRODUCED_NUMBERS'], ['', 'LLM_OUTPUT_REJECTED'], ['x'.repeat(2000), 'LLM_OUTPUT_REJECTED'], [new LlmError('down'), 'LLM_UNAVAILABLE']]) {
    const out = await phraseExplanation(explanation, fakeLlm(reply), { names: {} });
    assert.equal(out.source, 'deterministic'); assert.equal(out.reason, reason); assert.deepEqual(out.lines, explanation.lines);
  }
  assert.equal((await phraseExplanation(explanation, null)).reason, 'LLM_NOT_CONFIGURED');
});
test('preference parser: whitelists + validates; rejects bad values; never applied implicitly', async () => {
  const ok = await parsePreferenceText('cheap please, max 45 minutes, no stairs', fakeLlm('{"costSensitivity":0.9,"maxTravelMinutes":45,"requiresStepFreeAccess":true,"isAdmin":true}'));
  assert.deepEqual(ok, { prefs: { costSensitivity: 0.9 }, hard: { maxTravelMinutes: 45, requiresStepFreeAccess: true }, source: 'llm' });
  for (const bad of ['{"costSensitivity":7}', 'not json', '{"maxTravelMinutes":-3}']) assert.equal((await parsePreferenceText('x', fakeLlm(bad))).source, 'none');
  assert.equal((await parsePreferenceText('x', null)).reason, 'LLM_NOT_CONFIGURED'); assert.equal((await parsePreferenceText('', fakeLlm('{}'))).source, 'none');
});

let E, team, plan;
before(async () => { E = await makeEnv(); team = await E.team({ origins: [E.metro('Whitefield'), E.metro('Challaghatta'), E.metro('Silk Institute')] }); plan = await E.plans.requestOptimization(team.owner, team.group.id); });
after(() => E.close());
const chat = (llm) => createChatService({ db: E.db, groups: E.groups, plans: E.plans, config: {}, llm, clock: E.clock });

test('direct answers come from stored plan numbers', () => {
  const nameOf = (id) => plan.result.participants.find(p => p.userId === id)?.displayName;
  assert.match(answerFromPlan(plan.result, 'Why this station?', nameOf), /Recommended meetup/);
  assert.match(answerFromPlan(plan.result, 'who has the longest journey?', nameOf), /min\./);
  assert.match(answerFromPlan(plan.result, 'how much will it cost', nameOf), /₹\d/);
  assert.equal(answerFromPlan(plan.result, 'what is the weather', nameOf), null);
});
test('chat: plan questions answered deterministically without calling the LLM', async () => {
  const llm = fakeLlm('SHOULD NOT BE USED'); const c = chat(llm);
  const r = await c.ask(team.owner, { groupId: team.group.id, message: 'Why was this chosen?' });
  assert.equal(r.source, 'deterministic'); assert.equal(llm.calls.length, 0);
});
test('chat: open questions go to the LLM with pseudonymised, coordinate-free facts; unverified numbers are flagged', async () => {
  const llm = fakeLlm('Probably quiet on weekdays, about 99 people usually go.'); const c = chat(llm);
  const r = await c.ask(team.members[0], { groupId: team.group.id, message: 'Is it busy there on weekdays?' });
  assert.equal(r.source, 'llm'); assert.equal(r.unverifiedNumbers, true); assert.match(r.reply, /unverified/);
  const sent = llm.calls[0].system + JSON.stringify(llm.calls[0].messages);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(sent), 'no user ids sent to the LLM');
  assert.ok(!/Owner|Member1|Member2/.test(sent), 'no display names sent to the LLM');
  assert.ok(!/originLat|originLon|origin_lat/.test(sent), 'no origin coordinates sent to the LLM');
});
test('chat: without an LLM, or when it fails, the user still gets a useful answer', async () => {
  assert.equal((await chat(null).ask(team.owner, { groupId: team.group.id, message: 'tell me a joke' })).source, 'fallback');
  assert.equal((await chat(fakeLlm(new LlmError('x'))).ask(team.owner, { groupId: team.group.id, message: 'tell me a joke' })).source, 'fallback');
});
test('chat: validates input, enforces membership and rate limits', async () => {
  const c = chat(null);
  assert.equal(await E.code(c.ask(team.owner, { groupId: team.group.id, message: '' })), 'INVALID_INPUT');
  assert.equal(await E.code(c.ask(await E.user('Out'), { groupId: team.group.id, message: 'hello' })), 'NOT_FOUND');
  let last; for (let i = 0; i < 25; i++) last = await c.ask(team.members[1], { groupId: team.group.id, message: 'why?' }).catch(e => e.code);
  assert.equal(last, 'RATE_LIMITED');
});
test('parseNotes and phrase: membership enforced; deterministic when LLM is absent', async () => {
  const c = chat(null);
  assert.equal((await c.parseNotes(team.owner, { groupId: team.group.id, text: 'cheap' })).source, 'none');
  assert.equal(await E.code(c.parseNotes(await E.user('Out2'), { groupId: team.group.id, text: 'x' })), 'NOT_FOUND');
  const ph = await c.phrase(team.owner, { groupId: team.group.id });
  assert.equal(ph.source, 'deterministic'); assert.deepEqual(ph.lines, plan.result.explanation.lines);
  const withLlm = await chat(fakeLlm(`Meet at ${plan.result.recommended.label}.`)).phrase(team.owner, { groupId: team.group.id });
  assert.equal(withLlm.source, 'llm');
});

import { isGroqReasoningModel, GROQ_BASE } from '../src/ai/llm.js';
import { listGroqModels, testComplete } from '../src/ai/llmCheck.js';
const FAKE_GROQ = ['gsk', 'x'.repeat(8)].join('_');   // fake, short, assembled: not key-shaped for the repo scanner

test('Groq: OpenAI-compatible request to the documented endpoint; Bearer key; max_completion_tokens; reasoning fields only for gpt-oss', async () => {
  const calls = [];
  const mk = (model) => createLlm({ groqKey: FAKE_GROQ, groqModel: model, fetchImpl: async (u, o) => { calls.push({ u, o, body: JSON.parse(o.body) }); return res({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] }); } });
  const g = mk('openai/gpt-oss-20b');
  assert.equal(g.name, 'groq'); assert.equal(await g.complete({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 300 }), 'hello');
  assert.equal(calls[0].u, `${GROQ_BASE}/chat/completions`); assert.equal(calls[0].o.headers.Authorization, `Bearer ${FAKE_GROQ}`);
  assert.deepEqual(calls[0].body.messages[0], { role: 'system', content: 's' });
  assert.equal(calls[0].body.max_completion_tokens, 1000); assert.equal(calls[0].body.reasoning_effort, 'low'); assert.equal(calls[0].body.include_reasoning, false); assert.ok(!('max_tokens' in calls[0].body));
  assert.ok(!JSON.stringify(calls[0].body).includes(FAKE_GROQ));
  await mk('llama-3.3-70b-versatile').complete({ system: 's', messages: [], maxTokens: 300 });
  assert.equal(calls[1].body.max_completion_tokens, 300); assert.ok(!('reasoning_effort' in calls[1].body) && !('include_reasoning' in calls[1].body));   // non-reasoning model: no extra fields
  assert.equal(isGroqReasoningModel('openai/gpt-oss-120b'), true); assert.equal(isGroqReasoningModel('llama-3.1-8b-instant'), false);
});
test('Groq: a response cut off during reasoning, an empty reply and HTTP errors all become LlmError (so callers fall back)', async () => {
  const bad = (body, status = 200) => createLlm({ groqKey: FAKE_GROQ, retries: 0, fetchImpl: async () => res(body, status) });
  await assert.rejects(bad({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }).complete({ system: 's', messages: [] }), /cut off/);
  await assert.rejects(bad({ choices: [] }).complete({ system: 's', messages: [] }), /Empty/);
  await assert.rejects(bad({}, 401).complete({ system: 's', messages: [] }), LlmError);
  let n = 0; const flaky = createLlm({ groqKey: FAKE_GROQ, fetchImpl: async () => (++n === 1 ? res({}, 500) : res({ choices: [{ message: { content: 'ok' } }] })) });
  assert.equal(await flaky.complete({ system: 's', messages: [] }), 'ok'); assert.equal(n, 2);            // a 5xx is retried once
  let m = 0; const limited = createLlm({ groqKey: FAKE_GROQ, fetchImpl: async () => { m++; return res({}, 429); } });
  await assert.rejects(limited.complete({ system: 's', messages: [] }), /429/); assert.equal(m, 1);        // a 429 is NOT retried …
  await assert.rejects(limited.complete({ system: 's', messages: [] }), /backing off/); assert.equal(m, 1); // … and the provider is left alone afterwards
});
test('provider selection: explicit choice wins; auto-detect order anthropic → openai → groq; missing key → null; unknown provider → null', () => {
  assert.equal(createLlm({ groqKey: FAKE_GROQ }).name, 'groq'); assert.equal(createLlm({ provider: 'groq', groqKey: FAKE_GROQ, openaiKey: 'k' }).name, 'groq');
  assert.equal(createLlm({ openaiKey: 'k', groqKey: FAKE_GROQ }).name, 'openai'); assert.equal(createLlm({ provider: 'groq' }), null); assert.equal(createLlm({ provider: 'mystery', groqKey: FAKE_GROQ }), null);
});
test('llm:check helpers: model list is metadata-only, filters inactive models, distinguishes rejected key / outage; test call never echoes the key', async () => {
  let seen; const ok = await listGroqModels({ key: FAKE_GROQ, fetchImpl: async (u, o) => { seen = { u, o }; return res({ data: [{ id: 'b', active: true }, { id: 'a' }, { id: 'old', active: false }] }); } });
  assert.deepEqual(ok, { ok: true, models: ['a', 'b'] }); assert.equal(seen.u, `${GROQ_BASE}/models`); assert.equal(seen.o.headers.Authorization, `Bearer ${FAKE_GROQ}`); assert.ok(!('body' in seen.o));
  assert.deepEqual(await listGroqModels({ key: 'k', fetchImpl: async () => res({}, 401) }), { ok: false, reason: 'KEY_REJECTED' });
  assert.deepEqual(await listGroqModels({ key: 'k', fetchImpl: async () => { throw new Error('net'); } }), { ok: false, reason: 'UNREACHABLE', detail: null });
  assert.deepEqual(await testComplete({ name: 'groq', complete: async () => 'ready' }), { ok: true, provider: 'groq', chars: 5 });
  const f = await testComplete({ name: 'groq', complete: async () => { throw new Error(`bad key ${'q'.repeat(40)}`); } }); assert.equal(f.ok, false); assert.ok(!f.reason.includes('q'.repeat(30)));
});

import { explainNetworkFailure } from '../src/ai/llmCheck.js';
import { netCode } from '../src/ai/llm.js';
test('network failures keep a safe cause code and are explained in plain language (never "turn certificate checks off")', async () => {
  const certErr = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('unable to get local issuer certificate at https://x?key=SECRETVALUE'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }) });
  assert.equal(netCode(certErr), 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'); assert.equal(netCode(new Error('x')), null); assert.equal(netCode({ cause: { code: 'not a code!' } }), null);
  const r = await listGroqModels({ key: FAKE_GROQ, fetchImpl: async () => { throw certErr; } });
  assert.deepEqual(r, { ok: false, reason: 'UNREACHABLE', detail: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });
  const llm = createLlm({ groqKey: FAKE_GROQ, retries: 0, fetchImpl: async () => { throw certErr; } });
  const t = await testComplete(llm); assert.equal(t.ok, false); assert.equal(t.detail, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'); assert.ok(!t.reason.includes('SECRETVALUE') && !t.reason.includes(FAKE_GROQ));
  assert.match(explainNetworkFailure('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), /security tool/); assert.match(explainNetworkFailure('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), /NODE_EXTRA_CA_CERTS/);
  for (const code of ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ENOTFOUND', 'ETIMEDOUT', null]) assert.ok(!/TLS_REJECT_UNAUTHORIZED\s*=\s*0|rejectUnauthorized/i.test(explainNetworkFailure(code)));
  assert.match(explainNetworkFailure('ENOTFOUND'), /DNS/); assert.match(explainNetworkFailure('ETIMEDOUT'), /firewall/);
});
