import { h, mount, field, badge, announce } from '../dom.js';
import { get, post, put } from '../api.js';
import { ago } from '../format.js';

const STATUS = { invited: 'invited', planning: 'getting ready', en_route: 'on the way', at_station: 'at their metro station', arrived: 'at the meetup point', withdrawn: 'can’t make it' };
const QUICK = [['⏱ I’m 15 min late', 'I’m running 15 minutes late'], ['🚇 At my station', 'I’ve reached the metro station'], ['📍 I’m at the meetup', 'I’m already at the meetup point'], ['🙅 Can’t make it', 'I cannot make it today'], ['❓ Who is late?', 'Who is late?']];

// YOUR personal agent: a private conversation with your own agent. It is NOT a group chat — other people's agents never see these words,
// only the structured facts your agent chooses to publish (and only those you allow below).
export async function renderAgentPanel({ gid, closed, onChange }) {
  const [{ messages }, agent] = await Promise.all([get(`/api/groups/${gid}/agent/messages`), get(`/api/groups/${gid}/agent`)]);
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Private conversation with your agent' });
  const add = (who, text, note) => log.append(h('div', { class: `msg ${who}` }, h('strong', {}, who === 'me' ? 'You' : 'Your agent'), h('p', {}, text), note ? h('span', { class: 'hint' }, note) : null));
  if (!messages.length) add('bot', `Hi ${agent.participant.name} — I’m your personal agent for this meetup. Tell me things like “I’m running 15 minutes late” or “I’ve reached the station”, or ask “what happened to …?”. This conversation is private; I only pass on the facts that matter to the group.`);
  messages.forEach(m => add(m.role === 'user' ? 'me' : 'bot', m.body, m.role === 'agent' && m.published ? 'Shared with the group’s agents (facts only)' : null));
  const input = h('input', { type: 'text', maxlength: '500', autocomplete: 'off', placeholder: 'Message your agent…', disabled: closed });
  const send = async (text) => {
    const q = (text ?? input.value).trim(); if (!q) return; input.value = ''; add('me', q); log.scrollTop = log.scrollHeight;
    try { const r = await post(`/api/groups/${gid}/agent/messages`, { text: q }); add('bot', r.reply, r.published ? 'Shared with the group’s agents (facts only)' : r.intent === 'other' ? 'Private — not shared' : null); if (r.published) onChange?.(); }
    catch (x) { if (x.code === 'OFFLINE') { input.value = q; add('bot', 'You appear to be offline, so nothing was sent or shared. Your message is still in the box — send it when you are back online (a delay report that arrives hours late would mislead the group, so I do not queue it).'); } else add('bot', x.message); }
    log.scrollTop = log.scrollHeight;
  };
  const sharing = agent.sharing;
  const toggle = (key, label) => { const cb = h('input', { type: 'checkbox', checked: sharing[key], onchange: async () => { try { await put(`/api/groups/${gid}/agent/sharing`, { [key]: cb.checked }); announce(`${label} ${cb.checked ? 'will be shared' : 'will stay private'}`); } catch (x) { cb.checked = !cb.checked; announce(x.message); } } }); return h('label', { class: 'check' }, cb, ` ${label}`); };
  return h('section', { class: 'card', id: 'agent', 'aria-labelledby': 'agent-h' },
    h('h2', { id: 'agent-h' }, '🤖 Your personal agent'), badge('Private to you', 'ok'),
    h('p', { class: 'hint' }, 'Everyone in this meetup has their own agent. Agents coordinate behind the scenes through shared structured updates — there is no group chat.'),
    log,
    h('div', { class: 'row quick' }, QUICK.map(([label, text]) => h('button', { type: 'button', class: 'secondary', disabled: closed, onclick: () => send(text) }, label))),
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); send(); } }, field('Your message', input).row, h('button', { type: 'submit', disabled: closed }, 'Send')),
    h('details', {}, h('summary', {}, 'What my agent may share'),
      h('p', { class: 'hint' }, 'Your words are never shared. Only these facts can reach the other agents. Withdrawing from the meetup and your response to a plan are always shared, because the group has to plan around them. Exact start points are never shared.'),
      toggle('delays', 'Delays (e.g. “about 15 minutes late”)'), toggle('arrival', 'Arrival at my station / the meetup point'), toggle('location', 'That my starting point changed (not where)')));
}

// The shared picture of the group: who has joined, each agent's published state, sync, plan responses, coordinator advice,
// and a live feed of updates. Polls the shared event log (no websockets on this hosting) while the page is open.
export async function renderStatusBoard({ gid, root, isOwner, onRelease, names = {} }) {
  void names;
  const board = h('div'), feed = h('ul', { class: 'feed', 'aria-label': 'Group updates' }), live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  let since = 0, timer = null, firstLoad = true;
  const draw = async () => {
    const d = await get(`/api/groups/${gid}/dashboard`);
    const t = d.totals;
    mount(board,
      h('p', { class: 'chips' }, badge(`${t.joined} of ${t.seats} joined`, t.pending ? 'warn' : 'ok'), ' ', t.pending ? badge(`${t.pending} pending`, 'warn') : null, ' ', t.delayed ? badge(`${t.delayed} delayed`, 'warn') : null, ' ', t.arrived ? badge(`${t.arrived} at the meetup`, 'ok') : null, ' ', t.withdrawn ? badge(`${t.withdrawn} withdrew`) : null),
      d.recommendation ? h('p', { class: 'banner warn', role: 'status' }, d.recommendation.text) : null,
      h('ul', { class: 'members' }, d.roster.map(p => h('li', {}, h('strong', {}, p.name), p.isMe ? ' (you)' : '', ' — ',
        p.claimed ? [STATUS[p.status] ?? p.status, p.delayMinutes ? `, ~${p.delayMinutes} min late` : ''] : (p.status === 'withdrawn' ? STATUS.withdrawn : '⏳ waiting to join'),
        p.claimed ? h('span', { class: `sync ${p.sync?.inSync ? 'ok' : 'warn'}`, title: 'Whether this participant’s agent has read the latest shared updates' }, p.sync?.inSync ? ' · agent in sync' : ` · agent catching up (${p.sync?.pending})`) : null,
        isOwner && p.userId && !p.isMe ? [' ', h('span', { class: 'hint' }, `(account: ${p.accountName})`), ' ', h('button', { type: 'button', class: 'link danger', onclick: async () => { if (confirm(`Release ${p.name}’s place? Their name becomes available again.`)) await onRelease(p.userId); } }, 'Release place')] : null))),
      d.responses ? h('p', { class: 'hint' }, `Plan v${d.responses.version}: ${d.responses.agree} agree · ${d.responses.object} object · ${d.responses.waiting} not responded (changes are only made when the plan creator re-runs the optimisation and confirms).`) : null);
  };
  const pull = async (initial = false) => {
    if (!initial && (!root.isConnected || !board.isConnected)) { clearInterval(timer); return; }   // the user left this page
    try {
      const r = await get(`/api/groups/${gid}/events?since=${since}`);
      if (r.events.length) {
        r.events.forEach(e => feed.prepend(h('li', {}, h('span', { class: 'hint' }, `${ago(new Date(e.at).getTime())} · `), e.text)));
        const fresh = r.events.filter(e => !e.mine);
        if (!firstLoad && fresh.length) live.textContent = fresh.map(e => e.text).join(' ');
        since = r.events[r.events.length - 1].seq; await post(`/api/groups/${gid}/events/ack`, { seq: since }); await draw();
      }
      firstLoad = false;
    } catch { /* offline or closed: try again next tick */ }
  };
  await draw(); await pull(true);
  timer = setInterval(pull, 15000); timer?.unref?.();   // unref: never keeps a Node process (tests) alive
  return h('section', { class: 'card', id: 'status-board', 'aria-labelledby': 'status-h' }, h('h2', { id: 'status-h' }, 'Group status'), h('p', { class: 'hint' }, 'Built from the structured updates each agent has shared. Updated about every 15 seconds while this page is open.'), board, h('h3', {}, 'Updates'), feed.children.length ? feed : h('p', { class: 'hint' }, 'No updates yet.'), live, h('button', { type: 'button', class: 'secondary', onclick: () => pull() }, 'Refresh now'));
}
