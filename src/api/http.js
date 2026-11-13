// ═══════════════════════════════════════════════════════════
//  api/http.js — framework-agnostic request pipeline
//  request:  {method, path, query, headers, body, ip}   response: {status, headers, body}
//  Pipeline: size limit → CSRF/origin checks → session auth → route → JSON/error mapping.
//  No request bodies, cookies or coordinates are ever logged.
// ═══════════════════════════════════════════════════════════
import { DomainError, ErrorCode } from '../domain/errors.js';

export const MAX_BODY_BYTES = 64 * 1024;
export const COOKIE = 'mm_session';

const STATUS = {
  INVALID_INPUT: 400, INVALID_MODE: 400, MISSING_ORIGIN: 400, BAD_TRANSITION: 409, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  CONFLICT: 409, DUPLICATE_MEMBER: 409, MODE_LOCKED: 409, MODE_MISMATCH: 409, GROUP_CLOSED: 409, NOT_READY: 409,
  INVITE_INVALID: 404, INVITE_EXPIRED: 410, INVITE_REVOKED: 410, RATE_LIMITED: 429, PROVIDER_UNAVAILABLE: 503, TIMEOUT: 504,
};

export const SECURITY_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
});

export const json = (status, body, headers = {}) => ({ status, headers: { ...SECURITY_HEADERS, ...headers }, body: JSON.stringify(body) });

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const key = part.slice(0, i).trim(); if (!key) continue;
    let val = part.slice(i + 1).trim();
    try { val = decodeURIComponent(val); } catch { continue; }   // malformed escape → ignore this cookie, never throw
    out[key] = val;
  }
  return out;
}
export function sessionCookie(token, { secure, maxAgeSec }) {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
export const clearCookie = ({ secure }) => `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Cross-site request forgery defence for cookie auth: a browser always sends Origin / Sec-Fetch-Site on
// cross-site requests; reject anything that is not same-origin with an allowed origin.
export function assertSameOrigin(headers, { allowedOrigins }) {
  const site = headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) throw new DomainError(ErrorCode.FORBIDDEN, 'Cross-site requests are not allowed.');
  const origin = headers['origin'];
  if (origin && !allowedOrigins.includes(origin)) throw new DomainError(ErrorCode.FORBIDDEN, 'Cross-site requests are not allowed.');
}

export function compile(routes) {
  return routes.map(r => {
    const keys = [];
    const re = new RegExp('^' + r.path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    return { ...r, re, keys };
  });
}

export function createHandler({ routes, auth, config, log = () => {} }) {
  const table = compile(routes);
  const secure = config.appBaseUrl.startsWith('https://');
  const allowedOrigins = [new URL(config.appBaseUrl).origin, ...(config.extraOrigins ?? [])];

  return async function handle(req) {
    const started = Date.now();
    const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
    const requestId = headers['x-request-id']?.slice(0, 64) || Math.random().toString(36).slice(2, 10);
    let route = 'unmatched', res;
    try {
      const path = req.path.replace(/\/+$/, '') || '/';
      const method = req.method.toUpperCase();
      const hit = table.map(r => ({ r, m: r.re.exec(path) })).find(x => x.m && x.r.method === method);
      if (!hit) {
        const other = table.some(r => r.re.test(path));
        throw new DomainError(other ? ErrorCode.INVALID_INPUT : ErrorCode.NOT_FOUND, other ? 'Method not allowed.' : 'Not found.');
      }
      route = `${method} ${hit.r.path}`;
      if (MUTATING.has(method)) {
        assertSameOrigin(headers, { allowedOrigins });
        if (req.body != null && Object.keys(req.body).length && !/application\/json/i.test(headers['content-type'] ?? '')) throw new DomainError(ErrorCode.INVALID_INPUT, 'Content-Type must be application/json.');
      }
      if (typeof req.body === 'string' || (headers['content-length'] && Number(headers['content-length']) > MAX_BODY_BYTES)) throw new DomainError(ErrorCode.INVALID_INPUT, 'Invalid or oversized request body.');
      const params = Object.fromEntries(hit.r.keys.map((k, i) => [k, decodeURIComponent(hit.m[i + 1])]));
      const token = parseCookies(headers['cookie'])[COOKIE];
      const user = hit.r.auth === false ? null : await auth.authenticate(token);
      if (hit.r.auth !== false && !user) throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Please sign in.');
      const ctx = { headers, user, params, query: req.query ?? {}, body: req.body ?? {}, ip: req.ip ?? 'unknown', token, setCookie: null, cookieOpts: { secure }, requestId };
      const out = await hit.r.handler(ctx);
      res = json(out?.status ?? 200, out?.body ?? out ?? {}, ctx.setCookie ? { 'Set-Cookie': ctx.setCookie } : {});
    } catch (e) {
      if (e instanceof DomainError) {
        const status = STATUS[e.code] ?? 400;
        res = json(status, { error: { code: e.code, message: e.message, ...(e.missing ? { missing: e.missing } : {}) } }, e.code === 'RATE_LIMITED' ? { 'Retry-After': '60' } : {});
      } else {
        log({ level: 'error', requestId, route, error: String(e?.message ?? e).slice(0, 200) });
        res = json(500, { error: { code: 'INTERNAL', message: 'Something went wrong.' } });
      }
    }
    res.headers['X-Request-Id'] = requestId;
    log({ level: 'info', requestId, route, status: res.status, ms: Date.now() - started });
    return res;
  };
}
