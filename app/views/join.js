import { h, mount, announce } from '../dom.js';
import { post } from '../api.js';
import { createOriginPicker } from './originPicker.js';
import { prefsForm } from './prefs.js';

export async function renderJoin(root, ctx, token) {
  let inv;
  try { inv = (await post('/api/invitations/preview', { token })).invitation; }
  catch (e) { mount(root, h('div', { class: 'card narrow' }, h('h1', {}, 'Invitation unavailable'), h('p', {}, e.code === 'INVITE_EXPIRED' ? 'This invitation has expired.' : e.code === 'INVITE_REVOKED' ? 'This invitation was cancelled.' : 'This invitation is not valid, or the group is full.'), h('p', {}, 'Ask the group owner for a new link.'))); return; }

  if (!ctx.user) {
    sessionStorage.setItem('mm.afterLogin', `/join/${token}`);
    mount(root, h('div', { class: 'card narrow' }, h('h1', {}, `Join “${inv.groupName}”`), inv.namedSeats ? h('p', {}, `Invited: ${inv.participants.map(p => p.name).join(', ')}. You will choose which one is you after signing in.`) : null, h('p', {}, `This is a ${inv.mode === 'METRO' ? 'Metro' : 'Bike'} group. Sign in or create an account to continue.`),
      h('p', {}, h('a', { class: 'button', href: '#/login' }, 'Sign in'), ' ', h('a', { class: 'button secondary', href: '#/register' }, 'Create account'))));
    return;
  }
  const stations = await ctx.getStations();
  const profile = (await (await import('../api.js')).get('/api/me').catch(() => null))?.profile;
  const picker = createOriginPicker({ mode: inv.mode, stations, savedPlaces: profile?.savedPlaces ?? [], idPrefix: 'join' });
  const prefs = prefsForm({ mode: inv.mode });
  const err = h('p', { class: 'error', role: 'alert' });
  const seats = inv.namedSeats ? h('fieldset', { class: 'seats' }, h('legend', {}, 'Who are you?'), h('p', { class: 'hint' }, 'Pick your own name. A name can only be claimed once, and the plan creator can see which account claimed it.'),
    inv.participants.map((p, i) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'seat', value: p.id, disabled: p.claimed, required: true }), ` ${p.name}`, p.claimed ? ' (already claimed)' : ''))) : null;
  mount(root, h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const origin = picker.getOrigin(); if (!origin) { err.textContent = 'Set your starting point first.'; return; }
    const seat = seats?.querySelector('input[name=seat]:checked'); if (seats && !seat) { err.textContent = 'Choose which participant you are.'; return; }
    try { const r = await post('/api/invitations/join', { token, mode: inv.mode, origin, ...(seat ? { participantId: seat.value } : {}), ...prefs.value() }); announce('Joined group'); ctx.navigate(`/g/${r.group.id}`); }
    catch (x) { err.textContent = x.message; }
  } },
    h('h1', {}, `Join “${inv.groupName}”`), h('p', {}, `This is a ${inv.mode === 'METRO' ? 'Metro' : 'Bike'} group — everyone travels the same way.`),
    seats, h('h2', {}, 'Your starting point'), picker.el, h('h2', {}, 'Your preferences (optional)'), prefs.el,
    h('p', { class: 'hint' }, 'Privacy: other members never see your exact starting point. The plan does show each person’s route to the meetup, which implies roughly where they start.'),
    err, h('button', { type: 'submit' }, 'Join group')));
}
