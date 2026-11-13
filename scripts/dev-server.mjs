#!/usr/bin/env node
// Local full-stack server: static files + /api on an EMBEDDED Postgres (PGlite, persisted in .data/pgdata).
// No external accounts or credentials. Optional env: PORT, ANTHROPIC_API_KEY / OPENAI_API_KEY (for the LLM
// features), ROUTING_PROVIDER_URL (defaults to the public OSRM demo — development use only).
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgliteDb } from '../src/db/client.js';
import { createApp } from '../src/api/app.js';
import { loadConfig } from '../src/api/config.js';
import { createChatService } from '../src/ai/chat.js';
import { loadDotenv } from '../src/api/dotenv.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadDotenv(join(root, '.env'));          // optional local .env (git-ignored); shell variables win
const port = Number(process.env.PORT || 3000);
const config = loadConfig({ ...process.env, APP_BASE_URL: process.env.APP_BASE_URL || `http://localhost:${port}`, AUTO_MIGRATE: '1' });
await mkdir(join(root, '.data'), { recursive: true });
const db = await createPgliteDb({ dataDir: join(root, '.data', 'pgdata') });
if (env.loaded) console.log(`Loaded .env (${env.keys.length} variable(s) set from it)`);
const app = await createApp({ db, config, chat: (deps) => createChatService(deps), log: (e) => e.level === 'error' && console.error(e) });

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const STATIC_ROOTS = ['index.html', 'src/', 'app/', 'sw.js'];

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 70_000) { res.writeHead(413).end(); return; } chunks.push(c); }
      let body; const raw = Buffer.concat(chunks).toString();
      if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
      const out = await app.handle({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, ip: req.socket.remoteAddress });
      res.writeHead(out.status, out.headers).end(out.body); return;
    }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
    if (!p || p.endsWith('/')) p += 'index.html';
    if (p === 'app') p = 'app/index.html';
    if (p.includes('..') || !STATIC_ROOTS.some(r => p === r || p.startsWith(r))) { res.writeHead(404).end('not found'); return; }
    const buf = await readFile(join(root, p));
    res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }).end(buf);
  } catch (e) { res.writeHead(e.code === 'ENOENT' ? 404 : 500).end(e.code === 'ENOENT' ? 'not found' : 'error'); }
}).listen(port, '127.0.0.1', () => console.log(`MobiMeet dev server → http://localhost:${port}/app/  (classic planner: http://localhost:${port}/)`));
