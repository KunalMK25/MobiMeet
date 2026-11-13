import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.data', 'dist', '.git']);
const walk = (d) => readdirSync(d).flatMap(f => SKIP.has(f) ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]);
const FILES = walk('.').filter(f => !/package-lock\.json$|\.png$|^\.env$/.test(f));   // the real, git-ignored .env is never scanned or published
const text = (f) => readFileSync(f, 'utf8');

test('SQL: every query is parameterised — template literals interpolate only whitelisted constants', () => {
  const ALLOWED = [/^MEMBER_SQL$/, /^lock \? ' FOR UPDATE' : ''$/, /^m\.sql$/];
  const dirs = walk('src').filter(f => /\/(services|db|api|agents)\//.test(f) && f.endsWith('.js') && !f.endsWith('migrations.js'));
  let checked = 0;
  for (const f of dirs) {
    const src = text(f);
    for (const m of src.matchAll(/\.(?:query|exec)\(\s*`([^`]*)`/g)) {
      checked++;
      for (const e of m[1].matchAll(/\$\{([^}]*)\}/g)) assert.ok(ALLOWED.some(r => r.test(e[1].trim())), `${f}: SQL interpolates ${e[1]}`);
    }
    assert.ok(!/\.(?:query|exec)\(\s*['"][^'"]*['"]\s*\+/.test(src), `${f}: SQL built by string concatenation`);
  }
  assert.ok(checked > 40, `scanned ${checked} queries`);
});
test('no secrets or key material are committed (only placeholders in .env.example)', () => {
  const patterns = [/sk-ant-[A-Za-z0-9_-]{10,}/, /sk-[A-Za-z0-9]{32,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /gsk_[A-Za-z0-9]{20,}/, /postgres(?:ql)?:\/\/[^\s:@]+:(?!PASSWORD)[^\s@]{3,}@/];
  for (const f of FILES) { const s = text(f); for (const p of patterns) assert.ok(!p.test(s), `${f} matches secret pattern ${p}`); }
});
test('.env files are git-ignored and .env.example holds names with placeholders only', () => {
  const gi = text('.gitignore'); assert.ok(/^\.env$/m.test(gi) && /^\.env\.\*$/m.test(gi) && /^!\.env\.example$/m.test(gi));
  const ex = text('.env.example');
  for (const line of ex.split('\n').filter(l => /^[A-Z_]+=/.test(l))) { const k = line.slice(0, line.indexOf('=')), v = line.slice(line.indexOf('=') + 1).split(/\s+#/)[0].trim(); assert.ok(!/^(sk-|AKIA)/.test(v) && v.length < 70, `${k} must be a placeholder`); if (/KEY|SECRET/.test(k)) assert.equal(v, '', `${k} must be empty in the example`); }
  assert.ok(/^\.env$/m.test(gi), 'a local .env may exist, but it is git-ignored');
});
test('no word from the local, git-ignored deny-list appears anywhere in the project (private associations stay out of a public repo)', () => {
  // `.private-denylist` is optional, one term per line, and is itself git-ignored — so the list never gets published.
  let terms = []; try { terms = readFileSync('.private-denylist', 'utf8').split('\n').map(t => t.trim()).filter(t => t && !t.startsWith('#')); } catch { /* no local list: nothing to enforce */ }
  for (const term of terms) { const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); for (const f of FILES.filter(f => f !== '.private-denylist')) assert.ok(!re.test(text(f)), `${f} contains a deny-listed term`); }
  assert.ok(/^\.private-denylist$/m.test(text('.gitignore')), 'the deny-list file must be git-ignored');
});
test('LLM keys are only ever read server-side (never in app/, index.html or browser-shared src)', () => {
  for (const f of FILES.filter(f => f.startsWith('app/') || f === 'index.html' || f === 'sw.js')) assert.ok(!/ANTHROPIC_API_KEY|OPENAI_API_KEY|GROQ_API_KEY|x-api-key|api\.anthropic\.com|api\.openai\.com|api\.groq\.com/.test(text(f)), `${f} references an LLM key or endpoint`);
  const serverOnly = FILES.filter(f => /ANTHROPIC_API_KEY|OPENAI_API_KEY|GROQ_API_KEY/.test(text(f)) && f.endsWith('.js') && !f.startsWith('tests/'));
  assert.deepEqual(serverOnly.sort(), ['src/api/config.js', 'src/api/envCheck.js']);   // server-side only: config reads the keys, the checker reports their NAMES
});
test('the browser bundle never imports server-only modules (node:*, pg, db, services, api)', () => {
  const browser = FILES.filter(f => (f.startsWith('app/') || f === 'sw.js') && f.endsWith('.js'));
  for (const f of browser) assert.ok(!/from\s+['"](node:|pg['"]|\.\.\/src\/(db|services|api|agents|ai\/llm))/.test(text(f)), `${f} imports a server-only module`);
});
test('server code never logs request bodies, cookies or coordinates', () => {
  const src = text('src/api/http.js');
  for (const m of src.matchAll(/log\(\{([^}]*)\}\)/g)) assert.ok(!/body|cookie|lat|lon|origin|password|token/i.test(m[1].replace(/\bms\b/g, '')), `log payload: ${m[1]}`);
});
test('session cookie flags and CSRF/origin checks are in the request pipeline', () => {
  const src = text('src/api/http.js');
  assert.match(src, /HttpOnly; Path=\/; SameSite=Lax/); assert.match(src, /assertSameOrigin\(headers/); assert.match(src, /sec-fetch-site/);
});
