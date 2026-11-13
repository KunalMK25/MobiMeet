// ═══════════════════════════════════════════════════════════
//  bike/routingFactory.js — choose the road-routing provider from configuration
//
//  Contract every provider implements (domain/providers.js 'roadRouting'):
//     route(a, b) · matrix(sources, dests)  → see bike/osrmProvider.js
//  Implemented adapter: OSRM-compatible HTTP API (self-hosted OSRM, or any hosted gateway that speaks the
//  OSRM /route and /table protocol). Other vendors (Mapbox, Google, OpenRouteService, GraphHopper…) need
//  their own small adapter — see DEPLOYMENT.md (Bike routing). NOTHING paid is ever selected automatically.
//
//  Modes: 'osrm' (default; any OSRM-compatible service) or 'estimate' (explicit opt-in, no service, straight-line
//  estimates — see estimateProvider.js).
//
//  Safety rule: the public OSRM demo is for DEVELOPMENT ONLY. In a production-like deployment (https, non-
//  localhost APP_BASE_URL) it is refused unless ALLOW_PUBLIC_OSRM_IN_PRODUCTION=true is set explicitly; the
//  Bike mode then reports PROVIDER_UNAVAILABLE instead of silently hammering a shared demo server.
// ═══════════════════════════════════════════════════════════
import { createOsrmProvider } from './osrmProvider.js';
import { createEstimateProvider } from './estimateProvider.js';
import { DomainError, ErrorCode } from '../domain/errors.js';

export const PUBLIC_DEMO_HOSTS = Object.freeze(['router.project-osrm.org']);

export function isProductionLike(appBaseUrl) {
  try { const u = new URL(appBaseUrl); return u.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && !u.hostname.endsWith('.localhost'); } catch { return false; }
}
export function isPublicDemo(baseUrl) { try { return PUBLIC_DEMO_HOSTS.includes(new URL(baseUrl).hostname); } catch { return false; } }

const disabled = (reason) => ({
  name: 'disabled', disabled: true, reason,
  async route() { throw new DomainError(ErrorCode.PROVIDER_UNAVAILABLE, reason); },
  async matrix() { throw new DomainError(ErrorCode.PROVIDER_UNAVAILABLE, reason); },
});

// cfg: config.routing (see api/config.js). Returns {provider, status} where status ∈ 'demo' | 'configured' | 'disabled'.
export function createRoutingProvider(cfg, { appBaseUrl, fetchImpl } = {}) {
  // Explicit opt-in only (ROUTING_MODE=estimate): no service, no cost, straight-line estimates, labelled everywhere.
  if (cfg.mode === 'estimate') return { provider: createEstimateProvider(), status: 'estimate' };
  if (cfg.mode && cfg.mode !== 'osrm') return { provider: disabled(`Unknown ROUTING_MODE "${String(cfg.mode).slice(0, 20)}" (use "osrm" or "estimate").`), status: 'disabled' };
  const demo = isPublicDemo(cfg.baseUrl);
  if (demo && isProductionLike(appBaseUrl) && !cfg.allowPublicDemoInProduction) {
    return { provider: disabled('Bike routing needs a production routing provider (ROUTING_PROVIDER_URL); the public demo is development-only.'), status: 'disabled' };
  }
  const extraHeaders = {};
  if (cfg.apiKey) {
    const header = cfg.apiKeyHeader || 'Authorization';
    extraHeaders[header] = header.toLowerCase() === 'authorization' && !/^(bearer|basic)\s/i.test(cfg.apiKey) ? `Bearer ${cfg.apiKey}` : cfg.apiKey;
  }
  const provider = createOsrmProvider({ baseUrl: cfg.baseUrl, profile: cfg.profile, minIntervalMs: cfg.minIntervalMs, extraHeaders, ...(fetchImpl ? { fetchImpl } : {}) });
  return { provider, status: demo ? 'demo' : 'configured' };
}
