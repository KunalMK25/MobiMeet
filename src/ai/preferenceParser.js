// ═══════════════════════════════════════════════════════════
//  ai/preferenceParser.js — turn a participant's free-text note into SUGGESTED structured
//  preferences. The LLM output is parsed as JSON and passed through the same whitelisting
//  validators as the API; unknown keys are dropped, bad values reject the whole suggestion.
//  Nothing is applied automatically: the client shows the suggestion and the user confirms it
//  with a normal PUT /groups/:id/me. Without an LLM the result is empty (deterministic).
// ═══════════════════════════════════════════════════════════
import { validatePrefs, validateHard } from '../services/validation.js';

const SYSTEM = `Extract travel preferences from a note. Reply with ONLY a JSON object using any of these keys: costSensitivity (0-1), timeSensitivity (0-1), avoidInterchanges (true), minimizeFuelCost (true), maxTravelMinutes (positive number), maxDistanceKm (positive number), requiresStepFreeAccess (true). Omit keys the note does not clearly state. No prose.`;

export async function parsePreferenceText(text, llm) {
  const note = typeof text === 'string' ? text.trim().slice(0, 500) : '';
  if (!note) return { prefs: {}, hard: {}, source: 'none' };
  if (!llm) return { prefs: {}, hard: {}, source: 'none', reason: 'LLM_NOT_CONFIGURED' };
  try {
    const raw = await llm.complete({ system: SYSTEM, messages: [{ role: 'user', content: note }], maxTokens: 150 });
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const { maxTravelMinutes, maxDistanceKm, requiresStepFreeAccess, ...soft } = json;
    return { prefs: validatePrefs(soft), hard: validateHard({ maxTravelMinutes, maxDistanceKm, requiresStepFreeAccess }), source: 'llm' };
  } catch { return { prefs: {}, hard: {}, source: 'none', reason: 'LLM_OUTPUT_REJECTED' }; }
}
