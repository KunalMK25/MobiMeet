// Shared test environment: PGlite DB + real services + a synthetic routing provider (test-only).
import { createTestDb as createPgliteDb } from './testdb.js';
import { migrate } from '../src/db/migrate.js';
import { createAuthService } from '../src/services/auth.js';
import { createGroupService } from '../src/services/groups.js';
import { createPlanService } from '../src/services/plans.js';
import { createVenueService, createOverpassProvider } from '../src/venues/venueService.js';
import { haversineKm } from '../src/utils/geometry.js';
import { stationIdFor } from '../src/data/station-ids.js';
import { DomainError } from '../src/domain/errors.js';
import assert from 'node:assert/strict';

// A fake Overpass endpoint: answers with ONE named café placed 300 m from whatever point is being searched (parsed from the query),
// so tests do not depend on where the recommended meetup happens to be.
export const liveVenuesFetch = (name = 'Test Cafe') => async (url) => {
  const m = /around:(\d+),(-?[\d.]+),(-?[\d.]+)/.exec(decodeURIComponent(url));
  const lat = m ? Number(m[2]) + 0.0027 : 12.97, lon = m ? Number(m[3]) : 77.59;
  return { ok: true, status: 200, json: async () => ({ elements: [{ type: 'node', id: 7, lat, lon, tags: { name, amenity: 'cafe' } }] }) };
};

export const fakeRouting = (opts = {}) => ({
  name: 'fake', calls: { matrix: 0, route: 0 },
  async matrix(srcs, dsts) {
    this.calls.matrix++;
    if (opts.failMatrix) throw new Error('down');
    const d = srcs.map(s => dsts.map(t => Math.round(haversineKm(s.lat, s.lon, t.lat, t.lon) * 1.3 * 100) / 100));
    return { distanceKm: d, durationsMin: d.map(r => r.map(x => Math.round(x / 30 * 600) / 10)), provider: 'fake', profile: 'driving', fetchedAt: 1, cached: false };
  },
  async route(a, b) { this.calls.route++; return { geometry: [[a.lat, a.lon], [b.lat, b.lon]] }; },
});

export async function makeEnv({ routing = fakeRouting(), venueFetch } = {}) {
  const db = await createPgliteDb(); await migrate(db);
  let now = Date.parse('2026-11-13T10:00:00Z'); const clock = () => now;
  const auth = createAuthService({ db, clock });
  const groups = createGroupService({ db, clock });
  const venues = createVenueService({ live: createOverpassProvider({ fetchImpl: venueFetch ?? liveVenuesFetch(), now: clock }), now: clock });
  const plans = createPlanService({ db, clock, groups, providers: routing ? { roadRouting: routing } : {}, venues });
  let seq = 0;
  const user = async (name = 'U') => (await auth.register({ email: `${name.toLowerCase()}${++seq}@example.test`, password: 'correct horse battery', displayName: name }, { ip: `t${seq}` })).user;
  const code = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof DomainError, String(e.stack)); return e.code; } assert.fail('expected rejection'); };
  const metro = (name) => ({ stationId: stationIdFor(name) });
  // owner + N members, each with an origin; returns {owner, members:[...], group}
  async function team({ mode = 'METRO', origins }) {
    const owner = await user('Owner');
    let g = await groups.createGroup(owner, { name: 'Team', mode, origin: origins[0] });
    const members = [];
    for (let i = 1; i < origins.length; i++) {
      const u = await user('Member' + i);
      const inv = await groups.createInvitation(owner, g.id);
      await groups.joinWithToken(u, inv.token, { origin: origins[i] }, { ip: `j${++seq}` });
      members.push(u);
    }
    return { owner, members, group: await groups.getGroup(owner, g.id) };
  }
  return { db, auth, groups, plans, venues, user, code, metro, team, routing, advance: (ms) => { now += ms; }, clock, close: () => db.close() };
}
