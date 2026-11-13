// ═══════════════════════════════════════════════════════════
//  ai/llmCheck.js — helpers for `npm run llm:check` (run by YOU, locally, with the key from your private .env)
//  • listGroqModels(): GET /models — metadata only, consumes no tokens; shows which models the key can use.
//  • testComplete(): ONE tiny completion (≈20 output tokens) so you can see the key + model really work.
//  Neither function ever returns or logs the key.
// ═══════════════════════════════════════════════════════════
import { GROQ_BASE, netCode } from './llm.js';

export async function listGroqModels({ key, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${GROQ_BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: ctl.signal });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'KEY_REJECTED' };
    if (!res.ok) return { ok: false, reason: `HTTP_${res.status}` };
    const j = await res.json();
    return { ok: true, models: (j.data ?? []).filter(m => m.active !== false).map(m => m.id).sort() };
  } catch (e) { return { ok: false, reason: 'UNREACHABLE', detail: netCode(e) }; } finally { clearTimeout(t); }
}

export async function testComplete(llm) {
  try {
    const text = await llm.complete({ system: 'Reply with the single word: ready', messages: [{ role: 'user', content: 'ping' }], maxTokens: 20 });
    return { ok: true, provider: llm.name, chars: text.length };
  } catch (e) { return { ok: false, provider: llm.name, reason: String(e.message).replace(/[A-Za-z0-9_-]{24,}/g, '…'), detail: e.code ?? null }; }
}

// Plain-language explanation of a network failure code. Never suggests switching certificate verification off.
export function explainNetworkFailure(code) {
  if (['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_UNTRUSTED'].includes(code)) {
    return 'HTTPS traffic here is being re-signed by a security tool (a proxy or a wrapper such as `pmg`) whose certificate Node does not trust. Do NOT turn certificate checking off. Options: run the script directly with `node scripts/llm-check.mjs` (not through `npm`), or ask your IT/security team for the company CA certificate file and point NODE_EXTRA_CA_CERTS at it.';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The name api.groq.com could not be looked up (DNS). Check your internet connection or VPN.';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'The connection was blocked or timed out — a firewall, VPN or proxy may be stopping api.groq.com.';
  return 'The request failed before reaching Groq. Try again, or run the script directly with `node scripts/llm-check.mjs`.';
}
