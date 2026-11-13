// ═══════════════════════════════════════════════════════════
//  ml/registry.js — integration interface for OPTIONAL ML models (spec §10)
//
//  STATUS: no model is registered. No legitimate dataset (real, rights-cleared, labelled
//  door-to-door travel times) exists for this project, and training on synthetic data would
//  not demonstrate real-world performance — so none is trained, none is claimed, and every
//  feature works from the deterministic engines. This file is the seam where an evaluated model
//  would plug in LATER, with these guarantees enforced by code:
//   • a model must declare task, version, training-data provenance, a baseline it beats,
//     and its evaluation metrics before it can be registered (assertModelCard);
//   • predictions carry the model version and are never mixed into routing/fairness arithmetic
//     unless the model passed registration; callers always receive a deterministic fallback;
//   • SHAP-style MODEL explanations are a separate object from the optimizer's DECISION
//     explanation (optimizer/explain.js) and are only available if the model supplies them.
// ═══════════════════════════════════════════════════════════
import { DomainError, ErrorCode } from '../domain/errors.js';

export const MODEL_TASKS = Object.freeze(['travel_time_calibration', 'preference_model', 'candidate_ranking']);

export function assertModelCard(card) {
  const bad = (m) => { throw new DomainError(ErrorCode.INVALID_INPUT, `Invalid model card: ${m}`); };
  if (!card || typeof card !== 'object') bad('missing');
  if (!MODEL_TASKS.includes(card.task)) bad('task must be one of ' + MODEL_TASKS.join(', '));
  if (typeof card.version !== 'string' || !card.version) bad('version required');
  if (!card.dataset?.source || !card.dataset?.license || !card.dataset?.collectedOn) bad('dataset provenance (source, license, collectedOn) required');
  if (card.dataset?.synthetic === true) bad('synthetic data cannot be used to register a model for real-world predictions');
  if (!card.baseline?.name || typeof card.baseline.metric !== 'number') bad('a baseline and its metric are required');
  if (!card.evaluation || typeof card.evaluation.metric !== 'number' || typeof card.evaluation.testRows !== 'number' || card.evaluation.testRows < 1) bad('held-out evaluation (metric, testRows) required');
  if (!(card.evaluation.metricLowerIsBetter ? card.evaluation.metric < card.baseline.metric : card.evaluation.metric > card.baseline.metric)) bad('model must beat the deterministic baseline on held-out data');
  if (!Array.isArray(card.limitations) || !card.limitations.length) bad('known limitations must be documented');
  return card;
}

export function createModelRegistry() {
  const models = new Map();
  return {
    register(model) {
      if (typeof model?.predict !== 'function') throw new DomainError(ErrorCode.INVALID_INPUT, 'Model must implement predict(features).');
      assertModelCard(model.card);
      models.set(model.card.task, model);
    },
    has: (task) => models.has(task),
    list: () => [...models.values()].map(m => m.card),
    // Always returns a value: the model's prediction if registered, else the deterministic fallback — clearly labelled.
    predict(task, features, fallbackFn) {
      const m = models.get(task);
      if (!m) return { value: fallbackFn(features), source: 'deterministic-baseline', model: null };
      try { return { value: m.predict(features), source: 'model', model: { task, version: m.card.version } }; }
      catch { return { value: fallbackFn(features), source: 'deterministic-baseline', model: null, note: 'MODEL_ERROR' }; }
    },
    // MODEL explanation (feature contributions to ONE prediction). Never describes the optimizer's decision.
    explainPrediction(task, features) {
      const m = models.get(task);
      if (!m) return { available: false, reason: 'NO_MODEL_REGISTERED' };
      if (typeof m.explain !== 'function') return { available: false, reason: 'MODEL_HAS_NO_EXPLAINER', model: { task, version: m.card.version } };
      return { available: true, kind: 'model-explanation', model: { task, version: m.card.version }, contributions: m.explain(features), disclaimer: 'Feature contributions explain this model’s prediction only. They do not explain the group optimisation and do not prove fairness.' };
    },
  };
}
export const defaultRegistry = createModelRegistry();
