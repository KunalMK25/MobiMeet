// Real Claude integration: the structured context is passed as system
// context so the model grounds any app-related answer in the same
// data contextAwareAnswer() uses, while still answering general
// questions (Bangalore, metro history, etc.) from its own knowledge.
// (No longer calls any LLM from the browser — see askClaudeWithContext below.)
/**
 * AI module — (browser) live-LLM hook, intentionally DISABLED: it always throws so
 * callers fall back to the offline assistant. See the comment on the function.
 * @summary Purpose: forward the user's message to the real Claude API
 *   with the app-state context attached as system context, so
 *   app-related follow-ups stay grounded in real data while general
 *   questions (Bangalore facts, metro history, etc.) still get
 *   answered from the model's own knowledge.
 * @param {string} userMsg - the raw user message
 * @param {Object} ctx - a buildAppContext() snapshot
 * @returns {Promise<string>} the model's reply text
 * @throws if the HTTP request fails or the response has no text —
 *   the caller (sendMsg) catches this and falls back to offlineBotReply.
 * @complexity Network-bound.
 * @sideEffects None — no network access from the browser.
 */
export async function askClaudeWithContext(userMsg, ctx){
  // SECURITY (BuildSpec §9.5 / §15): the browser must never call an LLM provider directly — that needs an API
  // key, and keys must stay server-side. The classic planner therefore uses its data-grounded direct answers and
  // the offline bot (the caller falls back automatically on this error). LLM-assisted answers live in the
  // authenticated MobiMeet app: POST /api/chat (server-side key, plan-grounded, rate-limited).
  throw new Error('Live AI is available in the MobiMeet app (sign in); using the offline assistant here.');
}
