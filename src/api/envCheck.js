// ═══════════════════════════════════════════════════════════
//  api/envCheck.js — explains which environment variables are set/missing for a target, WITHOUT revealing values
//  and WITHOUT any network call (so it can never incur a charge). Output contains variable NAMES and plain-language
//  advice only. targets: 'local' | 'preview' | 'production'.
// ═══════════════════════════════════════════════════════════
import { loadConfig } from './config.js';

const set = (env, k) => typeof env[k] === 'string' && env[k].trim() !== '';
const looksPlaceholder = (v) => /\b(USER|PASSWORD|HOST|DBNAME|replace-with|example\.invalid|changeme)\b/i.test(v);

export function checkEnv(env, target = 'local') {
  const cfg = loadConfig(env);
  const findings = [];                         // {name, level: 'ok'|'missing'|'warn'|'info', message}
  const add = (name, level, message) => findings.push({ name, level, message });
  const need = target !== 'local';

  // ── database ──
  if (set(env, 'DATABASE_URL')) {
    const v = env.DATABASE_URL;
    if (!/^postgres(ql)?:\/\//i.test(v)) add('DATABASE_URL', 'warn', 'is set but does not start with postgres:// or postgresql://');
    else if (looksPlaceholder(v)) add('DATABASE_URL', 'warn', 'still contains placeholder text from .env.example (USER / PASSWORD / HOST / DBNAME)');
    else add('DATABASE_URL', 'ok', 'is set' + (/pooler/i.test(v) ? ' (pooled connection — good for serverless)' : ''));
  } else add('DATABASE_URL', need ? 'missing' : 'info', need ? 'is required: the app stores accounts, groups and plans in PostgreSQL' : 'not set — fine locally (an embedded database is used)');
  if (set(env, 'DATABASE_URL_UNPOOLED')) add('DATABASE_URL_UNPOOLED', 'ok', 'is set (used only for schema migrations)');
  else if (need) add('DATABASE_URL_UNPOOLED', 'info', 'not set — optional; migrations will use DATABASE_URL');

  // ── app URL / security ──
  if (set(env, 'APP_BASE_URL')) { try { const u = new URL(env.APP_BASE_URL); add('APP_BASE_URL', need && u.protocol !== 'https:' ? 'warn' : 'ok', need && u.protocol !== 'https:' ? 'should be an https:// URL for preview/production' : 'is set'); } catch { add('APP_BASE_URL', 'warn', 'is not a valid URL'); } }
  else add('APP_BASE_URL', cfg.appBaseUrl.startsWith('https://') ? 'ok' : (need ? 'warn' : 'info'), cfg.appBaseUrl.startsWith('https://') ? 'not set, but derived automatically from Vercel system variables' : need ? 'not set — set it to your site URL (on Vercel it is derived automatically if left empty)' : 'not set — defaults to http://localhost:3000');
  if (target === 'production') {
    if (!set(env, 'CRON_SECRET')) add('CRON_SECRET', 'missing', 'is required in production for the daily clean-up job (generate a long random string)');
    else add('CRON_SECRET', env.CRON_SECRET.length >= 24 ? 'ok' : 'warn', env.CRON_SECRET.length >= 24 ? 'is set' : 'is set but short — use at least 24 random characters');
  }

  // ── email (password reset) ──
  const mailMode = cfg.mail.mode;
  if (!set(env, 'MAIL_MODE') && need) add('MAIL_MODE', 'info', 'password reset by email is OFF in production: no mail provider is connected yet (the app says so on the Forgot-password page instead of pretending)');
  else if (mailMode === 'outbox' && need) add('MAIL_MODE', 'warn', '"outbox" is for local development only; on a production-like host it is ignored and email stays off');
  else if (mailMode === 'resend') {
    if (!set(env, 'RESEND_API_KEY') || !set(env, 'MAIL_FROM')) add('MAIL_MODE', 'warn', '"resend" needs BOTH RESEND_API_KEY and MAIL_FROM (an address on a domain verified in Resend); until then email stays OFF');
    else add('MAIL_MODE', 'ok', 'real email through Resend is configured (RESEND_API_KEY and MAIL_FROM are set)');
  }
  else if (!['outbox', 'disabled'].includes(mailMode)) add('MAIL_MODE', 'warn', `"${String(mailMode).slice(0, 20)}" is not supported (use "outbox" locally, "resend" with a verified domain, or "disabled")`);
  else if (!need) add('MAIL_MODE', 'info', `mail mode is "${mailMode}" — locally, password-reset links are kept in a development outbox and printed in the server log`);

  // ── routing ──
  const r = cfg.routing;
  if (r.mode === 'estimate') add('ROUTING_MODE', 'ok', 'is "estimate": Bike mode works with NO routing service, using clearly labelled straight-line estimates');
  else if (r.mode !== 'osrm') add('ROUTING_MODE', 'warn', 'has an unknown value — use "osrm" or "estimate"');
  else if (set(env, 'ROUTING_PROVIDER_URL')) add('ROUTING_PROVIDER_URL', 'ok', 'is set (your own OSRM-compatible service)');
  else if (need) add('ROUTING_MODE', 'missing', 'Bike mode needs a routing choice in production: set ROUTING_MODE=estimate (free, rough estimates) or ROUTING_PROVIDER_URL (a real routing service). The public demo is refused in production.');
  else add('ROUTING_PROVIDER_URL', 'info', 'not set — local development uses the public OSRM demo (development only)');
  if (cfg.routing.allowPublicDemoInProduction) add('ALLOW_PUBLIC_OSRM_IN_PRODUCTION', 'warn', 'is true — the shared public demo server is not meant for production use; set it to false');

  // ── AI (optional) ──
  const keys = { anthropic: ['ANTHROPIC_API_KEY', /^sk-ant-/, 'sk-ant-'], openai: ['OPENAI_API_KEY', /^sk-/, 'sk-'], groq: ['GROQ_API_KEY', /^gsk_/, 'gsk_'] };
  const present = Object.entries(keys).filter(([, [name]]) => set(env, name)).map(([p]) => p);
  if (!present.length) add('ANTHROPIC_API_KEY / OPENAI_API_KEY / GROQ_API_KEY', 'info', 'none is set — AI features stay off and everything uses deterministic answers (this is fine)');
  for (const p of present) {
    const [name, re, prefix] = keys[p];
    add(name, re.test(env[name]) ? 'ok' : 'warn', re.test(env[name]) ? 'is set (format looks right; not tested — run `npm run llm:check -- --test` yourself when you are ready to make one tiny real request)' : `is set but does not start with "${prefix}" — double-check you copied the whole key`);
  }
  if (present.length > 1 && !set(env, 'LLM_PROVIDER')) add('LLM_PROVIDER', 'warn', `several keys are set (${present.join(', ')}) — choose one by setting LLM_PROVIDER`);
  if (set(env, 'LLM_PROVIDER')) {
    if (!Object.keys(keys).includes(env.LLM_PROVIDER)) add('LLM_PROVIDER', 'warn', 'must be "anthropic", "openai" or "groq"');
    else if (!present.includes(env.LLM_PROVIDER)) add('LLM_PROVIDER', 'warn', 'names a provider whose key is not set');
  }
  if (present.includes('groq') && (!set(env, 'LLM_PROVIDER') || env.LLM_PROVIDER === 'groq')) add('GROQ_MODEL', 'info', `model is ${cfg.llm.groqModel}${set(env, 'GROQ_MODEL') ? '' : ' (default)'} — run \`npm run llm:check\` to see which models your key can use`);

  const blockers = findings.filter(f => f.level === 'missing' || f.level === 'warn' && target !== 'local' && ['DATABASE_URL', 'CRON_SECRET'].includes(f.name));
  return { target, findings, ready: blockers.length === 0 };
}

export function formatReport({ target, findings, ready }) {
  const icon = { ok: '✔', missing: '✘', warn: '!', info: '·' };
  return [`Environment check for: ${target}`, '', ...findings.map(f => `  ${icon[f.level]} ${f.name} — ${f.message}`), '', ready ? `Ready for ${target}.` : `NOT ready for ${target}: fix the ✘ / ! items above.`].join('\n');
}
