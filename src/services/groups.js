// ═══════════════════════════════════════════════════════════
//  services/groups.js — groups, memberships, invitations (authz-first)
//  Every group-scoped read/write loads the caller's membership; a missing group and
//  a group the caller does not belong to are indistinguishable (NOT_FOUND) so IDs
//  cannot be probed (IDOR / enumeration). Owner-only actions return FORBIDDEN only
//  to members who are not the owner.
// ═══════════════════════════════════════════════════════════
import { DomainError, ErrorCode, fail } from '../domain/errors.js';
import { GroupStatus, assertTransition, canTransition, validateNewGroup, assertModeUnchanged, assertCanJoin } from '../domain/group.js';
import { assertInvitationUsable, generateInviteToken, hashInviteToken, DEFAULT_INVITE_TTL_MS } from '../domain/invitation.js';
import { validateText, optionalText, validateOriginInput, validatePrefs, validateHard, requireUuid, isUuid } from './validation.js';
import { buildParticipantAgent } from '../agents/participantAgent.js';
import { inputHash } from '../agents/coordinator.js';
import { consume } from './rateLimit.js';
import { audit } from './audit.js';
import { validateSeatNames, createSeats, groupUsesNamedSeats, claimNamedSeat, openSeat, freeSeat, roster, seatOfUser } from './participants.js';
import { emit } from './events.js';
import { react } from './coordination.js';
import { EventType } from '../domain/agentIntents.js';

const gRow = (r) => ({ id: r.id, ownerId: r.owner_id, name: r.name, description: r.description, mode: r.mode, status: r.status, objective: r.objective, selectedPlanId: r.selected_plan_id, createdAt: r.created_at, updatedAt: r.updated_at });
export const mRow = (r) => ({
  id: r.id, groupId: r.group_id, userId: r.user_id, transportMode: r.transport_mode, role: r.role, joinStatus: r.join_status,
  originLat: r.origin_lat, originLon: r.origin_lon, originStationId: r.origin_station_id, originLabel: r.origin_label,
  softPrefs: r.soft_prefs ?? {}, hardConstraints: r.hard_constraints ?? {}, agentVersion: r.agent_version, displayName: r.display_name,
});
const MEMBER_SQL = `SELECT m.*, u.display_name FROM group_memberships m JOIN users u ON u.id = m.user_id`;

export const INVITE_LIMITS = Object.freeze({ minTtlHours: 1, maxTtlHours: 168, maxUsesCap: 50 });

export function createGroupService({ db, clock = Date.now }) {

  async function loadForMember(t, userId, groupIdRaw, { lock = false } = {}) {
    const groupId = requireUuid(groupIdRaw, 'Group');
    const g = (await t.query(`SELECT * FROM groups WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [groupId])).rows[0];
    const me = g && (await t.query(`${MEMBER_SQL} WHERE m.group_id = $1 AND m.user_id = $2 AND m.join_status = 'joined'`, [groupId, userId])).rows[0];
    if (!g || !me) fail(ErrorCode.NOT_FOUND, 'Group not found.');
    return { group: gRow(g), me: mRow(me) };
  }
  const assertOwner = (me) => { if (me.role !== 'owner') fail(ErrorCode.FORBIDDEN, 'Only the group owner can do this.'); };
  const loadMembers = async (t, groupId) => (await t.query(`${MEMBER_SQL} WHERE m.group_id = $1 ORDER BY m.created_at, m.user_id`, [groupId])).rows.map(mRow);

  // Per-viewer projection: other members' coordinates / labels / preferences are never returned.
  function view(group, members, viewerId) {
    return {
      ...group,
      members: members.filter(m => m.joinStatus === 'joined').map(m => ({
        userId: m.userId, displayName: m.displayName, role: m.role, isMe: m.userId === viewerId, hasOrigin: m.originLat != null,
        ...(m.userId === viewerId ? { origin: m.originLat == null ? null : { lat: m.originLat, lon: m.originLon, stationId: m.originStationId ?? undefined, label: m.originLabel }, softPrefs: m.softPrefs, hardConstraints: m.hardConstraints } : {}),
      })),
    };
  }

  async function writeMemberInput(t, group, me, { origin, softPrefs, hard }) {
    const next = { ...me };
    if (origin !== undefined) {
      const o = validateOriginInput(origin, { mode: group.mode });
      Object.assign(next, { originLat: o.lat, originLon: o.lon, originStationId: o.stationId ?? null, originLabel: o.label ?? null });
    }
    if (softPrefs !== undefined) next.softPrefs = validatePrefs(softPrefs);
    if (hard !== undefined) next.hardConstraints = validateHard(hard);
    let snapshot = null, version = me.agentVersion;
    if (next.originLat != null) {
      snapshot = buildParticipantAgent(next, { now: clock() }); version = me.agentVersion + 1;
      snapshot.version = version;
    }
    await t.query(
      `UPDATE group_memberships SET origin_lat=$3, origin_lon=$4, origin_station_id=$5, origin_label=$6, soft_prefs=$7, hard_constraints=$8,
         agent_snapshot=$9, agent_version=$10, updated_at=now() WHERE group_id=$1 AND user_id=$2`,
      [group.id, me.userId, next.originLat, next.originLon, next.originStationId, next.originLabel, JSON.stringify(next.softPrefs), JSON.stringify(next.hardConstraints), snapshot && JSON.stringify(snapshot), version]);
    return { ...next, agentVersion: version };
  }

  // Stale = current joined inputs differ from what the selected plan was computed from.
  async function planStaleness(t, group, members) {
    if (!group.selectedPlanId) return { hasPlan: false, stale: false };
    const p = (await t.query('SELECT input_hash, strategy, result FROM meetup_plans WHERE id = $1', [group.selectedPlanId])).rows[0];
    if (!p) return { hasPlan: false, stale: false };
    try {
      const parts = members.filter(m => m.joinStatus === 'joined' && m.originLat != null).map(m => buildParticipantAgent(m, { now: 0 }));
      const h = inputHash({ mode: group.mode, strategy: p.strategy, participants: parts, fuel: group.mode === 'BIKE' ? p.result?.fuelAssumptions ?? null : null, routeStrategy: p.result?.routeStrategy ?? 'fastest' });
      return { hasPlan: true, stale: h !== p.input_hash };
    } catch { return { hasPlan: true, stale: true }; }
  }

  return {
    loadForMember, loadMembers, mRow, view,

    async createGroup(user, input = {}) {
      const base = validateNewGroup({ name: input.name, mode: input.mode });
      const description = optionalText(input.description, 500, 'Description');
      return db.tx(async (t) => {
        const ownerName = (await t.query('SELECT display_name FROM users WHERE id=$1', [user.id])).rows[0].display_name;
        const seatNames = validateSeatNames(input.participantNames, { ownerName });
        const g = gRow((await t.query(`INSERT INTO groups (owner_id, name, description, mode, status) VALUES ($1,$2,$3,$4,'draft') RETURNING *`, [user.id, base.name, description, base.mode])).rows[0]);
        await t.query(`INSERT INTO group_memberships (group_id, transport_mode, user_id, role) VALUES ($1,$2,$3,'owner')`, [g.id, g.mode, user.id]);
        await createSeats(t, { groupId: g.id, ownerId: user.id, ownerName, names: seatNames });
        const me = mRow((await t.query(`${MEMBER_SQL} WHERE m.group_id=$1 AND m.user_id=$2`, [g.id, user.id])).rows[0]);
        let group = g;
        if (input.origin !== undefined) {
          await writeMemberInput(t, g, me, { origin: input.origin, softPrefs: input.softPrefs, hard: input.hard });
          assertTransition('draft', 'open');
          group = gRow((await t.query(`UPDATE groups SET status='open', updated_at=now() WHERE id=$1 RETURNING *`, [g.id])).rows[0]);
        }
        await audit(t, { actorId: user.id, groupId: g.id, type: 'group.created', detail: { mode: g.mode } });
        return { ...view(group, await loadMembers(t, g.id), user.id), participants: await roster(t, g.id, user.id, { asOwner: true }) };
      });
    },

    async listGroups(user) {
      const r = await db.query(`SELECT g.id, g.name, g.mode, g.status, g.updated_at, m.role,
        (SELECT count(*)::int FROM group_memberships x WHERE x.group_id = g.id AND x.join_status='joined') AS member_count
        FROM groups g JOIN group_memberships m ON m.group_id = g.id AND m.user_id = $1 AND m.join_status = 'joined' ORDER BY g.updated_at DESC`, [user.id]);
      return r.rows.map(x => ({ id: x.id, name: x.name, mode: x.mode, status: x.status, role: x.role, memberCount: x.member_count, updatedAt: x.updated_at }));
    },

    async getGroup(user, groupId) {
      return db.tx(async (t) => {
        const { group, me } = await loadForMember(t, user.id, groupId);
        const members = await loadMembers(t, group.id);
        const stale = await planStaleness(t, group, members);
        return { ...view(group, members, user.id), role: me.role, plan: stale, participants: await roster(t, group.id, user.id, { asOwner: me.role === 'owner' }) };
      });
    },

    async updateGroup(user, groupId, patch = {}) {
      return db.tx(async (t) => {
        const { group, me } = await loadForMember(t, user.id, groupId, { lock: true });
        assertOwner(me);
        assertModeUnchanged(group, patch.mode);               // mode is locked after creation
        if ([GroupStatus.CANCELLED, GroupStatus.EXPIRED].includes(group.status)) fail(ErrorCode.GROUP_CLOSED, 'This group is closed.');
        const name = patch.name === undefined ? group.name : validateText(patch.name, { max: 80, what: 'Group name' });
        const description = patch.description === undefined ? group.description : optionalText(patch.description, 500, 'Description');
        const g = gRow((await t.query('UPDATE groups SET name=$2, description=$3, updated_at=now() WHERE id=$1 RETURNING *', [group.id, name, description])).rows[0]);
        return view(g, await loadMembers(t, g.id), user.id);
      });
    },

    async updateMyInput(user, groupId, patch = {}) {
      return db.tx(async (t) => {
        const { group, me } = await loadForMember(t, user.id, groupId, { lock: true });
        if ([GroupStatus.CANCELLED, GroupStatus.EXPIRED].includes(group.status)) fail(ErrorCode.GROUP_CLOSED, 'This group is closed.');
        if (patch.mode !== undefined && patch.mode !== group.mode) fail(ErrorCode.MODE_MISMATCH, 'Participant transport mode must match the group transport mode.');
        await writeMemberInput(t, group, me, { origin: patch.origin, softPrefs: patch.softPrefs, hard: patch.hard });
        let status = group.status;
        if (status === GroupStatus.DRAFT && me.role === 'owner' && (patch.origin !== undefined)) status = GroupStatus.OPEN;
        else if (status === GroupStatus.PROPOSED && canTransition(status, GroupStatus.OPEN)) status = GroupStatus.OPEN; // inputs changed: proposal is no longer current
        if (status !== group.status) await t.query('UPDATE groups SET status=$2, updated_at=now() WHERE id=$1', [group.id, status]);
        await audit(t, { actorId: user.id, groupId: group.id, type: 'member.input_updated' });
        const g = { ...group, status };
        if (patch.origin !== undefined) {
          const seat = await seatOfUser(t, group.id, user.id);
          // Publishes ONLY that the starting point changed (never the coordinates) and only if this participant shares location changes.
          if (seat && seat.share.location) { await emit(t, { groupId: group.id, participantId: seat.id, type: EventType.LOCATION }); await react(t, { groupId: group.id, seatId: seat.id, type: EventType.LOCATION }); }
        }
        const members = await loadMembers(t, group.id);
        return { ...view(g, members, user.id), plan: await planStaleness(t, g, members) };
      });
    },

    async leaveGroup(user, groupId) {
      return db.tx(async (t) => {
        const { group, me } = await loadForMember(t, user.id, groupId, { lock: true });
        if (me.role === 'owner') fail(ErrorCode.FORBIDDEN, 'The owner cannot leave; cancel the group instead.');
        await t.query(`UPDATE group_memberships SET join_status='left', updated_at=now() WHERE group_id=$1 AND user_id=$2`, [group.id, user.id]);
        const seat = await freeSeat(t, { groupId: group.id, userId: user.id, status: 'withdrawn' });
        if (seat) { await emit(t, { groupId: group.id, participantId: seat.id, type: EventType.WITHDREW }); await react(t, { groupId: group.id, seatId: seat.id, type: EventType.WITHDREW }); }
        await audit(t, { actorId: user.id, groupId: group.id, type: 'member.left' });
        return { ok: true };
      });
    },

    async removeMember(user, groupId, targetUserId) {
      return db.tx(async (t) => {
        const { group, me } = await loadForMember(t, user.id, groupId, { lock: true });
        assertOwner(me);
        const target = requireUuid(targetUserId, 'Member');
        if (target === user.id) fail(ErrorCode.INVALID_INPUT, 'The owner cannot be removed.');
        const r = await t.query(`UPDATE group_memberships SET join_status='removed', updated_at=now() WHERE group_id=$1 AND user_id=$2 AND join_status='joined' RETURNING id`, [group.id, target]);
        if (!r.rows.length) fail(ErrorCode.NOT_FOUND, 'Member not found.');
        const seat = await freeSeat(t, { groupId: group.id, userId: target, status: 'invited' });   // the name becomes claimable again
        if (seat) { await emit(t, { groupId: group.id, participantId: seat.id, type: EventType.RELEASED }); await react(t, { groupId: group.id, seatId: seat.id, type: EventType.WITHDREW }); }
        await audit(t, { actorId: user.id, groupId: group.id, type: 'member.removed' });
        return { ok: true };
      });
    },

    async cancelGroup(user, groupId) {
      return db.tx(async (t) => {
        const { group, me } = await loadForMember(t, user.id, groupId, { lock: true });
        assertOwner(me);
        assertTransition(group.status, GroupStatus.CANCELLED);
        await t.query(`UPDATE groups SET status='cancelled', updated_at=now() WHERE id=$1`, [group.id]);
        await t.query('UPDATE group_invitations SET revoked_at = now() WHERE group_id=$1 AND revoked_at IS NULL', [group.id]);
        await emit(t, { groupId: group.id, type: EventType.GROUP_CANCELLED });
        await audit(t, { actorId: user.id, groupId: group.id, type: 'group.cancelled' });
        return { ok: true };
      });
    },

    // ── invitations ────────────────────────────────────────
    async createInvitation(user, groupId, { ttlHours, maxUses } = {}) {
      await consume(db, { key: `invite:${user.id}`, limit: 30, windowSec: 3600, now: clock() });
      const ttl = ttlHours === undefined ? DEFAULT_INVITE_TTL_MS : Math.round(Number(ttlHours) * 3600 * 1000);
      if (!Number.isFinite(ttl) || ttl < INVITE_LIMITS.minTtlHours * 3600e3 || ttl > INVITE_LIMITS.maxTtlHours * 3600e3) fail(ErrorCode.INVALID_INPUT, 'Invitation lifetime must be 1-168 hours.');
      const uses = maxUses === undefined ? 'auto' : maxUses;
      if (uses !== 'auto' && (!Number.isInteger(uses) || uses < 1 || uses > INVITE_LIMITS.maxUsesCap)) fail(ErrorCode.INVALID_INPUT, 'maxUses must be an integer from 1 to 50.');
      return db.tx(async (t) => {
        const { group, me } = await loadForMember(t, user.id, groupId, { lock: true });
        assertOwner(me);
        if (group.status !== GroupStatus.OPEN) fail(ErrorCode.NOT_READY, group.status === GroupStatus.DRAFT ? 'Set your own starting location first.' : 'This group is not accepting participants.');
        const open = (await t.query('SELECT count(*)::int n FROM group_participants WHERE group_id=$1 AND pre_named AND user_id IS NULL', [group.id])).rows[0].n;
        const maxUsesFinal = uses === 'auto' ? Math.min(Math.max(5, open), INVITE_LIMITS.maxUsesCap) : uses;
        const token = generateInviteToken();
        const r = (await t.query(`INSERT INTO group_invitations (group_id, created_by, token_hash, expires_at, max_uses) VALUES ($1,$2,$3,$4,$5) RETURNING id, expires_at`,
          [group.id, user.id, await hashInviteToken(token), new Date(clock() + ttl), maxUsesFinal])).rows[0];
        await audit(t, { actorId: user.id, groupId: group.id, type: 'invitation.created' });
        return { invitationId: r.id, token, expiresAt: r.expires_at, maxUses: maxUsesFinal };   // raw token returned exactly once
      });
    },

    async listInvitations(user, groupId) {
      return db.tx(async (t) => {
        const { group, me } = await loadForMember(t, user.id, groupId);
        assertOwner(me);
        const r = await t.query('SELECT id, expires_at, revoked_at, max_uses, uses, created_at FROM group_invitations WHERE group_id=$1 ORDER BY created_at DESC', [group.id]);
        return r.rows.map(x => ({ id: x.id, expiresAt: x.expires_at, revokedAt: x.revoked_at, maxUses: x.max_uses, uses: x.uses,
          status: x.revoked_at ? 'revoked' : new Date(x.expires_at).getTime() <= clock() ? 'expired' : x.uses >= x.max_uses ? 'used_up' : 'active' }));
      });
    },

    async revokeInvitation(user, groupId, invitationId) {
      return db.tx(async (t) => {
        const { group, me } = await loadForMember(t, user.id, groupId);
        assertOwner(me);
        const r = await t.query('UPDATE group_invitations SET revoked_at = now() WHERE id=$1 AND group_id=$2 AND revoked_at IS NULL RETURNING id', [requireUuid(invitationId, 'Invitation'), group.id]);
        if (!r.rows.length) fail(ErrorCode.NOT_FOUND, 'Invitation not found.');
        await audit(t, { actorId: user.id, groupId: group.id, type: 'invitation.revoked' });
        return { ok: true };
      });
    },

    // Public preview for link holders: group name + mode ONLY (no members, origins, plans).
    async previewInvitation(token, { ip = 'unknown' } = {}) {
      await consume(db, { key: `invite-preview:${ip}`, limit: 60, windowSec: 600, now: clock() });
      const inv = await findInvitation(db, token);
      assertInvitationUsable(inv && { expiresAt: new Date(inv.expires_at).getTime(), revokedAt: inv.revoked_at }, clock());
      const g = (await db.query('SELECT name, mode, status FROM groups WHERE id=$1', [inv.group_id])).rows[0];
      if (!g || g.status !== GroupStatus.OPEN || inv.uses >= inv.max_uses) fail(ErrorCode.INVITE_INVALID, 'This invitation is not valid.');
      const seats = (await db.query('SELECT id, name, user_id FROM group_participants WHERE group_id=$1 AND pre_named ORDER BY ord', [inv.group_id])).rows;
      // Names + claimed/available only: no accounts, no states, nothing about anyone's plans.
      return { groupName: g.name, mode: g.mode, namedSeats: seats.length > 0, participants: seats.map(s => ({ id: s.id, name: s.name, claimed: !!s.user_id })) };
    },

    async joinWithToken(user, token, input = {}, { ip = 'unknown' } = {}) {
      await consume(db, { key: `invite-join:${ip}`, limit: 20, windowSec: 600, now: clock() });
      return db.tx(async (t) => {
        const hash = await hashInviteToken(String(token ?? ''));
        const inv = (await t.query('SELECT * FROM group_invitations WHERE token_hash=$1 FOR UPDATE', [hash])).rows[0];
        assertInvitationUsable(inv && { expiresAt: new Date(inv.expires_at).getTime(), revokedAt: inv.revoked_at }, clock());
        if (inv.uses >= inv.max_uses) fail(ErrorCode.INVITE_INVALID, 'This invitation is not valid.');
        const g = gRow((await t.query('SELECT * FROM groups WHERE id=$1 FOR UPDATE', [inv.group_id])).rows[0]);
        const members = await loadMembers(t, g.id);
        const prior = members.find(m => m.userId === user.id);
        if (prior?.joinStatus === 'removed') fail(ErrorCode.FORBIDDEN, 'You cannot rejoin this group.');
        if (input.mode !== undefined && input.mode !== g.mode) fail(ErrorCode.MODE_MISMATCH, 'Participant transport mode must match the group transport mode.');
        const o = validateOriginInput(input.origin, { mode: g.mode });
        const named = await groupUsesNamedSeats(t, g.id);
        if (named && !isUuid(input.participantId) && !(await seatOfUser(t, g.id, user.id))) fail(ErrorCode.INVALID_INPUT, 'Choose which participant you are.');
        assertCanJoin(g, members.filter(m => m.joinStatus === 'joined'), { userId: user.id, mode: g.mode, origin: o });
        // The seat is claimed FIRST: if someone else got it, nothing else changes (the transaction aborts).
        const seat = named
          ? (prior?.joinStatus === 'joined' ? await seatOfUser(t, g.id, user.id) : await claimNamedSeat(t, { groupId: g.id, seatId: String(input.participantId).toLowerCase(), userId: user.id }))
          : await openSeat(t, { groupId: g.id, userId: user.id, displayName: user.displayName ?? (await t.query('SELECT display_name FROM users WHERE id=$1', [user.id])).rows[0].display_name });
        if (prior) await t.query(`UPDATE group_memberships SET join_status='joined', updated_at=now() WHERE group_id=$1 AND user_id=$2`, [g.id, user.id]);
        else await t.query(`INSERT INTO group_memberships (group_id, transport_mode, user_id, role) VALUES ($1,$2,$3,'member')`, [g.id, g.mode, user.id]);
        const me = mRow((await t.query(`${MEMBER_SQL} WHERE m.group_id=$1 AND m.user_id=$2`, [g.id, user.id])).rows[0]);
        await writeMemberInput(t, g, me, { origin: input.origin, softPrefs: input.softPrefs, hard: input.hard });
        await t.query('UPDATE group_invitations SET uses = uses + 1 WHERE id=$1', [inv.id]);
        if (g.status === GroupStatus.PROPOSED) await t.query(`UPDATE groups SET status='open', updated_at=now() WHERE id=$1`, [g.id]);
        await emit(t, { groupId: g.id, participantId: seat.id, type: EventType.JOINED });
        await audit(t, { actorId: user.id, groupId: g.id, type: 'member.joined' });
        const fresh = await loadMembers(t, g.id);
        return { ...view(g, fresh, user.id), participants: await roster(t, g.id, user.id) };
      });
    },
  };
}

async function findInvitation(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return (await db.query('SELECT * FROM group_invitations WHERE token_hash=$1', [await hashInviteToken(token)])).rows[0] ?? null;
}
export { DomainError };
