// ═══════════════════════════════════════════════════════════
//  bike/osrmProvider.js — OSRM-compatible road routing provider
//
//  Provider contract (domain/providers.js 'roadRouting'):
//    route(a, b)            → {distanceKm, durationMin, geometry:[[lat,lon],...]|null, ...}
//    matrix(sources, dests) → {durationsMin[i][j], distanceKm[i][j], snappedDestinations}
//  Configurable base URL / profile so the public demo can be swapped for a
//  self-hosted or commercial OSRM in production (env: ROUTING_PROVIDER_URL).
//
//  Honesty rules (spec §7): durations are the provider's free-flow road-network
//  estimate — NOT live traffic. Every response carries {provider, profile,
//  fetchedAt, trafficAware:false}. The public demo (router.project-osrm.org) is
//  for development only: it exposes the car profile and has a fair-use policy
//  (≈1 request/second, identify the client) — requests are spaced and cached.
// ═══════════════════════════════════════════════════════════
import { DomainError, ErrorCode } from '../domain/errors.js';

export class RoutingError extends Error {
  constructor(message, { retryable = false, cause } = {}) { super(message); this.name = 'RoutingError'; this.retryable = retryable; this.cause = cause; }
}

const r5 = (x) => Math.round(x * 1e5) / 1e5;
const coordKey = (p) => `${r5(p.lon)},${r5(p.lat)}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function createOsrmProvider({
  baseUrl = 'https://router.project-osrm.org',
  profile = 'driving',
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  retries = 1,
  minIntervalMs = 1100,          // public-demo fair-use spacing; set 0 for a private server
  cacheTtlMs = 6 * 60 * 60 * 1000,
  now = () => Date.now(),
  userAgent = 'MobiMeet-dev/0.1',
  extraHeaders = {},             // e.g. an API-key header for a hosted OSRM-compatible gateway (server-side only)
} = {}) {
  if (typeof fetchImpl !== 'function') throw new DomainError(ErrorCode.INVALID_INPUT, 'fetch implementation required');
  const base = baseUrl.replace(/\/+$/, '');
  const cache = new Map();
  let lastCall = 0;
  const meta = () => ({ provider: 'osrm', baseUrl: base, profile, trafficAware: false, fetchedAt: now() });

  async function getJson(path) {
    const url = `${base}${path}`;
    const hit = cache.get(url);
    if (hit && now() - hit.at < cacheTtlMs) return { json: hit.json, cached: true, fetchedAt: hit.at };
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const wait = lastCall + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastCall = now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { signal: ctl.signal, headers: { 'User-Agent': userAgent, Accept: 'application/json', ...extraHeaders } });
        if (res.status === 429 || res.status >= 500) throw new RoutingError(`Routing provider status ${res.status}`, { retryable: true });
        if (!res.ok) throw new RoutingError(`Routing provider status ${res.status}`);
        const json = await res.json();
        if (json.code && json.code !== 'Ok') throw new RoutingError(`Routing provider code ${json.code}`);
        cache.set(url, { json, at: now() });
        return { json, cached: false, fetchedAt: now() };
      } catch (e) {
        lastErr = e instanceof RoutingError ? e : new RoutingError(e.name === 'AbortError' ? 'Routing provider timed out' : 'Routing provider unreachable', { retryable: true, cause: e });
        if (!lastErr.retryable) break;
      } finally { clearTimeout(timer); }
    }
    throw lastErr;
  }

  return {
    name: 'osrm',
    cacheSize: () => cache.size,

    async route(a, b) {
      const coords = `${coordKey(a)};${coordKey(b)}`;
      const { json, cached, fetchedAt } = await getJson(`/route/v1/${profile}/${coords}?overview=simplified&geometries=geojson`);
      const r = json.routes?.[0];
      if (!r) throw new RoutingError('No route found');
      return {
        distanceKm: Math.round(r.distance / 10) / 100, durationMin: Math.round(r.duration / 6) / 10,
        geometry: r.geometry?.coordinates?.map(([lon, lat]) => [lat, lon]) ?? null,
        ...meta(), fetchedAt, cached,
      };
    },

    // One request for all sources × destinations (OSRM table service).
    async matrix(sources, dests) {
      const all = [...sources, ...dests];
      const coords = all.map(coordKey).join(';');
      const s = sources.map((_, i) => i).join(';');
      const d = dests.map((_, i) => sources.length + i).join(';');
      const { json, cached, fetchedAt } = await getJson(`/table/v1/${profile}/${coords}?sources=${s}&destinations=${d}&annotations=duration,distance`);
      if (!json.durations || !json.distances) throw new RoutingError('Routing provider returned no matrix');
      const toMin = (v) => (v == null ? null : Math.round(v / 6) / 10);
      const toKm = (v) => (v == null ? null : Math.round(v / 10) / 100);
      return {
        durationsMin: json.durations.map(row => row.map(toMin)),
        distanceKm: json.distances.map(row => row.map(toKm)),
        snappedDestinations: (json.destinations || []).map(x => x && x.location ? { lat: x.location[1], lon: x.location[0], snapDistanceM: x.distance ?? null } : null),
        ...meta(), fetchedAt, cached,
      };
    },
  };
}
