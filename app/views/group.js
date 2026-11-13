import { h, mount, field, badge, announce } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { createOriginPicker } from './originPicker.js';
import { prefsForm } from './prefs.js';
import { renderPlan, renderVenues } from './plan.js';
import { renderWhatIf } from './whatif.js';
import { renderChat } from './chat.js';
import { renderAgentPanel, renderStatusBoard } from './coordination.js';
import { STATUS_LABEL, STRATEGY_LABEL, ago } from '../format.js';
import { RADIUS, VENUE_CATEGORIES } from '../../src/venues/core.js';

export async function renderGroup(root, ctx, gid) {
  const stations = await ctx.getStations();
  const profile = (await get('/api/me').catch(() => null))?.profile;
  let group;
  try { group = (await get(`/api/groups/${gid}`)).group; }
  catch (e) {
    if (e.code !== 'OFFLINE') throw e;
    const cached = ctx.planCache.load(gid);
    mount(root, h('p', { class: 'banner warn', role: 'status' }, cached ? `You are offline. Showing the plan saved ${ago(cached.savedAt)}${cached.stale ? ' — it may be out of date' : ''}.` : 'You are offline and no plan was saved for this group on this device.'),
      cached ? renderPlan(cached.plan, { names: Object.fromEntries(cached.plan.result.participants.map(p => [p.userId, p.displayName])), mode: cached.plan.result.mode, stale: true, isOwner: false, onConfirm() {}, onPhrase: async () => {} }) : null);
    return;
  }
  const me = group.members.find(m => m.isMe), isOwner = group.role === 'owner';
  const names = Object.fromEntries(group.members.map(m => [m.userId, m.displayName]));
  const reload = () => renderGroup(root, ctx, gid);

  // ── header ──
  const header = h('header', { class: 'group-head' }, h('h1', {}, group.name), badge(group.mode === 'METRO' ? '🚇 Metro' : '🏍️ Bike'), ' ', badge(STATUS_LABEL[group.status] ?? group.status, group.status),
    group.description ? h('p', {}, group.description) : null,
    ['cancelled', 'expired'].includes(group.status) ? h('p', { class: 'banner warn' }, `This group is ${group.status}.`) : null);

  // ── participants (named seats): who has joined and who is still pending ──
  const seats = group.participants ?? [];
  const membersCard = h('section', { class: 'card' }, h('h2', {}, `Participants (${seats.filter(p => p.claimed).length}/${seats.length || group.members.length} joined)`),
    h('ul', { class: 'members' }, seats.map(p => h('li', {}, h('strong', {}, p.name), p.isMe ? ' (you)' : '', ' — ', p.claimed ? '✔ joined' : p.status === 'withdrawn' ? 'can’t make it' : '⏳ pending (name not claimed yet)'))),
    !isOwner ? h('button', { type: 'button', class: 'secondary danger', onclick: async () => { if (confirm('Leave this group? Your agent will tell the others that you withdrew.')) { await post(`/api/groups/${gid}/leave`); ctx.navigate('/'); } } }, 'Leave group') : null);
  const release = async (userId) => { try { await del(`/api/groups/${gid}/members/${userId}`); reload(); } catch (e) { alert(e.message); } };

  // ── my starting point & preferences ──
  const closed = ['cancelled', 'expired'].includes(group.status);
  const picker = createOriginPicker({ mode: group.mode, stations, savedPlaces: profile?.savedPlaces ?? [], initial: me.origin ?? null, idPrefix: 'me' });
  const prefs = prefsForm({ mode: group.mode, softPrefs: me.softPrefs, hard: me.hardConstraints });
  const note = h('textarea', { rows: '2', maxlength: '500', placeholder: 'e.g. “I’d rather pay less and can’t travel more than 45 minutes”' });
  const suggestOut = h('div', { 'aria-live': 'polite' });
  const myErr = h('p', { class: 'error', role: 'alert' }), myOk = h('p', { class: 'ok', role: 'status' });
  const myCard = h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); myErr.textContent = ''; myOk.textContent = '';
    try { const o = picker.getOrigin(); await put(`/api/groups/${gid}/me`, { ...(o ? { origin: o } : {}), ...prefs.value() }); announce('Saved'); await reload(); } catch (x) { myErr.textContent = x.message; }
  } }, h('h2', {}, 'Your starting point & preferences'), picker.el, prefs.el,
    h('details', {}, h('summary', {}, 'Describe your preferences in words (optional)'), field('Your note', note).row,
      h('button', { type: 'button', class: 'secondary', onclick: async () => {
        suggestOut.replaceChildren();
        try {
          const r = await post(`/api/groups/${gid}/me/parse-notes`, { text: note.value });
          if (r.source !== 'llm' || (!Object.keys(r.prefs).length && !Object.keys(r.hard).length)) { suggestOut.append(h('p', { class: 'hint' }, r.reason === 'LLM_NOT_CONFIGURED' ? 'The AI helper is not configured; use the controls above.' : 'No settings could be read from that note.')); return; }
          suggestOut.append(h('p', {}, 'Suggested settings: ', h('code', {}, JSON.stringify({ ...r.prefs, ...r.hard }))), h('button', { type: 'button', class: 'secondary', onclick: () => { prefs.set({ ...prefs.value().softPrefs, ...r.prefs }, { ...prefs.value().hard, ...r.hard }); suggestOut.replaceChildren(h('p', { class: 'hint' }, 'Applied to the form — press Save to keep them.')); } }, 'Apply to form'));
        } catch (e) { suggestOut.append(h('p', { class: 'error' }, e.message)); }
      } }, 'Suggest settings from my note'), suggestOut),
    myErr, myOk, h('button', { type: 'submit', disabled: closed }, 'Save my details'));

  // ── invitations (owner) ──
  const inviteCard = isOwner && group.status === 'open' ? await invitationsCard(gid, ctx, reload) : null;
  const draftHint = isOwner && group.status === 'draft' ? h('p', { class: 'banner warn' }, 'Set your own starting point below to open the group and invite others.') : null;

  // ── optimise (owner) ──
  const planBox = h('div'), venuesBox = h('div'), optErr = h('p', { class: 'error', role: 'alert' });
  const optCard = isOwner && !closed ? optimiseCard(gid, group, optErr, async () => { optErr.textContent = ''; await reload(); }) : null;

  // Elements are captured now: if the user navigates or reloads while the slower parts below are still loading, an OLDER render must
  // only ever write into its own (detached) elements — never into the page that replaced it (that duplicated whole cards on slow networks).
  const zone = h('div', { id: 'agent-zone' }), extrasBox = h('div', { id: 'extras' });
  const modeCrumb = h('p', { class: 'crumbs' }, h('a', { href: group.mode === 'METRO' ? '#/metro' : '#/bike' }, `← ${group.mode === 'METRO' ? 'Metro' : 'Bike'} groups`));
  mount(root, modeCrumb, header, draftHint, h('div', { class: 'grid' }, h('div', {}, membersCard, myCard, inviteCard), h('div', {}, optCard, planBox, venuesBox)), zone, extrasBox);
  // Personal agent (private) + shared group status (built from structured updates). Both are separate from the plan Q&A below.
  try {
    const board = await renderStatusBoard({ gid, root, isOwner, onRelease: release });
    zone.append(h('div', { class: 'grid' }, await renderAgentPanel({ gid, closed, onChange: () => root.querySelector('#status-board button.secondary')?.click() }), board));
  } catch (e) { if (e.code !== 'OFFLINE') zone.append(h('p', { class: 'error' }, e.message)); }
  await loadPlan({ gid, group, ctx, names, isOwner, planBox, venuesBox, reload });
  if (group.members.length >= 1 && !closed) {
    extrasBox.append(renderWhatIf({ gid, group, names, stations, ctx }), renderChat({ gid }));
  }
}

async function loadPlan({ gid, group, ctx, names, isOwner, planBox, venuesBox, reload }) {
  if (!group.selectedPlanId) { mount(planBox, h('section', { class: 'card' }, h('h2', {}, 'Meetup plan'), h('p', {}, isOwner ? 'When everyone has set a starting point, run the optimisation to find the fairest meetup location.' : 'The owner has not run the optimisation yet.'))); return; }
  try {
    const [{ plan }, { plans }] = await Promise.all([get(`/api/groups/${gid}/plans/current`), get(`/api/groups/${gid}/plans`)]);
    ctx.planCache.save(gid, plan);
    const render = (p) => renderPlan(p, { names, mode: group.mode, stale: group.plan?.stale && p.id === plan.id, isOwner,
      onConfirm: async () => { try { await post(`/api/groups/${gid}/plans/${p.id}/confirm`); announce('Plan confirmed'); await reload(); } catch (e) { alert(e.message); } },
      onPhrase: async (out) => { const r = await post(`/api/groups/${gid}/plans/${p.id}/phrase`); out.replaceChildren(h('p', {}, r.lines.join(' ')), h('p', { class: 'hint' }, r.source === 'llm' ? `Reworded by ${r.provider} — numbers verified against the plan.` : 'Showing the standard wording (AI rewording is unavailable or was not verified).')); } });
    const history = plans.length > 1 ? h('details', {}, h('summary', {}, `Plan history (${plans.length} versions)`), h('ul', {}, plans.map(p => h('li', {}, h('button', { type: 'button', class: 'link', onclick: async () => { const r = await get(`/api/groups/${gid}/plans/${p.id}`); mount(planBox, history, render(r.plan)); } }, `v${p.version} — ${p.recommended ?? 'no result'} (${p.status}${p.isSelected ? ', current' : ''})`))))) : null;
    mount(planBox, history, render(plan));
    if (plan.result.recommended) venuesSection(venuesBox, gid, group.mode);
  } catch (e) { mount(planBox, h('p', { class: 'error' }, e.message)); }
}

function venuesSection(box, gid, mode) {
  const cat = h('select', {}, h('option', { value: 'all' }, 'Everything'), Object.entries(VENUE_CATEGORIES).map(([k, c]) => h('option', { value: k }, `${c.emoji} ${c.label}`)));
  const radius = h('select', {}, RADIUS.optionsKm.map(k => h('option', { value: String(k), selected: k === RADIUS.defaultKm }, `${k} km`)));
  const out = h('div', { 'aria-live': 'polite' });
  const run = async (refresh) => {
    out.replaceChildren(h('p', { class: 'hint' }, 'Looking for places…'));
    try { const r = await get(`/api/groups/${gid}/plans/current/venues?categories=${cat.value}&radiusKm=${radius.value}${refresh ? '&refresh=1' : ''}`); out.replaceChildren(renderVenues(r.venues, { mode })); }
    catch (e) { out.replaceChildren(h('p', { class: 'error' }, e.message)); }
  };
  cat.addEventListener('change', () => run(false)); radius.addEventListener('change', () => run(false));
  mount(box, h('section', { class: 'card' }, h('h2', {}, 'Find places to hang out'), h('div', { class: 'row' }, field('Type of place', cat).row, field('Search radius', radius).row),
    h('button', { type: 'button', class: 'secondary', onclick: () => run(true) }, 'Search near the meetup point')), out);
  run(false);   // show suggestions immediately; the buttons refine or refresh them
}

function optimiseCard(gid, group, errBox, after) {
  const strat = h('select', {}, Object.entries(STRATEGY_LABEL).map(([k, v]) => h('option', { value: k }, v)));
  const routeStrat = h('select', {}, [['fastest', 'Fastest'], ['fewest_transfers', 'Fewest changes'], ['lowest_fare', 'Lowest fare (fewest stops)']].map(([k, v]) => h('option', { value: k }, v)));
  const mileage = h('input', { type: 'number', min: '1', step: '0.1' }), price = h('input', { type: 'number', min: '1', step: '0.01' }), pdate = h('input', { type: 'date' }), psrc = h('input', { type: 'text', maxlength: '80', placeholder: 'e.g. petrol pump board' });
  const btn = h('button', { type: 'submit' }, 'Find the fairest meetup');
  return h('form', { class: 'card', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); errBox.textContent = ''; btn.disabled = true; btn.setAttribute('aria-busy', 'true'); announce('Calculating…');
    const fuel = group.mode === 'BIKE' && mileage.value && price.value ? { mileageKmPerLitre: Number(mileage.value), fuelPricePerLitre: Number(price.value), ...(pdate.value ? { priceDate: pdate.value } : {}), ...(psrc.value ? { priceSource: psrc.value } : {}) } : undefined;
    try { await post(`/api/groups/${gid}/optimize`, { strategy: strat.value, ...(group.mode === 'METRO' ? { routeStrategy: routeStrat.value } : {}), ...(fuel ? { fuel } : {}) }); announce('Plan ready'); await after(); }
    catch (x) { errBox.textContent = x.code === 'NOT_READY' ? `${x.message}${x.missing ? ' (someone is still missing a starting point)' : ''}` : x.message; }
    finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  } }, h('h2', {}, 'Find a meetup'), field('Strategy', strat, 'Balanced / Fair minimises the longest individual journey first.').row,
    group.mode === 'METRO' ? field('How each person’s route is chosen', routeStrat, 'Only matters where more than one route exists; reported times and fares are always those of the route chosen.').row : null,
    group.mode === 'BIKE' ? h('details', {}, h('summary', {}, 'Fuel cost estimate (optional)'), h('p', { class: 'hint' }, 'Fuel cost is only shown if you provide both values. We never guess a fuel price.'),
      field('Mileage (km per litre)', mileage).row, field('Fuel price (₹ per litre)', price).row, field('Price date', pdate).row, field('Price source', psrc).row) : null,
    errBox, btn);
}

async function invitationsCard(gid, ctx, reload) {
  const { invitations } = await get(`/api/groups/${gid}/invitations`);
  const ttl = h('select', {}, [[24, '1 day'], [72, '3 days'], [168, '7 days']].map(([v, l]) => h('option', { value: v }, l))), uses = h('input', { type: 'number', min: '1', max: '50', value: '5' });
  const out = h('div', { 'aria-live': 'polite' }), err = h('p', { class: 'error', role: 'alert' });
  return h('section', { class: 'card' }, h('h2', {}, 'Invite people'),
    field('Link valid for', ttl).row, field('Maximum people who can use it', uses).row,
    h('button', { type: 'button', onclick: async () => {
      err.textContent = '';
      try {
        const r = await post(`/api/groups/${gid}/invitations`, { ttlHours: Number(ttl.value), maxUses: Number(uses.value) });
        const link = `${location.origin}${location.pathname}#/join/${r.token}`;
        out.replaceChildren(h('p', {}, 'Share this link — it is shown only once:'), h('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Invitation link', onfocus: (e) => e.target.select() }),
          h('button', { type: 'button', class: 'secondary', onclick: async () => { try { await navigator.clipboard.writeText(link); announce('Link copied'); } catch { announce('Select the link and copy it manually'); } } }, 'Copy link'),
          navigator.share ? h('button', { type: 'button', class: 'secondary', onclick: () => navigator.share({ title: 'Join my meetup on MobiMeet', url: link }).catch(() => {}) }, 'Share…') : null,
          h('p', { class: 'hint' }, 'One link for everyone. Each invited person picks their own name when they open it; each name can be claimed once, and you can release a place that was claimed by the wrong person.'));
      } catch (e) { err.textContent = e.message; }
    } }, 'Create invitation link'), err, out,
    invitations.length ? h('ul', { class: 'invites' }, invitations.map(i => h('li', {}, `${i.status} · ${i.uses}/${i.maxUses} used · expires ${new Date(i.expiresAt).toLocaleDateString()} `,
      i.status === 'active' ? h('button', { type: 'button', class: 'link danger', onclick: async () => { await del(`/api/groups/${gid}/invitations/${i.id}`); reload(); } }, 'Revoke') : null))) : null,
    h('p', { class: 'hint' }, 'Cancel the whole group to revoke every link at once.'),
    h('button', { type: 'button', class: 'secondary danger', onclick: async () => { if (confirm('Cancel this group? This cannot be undone.')) { await post(`/api/groups/${gid}/cancel`); reload(); } } }, 'Cancel group'));
}
