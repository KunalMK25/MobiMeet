// Composition root: wires db → services → routes → handler. Used by the Vercel function, the dev server and tests.
import { createAuthService } from '../services/auth.js';
import { createMailer } from '../services/mailer.js';
import { isProductionLike } from '../bike/routingFactory.js';
import { createGroupService } from '../services/groups.js';
import { createPlanService } from '../services/plans.js';
import { createAgentService } from '../services/agents.js';
import { createVenueService, createOverpassProvider } from '../venues/venueService.js';
import { createRoutingProvider } from '../bike/routingFactory.js';
import { buildRoutes } from './routes.js';
import { createHandler } from './http.js';
import { migrate } from '../db/migrate.js';
import { createGeocoder } from '../geo/geocoder.js';
import { createRetentionService } from '../services/retention.js';
import { consume } from '../services/rateLimit.js';

export async function createApp({ db, config, providers = {}, chat = null, clock = Date.now, log = () => {}, venues, geocoder = createGeocoder() } = {}) {
  if (config.autoMigrate) await migrate(db);
  const mailer = createMailer({ mode: config.mail.mode, productionLike: isProductionLike(config.appBaseUrl), log, resend: { apiKey: config.mail.resendApiKey, from: config.mail.from } });
  const auth = createAuthService({ db, clock, mailer, resetUrl: (t) => `${config.appBaseUrl}/app/#/reset/${t}` });
  const groups = createGroupService({ db, clock });
  const chosen = providers.roadRouting ? { provider: providers.roadRouting, status: 'configured' } : createRoutingProvider(config.routing, { appBaseUrl: config.appBaseUrl });
  const routing = chosen.provider;
  const venueSvc = venues ?? createVenueService({ live: createOverpassProvider({ endpoint: config.overpassUrl }), defaultRadiusKm: config.venues.radiusKm });
  const plans = createPlanService({ db, clock, groups, providers: { roadRouting: routing }, venues: venueSvc, geocoder });
  const chatSvc = typeof chat === 'function' ? chat({ db, groups, plans, config }) : chat;
  const retention = createRetentionService({ db, clock });
  const agents = createAgentService({ db, groups, clock, llm: chatSvc?.llm ?? null, budget: config.llm.budget });
  const handle = createHandler({ routes: buildRoutes({ auth, groups, plans, agents, chat: chatSvc, geocoder, retention, config, routingStatus: chosen.status, mailer, limit: (id, name, n, sec) => consume(db, { key: `${name}:${id}`, limit: n, windowSec: sec, now: clock() }) }), auth, config, log });
  return { handle, routingStatus: chosen.status, mailer, services: { auth, groups, plans, agents, venues: venueSvc, retention }, db };
}
