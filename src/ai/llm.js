// ═══════════════════════════════════════════════════════════
//  ai/llm.js — server-side LLM providers (Anthropic Messages / OpenAI Chat Completions)
//  Keys come from the server environment ONLY; this module is never bundled for the browser.
//  Bounded: per-call timeout, ≤1 retry on 429/5xx, capped output tokens. Prompts/replies are not logged.
//  Returns null from createLlm() when no key is configured — every caller has a deterministic fallback.
// ═══════════════════════════════════════════════════════════
export class LlmError extends Error { constructor(m, retryable = false, code = null) { super(m); this.name = 'LlmError'; this.retryable = retryable; this.code = code; } }

// Network-level cause of a failed fetch (e.g. ENOTFOUND, UNABLE_TO_GET_ISSUER_CERT_LOCALLY). Only a safe, upper-case code is
// kept — never a message that could contain a URL or a key.
export const netCode = (e) => { const c = e?.cause?.code ?? e?.code; return typeof c === 'string' && /^[A-Z0-9_]{3,60}$/.test(c) ? c : null; };

export const GROQ_BASE = 'https://api.groq.com/openai/v1';
// gpt-oss models on Groq are "reasoning" models: they accept reasoning_effort/include_reasoning and may spend part of the
// completion budget on hidden reasoning, so they get a low effort and extra headroom. Other models must not receive these fields.
export const isGroqReasoningModel = (m) => /^openai\/gpt-oss/.test(String(m));

export function createLlm({ provider, anthropicKey, openaiKey, groqKey, anthropicModel, openaiModel, groqModel = 'openai/gpt-oss-20b', fetchImpl = globalThis.fetch, timeoutMs = 20000, retries = 1 } = {}) {
  const choice = provider || (anthropicKey ? 'anthropic' : openaiKey ? 'openai' : groqKey ? 'groq' : null);
  if (choice === 'anthropic' && !anthropicKey) return null;
  if (choice === 'openai' && !openaiKey) return null;
  if (choice === 'groq' && !groqKey) return null;
  if (!choice || !['anthropic', 'openai', 'groq'].includes(choice)) return null;

  let coolUntil = 0;                       // after a 429 the provider is left alone until this time (per instance)
  async function post(url, headers, body) {
    if (Date.now() < coolUntil) throw new LlmError('LLM provider is rate-limiting; backing off', false, 'COOLDOWN');
    let last;
    for (let i = 0; i <= retries; i++) {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
        if (res.status === 429) {
          const wait = Math.min(Math.max(Number(res.headers?.get?.('retry-after')) || 30, 5), 120);
          coolUntil = Date.now() + wait * 1000;
          throw new LlmError('LLM provider status 429', false, 'RATE_LIMITED');       // retrying immediately would only make it worse
        }
        if (res.status >= 500) throw new LlmError(`LLM provider status ${res.status}`, true);
        if (!res.ok) throw new LlmError(`LLM provider status ${res.status}`);
        return await res.json();
      } catch (e) {
        last = e instanceof LlmError ? e : new LlmError(e.name === 'AbortError' ? 'LLM request timed out' : `LLM provider unreachable${netCode(e) ? ` (${netCode(e)})` : ''}`, true, netCode(e));
        if (!last.retryable) break;
      } finally { clearTimeout(timer); }
    }
    throw last;
  }

  if (choice === 'anthropic') return {
    name: 'anthropic',
    async complete({ system, messages, maxTokens = 400 }) {
      const j = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        { model: anthropicModel, max_tokens: Math.min(maxTokens, 800), system, messages });
      const text = (j.content || []).map(b => b.text || '').join('').trim();
      if (!text) throw new LlmError('Empty LLM response');
      return text;
    },
  };
  if (choice === 'groq') return {
    name: 'groq',
    async complete({ system, messages, maxTokens = 400 }) {
      const reasoning = isGroqReasoningModel(groqModel);
      const want = Math.min(maxTokens, 800);
      const j = await post(`${GROQ_BASE}/chat/completions`, { Authorization: `Bearer ${groqKey}` }, {
        model: groqModel, messages: [{ role: 'system', content: system }, ...messages],
        max_completion_tokens: reasoning ? Math.min(want + 700, 1500) : want,        // headroom for hidden reasoning
        ...(reasoning ? { reasoning_effort: 'low', include_reasoning: false } : {}),
      });
      const c = j.choices?.[0];
      const text = c?.message?.content?.trim();
      if (!text) throw new LlmError(c?.finish_reason === 'length' ? 'LLM response was cut off before any answer' : 'Empty LLM response');
      return text;
    },
  };
  return {
    name: 'openai',
    async complete({ system, messages, maxTokens = 400 }) {
      const j = await post('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${openaiKey}` },
        { model: openaiModel, max_tokens: Math.min(maxTokens, 800), messages: [{ role: 'system', content: system }, ...messages] });
      const text = j.choices?.[0]?.message?.content?.trim();
      if (!text) throw new LlmError('Empty LLM response');
      return text;
    },
  };
}
