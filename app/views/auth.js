import { h, mount, announce } from '../dom.js';
import { get, post } from '../api.js';
import { passwordProblems, passwordStrength, PASSWORD } from '../../src/utils/passwordPolicy.js';

// ── building blocks ────────────────────────────────────────────────────────────────────
let uid = 0;
const nextId = (p) => `${p}${++uid}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Labelled input with an inline error line wired to aria-describedby / aria-invalid.
function field(label, input, { hint } = {}) {
  const id = input.id || nextId('f'); input.id = id;
  const err = h('div', { class: 'field-error', id: `${id}-err`, role: 'alert' });
  const hintEl = hint ? h('div', { class: 'hint', id: `${id}-hint` }, hint) : null;
  input.setAttribute('aria-describedby', [hintEl && hintEl.id, err.id].filter(Boolean).join(' '));
  const setError = (msg) => { err.textContent = msg || ''; if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); return !msg; };
  return { row: h('div', { class: 'field' }, h('label', { for: id }, label), input, hintEl, err), input, setError };
}

// Password field with a Show/Hide control and (optionally) live strength guidance.
export function passwordField(label, { autocomplete, meter = false, context = () => ({}) } = {}) {
  const id = nextId('pw');
  const input = h('input', { id, type: 'password', autocomplete, required: true, minlength: String(PASSWORD.min), maxlength: String(PASSWORD.max), spellcheck: 'false', autocapitalize: 'off' });
  const toggle = h('button', { type: 'button', class: 'pw-toggle secondary', 'aria-pressed': 'false', 'aria-label': 'Show password', onclick: () => {
    const show = input.type === 'password'; input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show)); toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); toggle.textContent = show ? 'Hide' : 'Show'; input.focus();
  } }, 'Show');
  const err = h('div', { class: 'field-error', id: `${id}-err`, role: 'alert' });
  const bars = h('div', { class: 'meter', 'data-score': '0', 'aria-hidden': 'true' }, [1, 2, 3, 4].map(() => h('span')));
  const tip = h('div', { class: 'hint', id: `${id}-tip`, 'aria-live': 'polite' });
  input.setAttribute('aria-describedby', meter ? `${tip.id} ${err.id}` : err.id);
  const row = h('div', { class: 'field' }, h('label', { for: id }, label), h('div', { class: 'pw' }, input, toggle), meter ? [bars, tip] : null, err);
  const setError = (msg) => { err.textContent = msg || ''; if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); return !msg; };
  if (meter) {
    const intro = `At least ${PASSWORD.min} characters — a few random words make a strong, memorable password.`;
    tip.textContent = intro;
    input.addEventListener('input', () => {
      const s = passwordStrength(input.value), problems = passwordProblems(input.value, context());
      bars.dataset.score = String(input.value ? s.score : 0);
      tip.textContent = !input.value ? intro : problems.length ? problems[0] : `${s.label} password.`;
    });
  }
  return { row, input, toggle, setError, validate: () => setError(passwordProblems(input.value, context())[0] ?? null) };
}

const friendly = (e) => e.status === 429 ? 'Too many attempts. Please wait a minute and try again.' : e.code === 'OFFLINE' ? 'You appear to be offline. Check your connection and try again.' : e.message;

// A form with: per-field validation (on blur, then live; all on submit with focus on the first problem), a busy button,
// a form-level alert, and success handling by the caller.
function authForm({ title, sub, submitLabel, busyLabel, fields, onSubmit, footer, extra }) {
  const formErr = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'primary' }, submitLabel);
  const form = h('form', { class: 'card auth-card', novalidate: true }, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null, extra, fields.map(f => f.row), formErr, btn, footer);
  for (const f of fields) {
    let touched = false;
    f.input.addEventListener('blur', () => { touched = true; f.validate?.(); });
    f.input.addEventListener('input', () => { if (touched) f.validate?.(); });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); formErr.textContent = '';
    const bad = fields.filter(f => f.validate && !f.validate());
    if (bad.length) { bad[0].input.focus(); announce(`Please fix: ${bad.length} field${bad.length > 1 ? 's' : ''}`); return; }
    btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = busyLabel;
    try { await onSubmit(); } catch (x) { formErr.textContent = friendly(x); }
    finally { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = submitLabel; }
  });
  return { form, formErr, btn };
}

const aside = (heading, points) => h('aside', { class: 'auth-aside', 'aria-hidden': 'true' },
  h('div', {}, h('span', { class: 'logo-mark' }, '🚇'), h('h2', {}, heading), h('ul', {}, points.map(([i, t]) => h('li', {}, h('span', {}, i), h('span', {}, t))))),
  h('div', { class: 'lines' }, ['#a78bfa', '#34d399', '#fcd34d', '#f9a8d4', '#ff6b35'].map(c => h('i', { style: `background:${c}` }))));
const POINTS = [['⚖️', 'Meet where nobody travels unfairly far'], ['🚇', 'Metro groups, with the new Pink Line'], ['🏍️', 'Bike groups on real road routes'], ['🔒', 'Your exact start point is never shown to others']];
const page = (root, ...kids) => mount(root, h('div', { class: 'auth' }, aside('Plan a fair meetup, together.', POINTS), ...kids));
const emailValidator = (input, f) => () => f.setError(!input.value.trim() ? 'Enter your email address.' : EMAIL_RE.test(input.value.trim()) ? null : 'That does not look like an email address.');

// ── sign in ───────────────────────────────────────────────────────────────────────────
export function renderLogin(root, ctx) {
  const notice = sessionStorage.getItem('mm.notice'); sessionStorage.removeItem('mm.notice');
  const email = field('Email', h('input', { type: 'email', autocomplete: 'username', required: true, autocapitalize: 'off', spellcheck: 'false' }));
  const pw = passwordField('Password', { autocomplete: 'current-password' });
  email.validate = emailValidator(email.input, email);
  pw.validate = () => pw.setError(pw.input.value ? null : 'Enter your password.');
  const { form } = authForm({
    title: 'Welcome back', sub: 'Sign in to plan your next meetup.', submitLabel: 'Sign in', busyLabel: 'Signing in…', fields: [email, pw],
    extra: notice ? h('p', { class: 'banner good', role: 'status' }, notice) : null,
    onSubmit: async () => { const r = await post('/api/auth/login', { email: email.input.value.trim(), password: pw.input.value }); announce(`Signed in as ${r.user.displayName}`); await ctx.signedIn(r.user); },
    footer: h('p', { class: 'alt' }, h('a', { href: '#/forgot' }, 'Forgot your password?'), h('br'), 'New to MobiMeet? ', h('a', { href: '#/register' }, 'Create an account')),
  });
  page(root, form); email.input.focus();
}

// ── sign up ───────────────────────────────────────────────────────────────────────────
export function renderRegister(root, ctx) {
  const name = field('Your name', h('input', { type: 'text', autocomplete: 'name', maxlength: '60', required: true }), { hint: 'Shown to the people in your groups.' });
  const email = field('Email', h('input', { type: 'email', autocomplete: 'username', required: true, autocapitalize: 'off', spellcheck: 'false' }), { hint: 'Used to sign in and to reset your password.' });
  const pw = passwordField('Password', { autocomplete: 'new-password', meter: true, context: () => ({ email: email.input.value, name: name.input.value }) });
  name.validate = () => name.setError(name.input.value.trim().length >= 1 && name.input.value.trim().length <= 60 ? null : 'Enter your name (up to 60 characters).');
  email.validate = emailValidator(email.input, email);
  const { form } = authForm({
    title: 'Create your account', sub: 'Free. Takes under a minute.', submitLabel: 'Create account', busyLabel: 'Creating your account…', fields: [name, email, pw],
    onSubmit: async () => { const r = await post('/api/auth/register', { displayName: name.input.value.trim(), email: email.input.value.trim(), password: pw.input.value }); announce(`Welcome, ${r.user.displayName}!`); await ctx.signedIn(r.user, { welcome: true }); },
    footer: h('p', { class: 'alt' }, 'Already registered? ', h('a', { href: '#/login' }, 'Sign in')),
  });
  page(root, form); name.input.focus();
}

// ── forgot password ───────────────────────────────────────────────────────────────────
export async function renderForgot(root) {
  let caps = { passwordReset: false, mailMode: 'disabled' };
  try { caps = await get('/api/auth/capabilities'); } catch { /* treated as unavailable */ }
  if (!caps.passwordReset) {
    page(root, h('div', { class: 'card auth-card' }, h('h1', {}, 'Reset your password'),
      h('p', { class: 'banner warn', role: 'status' }, 'Password reset by email is not switched on for this server yet, so no reset email can be sent.'),
      h('p', {}, 'If you run this server, connect an email service (see the setup guide). Otherwise please ask whoever manages it to help you regain access.'),
      h('p', { class: 'alt' }, h('a', { href: '#/login' }, '← Back to sign in')))); return;
  }
  const email = field('Email', h('input', { type: 'email', autocomplete: 'username', required: true, autocapitalize: 'off', spellcheck: 'false' }));
  email.validate = emailValidator(email.input, email);
  const outcome = h('div', { 'aria-live': 'polite' });
  const { form } = authForm({
    title: 'Reset your password', sub: 'Enter the email you signed up with and we will send you a link.', submitLabel: 'Send reset link', busyLabel: 'Sending…', fields: [email],
    onSubmit: async () => {
      await post('/api/auth/forgot', { email: email.input.value.trim() });
      outcome.replaceChildren(h('p', { class: 'banner good' }, 'If that address is registered, a reset link is on its way. It works for 30 minutes and only once.'));
      if (caps.mailMode === 'outbox') {                                    // development only: no email is really sent
        try {
          const { messages } = await get('/api/dev/outbox'); const last = messages.filter(m => m.to.toLowerCase() === email.input.value.trim().toLowerCase()).at(-1);
          const link = last && /(https?:\/\/\S+#\/reset\/[\w-]+)/.exec(last.text)?.[1];
          if (link) outcome.append(h('p', { class: 'banner warn' }, 'Development mode — no email is sent. ', h('a', { href: `#/reset/${link.split('#/reset/')[1]}` }, 'Open the reset link')));
        } catch { /* outbox not available */ }
      }
    },
    footer: h('p', { class: 'alt' }, h('a', { href: '#/login' }, '← Back to sign in')),
  });
  form.insertBefore(outcome, form.querySelector('button[type=submit]'));
  page(root, form); email.input.focus();
}

// ── choose a new password ─────────────────────────────────────────────────────────────
export function renderReset(root, ctx, token) {
  const pw = passwordField('New password', { autocomplete: 'new-password', meter: true });
  const { form } = authForm({
    title: 'Choose a new password', sub: 'You will be signed out everywhere else.', submitLabel: 'Update password', busyLabel: 'Updating…', fields: [pw],
    onSubmit: async () => { await post('/api/auth/reset', { token, password: pw.input.value }); sessionStorage.setItem('mm.notice', 'Your password was updated. Sign in with the new one.'); ctx.navigate('/login'); },
    footer: h('p', { class: 'alt' }, h('a', { href: '#/forgot' }, 'Link expired? Request a new one')),
  });
  page(root, form); pw.input.focus();
}
