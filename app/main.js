import { h, mount, announce } from './dom.js';
import { get, post } from './api.js';
import { createPlanCache } from './offline.js';
import { renderLogin, renderRegister, renderForgot, renderReset } from './views/auth.js';
import { renderModeSelect } from './views/modeSelect.js';
import { renderDashboard } from './views/dashboard.js';
import { renderGroup } from './views/group.js';
import { renderJoin } from './views/join.js';
import { renderProfile } from './views/profile.js';

const root = document.getElementById('view');
const nav = document.getElementById('nav');
const planCache = createPlanCache();
let user = null, stations = null;

const ctx = {
  get user() { return user; }, planCache,
  navigate: (path) => { location.hash = `#${path}`; },
  getStations: async () => (stations ??= (await get('/api/stations')).stations),
  // After signing in, return to what was being opened (e.g. an invitation) — otherwise to the travel-mode screen.
  signedIn: async (u) => { user = u; drawNav(); const back = sessionStorage.getItem('mm.afterLogin'); sessionStorage.removeItem('mm.afterLogin'); ctx.navigate(back || '/'); },
  signedOut: () => { user = null; planCache.clearAll(); drawNav(); },
  refreshUser: async () => { try { user = (await get('/api/me')).profile; } catch { /* ignore */ } drawNav(); },
};

const logoMark = () => h('span', { class: 'logo-mark', 'aria-hidden': 'true' }, '🚇');
function drawNav() {
  const here = location.hash.replace(/^#/, '') || '/';
  const link = (href, text, match) => h('a', { href, ...(match && match.test(here) ? { 'aria-current': 'page' } : {}) }, text);
  mount(nav,
    h('a', { href: '#/', class: 'brand', 'aria-label': 'MobiMeet home' }, logoMark(), h('span', { class: 'brand-name' }, 'Mobi', h('em', {}, 'Meet'))),
    user ? [link('#/metro', '🚇 Metro', /^\/(metro|g\/)/), link('#/bike', '🏍️ Bike', /^\/bike/), link('#/profile', 'Profile', /^\/profile/), h('a', { href: '../' }, 'Quick Metro planner'),
      h('span', { class: 'who' }, user.displayName ?? ''),
      h('button', { type: 'button', class: 'link', onclick: async () => { try { await post('/api/auth/logout'); } catch { /* offline */ } ctx.signedOut(); ctx.navigate('/login'); } }, 'Sign out')]
         : [h('a', { href: '../' }, 'Quick Metro planner'), link('#/login', 'Sign in', /^\/login/), link('#/register', 'Create account', /^\/register/)]);
}

const ROUTES = [
  [/^\/login$/, () => renderLogin(root, ctx), 'public'],
  [/^\/register$/, () => renderRegister(root, ctx), 'public'],
  [/^\/forgot$/, () => renderForgot(root, ctx), 'public'],
  [/^\/reset\/([\w-]{20,100})$/, (m) => renderReset(root, ctx, m[1]), 'public'],
  [/^\/join\/([\w-]{20,100})$/, (m) => renderJoin(root, ctx, m[1]), 'public'],
  [/^\/$/, () => renderModeSelect(root, ctx), 'auth'],
  [/^\/metro$/, () => renderDashboard(root, ctx, 'METRO'), 'auth'],
  [/^\/bike$/, () => renderDashboard(root, ctx, 'BIKE'), 'auth'],
  [/^\/profile$/, () => renderProfile(root, ctx), 'auth'],
  [/^\/g\/([0-9a-f-]{36})$/i, (m) => renderGroup(root, ctx, m[1]), 'auth'],
];

async function render() {
  const path = location.hash.replace(/^#/, '') || '/';
  drawNav();
  const hit = ROUTES.map(([re, fn, access]) => ({ m: re.exec(path), fn, access })).find(x => x.m);
  if (!hit) { mount(root, h('div', { class: 'card narrow' }, h('h1', {}, 'Page not found'), h('a', { href: '#/' }, 'Back to home'))); return; }
  if (hit.access === 'auth' && !user) { sessionStorage.setItem('mm.afterLogin', path); ctx.navigate('/login'); return; }
  if (user && /^\/(login|register|forgot)$/.test(path)) { ctx.navigate('/'); return; }      // already signed in
  mount(root, h('p', { class: 'hint', role: 'status' }, 'Loading…'));
  try { await hit.fn(hit.m); }
  catch (e) {
    if (e.status === 401) { user = null; drawNav(); sessionStorage.setItem('mm.afterLogin', path); ctx.navigate('/login'); return; }
    mount(root, h('div', { class: 'card narrow' }, h('h1', {}, e.status === 404 ? 'Not found' : 'Something went wrong'), h('p', {}, e.status === 404 ? 'That group or page does not exist, or you do not have access.' : e.message), h('a', { href: '#/' }, 'Back to home')));
  }
  const heading = root.querySelector('h1'); if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: false }); document.title = `${heading.textContent} · MobiMeet`; }
}

const banner = document.getElementById('offline-banner');
const setOnline = () => { banner.hidden = navigator.onLine; if (!navigator.onLine) announce('You are offline'); };
addEventListener('online', setOnline); addEventListener('offline', setOnline); setOnline();

addEventListener('hashchange', render);
try { user = (await get('/api/session')).user; } catch { user = null; }
render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('../sw.js').catch(() => { /* offline support is optional */ });
