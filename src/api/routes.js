// Route table — thin: parse input, call a service, return JSON. All authorisation lives in the services.
import { ST } from '../data/stations.js';
import { stationIdFor } from '../data/station-ids.js';
import { sessionCookie, clearCookie } from './http.js';
import { SESSION_TTL_MS } from '../services/auth.js';
import { DomainError, ErrorCode } from '../domain/errors.js';
import { constantTimeEqual } from '../services/crypto.js';

const obj = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});
// A radius the client sent must be a number in the allowed range — reject nonsense instead of silently ignoring it.
const radiusParam = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0.5 || n > 5) throw new DomainError(ErrorCode.INVALID_INPUT, 'radiusKm must be a number from 0.5 to 5.'); return n; };
const list = (s) => (typeof s === 'string' && s ? s.split(',').map(x => x.trim()).filter(Boolean) : undefined);

export function buildRoutes({ auth, groups, plans, agents, chat, geocoder, limit, retention, config, routingStatus = 'configured', mailer = null }) {
  const R = (method, path, handler, opts = {}) => ({ method, path, handler, ...opts });
  const login = (ctx, r) => { ctx.setCookie = sessionCookie(r.sessionToken, { ...ctx.cookieOpts, maxAgeSec: SESSION_TTL_MS / 1000 }); return { user: r.user }; };
  return [
    // routing: 'demo' (public OSRM, dev only) | 'configured' | 'disabled' (production without a provider)
    R('GET', '/api/health', () => ({ ok: true, routing: routingStatus }), { auth: false }),
    R('GET', '/api/stations', () => ({ stations: Object.entries(ST).filter(([, s]) => s.op).map(([name, s]) => ({ id: stationIdFor(name), name, line: s.li, lat: s.la, lon: s.lo })) }), { auth: false }),

    R('POST', '/api/auth/register', async (c) => login(c, await auth.register(obj(c.body), { ip: c.ip })), { auth: false }),
    R('POST', '/api/auth/login', async (c) => login(c, await auth.login(obj(c.body), { ip: c.ip })), { auth: false }),
    R('GET', '/api/auth/capabilities', () => auth.capabilities(), { auth: false }),
    R('POST', '/api/auth/forgot', (c) => auth.requestPasswordReset(obj(c.body), { ip: c.ip }), { auth: false }),
    R('POST', '/api/auth/reset', (c) => auth.resetPassword(obj(c.body), { ip: c.ip }), { auth: false }),
    R('POST', '/api/auth/logout-all', async (c) => { const r = await auth.logoutEverywhere(c.user.id); c.setCookie = clearCookie(c.cookieOpts); return r; }),
    R('POST', '/api/me/password', (c) => auth.changePassword(c.user.id, obj(c.body), { sessionToken: c.token })),
    // Development only: read the emails the local "outbox" kept (registered ONLY when mail mode is 'outbox', which production-like hosts refuse).
    ...(mailer?.mode === 'outbox' ? [R('GET', '/api/dev/outbox', () => ({ messages: mailer.outbox() }), { auth: false })] : []),
    R('POST', '/api/auth/logout', async (c) => { await auth.logout(c.token); c.setCookie = clearCookie(c.cookieOpts); return { ok: true }; }, { auth: false }),
    ...(geocoder ? [R('GET', '/api/geocode', async (c) => { await limit(c.user.id, 'geocode', 30, 600); return geocoder.search(c.query.q); })] : []),
    // Startup probe for the web app: always 200, {user:null} when signed out (no console-noisy 401s).
    R('GET', '/api/session', async (c) => ({ user: await auth.authenticate(c.token) }), { auth: false }),
    R('GET', '/api/me', async (c) => ({ profile: await auth.getProfile(c.user.id) })),
    R('PATCH', '/api/me', async (c) => auth.updateProfile(c.user.id, obj(c.body))),
    R('DELETE', '/api/me', async (c) => { const r = await retention.deleteAccount(c.user, obj(c.body).password); c.setCookie = clearCookie(c.cookieOpts); return r; }),
    R('DELETE', '/api/groups/:id', (c) => retention.purgeGroup(c.user, c.params.id)),
    // Scheduled maintenance (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). Disabled unless CRON_SECRET is set.
    R('GET', '/api/maintenance', async (c) => {
      const secret = config.cronSecret; const given = (c.headers.authorization ?? '').replace(/^Bearer /i, '');
      if (!secret || !constantTimeEqual(given, secret)) throw new DomainError(ErrorCode.NOT_FOUND, 'Not found.');
      return retention.runMaintenance();
    }, { auth: false }),

    R('GET', '/api/groups', async (c) => ({ groups: await groups.listGroups(c.user) })),
    R('POST', '/api/groups', async (c) => ({ status: 201, body: { group: await groups.createGroup(c.user, obj(c.body)) } })),
    R('GET', '/api/groups/:id', async (c) => ({ group: await groups.getGroup(c.user, c.params.id) })),
    R('PATCH', '/api/groups/:id', async (c) => ({ group: await groups.updateGroup(c.user, c.params.id, obj(c.body)) })),
    R('POST', '/api/groups/:id/cancel', (c) => groups.cancelGroup(c.user, c.params.id)),
    R('PUT', '/api/groups/:id/me', async (c) => ({ group: await groups.updateMyInput(c.user, c.params.id, obj(c.body)) })),
    R('POST', '/api/groups/:id/leave', (c) => groups.leaveGroup(c.user, c.params.id)),
    R('DELETE', '/api/groups/:id/members/:userId', (c) => groups.removeMember(c.user, c.params.id, c.params.userId)),

    R('POST', '/api/groups/:id/invitations', async (c) => ({ status: 201, body: await groups.createInvitation(c.user, c.params.id, obj(c.body)) })),
    R('GET', '/api/groups/:id/invitations', async (c) => ({ invitations: await groups.listInvitations(c.user, c.params.id) })),
    R('DELETE', '/api/groups/:id/invitations/:invId', (c) => groups.revokeInvitation(c.user, c.params.id, c.params.invId)),
    // Tokens travel in the POST body (never the URL) so they stay out of access logs and referrers.
    R('POST', '/api/invitations/preview', async (c) => ({ invitation: await groups.previewInvitation(obj(c.body).token, { ip: c.ip }) }), { auth: false }),
    R('POST', '/api/invitations/join', async (c) => { const b = obj(c.body); return { group: await groups.joinWithToken(c.user, b.token, b, { ip: c.ip }) }; }),

    // Personal agent (private to the caller) and the shared coordination layer (events every member's agent reads).
    R('GET', '/api/groups/:id/agent', async (c) => agents.getAgent(c.user, c.params.id)),
    R('GET', '/api/groups/:id/agent/messages', async (c) => ({ messages: await agents.listMessages(c.user, c.params.id) })),
    R('POST', '/api/groups/:id/agent/messages', async (c) => agents.sendMessage(c.user, c.params.id, obj(c.body).text)),
    R('PUT', '/api/groups/:id/agent/sharing', async (c) => agents.setSharing(c.user, c.params.id, obj(c.body))),
    R('GET', '/api/groups/:id/events', async (c) => agents.pullEvents(c.user, c.params.id, { since: c.query.since })),
    R('POST', '/api/groups/:id/events/ack', async (c) => agents.ack(c.user, c.params.id, obj(c.body).seq)),
    R('GET', '/api/groups/:id/dashboard', async (c) => agents.dashboard(c.user, c.params.id)),

    R('POST', '/api/groups/:id/optimize', async (c) => ({ plan: await plans.requestOptimization(c.user, c.params.id, obj(c.body)) })),
    R('GET', '/api/groups/:id/plans', async (c) => ({ plans: await plans.listPlans(c.user, c.params.id) })),
    R('GET', '/api/groups/:id/plans/:planId', async (c) => ({ plan: await plans.getPlan(c.user, c.params.id, c.params.planId === 'current' ? undefined : c.params.planId) })),
    R('POST', '/api/groups/:id/plans/:planId/confirm', async (c) => ({ plan: await plans.confirmPlan(c.user, c.params.id, c.params.planId) })),
    R('GET', '/api/groups/:id/plans/:planId/venues', async (c) => ({ venues: await plans.getPlanVenues(c.user, c.params.id, c.params.planId === 'current' ? undefined : c.params.planId,
      { refresh: c.query.refresh === '1', categories: list(c.query.categories) ?? ['all'], radiusKm: c.query.radiusKm !== undefined && c.query.radiusKm !== '' ? radiusParam(c.query.radiusKm) : undefined }) })),

    R('POST', '/api/groups/:id/whatif', async (c) => ({ status: 201, body: await plans.runScenario(c.user, c.params.id, obj(c.body)) })),
    R('GET', '/api/groups/:id/whatif', async (c) => ({ scenarios: await plans.listScenarios(c.user, c.params.id) })),
    R('POST', '/api/groups/:id/whatif/compare', async (c) => plans.compareScenarios(c.user, c.params.id, obj(c.body).ids)),

    ...(chat ? [
      R('POST', '/api/chat', async (c) => chat.ask(c.user, obj(c.body))),
      R('POST', '/api/groups/:id/me/parse-notes', async (c) => chat.parseNotes(c.user, { groupId: c.params.id, text: obj(c.body).text })),
      R('POST', '/api/groups/:id/plans/:planId/phrase', async (c) => chat.phrase(c.user, { groupId: c.params.id, planId: c.params.planId === 'current' ? undefined : c.params.planId })),
    ] : []),
  ];
}
export { DomainError, ErrorCode };
