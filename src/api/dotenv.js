// Minimal .env loader (no dependency). Used ONLY by local scripts; Vercel injects real environment variables.
//  • KEY=value lines; `#` comments (whole-line, or after whitespace); optional single/double quotes; blank values allowed.
//  • Variables that are already set in the environment are NEVER overwritten.
//  • Values are never printed or returned in error messages.
import { readFileSync, existsSync } from 'node:fs';

export function parseDotenv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

export function loadDotenv(path = '.env', env = process.env) {
  if (!existsSync(path)) return { loaded: false, keys: [] };
  const parsed = parseDotenv(readFileSync(path, 'utf8'));
  const keys = [];
  for (const [k, v] of Object.entries(parsed)) if (env[k] === undefined && v !== '') { env[k] = v; keys.push(k); }
  return { loaded: true, keys };          // names only
}
