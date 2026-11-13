import { h, mount, field, announce } from '../dom.js';
import { get, patch, post, del } from '../api.js';
import { passwordField } from './auth.js';
import { createOriginPicker } from './originPicker.js';
import { prefsForm } from './prefs.js';

export async function renderProfile(root, ctx) {
  const { profile } = await get('/api/me');
  const name = h('input', { type: 'text', maxlength: '60', value: profile.displayName });
  const prefs = prefsForm({ mode: 'METRO', softPrefs: profile.defaultPrefs });
  let places = [...profile.savedPlaces];
  const placesBox = h('ul', { 'aria-label': 'Saved places' });
  const drawPlaces = () => placesBox.replaceChildren(...places.map((p, i) => h('li', {}, `${p.label} `, h('button', { type: 'button', class: 'link danger', onclick: () => { places.splice(i, 1); drawPlaces(); } }, 'Remove'))));
  drawPlaces();
  const label = h('input', { type: 'text', maxlength: '60', placeholder: 'e.g. Home' });
  const picker = createOriginPicker({ mode: 'BIKE', savedPlaces: [], idPrefix: 'prof' });
  const msg = h('p', { role: 'status', class: 'ok' }), err = h('p', { role: 'alert', class: 'error' });
  const details = h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); msg.textContent = err.textContent = '';
    try { const { softPrefs } = prefs.value(); await patch('/api/me', { displayName: name.value, defaultPrefs: { timeSensitivity: softPrefs.timeSensitivity, costSensitivity: softPrefs.costSensitivity }, savedPlaces: places }); msg.textContent = 'Saved.'; announce('Profile saved'); ctx.refreshUser(); }
    catch (x) { err.textContent = x.message; }
  } }, h('h1', {}, 'Your profile'), field('Display name', name).row,
    h('p', { class: 'hint' }, 'Account email: ', profile.email), h('h2', {}, 'Default preferences'), prefs.el,
    h('h2', {}, 'Saved places'), h('p', { class: 'hint' }, 'Quick starting points for groups. A group never changes these — each group keeps its own starting point.'), placesBox,
    h('fieldset', {}, h('legend', {}, 'Add a place'), field('Name', label).row, picker.el,
      h('button', { type: 'button', class: 'secondary', onclick: () => { const o = picker.getOrigin(); err.textContent = ''; if (!label.value.trim() || !o || o.lat == null) { err.textContent = 'Give the place a name and choose a location (an address or coordinates).'; return; } if (places.length >= 10) { err.textContent = 'At most 10 saved places.'; return; } places.push({ label: label.value.trim(), lat: o.lat, lon: o.lon }); label.value = ''; drawPlaces(); } }, 'Add place')),
    msg, err, h('button', { type: 'submit' }, 'Save profile'));

  // ── security ──
  const cur = passwordField('Current password', { autocomplete: 'current-password' });
  const next = passwordField('New password', { autocomplete: 'new-password', meter: true, context: () => ({ email: profile.email, name: name.value }) });
  cur.validate = () => cur.setError(cur.input.value ? null : 'Enter your current password.');
  const pwMsg = h('p', { class: 'ok', role: 'status' }), pwErr = h('p', { class: 'error', role: 'alert' });
  const changeBtn = h('button', { type: 'submit' }, 'Change password');
  const security = h('form', { class: 'card', novalidate: true, id: 'security', onsubmit: async (e) => {
    e.preventDefault(); pwMsg.textContent = pwErr.textContent = '';
    if (![cur.validate(), next.validate()].every(Boolean)) return;
    changeBtn.disabled = true; changeBtn.setAttribute('aria-busy', 'true');
    try { await post('/api/me/password', { currentPassword: cur.input.value, newPassword: next.input.value }); cur.input.value = next.input.value = ''; pwMsg.textContent = 'Password changed. Your other devices were signed out.'; announce('Password changed'); }
    catch (x) { pwErr.textContent = x.message; } finally { changeBtn.disabled = false; changeBtn.removeAttribute('aria-busy'); }
  } }, h('h2', {}, 'Password & sessions'), cur.row, next.row, pwMsg, pwErr, changeBtn,
    h('p', { class: 'hint' }, 'Signed in on a shared or lost device?'),
    h('button', { type: 'button', class: 'secondary', onclick: async () => { await post('/api/auth/logout-all'); ctx.signedOut(); sessionStorage.setItem('mm.notice', 'You were signed out on all devices.'); ctx.navigate('/login'); } }, 'Sign out everywhere'));

  // ── delete account ──
  const delPw = passwordField('Confirm with your password', { autocomplete: 'current-password' });
  const delErr = h('p', { class: 'error', role: 'alert' });
  const sure = h('input', { type: 'checkbox', id: 'del-sure' });
  const danger = h('details', { class: 'card' }, h('summary', {}, 'Delete my account'),
    h('p', { class: 'hint' }, 'This permanently removes your starting points, preferences, saved places and sign-ins, and cancels groups you own. It cannot be undone.'),
    delPw.row, h('label', { class: 'check', for: 'del-sure' }, sure, ' I understand this cannot be undone'), delErr,
    h('button', { type: 'button', class: 'danger', onclick: async () => {
      delErr.textContent = '';
      if (!sure.checked) { delErr.textContent = 'Tick the box to confirm.'; return; }
      if (!delPw.input.value) { delPw.setError('Enter your password.'); return; }
      try { await del('/api/me', { password: delPw.input.value }); ctx.signedOut(); sessionStorage.setItem('mm.notice', 'Your account was deleted.'); ctx.navigate('/register'); }
      catch (x) { delErr.textContent = x.message; }
    } }, 'Delete my account permanently'));

  mount(root, details, security, danger);
}
