// Environment → config. Names only here; values come from the process environment (never committed).
// On Vercel, the platform provides the deployment's own host names (system variables, no protocol). They let a
// preview deployment (whose URL changes every time) work without hand-editing APP_BASE_URL:
//   VERCEL_PROJECT_PRODUCTION_URL — the production domain; VERCEL_URL — this exact deployment; VERCEL_BRANCH_URL — this branch.
// Only this project's own hosts are added to the same-origin allow-list.
export function vercelOrigins(env) {
  return ['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL', 'VERCEL_BRANCH_URL'].map(k => env[k]).filter(Boolean).map(h => `https://${h}`);
}

import { budgetFromEnv } from '../services/llmBudget.js';
import { isProductionLike } from '../bike/routingFactory.js';

export function loadConfig(env = process.env) {
  const bool = (v) => v === '1' || v === 'true';
  const onVercel = env.VERCEL === '1' || !!env.VERCEL_URL;
  const derivedBase = onVercel ? (env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null) : null;
  const appBaseUrl = env.APP_BASE_URL || derivedBase || 'http://localhost:3000';
  return {
    appBaseUrl,
    extraOrigins: [...new Set([...(env.EXTRA_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean), ...vercelOrigins(env)])].filter(o => o !== new URL(appBaseUrl).origin),
    databaseUrl: env.DATABASE_URL || null,
    // Schema changes are applied over a direct (non-pooled) connection when the provider supplies one (Neon: DATABASE_URL_UNPOOLED).
    migrationUrl: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || null,
    databaseSsl: env.DATABASE_SSL === 'false' ? false : env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    autoMigrate: bool(env.AUTO_MIGRATE),
    // Outgoing email. 'outbox' = development only (nothing is sent; messages are kept in memory); 'disabled' = no email.
    // Default: outbox on a local/dev host, disabled on a production-like (https, non-localhost) deployment.
    mail: { mode: env.MAIL_MODE || (isProductionLike(appBaseUrl) ? 'disabled' : 'outbox'), resendApiKey: env.RESEND_API_KEY || null, from: env.MAIL_FROM || null },
    cronSecret: env.CRON_SECRET || null,
    routing: {
      // mode: 'osrm' (default; any OSRM-compatible service) | 'estimate' (explicit opt-in: labelled straight-line estimates, no service)
      mode: env.ROUTING_MODE || 'osrm',
      baseUrl: env.ROUTING_PROVIDER_URL || 'https://router.project-osrm.org', profile: env.ROUTING_PROFILE || 'driving',
      minIntervalMs: env.ROUTING_MIN_INTERVAL_MS !== undefined && env.ROUTING_MIN_INTERVAL_MS !== '' ? Number(env.ROUTING_MIN_INTERVAL_MS) : 1100,
      apiKey: env.ROUTING_API_KEY || null, apiKeyHeader: env.ROUTING_API_KEY_HEADER || null,
      allowPublicDemoInProduction: bool(env.ALLOW_PUBLIC_OSRM_IN_PRODUCTION),
    },
    overpassUrl: env.OVERPASS_URL || undefined,
    // Nearby-venue search radius in km (default ≈ 2.5; clamped to 0.5–5 by the venue service). Per-request values override it.
    venues: { radiusKm: env.VENUE_RADIUS_KM ? Number(env.VENUE_RADIUS_KM) : 2.5 },
    llm: { budget: budgetFromEnv(env), provider: env.LLM_PROVIDER || null, anthropicKey: env.ANTHROPIC_API_KEY || null, openaiKey: env.OPENAI_API_KEY || null, groqKey: env.GROQ_API_KEY || null, groqModel: env.GROQ_MODEL || 'openai/gpt-oss-20b', anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini' },
  };
}
