// Vercel serverless entry (the ONLY function — rewritten from /api/*; see vercel.json).
// Production needs DATABASE_URL (a PERSONAL Postgres you provision) and APP_BASE_URL.
import { createApp } from '../src/api/app.js';
import { createPgDb } from '../src/db/client.js';
import { loadConfig } from '../src/api/config.js';
import { createChatService } from '../src/ai/chat.js';

let appPromise;
function getApp() {
  appPromise ??= (async () => {
    const config = loadConfig();
    const db = await createPgDb({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
    return createApp({ db, config, chat: (deps) => createChatService({ ...deps }), log: (e) => console.log(JSON.stringify(e)) });
  })().catch((e) => { appPromise = null; throw e; });
  return appPromise;
}

// vercel.json rewrites /api/:path* → /api/index?__path=:path* so the original API path is explicit
// (we do not rely on how the platform reports req.url after a rewrite).
export function adaptRequest(req) {
  const url = new URL(req.url, 'http://x');
  const original = url.searchParams.get('__path');
  url.searchParams.delete('__path');
  return {
    method: req.method, path: original != null ? `/api/${original}` : url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers,
    body: req.body && typeof req.body === 'object' ? req.body : (typeof req.body === 'string' && req.body ? req.body : undefined),
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown',
  };
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    const out = await app.handle(adaptRequest(req));
    res.statusCode = out.status;
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.end(out.body);
  } catch (e) {
    console.error(JSON.stringify({ level: 'fatal', error: String(e?.message ?? e).slice(0, 200) }));
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end('{"error":{"code":"INTERNAL","message":"Service unavailable."}}');
  }
}
