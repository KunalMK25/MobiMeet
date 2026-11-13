#!/usr/bin/env node
// npm run llm:check            → (Groq) lists the models your key can use — free metadata call, no tokens
// npm run llm:check -- --test  → additionally makes ONE tiny real request with the configured provider/model
import { loadDotenv } from '../src/api/dotenv.js';
import { loadConfig } from '../src/api/config.js';
import { createLlm } from '../src/ai/llm.js';
import { listGroqModels, testComplete, explainNetworkFailure } from '../src/ai/llmCheck.js';

loadDotenv('.env');
const cfg = loadConfig();
const llm = createLlm(cfg.llm);
if (!llm) { console.log('No AI key is configured (add GROQ_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY to .env). Nothing to check — the app uses built-in answers.'); process.exit(0); }
console.log(`Configured AI provider: ${llm.name}`);
if (llm.name === 'groq') {
  const r = await listGroqModels({ key: cfg.llm.groqKey });
  if (!r.ok) {
    console.log(r.reason === 'KEY_REJECTED' ? '✘ Groq rejected the key — check you copied all of it (it starts with gsk_).' : `✘ Could not list models (${r.reason}${r.detail ? `: ${r.detail}` : ''}).`);
    if (r.reason === 'UNREACHABLE') console.log('  → ' + explainNetworkFailure(r.detail));
  }
  else {
    console.log(`✔ Key accepted. ${r.models.length} model(s) available to you.`);
    const mine = cfg.llm.groqModel; console.log(`  Configured model: ${mine} — ${r.models.includes(mine) ? '✔ available' : '✘ NOT available to your key; set GROQ_MODEL to one of the list below'}`);
    console.log('  Available: ' + r.models.join(', '));
  }
}
if (process.argv.includes('--test')) {
  console.log('Making one tiny real request…');
  const t = await testComplete(llm);
  console.log(t.ok ? `✔ ${t.provider} answered (${t.chars} characters).` : `✘ ${t.provider} failed: ${t.reason}`);
  if (!t.ok && t.detail) console.log('  → ' + explainNetworkFailure(t.detail));
  process.exit(t.ok ? 0 : 1);
}
