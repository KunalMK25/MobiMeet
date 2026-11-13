import { h, field, announce } from '../dom.js';
import { get, post } from '../api.js';
import { createOriginPicker } from './originPicker.js';
import { minutes, rupees, deltaText, STRATEGY_LABEL, fmt } from '../format.js';

// What-if analysis: scenarios are computed and stored separately; they never change the group or any plan.
export function renderWhatIf({ gid, group, names, stations, ctx }) {
  const strat = h('select', {}, h('option', { value: '' }, 'Keep current strategy'), Object.entries(STRATEGY_LABEL).map(([k, v]) => h('option', { value: k }, v)));
  const others = group.members.filter(m => !m.isMe || true);
  const removes = others.map(m => ({ m, box: h('input', { type: 'checkbox', value: m.userId, id: `rm-${m.userId}` }) }));
  const guestName = h('input', { type: 'text', maxlength: '40', placeholder: 'Guest name' });
  const guestPicker = createOriginPicker({ mode: group.mode, stations, savedPlaces: [], idPrefix: 'guest' });
  const addGuest = h('input', { type: 'checkbox', id: 'wi-guest' });
  const moveWho = h('select', {}, h('option', { value: '' }, 'Nobody'), others.map(m => h('option', { value: m.userId }, m.displayName)));
  const movePicker = createOriginPicker({ mode: group.mode, stations, savedPlaces: [], idPrefix: 'move' });
  const out = h('div', { 'aria-live': 'polite' }), err = h('p', { class: 'error', role: 'alert' }), list = h('div');

  const loadList = async () => {
    try {
      const { scenarios } = await get(`/api/groups/${gid}/whatif`);
      if (!scenarios.length) { list.replaceChildren(); return; }
      list.replaceChildren(h('h3', {}, 'Saved scenarios'), h('ul', {}, scenarios.slice(0, 10).map(s => h('li', {}, `${new Date(s.createdAt).toLocaleTimeString()} — ${STRATEGY_LABEL[s.strategy] ?? s.strategy} → ${s.recommended ?? 'no feasible location'}`))),
        scenarios.length > 1 ? h('button', { type: 'button', class: 'secondary', onclick: async () => {
          const r = await post(`/api/groups/${gid}/whatif/compare`, { ids: scenarios.slice(0, 5).map(s => s.id) });
          list.append(compareTable(r));
        } }, 'Compare latest scenarios with the current plan') : null);
    } catch { /* offline */ }
  };

  const run = h('button', { type: 'button', onclick: async () => {
    err.textContent = ''; run.disabled = true;
    try {
      const def = {};
      if (strat.value) def.strategy = strat.value;
      const rm = removes.filter(x => x.box.checked).map(x => x.m.userId); if (rm.length) def.removeParticipantIds = rm;
      if (addGuest.checked) { const o = guestPicker.getOrigin(); if (!o) throw new Error('Set the guest’s starting point.'); def.addParticipants = [{ displayName: guestName.value || 'Guest', origin: o }]; }
      if (moveWho.value) { const o = movePicker.getOrigin(); if (!o) throw new Error('Set the new starting point for the person you chose.'); def.overrides = [{ participantId: moveWho.value, origin: o }]; }
      const r = await post(`/api/groups/${gid}/whatif`, def);
      announce('Scenario ready'); out.replaceChildren(scenarioCard(r)); loadList();
    } catch (e) { err.textContent = e.message; } finally { run.disabled = false; }
  } }, 'Run scenario');

  loadList();
  return h('section', { class: 'card', id: 'whatif' }, h('h2', {}, 'What if…?'), h('p', { class: 'hint' }, 'Try changes without touching the real plan. Scenarios are private to the group and never overwrite a confirmed plan.'),
    field('Strategy', strat).row,
    h('fieldset', {}, h('legend', {}, 'Remove people from the scenario'), removes.map(x => h('label', { class: 'check', for: x.box.id }, x.box, ` ${x.m.displayName}`))),
    h('fieldset', {}, h('legend', {}, 'Add a guest'), h('label', { class: 'check', for: 'wi-guest' }, addGuest, ' Include a guest'), field('Guest name', guestName).row, guestPicker.el),
    h('fieldset', {}, h('legend', {}, 'Move someone’s starting point'), field('Who', moveWho).row, movePicker.el),
    run, err, out, list);
}

function scenarioCard(r) {
  const rec = r.result.recommended, c = r.comparison;
  if (!rec) return h('div', { class: 'banner warn' }, 'No location satisfies everyone’s limits in this scenario.');
  return h('div', { class: 'scenario' }, h('h3', {}, `Scenario result: meet at ${rec.label}`),
    h('p', {}, `Longest journey ${minutes(rec.metrics.burden.max)} · total ${minutes(rec.metrics.time.total)} · cost ${rupees(rec.metrics.costTotal)} · fairness index ${rec.metrics.burden.jain}`),
    c.comparable ? h('div', {}, h('p', {}, c.recommendedChanged ? `Different from the current plan (${c.base.label}).` : 'Same location as the current plan.'),
      h('ul', {}, h('li', {}, `Longest journey: ${deltaText(c.deltas.maxBurdenMin)}`), h('li', {}, `Group total time: ${deltaText(c.deltas.totalTimeMin)}`), h('li', {}, `Cost: ${deltaText(c.deltas.costTotal, '₹')}`), h('li', {}, `Interchanges: ${deltaText(c.deltas.interchanges, '')}`))) : h('p', { class: 'hint' }, 'There is no current plan to compare against.'),
    h('p', { class: 'hint' }, 'This scenario was saved separately. Your group’s plan is unchanged.'));
}
function compareTable(r) {
  const rows = [r.current && { label: 'Current plan', ...r.current }, ...r.scenarios.map((s, i) => ({ label: `Scenario ${i + 1}`, ...s }))].filter(Boolean);
  return h('table', { class: 'data' }, h('caption', {}, 'Scenarios side by side'), h('thead', {}, h('tr', {}, ['', 'Strategy', 'Meet at', 'Longest', 'Total', 'Cost', 'Changes'].map(c => h('th', { scope: 'col' }, c)))),
    h('tbody', {}, rows.map(x => h('tr', {}, h('th', { scope: 'row' }, x.label), h('td', {}, STRATEGY_LABEL[x.strategy] ?? x.strategy), h('td', {}, x.recommended ?? '—'), h('td', {}, minutes(x.maxBurdenMin)), h('td', {}, minutes(x.totalTimeMin)), h('td', {}, rupees(x.costTotal)), h('td', {}, x.interchanges == null ? '—' : String(fmt(x.interchanges)))))));
}
