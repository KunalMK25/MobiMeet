// Fetch wrapper: same-origin cookies, JSON in/out, normalised errors. No tokens are ever read from JS (cookie is HttpOnly).
export class ApiError extends Error { constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; Object.assign(this, extra); } }

export async function api(method, path, body, { fetchImpl = globalThis.fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'OFFLINE', 'You appear to be offline.'); }
  let json = null; try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? 'Request failed.', { missing: json?.error?.missing });
  return json;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const patch = (p, b = {}) => api('PATCH', p, b);
export const del = (p, b) => api('DELETE', p, b);
