// ═══════════════════════════════════════════════════════════
//  services/retention.js — data retention & deletion (spec §14)
//  Policy (defaults, configurable):
//   • Groups with no activity for 30 days while draft/open/proposed → status 'expired' (invitations revoked).
//   • Cancelled / expired groups are DELETED 30 days after they closed — memberships (incl. starting
//     points), plans, venues, scenarios and invitations go with them (ON DELETE CASCADE).
//   • Confirmed groups are kept 180 days after their last update, then deleted.
//   • Private agent conversations are deleted after 30 days (the structured shared events stay with the group).
//   • Expired/revoked sessions, rate-limit counters (>1 h) and audit events (>365 days) are purged.
//  Account deletion anonymises the user row (kept only so plan history stays referentially valid) and removes
//  their starting points, preferences, sessions and profile.
// ═══════════════════════════════════════════════════════════
import { DomainError, ErrorCode, fail } from '../domain/errors.js';
import { verifyPassword } from './crypto.js';
import { audit } from './audit.js';
import { purgeOld } from './rateLimit.js';

export const RETENTION = Object.freeze({ inactiveDays: 30, closedDays: 30, confirmedDays: 180, auditDays: 365, agentMessageDays: 30 });
const DAY = 86400e3;

export function createRetentionService({ db, clock = Date.now, policy = RETENTION }) {
  const ago = (days) => new Date(clock() - days * DAY);
  return {
    async runMaintenance() {
      const out = await db.tx(async (t) => {
        const expired = (await t.query(`UPDATE groups SET status='expired', updated_at=now() WHERE status IN ('draft','open','proposed','optimizing') AND updated_at < $1 RETURNING id`, [ago(policy.inactiveDays)])).rows;
        if (expired.length) await t.query('UPDATE group_invitations SET revoked_at = now() WHERE revoked_at IS NULL AND group_id = ANY($1::uuid[])', [expired.map(r => r.id)]);
        const deleted = (await t.query(`DELETE FROM groups WHERE (status IN ('cancelled','expired') AND updated_at < $1) OR (status = 'confirmed' AND updated_at < $2) RETURNING id`, [ago(policy.closedDays), ago(policy.confirmedDays)])).rows;
        const sessions = (await t.query(`DELETE FROM sessions WHERE expires_at < $1 OR revoked_at < $2 RETURNING id`, [new Date(clock()), ago(1)])).rows;
        const audits = (await t.query('DELETE FROM audit_events WHERE created_at < $1 RETURNING id', [ago(policy.auditDays)])).rows;
        const msgs = (await t.query('DELETE FROM agent_messages WHERE created_at < $1 RETURNING id', [ago(policy.agentMessageDays)])).rows;   // private agent conversations are short-lived
        return { deletedAgentMessages: msgs.length, expiredGroups: expired.length, deletedGroups: deleted.length, deletedSessions: sessions.length, deletedAuditEvents: audits.length };
      });
      await purgeOld(db, clock());
      return out;
    },

    // Owner deletes a cancelled group right away (instead of waiting for the retention window).
    async purgeGroup(user, groupId) {
      const r = await db.tx(async (t) => {
        const g = (await t.query(`SELECT g.id, g.status FROM groups g JOIN group_memberships m ON m.group_id=g.id AND m.user_id=$2 AND m.role='owner' AND m.join_status='joined' WHERE g.id=$1 FOR UPDATE OF g`, [groupId, user.id])).rows[0];
        if (!g) fail(ErrorCode.NOT_FOUND, 'Group not found.');
        if (!['cancelled', 'expired'].includes(g.status)) fail(ErrorCode.CONFLICT, 'Cancel the group before deleting its data.');
        await t.query('UPDATE groups SET selected_plan_id = NULL WHERE id=$1', [g.id]);
        await t.query('DELETE FROM groups WHERE id=$1', [g.id]);
        await audit(t, { actorId: user.id, type: 'group.purged' });
        return { ok: true };
      });
      return r;
    },

    async deleteAccount(user, password) {
      const u = (await db.query('SELECT password_hash FROM users WHERE id=$1', [user.id])).rows[0];
      if (!u || typeof password !== 'string' || !(await verifyPassword(password, u.password_hash))) fail(ErrorCode.UNAUTHENTICATED, 'Password confirmation failed.');
      return db.tx(async (t) => {
        // Groups the user owns are cancelled (others lose access to a leaderless group); memberships are cleared.
        const owned = (await t.query(`SELECT group_id FROM group_memberships WHERE user_id=$1 AND role='owner' AND join_status='joined'`, [user.id])).rows.map(r => r.group_id);
        if (owned.length) {
          await t.query(`UPDATE groups SET status='cancelled', updated_at=now() WHERE id = ANY($1::uuid[]) AND status NOT IN ('cancelled','expired')`, [owned]);
          await t.query('UPDATE group_invitations SET revoked_at=now() WHERE revoked_at IS NULL AND group_id = ANY($1::uuid[])', [owned]);
        }
        await t.query(`UPDATE group_memberships SET join_status='left', origin_lat=NULL, origin_lon=NULL, origin_station_id=NULL, origin_label=NULL, soft_prefs='{}', hard_constraints='{}', agent_snapshot=NULL, updated_at=now() WHERE user_id=$1`, [user.id]);
        await t.query(`UPDATE group_participants SET user_id=NULL, claimed_at=NULL, travel_status='withdrawn', delay_minutes=0, pending_action=NULL WHERE user_id=$1`, [user.id]);
        await t.query('DELETE FROM agent_messages WHERE user_id=$1', [user.id]);          // private agent conversations go with the account
        await t.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
        await t.query('DELETE FROM user_profiles WHERE user_id=$1', [user.id]);
        await t.query(`UPDATE users SET email=$2, display_name='Deleted user', password_hash='!', updated_at=now() WHERE id=$1`, [user.id, `deleted-${user.id}@invalid.example`]);
        await audit(t, { actorId: user.id, type: 'account.deleted' });
        return { ok: true };
      });
    },
  };
}
export { DomainError };
