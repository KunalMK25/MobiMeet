import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelRegistry, assertModelCard, defaultRegistry } from '../src/ml/registry.js';

const goodCard = () => ({ task: 'travel_time_calibration', version: '1.0.0', dataset: { source: 'example-rights-cleared-set', license: 'CC-BY-4.0', collectedOn: '2026-01-01', synthetic: false },
  baseline: { name: 'dijkstra-schedule', metric: 6.2 }, evaluation: { metric: 4.1, metricLowerIsBetter: true, testRows: 500 }, limitations: ['Only tested on weekday peaks'] });

test('nothing is registered by default: predictions fall back to the deterministic baseline and say so', () => {
  assert.deepEqual(defaultRegistry.list(), []);
  const r = defaultRegistry.predict('travel_time_calibration', { x: 1 }, () => 42);
  assert.deepEqual(r, { value: 42, source: 'deterministic-baseline', model: null });
  assert.deepEqual(defaultRegistry.explainPrediction('travel_time_calibration', {}), { available: false, reason: 'NO_MODEL_REGISTERED' });
});
test('model cards are enforced: provenance, non-synthetic data, baseline, held-out evaluation that beats baseline, limitations', () => {
  assertModelCard(goodCard());
  const cases = [
    (c) => { c.task = 'magic'; }, (c) => { delete c.version; }, (c) => { delete c.dataset.license; }, (c) => { c.dataset.synthetic = true; },
    (c) => { delete c.baseline; }, (c) => { c.evaluation.testRows = 0; }, (c) => { c.evaluation.metric = 9; }, (c) => { c.limitations = []; },
  ];
  for (const mutate of cases) { const c = goodCard(); mutate(c); assert.throws(() => assertModelCard(c), /Invalid model card/); }
  const hb = goodCard(); hb.evaluation = { metric: 0.9, metricLowerIsBetter: false, testRows: 10 }; hb.baseline.metric = 0.8; assertModelCard(hb); // higher-is-better metrics
});
test('a registered model is used with its version attached; errors fall back; explanations stay separate and labelled', () => {
  const reg = createModelRegistry();
  assert.throws(() => reg.register({ card: goodCard() }), /predict/);
  reg.register({ card: goodCard(), predict: (f) => f.x * 2, explain: (f) => ({ x: f.x }) });
  const r = reg.predict('travel_time_calibration', { x: 4 }, () => 0);
  assert.deepEqual(r, { value: 8, source: 'model', model: { task: 'travel_time_calibration', version: '1.0.0' } });
  const e = reg.explainPrediction('travel_time_calibration', { x: 4 });
  assert.equal(e.available, true); assert.equal(e.kind, 'model-explanation'); assert.match(e.disclaimer, /do not prove fairness/);
  const bad = createModelRegistry(); bad.register({ card: goodCard(), predict: () => { throw new Error('boom'); } });
  assert.equal(bad.predict('travel_time_calibration', {}, () => 7).value, 7); assert.equal(bad.explainPrediction('travel_time_calibration', {}).reason, 'MODEL_HAS_NO_EXPLAINER');
});
