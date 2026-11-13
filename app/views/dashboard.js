import { h, mount, field, badge, announce } from '../dom.js';
import { get, post } from '../api.js';
import { createOriginPicker } from './originPicker.js';
import { STATUS_LABEL } from '../format.js';
import { GROUP_LIMITS } from '../../src/config/Limits.js';

const MODE = { METRO: { name: 'Metro', icon: '🚇', href: '#/metro', other: 'BIKE' }, BIKE: { name: 'Bike', icon: '🏍️', href: '#/bike', other: 'METRO' } };

// The planner for ONE travel mode. The mode comes from where you are (#/metro or #/bike) — it is never asked again, so a
// group cannot be created in the wrong mode by accident. (The server and database enforce it too.)
export async function renderDashboard(root, ctx, mode) {
  const M = MODE[mode];
  const stations = mode === 'METRO' ? await ctx.getStations() : [];
  let all = [];
  try { all = (await get('/api/groups')).groups; } catch (e) { if (e.code === 'OFFLINE') { mount(root, h('p', { class: 'banner warn' }, 'You are offline. Open a group you viewed before to see its saved plan.')); return; } throw e; }
  const profile = (await get('/api/me').catch(() => null))?.profile;
  const groups = all.filter(g => g.mode === mode), others = all.length - groups.length;

  const list = groups.length
    ? h('ul', { class: 'cards' }, groups.map(g => h('li', {}, h('a', { href: `#/g/${g.id}`, class: 'card link-card' },
        h('strong', {}, g.name), ' ', badge(STATUS_LABEL[g.status] ?? g.status, g.status),
        h('div', { class: 'hint' }, `${g.memberCount} participant${g.memberCount === 1 ? '' : 's'} · ${g.role}`)))))
    : h('p', {}, `You have no ${M.name} groups yet. Create one below, or open an invitation link someone shared with you.`);

  const names = h('textarea', { rows: '3', maxlength: '600', placeholder: 'One name per line, e.g.\nAsha\nBilal' });
  const name = h('input', { type: 'text', maxlength: '80', required: true }), desc = h('input', { type: 'text', maxlength: '500' });
  const picker = createOriginPicker({ mode, stations, savedPlaces: profile?.savedPlaces ?? [], idPrefix: 'create' });
  const err = h('p', { class: 'error', role: 'alert' });
  const create = h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      const r = await post('/api/groups', { name: name.value, description: desc.value, mode, participantNames: names.value.split(/[\n,]/).map(x => x.trim()).filter(Boolean), ...(picker.getOrigin() ? { origin: picker.getOrigin() } : {}) });
      announce('Group created'); ctx.navigate(`/g/${r.group.id}`);
    } catch (x) { err.textContent = x.message; }
  } },
    h('h2', {}, `Create a ${M.name} group`), h('p', { class: 'hint' }, `Everyone in this group will travel by ${M.name.toLowerCase()}. This is fixed once the group is created.`),
    field('Group name', name).row, field('Description (optional)', desc).row,
    field(`Who are you meeting? (optional, up to ${GROUP_LIMITS.max - 1} names)`, names, 'Each invited person picks their own name from the invitation link. You are added automatically.').row,
    h('div', { class: 'lbl' }, 'Your starting point'), picker.el, err, h('button', { type: 'submit' }, `Create ${M.name} group`));

  mount(root,
    h('p', { class: 'crumbs' }, h('a', { href: '#/' }, '← Travel mode')),
    h('h1', {}, `${M.icon} ${M.name} groups`),
    list,
    others ? h('p', { class: 'hint' }, `You also have ${others} ${MODE[M.other].name} group${others === 1 ? '' : 's'} — `, h('a', { href: MODE[M.other].href }, `open the ${MODE[M.other].name} planner`), '.') : null,
    create,
    mode === 'METRO' ? h('p', { class: 'hint' }, 'Looking for the single-device planner? ', h('a', { href: '../' }, 'Open the Quick Metro planner'), '.') : null);
}
