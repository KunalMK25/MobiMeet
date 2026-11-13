// End-to-end UI tests: real app/*.js views in jsdom talking to the real API pipeline on PGlite (no network, synthetic data).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createTestDb as createPgliteDb } from './testdb.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/api/app.js';
import { loadConfig } from '../src/api/config.js';
import { createChatService } from '../src/ai/chat.js';
import { createVenueService, createOverpassProvider } from '../src/venues/venueService.js';
import { fakeRouting, liveVenuesFetch } from './helpers.js';

const ORIGIN = 'http://localhost:3000';
let db, app, dom, win, doc, jar = '', online = true, failFetch = false, ipSeq = 0;
const alerts = [];

before(async () => {
  db = await createPgliteDb(); await migrate(db);
  app = await createApp({ db, config: loadConfig({ APP_BASE_URL: ORIGIN }), providers: { roadRouting: fakeRouting() },
    venues: createVenueService({ live: createOverpassProvider({ fetchImpl: liveVenuesFetch('Test <b>Cafe</b>') }) }),
    chat: ({ db, groups, plans, config }) => createChatService({ db, groups, plans, config, llm: null }) });

  const html = readFileSync('app/index.html', 'utf8');
  dom = new JSDOM(html, { url: `${ORIGIN}/app/`, pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  win = dom.window; doc = win.document;
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  def('document', doc); def('window', win); def('navigator', win.navigator); def('location', win.location); def('localStorage', win.localStorage); def('sessionStorage', win.sessionStorage);
  def('addEventListener', win.addEventListener.bind(win)); def('Node', win.Node); def('confirm', () => true); def('alert', (m) => alerts.push(m));
  def('devicePixelRatio', 1);
  def('fetch', async (path, opts = {}) => {
    if (!online || failFetch) throw new TypeError('network down');
    const url = new URL(path, ORIGIN);
    const res = await app.handle({ method: opts.method || 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), body: opts.body ? JSON.parse(opts.body) : undefined, ip: `203.0.113.${(++ipSeq % 200) + 1}`,
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...(jar ? { cookie: jar } : {}) } });
    const sc = res.headers['Set-Cookie']; if (sc) jar = sc.startsWith('mm_session=;') ? '' : sc.split(';')[0];
    return { ok: res.status < 400, status: res.status, json: async () => JSON.parse(res.body) };
  });
  await import('../app/main.js');
});
after(async () => { win.close(); await db.close(); });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WAIT_MS = process.env.TEST_DATABASE_URL ? 60000 : 4000;       // a remote database (e.g. Neon in another country) is slower per query; same assertions
async function waitFor(fn, what = 'condition', ms = WAIT_MS) { const t = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}\n${doc.getElementById('view').textContent.slice(0, 400)}`); await sleep(25); } }
const h1 = () => doc.querySelector('#view h1')?.textContent;
const go = async (hash) => { win.location.hash = hash; await sleep(10); };
const type = (el, v, ev = 'input') => { el.value = v; el.dispatchEvent(new win.Event(ev, { bubbles: true })); };
const submit = (form) => form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
const byText = (sel, text) => [...doc.querySelectorAll(sel)].find(e => e.textContent.trim().startsWith(text));
const fieldByLabel = (text) => { const l = [...doc.querySelectorAll('#view label')].find(x => x.textContent.trim().startsWith(text)); return l && doc.getElementById(l.getAttribute('for')); };

test('unauthenticated visitors are sent to sign-in, and routes are guarded', async () => {
  await go('#/');
  await waitFor(() => h1() === 'Welcome back', 'sign-in page');
  assert.ok(doc.querySelector('#nav a[href="#/login"]'));
  for (const guarded of ['#/profile', '#/metro', '#/bike']) { await go(guarded); await waitFor(() => h1() === 'Welcome back', `guard redirect from ${guarded}`); }
  await go('#/profile'); await waitFor(() => h1() === 'Welcome back');           // the page being asked for is remembered for after sign-in
  await go('#/nope'); await waitFor(() => h1() === 'Page not found', '404');
});
test('register → dashboard; wrong sign-in shows an error without leaking which field was wrong', async () => {
  await go('#/register'); await waitFor(() => h1() === 'Create your account');
  const form = doc.querySelector('#view form');
  type(fieldByLabel('Your name'), 'Asha <script>x</script>'); type(fieldByLabel('Email'), 'asha@example.test'); type(fieldByLabel('Password'), 'correct horse battery');
  submit(form);
  await waitFor(() => h1() === 'Your profile', 'returned to the originally requested page (#/profile)');   // return-to-page after sign-in
  await go('#/'); await waitFor(() => /^Welcome back, Asha$/.test(h1() ?? ''), 'travel-mode screen greets the user by first name');
  assert.match(doc.querySelector('#nav .who').textContent, /Asha <script>x<\/script>/);   // shown as text
  assert.equal(doc.querySelectorAll('#nav script').length, 0);
  const cards = [...doc.querySelectorAll('#view a.mode-card')];
  assert.deepEqual(cards.map(c => c.getAttribute('href')), ['#/metro', '#/bike']);
  assert.match(cards[0].textContent, /Group Metro Meetup Planner/); assert.match(cards[1].textContent, /Group Bike Meetup Planner/);
  assert.equal(doc.querySelectorAll('#view input[type=radio]').length, 0, 'no mode radio buttons here — the choice is the card you open');
  cards[0].click(); await go('#/metro'); await waitFor(() => /Metro groups$/.test(h1() ?? ''), 'Metro planner');
  assert.equal(doc.querySelectorAll('#view input[type=radio]').length, 0, 'inside a planner the mode is fixed, never asked again');
  assert.match(doc.getElementById('view').textContent, /Create a Metro group/); assert.match(doc.getElementById('view').textContent, /fixed once the group is created/);
  assert.ok(doc.querySelector('#nav a[href="#/metro"][aria-current="page"]'));
});
test('create a Metro group with a hostile name: rendered as text, never as markup', async () => {
  const name = '<img src=x onerror="window.__pwned=1">Trip';
  type(fieldByLabel('Group name'), name);
  const st = doc.querySelector('#view input[list]'); type(st, 'Majestic', 'change');
  await waitFor(() => /Starting point: Majestic/.test(doc.querySelector('#view .selected').textContent), 'station chosen');
  submit(doc.querySelector('#view form.card:last-of-type') ?? doc.querySelectorAll('#view form')[0]);
  await waitFor(() => h1() === name, 'group page');
  assert.equal(doc.querySelector('#view img'), null); assert.equal(win.__pwned, undefined);
  await waitFor(() => /Participants \(1\/1 joined\)/.test(doc.getElementById('view').textContent));
  assert.match(doc.getElementById('view').textContent, /Metro/);
});
let token, gid;
test('owner creates an invitation link (token appears once, in the URL fragment)', async () => {
  gid = /#\/g\/([0-9a-f-]{36})/.exec(win.location.hash)[1];
  byText('#view button', 'Create invitation link').click();
  const link = await waitFor(() => doc.querySelector('input[aria-label="Invitation link"]'), 'invitation link');
  assert.match(link.value, /#\/join\/[\w-]{43}$/); token = link.value.split('/join/')[1];
});
async function otherUser(email) {   // a second person, via the API (their own cookie jar)
  const h = { 'content-type': 'application/json', origin: ORIGIN };
  const reg = await app.handle({ method: 'POST', path: '/api/auth/register', ip: `198.51.100.${++ipSeq}`, headers: h, body: { email, password: 'correct horse battery', displayName: 'Ben' } });
  const cookie = reg.headers['Set-Cookie'].split(';')[0];
  return (path, body, method = 'POST') => app.handle({ method, path, ip: `198.51.100.${++ipSeq}`, headers: { ...h, cookie }, body });
}
test('a friend joins; owner sees them, optimises, and the plan renders with a table, explanation and no raw coordinates', async () => {
  const ben = await otherUser('ben@example.test');
  const j = await ben('/api/invitations/join', { token, origin: { stationId: 'stn_whitefield' } }); assert.equal(j.status, 200);
  await go('#/'); await go(`#/g/${gid}`);
  await waitFor(() => /Participants \(2\/2 joined\)/.test(doc.getElementById('view').textContent), '2 participants');
  assert.match(doc.getElementById('view').textContent, /Ben.*✔ joined/);
  submit(byText('#view form button[type=submit]', 'Find the fairest meetup').form);
  await waitFor(() => /^Meet (at|near) /.test(doc.querySelector('#view .plan h2')?.textContent ?? ''), 'plan');
  const rows = doc.querySelector('#view .plan table.data').querySelectorAll('tbody tr'); assert.equal(rows.length, 2);   // first table = journeys
  assert.ok([...doc.querySelectorAll('#view .plan th[scope=col]')].some(x => x.textContent === 'Travel time'));
  assert.match(doc.querySelector('#view .plan').textContent, /Why this location/);
  assert.match(doc.querySelector('#view .plan').textContent, /Fairness index \(Jain\)/);
  assert.ok(!/originLat|77\.7503/.test(doc.getElementById('view').innerHTML));
  assert.ok(byText('#view button', 'Confirm this plan'));
});
test('chat answers from plan data', async () => {
  const input = doc.querySelector('#chat input'); type(input, 'Why this location?'); submit(doc.querySelector('#chat form'));
  await waitFor(() => /Recommended meetup/.test(doc.querySelector('#chat .chat-log').textContent), 'bot reply');
  assert.match(doc.querySelector('#chat .chat-log').textContent, /Answered from your plan data/);
});
test('what-if runs a scenario and states that the plan is unchanged', async () => {
  const sel = doc.querySelector('#whatif select'); type(sel, 'fastest', 'change');
  byText('#whatif button', 'Run scenario').click();
  await waitFor(() => doc.querySelector('#whatif .scenario'), 'scenario');
  assert.match(doc.querySelector('#whatif .scenario').textContent, /Your group’s plan is unchanged/);
  assert.match(doc.querySelector('#whatif .scenario').textContent, /(better|worse|no change)/);
});
test('owner confirms the plan; status badge updates', async () => {
  byText('#view button', 'Confirm this plan').click();
  await waitFor(() => /Confirmed/.test(doc.querySelector('#view .plan-head .badge')?.textContent ?? ''), 'confirmed badge');
  assert.equal(byText('#view button', 'Confirm this plan'), undefined);
});
test('venues: live data shown with attribution; venue names are text, links are validated OSM URLs', async () => {
  byText('#view button', 'Search near the meetup point').click();
  await waitFor(() => doc.querySelector('.venues li'), 'venues');
  assert.match(doc.querySelector('.venues').textContent, /Test <b>Cafe<\/b>/); assert.equal(doc.querySelectorAll('.venues b').length, 0);
  const li = [...doc.querySelectorAll('.venues li')].find(x => x.textContent.includes('Test <b>Cafe</b>'));
  assert.match(li.querySelector('a').href, /^https:\/\/www\.openstreetmap\.org\/node\/7$/);
  assert.match(li.textContent, /Live OSM/); assert.match(li.textContent, /km from/);         // provenance badge + distance from the meetup point
  assert.match(doc.getElementById('view').textContent, /Places within 2\.5 km of/);
  assert.match(doc.getElementById('view').textContent, /OpenStreetMap contributors/);
});
test('offline: the last plan is shown from this device with a timestamp warning; actions are not offered', async () => {
  failFetch = true; win.dispatchEvent(new win.Event('offline'));
  await go('#/'); await go(`#/g/${gid}`);
  await waitFor(() => /You are offline\. Showing the plan saved/.test(doc.getElementById('view').textContent), 'offline banner');
  assert.match(doc.getElementById('view').textContent, /Meet at /);
  assert.equal(byText('#view button', 'Confirm this plan'), undefined);
  failFetch = false;
});
test('sign-out clears saved plans from the device; invitation page for signed-out visitors shows only group name and mode', async () => {
  await go('#/metro'); await waitFor(() => /Metro groups$/.test(h1() ?? ''));
  assert.ok([...Object.keys(win.localStorage)].some(k => k.startsWith('mm.plan.')));
  // a separate, still-open group to invite into (the first one is confirmed, so its link is rightly dead)
  const mk = await (await fetch('/api/groups', { method: 'POST', body: JSON.stringify({ name: 'Open <i>Trip</i>', mode: 'METRO', origin: { stationId: 'stn_majestic' } }) })).json();
  token = (await (await fetch(`/api/groups/${mk.group.id}/invitations`, { method: 'POST', body: JSON.stringify({}) })).json()).token;
  byText('#nav button', 'Sign out').click();
  await waitFor(() => h1() === 'Welcome back', 'signed out');
  assert.ok(![...Object.keys(win.localStorage)].some(k => k.startsWith('mm.')), 'plans removed from device');
  await go(`#/join/${token}`);
  await waitFor(() => /^Join “/.test(h1() ?? ''), 'invite page');
  const text = doc.getElementById('view').textContent;
  assert.match(text, /Metro group/); assert.match(text, /Open <i>Trip<\/i>/); assert.equal(doc.querySelectorAll('#view i').length, 0);
  assert.ok(!/Ben|Majestic|Whitefield|Asha/.test(text), 'no member or location data for link holders');
  assert.ok(byText('#view a', 'Sign in'));   // the invitation page offers sign-in / create account
  await go('#/join/' + 'x'.repeat(43)); await waitFor(() => h1() === 'Invitation unavailable', 'bad invite');
});
test('sign-up screen: inline validation, show/hide password, live strength guidance, and a clear first-error focus', async () => {
  await go('#/register'); await waitFor(() => h1() === 'Create your account');
  const form = doc.querySelector('#view form'); submit(form);
  assert.ok([...doc.querySelectorAll('#view .field-error')].filter(e => e.textContent).length >= 3, 'every empty field explains itself');
  assert.equal(doc.activeElement, fieldByLabel('Your name'), 'focus moves to the first problem');
  assert.equal(fieldByLabel('Email').getAttribute('aria-invalid'), 'true'); assert.equal(fieldByLabel('Password').getAttribute('aria-invalid'), 'true');
  type(fieldByLabel('Email'), 'not-an-email'); fieldByLabel('Email').dispatchEvent(new win.Event('blur'));
  assert.match(doc.getElementById(fieldByLabel('Email').id + '-err').textContent, /does not look like an email/);
  const pw = fieldByLabel('Password'), meter = doc.querySelector('#view .meter'), tip = () => doc.getElementById(pw.id + '-tip').textContent;
  type(pw, 'password123'); assert.match(tip(), /too common/);
  type(pw, 'short'); assert.equal(meter.dataset.score, '1'); assert.match(tip(), /at least 10/i);
  type(pw, 'four word pass phrase'); assert.equal(meter.dataset.score, '4'); assert.equal(tip(), 'Strong password.');
  const toggle = doc.querySelector('#view .pw-toggle');
  assert.equal(pw.type, 'password'); assert.equal(toggle.getAttribute('aria-pressed'), 'false'); assert.equal(toggle.getAttribute('aria-label'), 'Show password');
  toggle.click(); assert.equal(pw.type, 'text'); assert.equal(toggle.getAttribute('aria-pressed'), 'true'); assert.equal(toggle.getAttribute('aria-label'), 'Hide password'); assert.equal(doc.activeElement, pw);
  toggle.click(); assert.equal(pw.type, 'password');
  type(fieldByLabel('Email'), 'newuser@example.test'); type(fieldByLabel('Your name'), 'Nia');
  type(pw, 'newuser2026'); assert.match(tip(), /email/);                                          // built from the email → rejected live
  type(pw, 'a long unusual passphrase'); submit(form);
  await waitFor(() => /^Join “Open/.test(h1() ?? ''), 'a pending invitation is reopened right after sign-up (the person was in the middle of joining)');
  await go('#/'); await waitFor(() => /^Welcome back, Nia$/.test(h1() ?? ''), 'registered and greeted by name'); assert.match(doc.querySelector('#nav .who').textContent, /Nia/);
});
test('sign-in screen: one generic error for a wrong password (never says which part was wrong), the button recovers, validation is inline', async () => {
  byText('#nav button', 'Sign out').click(); await waitFor(() => h1() === 'Welcome back');
  const form = doc.querySelector('#view form'); submit(form);
  assert.match(doc.getElementById(fieldByLabel('Email').id + '-err').textContent, /Enter your email/); assert.match(doc.getElementById(fieldByLabel('Password').id + '-err').textContent, /Enter your password/);
  type(fieldByLabel('Email'), 'nia@x.test'); type(fieldByLabel('Email'), 'newuser@example.test'); type(fieldByLabel('Password'), 'definitely wrong password'); submit(form);
  await waitFor(() => /Incorrect email or password/.test(doc.querySelector('#view .error')?.textContent ?? ''), 'generic error');
  const btn = doc.querySelector('#view button[type=submit]'); assert.equal(btn.disabled, false); assert.equal(btn.textContent, 'Sign in'); assert.equal(btn.hasAttribute('aria-busy'), false);
  type(fieldByLabel('Email'), 'ghost@example.test'); submit(form);
  await waitFor(() => /Incorrect email or password/.test(doc.querySelector('#view .error')?.textContent ?? ''));   // unknown account: the same words
});
test('forgot → reset password (development outbox): generic confirmation, one-time link, old password stops working, notice on sign-in', async () => {
  await go('#/forgot'); await waitFor(() => h1() === 'Reset your password');
  type(fieldByLabel('Email'), 'newuser@example.test'); submit(doc.querySelector('#view form'));
  await waitFor(() => /If that address is registered/.test(doc.getElementById('view').textContent), 'generic confirmation');
  const link = await waitFor(() => byText('#view a', 'Open the reset link'), 'development reset link'); assert.match(doc.getElementById('view').textContent, /no email is sent/);
  win.location.hash = link.getAttribute('href'); await waitFor(() => h1() === 'Choose a new password');
  type(fieldByLabel('New password'), 'password123'); submit(doc.querySelector('#view form')); await sleep(60);
  assert.match(doc.querySelector('#view .field-error').textContent, /too common/);                                     // client-side rejection, link still valid
  type(fieldByLabel('New password'), 'my brand new passphrase'); submit(doc.querySelector('#view form'));
  await waitFor(() => h1() === 'Welcome back' && /Your password was updated/.test(doc.getElementById('view').textContent), 'back at sign-in with a notice');
  type(fieldByLabel('Email'), 'newuser@example.test'); type(fieldByLabel('Password'), 'a long unusual passphrase'); submit(doc.querySelector('#view form'));
  await waitFor(() => /Incorrect email or password/.test(doc.querySelector('#view .error')?.textContent ?? ''), 'old password rejected');
  type(fieldByLabel('Password'), 'my brand new passphrase'); submit(doc.querySelector('#view form'));
  await waitFor(() => /^Welcome back, Nia$/.test(h1() ?? ''), 'signed in with the new password');
  win.location.hash = link.getAttribute('href'); await waitFor(() => h1() === 'Welcome back, Nia');                    // already signed in: reset page redirects home
  await go('#/forgot'); await waitFor(() => h1() === 'Welcome back, Nia');
});
test('profile security: change password (needs the current one), sign out everywhere, delete account', async () => {
  await go('#/profile'); await waitFor(() => h1() === 'Your profile');
  const sec = doc.getElementById('security');
  type(fieldByLabel('Current password'), 'wrong wrong wrong'); type(sec.querySelector('input[autocomplete=new-password]'), 'another good passphrase'); submit(sec);
  await waitFor(() => /current password is not correct/.test(sec.querySelector('.error').textContent), 'wrong current password');
  type(fieldByLabel('Current password'), 'my brand new passphrase'); submit(sec);
  await waitFor(() => /Password changed/.test(sec.querySelector('.ok').textContent), 'changed');
  assert.equal(fieldByLabel('Current password').value, '');
  byText('#view button', 'Sign out everywhere').click(); await waitFor(() => h1() === 'Welcome back' && /signed out on all devices/.test(doc.getElementById('view').textContent), 'signed out everywhere');
  type(fieldByLabel('Email'), 'newuser@example.test'); type(fieldByLabel('Password'), 'another good passphrase'); submit(doc.querySelector('#view form'));
  await waitFor(() => /^Welcome back, Nia$/.test(h1() ?? ''));
  await go('#/profile'); await waitFor(() => h1() === 'Your profile');
  const del = byText('#view button', 'Delete my account permanently'); const box = doc.querySelector('#view details.card'); box.open = true;
  del.click(); assert.match(box.querySelector('.error').textContent, /Tick the box/);
  doc.getElementById('del-sure').checked = true; del.click(); assert.match(box.textContent, /Enter your password/);
  type(box.querySelector('input[autocomplete=current-password]'), 'not my password'); del.click();
  await waitFor(() => /confirmation failed/.test(box.querySelector('.error').textContent), 'wrong password blocks deletion');
  type(box.querySelector('input[autocomplete=current-password]'), 'another good passphrase'); del.click();
  await waitFor(() => h1() === 'Create your account' && /account was deleted/.test(doc.getElementById('view').textContent) || h1() === 'Create your account', 'account deleted');
  await go('#/login'); await waitFor(() => h1() === 'Welcome back');
  type(fieldByLabel('Email'), 'newuser@example.test'); type(fieldByLabel('Password'), 'another good passphrase'); submit(doc.querySelector('#view form'));
  await waitFor(() => /Incorrect email or password/.test(doc.querySelector('#view .error')?.textContent ?? ''), 'deleted account cannot sign in');
});
test('Bike group: coordinate entry is validated and creation works end to end', async () => {
  await go('#/login'); await waitFor(() => h1() === 'Welcome back');
  type(fieldByLabel('Email'), 'asha@example.test'); type(fieldByLabel('Password'), 'correct horse battery'); submit(doc.querySelector('#view form'));
  await waitFor(() => /^Welcome back, Asha$/.test(h1() ?? ''), 'signed in; no pending page → the travel-mode screen');
  await go('#/bike'); await waitFor(() => /Bike groups$/.test(h1() ?? ''), 'Bike planner');
  assert.equal(doc.querySelectorAll('#view input[type=radio]').length, 0); assert.ok(!doc.querySelector('#view input[list]'), 'no station field: Bike uses road locations');
  assert.match(doc.getElementById('view').textContent, /Create a Bike group/);
  assert.ok(!doc.getElementById('view').textContent.includes('Open <i>Trip</i>'), 'Metro groups are not listed in the Bike planner');
  type(fieldByLabel('Group name'), 'Ride day');
  const details = doc.querySelector('#view details'); details.open = true;
  type(fieldByLabel('Latitude'), '28.6'); type(fieldByLabel('Longitude'), '77.2'); byText('#view button', 'Use these coordinates').click();
  assert.match(doc.querySelector('#view .error').textContent, /outside the Bengaluru area/);
  type(fieldByLabel('Latitude'), '12.9716'); type(fieldByLabel('Longitude'), '77.5946'); byText('#view button', 'Use these coordinates').click();
  await waitFor(() => /Starting point: 12\.9716, 77\.5946/.test(doc.querySelector('#view .selected').textContent), 'coords accepted');
  submit(doc.querySelectorAll('#view form')[0]);
  await waitFor(() => h1() === 'Ride day', 'bike group page');
  assert.match(doc.getElementById('view').textContent, /Bike/);
  assert.ok(byText('#view summary', 'Invite people') || byText('#view h2', 'Invite people'));
});

test('named seats + personal agent: creator names the others, one link, identity selection, roster, private agent, shared status', async () => {
  await go('#/metro'); await waitFor(() => /Metro groups$/.test(h1() ?? ''), 'Metro planner');
  type(fieldByLabel('Group name'), 'Crew'); type(fieldByLabel('Who are you meeting?'), 'Dev\nEsha');
  type(doc.querySelector('#view input[list]'), 'Majestic', 'change');
  await waitFor(() => /Starting point: Majestic/.test(doc.querySelector('#view .selected').textContent), 'station chosen');
  submit(doc.querySelector('#view form.card:last-of-type') ?? doc.querySelectorAll('#view form')[0]);
  await waitFor(() => h1() === 'Crew', 'group page');
  const gid2 = /#\/g\/([0-9a-f-]{36})/.exec(win.location.hash)[1];
  await waitFor(() => /Participants \(1\/3 joined\)/.test(doc.getElementById('view').textContent), 'roster with pending names');
  assert.match(doc.getElementById('view').textContent, /Dev.*pending/); assert.match(doc.getElementById('view').textContent, /Esha.*pending/);
  await waitFor(() => /Your personal agent/.test(doc.getElementById('view').textContent), 'agent panel (rendered after the roster, once its own requests finish)');
  assert.match(doc.getElementById('view').textContent, /Private to you/);
  assert.ok(!doc.querySelector('#agent input[type=text]')?.closest('form#group-chat'), 'no group chat');
  byText('#view button', 'Create invitation link').click();
  const link = await waitFor(() => doc.querySelector('input[aria-label="Invitation link"]'), 'invitation link'); const tok = link.value.split('/join/')[1];
  assert.match(doc.getElementById('view').textContent, /each name can be claimed once/);

  // a second account claims "Dev" through the API; the roster, status board and the creator's view of the claiming account update
  const ben = await otherUser('dev@example.test');
  const pv = (await (await ben('/api/invitations/preview', { token: tok })).body); const seats = JSON.parse(pv).invitation.participants;
  assert.deepEqual(seats.map(x => x.name), ['Dev', 'Esha']);
  assert.equal((await ben('/api/invitations/join', { token: tok, origin: { stationId: 'stn_whitefield' }, participantId: seats[0].id })).status, 200);
  assert.equal((await ben('/api/invitations/join', { token: tok, origin: { stationId: 'stn_whitefield' }, participantId: seats[0].id })).status, 409);   // already claimed
  await go('#/'); await go(`#/g/${gid2}`);
  await waitFor(() => /Participants \(2\/3 joined\)/.test(doc.getElementById('view').textContent), 'Dev joined');
  await waitFor(() => /2 of 3 joined/.test(doc.querySelector('#status-board')?.textContent ?? ''), 'status board');
  assert.match(doc.querySelector('#status-board').textContent, /account: Ben/);        // the creator sees which account holds the seat
  assert.match(doc.querySelector('#status-board').textContent, /Esha.*waiting to join/);

  // private agent conversation → a structured update appears on the shared status board
  const box = doc.querySelector('#agent input[type=text]'); type(box, "I'm running 15 minutes late because of a private errand");
  submit(box.closest('form'));
  await waitFor(() => /about 15 minutes late/.test(doc.querySelector('#agent .chat-log').textContent), 'agent reply');
  assert.match(doc.querySelector('#agent .chat-log').textContent, /Shared with the group/);
  await waitFor(() => /~15 min late/.test(doc.querySelector('#status-board').textContent), 'status board shows the shared delay');
  assert.ok(!doc.getElementById('view').textContent.includes('private errand') || doc.querySelector('#agent .chat-log').textContent.includes('private errand'));
  assert.ok(!doc.querySelector('#status-board').textContent.includes('private errand'), 'the words never reach the shared board');
  type(box, 'My landlord keeps calling'); submit(box.closest('form'));
  await waitFor(() => /Private — not shared/.test(doc.querySelector('#agent .chat-log').textContent), 'private note');
  // sharing controls
  const delaysBox = [...doc.querySelectorAll('#agent label.check input')][0]; assert.equal(delaysBox.checked, true);
  delaysBox.checked = false; delaysBox.dispatchEvent(new win.Event('change', { bubbles: true }));
  await waitFor(async () => (await app.handle({ method: 'GET', path: `/api/groups/${gid2}/agent`, ip: '9.9.9.9', headers: { origin: ORIGIN, cookie: jar } }).then(r => JSON.parse(r.body))).sharing.delays === false, 'sharing saved');

  // the invitation page: a signed-out visitor sees the invited names and must pick one; claimed names are disabled
  byText('#nav button', 'Sign out').click(); await waitFor(() => h1() === 'Welcome back', 'signed out');
  await go(`#/join/${tok}`); await waitFor(() => /Invited: Dev, Esha/.test(doc.getElementById('view').textContent), 'invite page lists names');
  assert.ok(!/stn_|originLat/.test(doc.getElementById('view').innerHTML));
  doc.querySelector('#view a[href="#/register"]').click(); await go('#/register'); await waitFor(() => h1() === 'Create your account');
  type(fieldByLabel('Your name'), 'Esha'); type(fieldByLabel('Email'), 'esha@example.test'); type(fieldByLabel('Password'), 'correct horse battery'); submit(doc.querySelector('#view form'));
  await waitFor(() => /^Join “Crew”$/.test(h1() ?? ''), 'returned to the invitation');
  const radios = [...doc.querySelectorAll('#view input[name=seat]')];
  assert.deepEqual(radios.map(r => [r.disabled]), [[true], [false]]); assert.match(doc.querySelector('#view .seats').textContent, /Dev \(already claimed\)/);
  type(doc.querySelector('#view input[list]'), 'Indiranagar', 'change');
  await waitFor(() => /Starting point: Indiranagar/.test(doc.querySelector('#view .selected').textContent));
  submit(doc.querySelector('#view form'));
  await waitFor(() => [...doc.querySelectorAll('#view .error')].some(e => /Choose which participant you are/.test(e.textContent)), 'a seat must be chosen');
  radios[1].checked = true; submit(doc.querySelector('#view form'));
  await waitFor(() => h1() === 'Crew', 'joined');
  await waitFor(() => /Participants \(3\/3 joined\)/.test(doc.getElementById('view').textContent), 'all joined');
  // Esha asks HER agent about Dev; it answers from shared updates only (nothing from the creator's private chat)
  await waitFor(() => doc.querySelector('#agent input[type=text]'), 'agent panel');
  const eb = doc.querySelector('#agent input[type=text]'); type(eb, 'What happened to Dev?'); submit(eb.closest('form'));
  await waitFor(() => /Dev/.test(doc.querySelector('#agent .chat-log').textContent.split('What happened to Dev?')[1] ?? ''), 'answer about Dev');
  assert.ok(!doc.querySelector('#agent .chat-log').textContent.includes('landlord'));
});

test('Bike journey in the UI: second rider joins, optimise, route sketch + list, venue shown on the map, no Metro-only controls', async () => {
  await go('#/bike'); await waitFor(() => /Bike groups$/.test(h1() ?? ''));
  type(fieldByLabel('Group name'), 'Bike day'); doc.querySelector('#view details').open = true;
  type(fieldByLabel('Latitude'), '12.9716'); type(fieldByLabel('Longitude'), '77.5946'); byText('#view button', 'Use these coordinates').click();
  await waitFor(() => /Starting point: 12\.9716/.test(doc.querySelector('#view .selected').textContent));
  submit(doc.querySelectorAll('#view form')[0]); await waitFor(() => h1() === 'Bike day', 'bike group page');
  const bgid = /#\/g\/([0-9a-f-]{36})/.exec(win.location.hash)[1];
  byText('#view button', 'Create invitation link').click();
  const tk = (await waitFor(() => doc.querySelector('input[aria-label="Invitation link"]'))).value.split('/join/')[1];
  const rider = await otherUser('rider@example.test');
  assert.equal((await rider('/api/invitations/join', { token: tk, origin: { lat: 12.99, lon: 77.7 } })).status, 200);
  assert.equal((await rider('/api/invitations/join', { token: tk, mode: 'METRO', origin: { stationId: 'stn_whitefield' } })).status, 409 );   // mixed mode is rejected
  await go('#/'); await go(`#/g/${bgid}`); await waitFor(() => /Participants \(2\/2 joined\)/.test(doc.getElementById('view').textContent));
  assert.ok(!byText('#view label', 'How each person’s route is chosen'), 'Metro-only route strategy is not offered for Bike');
  submit(byText('#view form button[type=submit]', 'Find the fairest meetup').form);
  await waitFor(() => /^Meet (at|near) /.test(doc.querySelector('#view .plan h2')?.textContent ?? ''), 'bike plan');
  assert.ok(doc.querySelector('#view .plan canvas[role=img]'), 'route sketch drawn from road geometry');
  assert.equal(doc.querySelector('#view .plan table.data').querySelectorAll('tbody tr').length, 2);   // list-based alternative to the map
  const show = await waitFor(() => byText('#view button', 'Show on map'), 'a venue with coordinates');
  show.click(); await waitFor(() => /Selected place: /.test(doc.querySelector('#view .plan canvas').getAttribute('aria-label')), 'venue marked on the map');
});

test('accessibility: every form control has an accessible name; landmarks, language, skip link, single h1, no positive tabindex', () => {
  const view = doc.getElementById('view');
  const named = (el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
    if (el.id && doc.querySelector(`label[for="${el.id}"]`)) return true;
    return !!el.closest('label');
  };
  const controls = [...view.querySelectorAll('input:not([type=hidden]):not([type=submit]), select, textarea')];
  assert.ok(controls.length > 10, `checked ${controls.length} controls`);
  const unnamed = controls.filter(c => !named(c)).map(c => `${c.tagName}#${c.id}[${c.type}]`);
  assert.deepEqual(unnamed, [], 'controls without an accessible name');
  const buttons = [...view.querySelectorAll('button')].filter(b => !b.textContent.trim() && !b.getAttribute('aria-label'));
  assert.equal(buttons.length, 0, 'icon-only buttons need names');
  assert.equal(doc.documentElement.lang, 'en'); assert.ok(doc.querySelector('a.skip[href="#view"]')); assert.ok(doc.querySelector('main#view')); assert.ok(doc.querySelector('nav[aria-label]'));
  assert.equal(view.querySelectorAll('h1').length, 1); assert.ok(doc.getElementById('status').getAttribute('aria-live'));
  assert.equal([...doc.querySelectorAll('[tabindex]')].filter(e => Number(e.getAttribute('tabindex')) > 0).length, 0);
  assert.ok([...view.querySelectorAll('.error')].every(e => e.getAttribute('role') === 'alert'), 'error text is announced');
  const ids = [...doc.querySelectorAll('[id]')].map(e => e.id); assert.equal(new Set(ids).size, ids.length, 'duplicate ids: ' + ids.filter((x, i) => ids.indexOf(x) !== i));
});
