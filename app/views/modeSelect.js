import { h, mount } from '../dom.js';

// The first screen after sign-in: choose how THIS group will travel. The choice decides which planner opens, and it is
// carried into group creation (a group's mode is fixed when it is created and can never be changed afterwards).
export function renderModeSelect(root, ctx) {
  const first = (ctx.user?.displayName ?? '').trim().split(/\s+/)[0];
  const card = (cls, href, icon, tag, title, sub, points, cta) => h('a', { class: `mode-card ${cls}`, href, 'aria-label': `${title}: ${sub}` },
    h('span', { class: 'icon', 'aria-hidden': 'true' }, icon), h('span', { class: 'tag' }, tag), h('h2', {}, title), h('p', {}, sub),
    h('ul', {}, points.map(p => h('li', {}, p))), h('span', { class: 'go' }, `${cta} →`));
  mount(root,
    h('div', { class: 'welcome' }, h('h1', {}, first ? `Welcome back, ${first}` : 'Welcome'), h('p', {}, 'How is your group travelling? Everyone in a group uses the same way, chosen once when you create it.')),
    h('div', { class: 'mode-grid' },
      card('metro', '#/metro', '🚇', 'Namma Metro', 'Metro', 'Group Metro Meetup Planner', ['Line-aware routes with interchanges and fares', 'Includes the new Pink Line (Phase 1)', 'Meetup station plus places within walking distance'], 'Open Metro planner'),
      card('bike', '#/bike', '🏍️', 'Road routes', 'Bike', 'Group Bike Meetup Planner', ['Real road distances and travel times', 'Optional fuel-cost estimate with your own assumptions', 'Meetup point plus places nearby'], 'Open Bike planner')),
    h('p', { class: 'mode-note' }, 'Just exploring? Try the ', h('a', { href: '../' }, 'Quick Metro planner'), ' — no sign-in needed.'));
}
