import { h, field } from '../dom.js';
import { post } from '../api.js';

// Plan-grounded assistant. Answers come from stored plan numbers; open questions go to the server-side LLM if configured.
export function renderChat({ gid }) {
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Assistant conversation' });
  const input = h('input', { type: 'text', maxlength: '500', autocomplete: 'off', placeholder: 'e.g. Why this location? Who travels the longest?' });
  const add = (who, text, meta) => log.append(h('div', { class: `msg ${who}` }, h('strong', {}, who === 'me' ? 'You' : 'MobiBot'), h('p', {}, text), meta ? h('span', { class: 'hint' }, meta) : null));
  const send = async (e) => {
    e.preventDefault(); const q = input.value.trim(); if (!q) return; input.value = ''; add('me', q);
    try { const r = await post('/api/chat', { groupId: gid, message: q }); add('bot', r.reply, r.source === 'deterministic' ? 'Answered from your plan data' : r.source === 'llm' ? 'AI-generated · figures outside your plan data are unverified' : ''); }
    catch (x) { add('bot', x.message); }
  };
  return h('section', { class: 'card', id: 'chat' }, h('h2', {}, 'Ask about your plan'), log,
    h('form', { onsubmit: send, class: 'row' }, field('Your question', input).row, h('button', { type: 'submit' }, 'Ask')));
}
