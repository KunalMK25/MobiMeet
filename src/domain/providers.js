import { ErrorCode, fail } from './errors.js';

// Replaceable provider interfaces (spec §13.3). Each provider is a plain
// object; assertProvider() checks the shape at the composition root so a
// missing method fails fast instead of deep inside an optimizer run.
export const ProviderContracts = Object.freeze({
  roadRouting: ['route'],        // route(origin, destination) -> {distanceKm, durationMin, geometry?, provider, fetchedAt}
  venues:      ['search'],       // search(point, radiusKm, categories) -> Venue[]
  llm:         ['complete'],     // complete(prompt, opts) -> string
  persistence: ['load', 'save'],
});

export function assertProvider(kind, impl) {
  const methods = ProviderContracts[kind];
  if (!methods) fail(ErrorCode.INVALID_INPUT, `Unknown provider kind: ${kind}`);
  const missing = methods.filter(m => typeof impl?.[m] !== 'function');
  if (missing.length) fail(ErrorCode.INVALID_INPUT, `${kind} provider missing: ${missing.join(', ')}`);
  return impl;
}
