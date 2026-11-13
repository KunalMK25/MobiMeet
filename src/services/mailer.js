// ═══════════════════════════════════════════════════════════
//  services/mailer.js — outgoing email, behind a tiny interface:   mailer.send({to, subject, text}) → Promise
//  Modes (MAIL_MODE):
//    outbox   — DEVELOPMENT ONLY. Nothing is sent; messages are kept in memory (and logged) so the password-reset flow
//               can be tried locally. Refused in production-like deployments.
//    disabled — no email is sent, and the app SAYS SO (password reset is reported as unavailable). Production default.
//    resend   — real delivery through Resend's HTTPS API (RESEND_API_KEY + MAIL_FROM on a domain verified in Resend).
//               Active ONLY when both are set; otherwise the mailer is 'disabled'. send() resolves only after the provider
//               answered 2xx and throws otherwise — a message is never reported as sent when it was not accepted.
//  Unknown modes are treated as disabled. The API key is sent only to api.resend.com and never appears in errors or logs.
// ═══════════════════════════════════════════════════════════
export const RESEND_URL = 'https://api.resend.com/emails';
export function createMailer({ mode = 'disabled', productionLike = false, log = () => {}, resend = {}, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const resendReady = mode === 'resend' && !!resend.apiKey && /^[^\s<>]+@[^\s<>]+\.[^\s<>]+$|^[^<>]+<[^\s<>]+@[^\s<>]+\.[^\s<>]+>$/.test(resend.from ?? '');
  const effective = mode === 'outbox' && !productionLike ? 'outbox' : resendReady ? 'resend' : 'disabled';
  const messages = [];
  return {
    mode: effective,
    requestedMode: mode,
    enabled: effective !== 'disabled',
    async send({ to, subject, text }) {
      if (effective === 'resend') {
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let res;
        try { res = await fetchImpl(RESEND_URL, { method: 'POST', headers: { Authorization: `Bearer ${resend.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: resend.from, to: [to], subject, text }), signal: ctl.signal }); }
        catch { throw new Error('Email provider unreachable.'); }
        finally { clearTimeout(timer); }
        if (!res.ok) { log({ level: 'warn', event: 'mail.rejected', status: res.status }); throw new Error(`Email provider refused the message (status ${res.status}).`); }
        log({ level: 'info', event: 'mail.sent', provider: 'resend' });
        return;
      }
      if (effective !== 'outbox') throw new Error('Email delivery is not configured.');
      messages.push({ to, subject, text, at: Date.now() });
      if (messages.length > 50) messages.shift();
      log({ level: 'info', event: 'mail.outbox', to: String(to).replace(/^(.).*(@.*)$/, '$1***$2'), subject });
    },
    // development inspection only (the API exposes it ONLY in outbox mode on a non-production host)
    outbox: () => messages.map(m => ({ ...m })),
  };
}
