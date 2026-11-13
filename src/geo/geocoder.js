// ═══════════════════════════════════════════════════════════
//  geo/geocoder.js — address search via OpenStreetMap Nominatim (server-side proxy)
//  Why a proxy: keeps the user's IP away from the third party, lets us enforce Nominatim's
//  usage policy (≤1 request/s, identifying User-Agent, caching, no bulk use) in one place, and
//  restricts results to the Bengaluru area. Results are OSM data (ODbL — attribution required).
//  The typed query is the only thing sent upstream; no account data is included.
// ═══════════════════════════════════════════════════════════
import { DomainError, ErrorCode } from '../domain/errors.js';

export const BENGALURU_VIEWBOX = '77.30,13.25,77.90,12.70'; // left,top,right,bottom
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function createGeocoder({ fetchImpl = globalThis.fetch, endpoint = 'https://nominatim.openstreetmap.org/search', minIntervalMs = 1100, timeoutMs = 8000, cacheTtlMs = 24 * 3600e3, now = Date.now, userAgent = 'MobiMeet-dev/0.1' } = {}) {
  const cache = new Map();
  let last = 0;
  return {
    name: 'nominatim',
    async search(query) {
      const q = typeof query === 'string' ? query.trim().replace(/\s+/g, ' ') : '';
      if (q.length < 3 || q.length > 120) throw new DomainError(ErrorCode.INVALID_INPUT, 'Search text must be 3-120 characters.');
      const key = q.toLowerCase();
      const hit = cache.get(key);
      if (hit && now() - hit.at < cacheTtlMs) return { ...hit.value, cached: true };
      const wait = last + minIntervalMs - now(); if (wait > 0) await sleep(wait); last = now();
      const url = `${endpoint}?${new URLSearchParams({ q, format: 'jsonv2', limit: '5', viewbox: BENGALURU_VIEWBOX, bounded: '1', countrycodes: 'in' })}`;
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { signal: ctl.signal, headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const rows = await res.json();
        const results = rows.map(r => ({ label: String(r.display_name).slice(0, 160), lat: Number(r.lat), lon: Number(r.lon) }))
          .filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
        const value = { results, attribution: '© OpenStreetMap contributors (ODbL)' };
        cache.set(key, { at: now(), value });
        return value;
      } catch { throw new DomainError(ErrorCode.PROVIDER_UNAVAILABLE, 'Address search is unavailable right now.'); }
      finally { clearTimeout(timer); }
    },

    // Human-readable area name for ONE point (used only for the recommended meetup, never for participants' origins).
    async reverse(lat, lon) {
      if (![lat, lon].every(Number.isFinite)) throw new DomainError(ErrorCode.INVALID_INPUT, 'Valid coordinates required.');
      const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
      const hit = cache.get('rev:' + key);
      if (hit && now() - hit.at < cacheTtlMs) return { ...hit.value, cached: true };
      const wait = last + minIntervalMs - now(); if (wait > 0) await sleep(wait); last = now();
      const url = `${endpoint.replace(/\/search$/, '/reverse')}?${new URLSearchParams({ lat: String(lat), lon: String(lon), format: 'jsonv2', zoom: '16' })}`;
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { signal: ctl.signal, headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const j = await res.json(); const a = j.address ?? {};
        const areaName = [a.road ?? a.neighbourhood, a.suburb ?? a.city_district].filter(Boolean).join(', ') || null;
        const value = { areaName, attribution: '© OpenStreetMap contributors (ODbL)' };
        cache.set('rev:' + key, { at: now(), value });
        return value;
      } catch { throw new DomainError(ErrorCode.PROVIDER_UNAVAILABLE, 'Place lookup is unavailable right now.'); }
      finally { clearTimeout(timer); }
    },
  };
}
