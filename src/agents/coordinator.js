// ═══════════════════════════════════════════════════════════
//  agents/coordinator.js — group coordinator (bounded, deterministic)
//  1 verify membership/mode/completeness → 2 build participant agent inputs →
//  3 call the correct transport engine under a timeout → 4 return a structured
//  plan + explanation inputs + a reproducibility hash.
//  No loops: each engine is invoked once; retries are bounded (MAX_ATTEMPTS)
//  and only for retryable provider failures. Routing, fares and fairness are
//  NEVER delegated to an LLM.
// ═══════════════════════════════════════════════════════════
import { DomainError, ErrorCode } from '../domain/errors.js';
import { assertSameMode } from '../domain/transport.js';
import { MIN_PARTICIPANTS, MAX_PARTICIPANTS } from '../optimizer/groupOptimizer.js';
import { optimizeMetroGroup } from '../optimizer/metroOptimizer.js';
import { optimizeBikeGroup } from '../bike/bikeOptimizer.js';
import { buildParticipantAgent } from './participantAgent.js';
import { sha256hex } from '../services/crypto.js';

export const COORDINATOR_LIMITS = Object.freeze({ timeoutMs: 60000, maxAttempts: 2 });

export const canonicalJson = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));

export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new DomainError(ErrorCode.TIMEOUT, `${label} timed out.`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// Hash of everything that determines the result (inputs, mode, strategy, assumptions).
export function inputHash({ mode, strategy, participants, fuel, routeStrategy = 'fastest' }) {
  const stable = participants.map(({ updatedAt, ...rest }) => rest).sort((a, b) => (a.participantId < b.participantId ? -1 : 1));
  return sha256hex(canonicalJson({ mode, strategy, participants: stable, fuel: fuel ?? null, routeStrategy: mode === 'METRO' ? routeStrategy : null }));
}

export function prepareParticipants(group, members, { now = Date.now() } = {}) {
  const joined = members.filter(m => m.joinStatus === 'joined');
  if (joined.length < MIN_PARTICIPANTS) throw new DomainError(ErrorCode.NOT_READY, `At least ${MIN_PARTICIPANTS} participants are needed.`);
  if (joined.length > MAX_PARTICIPANTS) throw new DomainError(ErrorCode.INVALID_INPUT, `At most ${MAX_PARTICIPANTS} participants are supported.`);
  const missing = joined.filter(m => m.originLat == null).map(m => m.userId);
  if (missing.length) { const e = new DomainError(ErrorCode.NOT_READY, 'Every participant must provide an origin first.'); e.missing = missing; throw e; }
  for (const m of joined) assertSameMode(group.mode, m.transportMode);
  return joined.map(m => buildParticipantAgent(m, { now }));
}

export async function runCoordinator({ group, members, strategy = 'balanced', routeStrategy = 'fastest', fuel = null, providers = {}, now = Date.now(), names = {}, limits = COORDINATOR_LIMITS }) {
  const participants = prepareParticipants(group, members, { now });
  const hash = inputHash({ mode: group.mode, strategy, participants, fuel: group.mode === 'BIKE' ? fuel : null, routeStrategy });

  let attempt = 0, lastErr;
  while (attempt < limits.maxAttempts) {
    attempt++;
    try {
      const result = await withTimeout((async () => {
        if (group.mode === 'METRO') return optimizeMetroGroup(participants, { strategy, now, routeStrategy });
        if (!providers.roadRouting) throw new DomainError(ErrorCode.PROVIDER_UNAVAILABLE, 'No road routing provider configured.');
        return optimizeBikeGroup(participants, { provider: providers.roadRouting, fuel, strategy, now });
      })(), limits.timeoutMs, 'Optimisation');
      return { inputHash: hash, participants, result: relabel(result, names), attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (!(e instanceof DomainError && e.code === ErrorCode.TIMEOUT)) break; // deterministic failures are not retried
    }
  }
  throw lastErr;
}

// Replace participant ids in explanation lines with display names (numbers untouched).
function relabel(result, names) {
  if (!result.explanation) return result;
  const sub = (s) => Object.entries(names).reduce((acc, [id, n]) => acc.split(id).join(n), s);
  return { ...result, explanation: { ...result.explanation, lines: result.explanation.lines.map(sub) } };
}
