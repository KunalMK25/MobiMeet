import { h, field } from '../dom.js';

// Preference + constraint inputs shared by join / my-input forms. value() returns API-shaped {softPrefs, hard}.
export function prefsForm({ mode, softPrefs = {}, hard = {} }) {
  const range = (v) => h('input', { type: 'range', min: '0', max: '1', step: '0.1', value: String(v ?? 0.5) });
  const time = range(softPrefs.timeSensitivity), cost = range(softPrefs.costSensitivity);
  const out = (inp) => h('output', {}, inp.value); const tO = out(time), cO = out(cost);
  time.addEventListener('input', () => { tO.textContent = time.value; }); cost.addEventListener('input', () => { cO.textContent = cost.value; });
  const avoid = h('input', { type: 'checkbox', checked: softPrefs.avoidInterchanges === true }), fuel = h('input', { type: 'checkbox', checked: softPrefs.minimizeFuelCost === true });
  const maxT = h('input', { type: 'number', min: '1', max: '600', step: '1', value: hard.maxTravelMinutes ?? '' }), maxD = h('input', { type: 'number', min: '1', max: '500', step: '1', value: hard.maxDistanceKm ?? '' });
  const stepFree = h('input', { type: 'checkbox', checked: hard.requiresStepFreeAccess === true });
  const slider = (text, inp, outEl, hint) => { inp.id = inp.id || `rng${Math.random().toString(36).slice(2, 8)}`; return h('div', { class: 'field' }, h('label', { for: inp.id }, text), h('div', { class: 'range' }, inp, outEl), hint ? h('div', { class: 'hint' }, hint) : null); };
  const el = h('div', { class: 'prefs' },
    slider('How much does travel time matter?', time, tO, '0 = not at all, 1 = a lot'),
    slider('How much does cost matter?', cost, cO),
    mode === 'METRO' ? h('label', { class: 'check' }, avoid, ' Avoid interchanges where possible') : h('label', { class: 'check' }, fuel, ' Minimise fuel cost'),
    h('details', {}, h('summary', {}, 'Hard limits (optional)'),
      field('Maximum travel time (minutes)', maxT, 'Locations that exceed this for you are ruled out.').row,
      mode === 'BIKE' ? field('Maximum distance (km)', maxD).row : null,
      h('label', { class: 'check' }, stepFree, ' I need step-free access'), h('p', { class: 'hint' }, 'Step-free data is not available yet, so this is recorded but cannot be applied to results.')));
  return { el, value: () => ({
    softPrefs: { timeSensitivity: Number(time.value), costSensitivity: Number(cost.value), ...(avoid.checked ? { avoidInterchanges: true } : {}), ...(fuel.checked ? { minimizeFuelCost: true } : {}) },
    hard: { ...(maxT.value ? { maxTravelMinutes: Number(maxT.value) } : {}), ...(maxD.value ? { maxDistanceKm: Number(maxD.value) } : {}), ...(stepFree.checked ? { requiresStepFreeAccess: true } : {}) },
  }), set: (s = {}, hd = {}) => { time.value = s.timeSensitivity ?? 0.5; cost.value = s.costSensitivity ?? 0.5; tO.textContent = time.value; cO.textContent = cost.value; avoid.checked = s.avoidInterchanges === true; fuel.checked = s.minimizeFuelCost === true; maxT.value = hd.maxTravelMinutes ?? ''; maxD.value = hd.maxDistanceKm ?? ''; stepFree.checked = hd.requiresStepFreeAccess === true; } };
}
