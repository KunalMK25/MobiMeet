// ═══════════════════════════════════════════════════════════
//  services/participants.js — participant seats (names), single-claim, and the roster projection.
//  A "seat" is one participant entry of a group. Seats entered by the creator are `pre_named`; they can be
//  claimed EXACTLY ONCE by an authenticated account (decided atomically by the UPDATE ... WHERE user_id IS NULL
//  plus the partial unique index), never by typing a name. A seat also holds the agent's PUBLISHED state.
// ═══════════════════════════════════════════════════════════
import { ErrorCode, fail } from '../domain/errors.js';
import { GROUP_LIMITS } from '../config/Limits.js';
import { DEFAULT_SHARE } from '../domain/agentIntents.js';
import { validateText } from './validation.js';

export const MAX_SEATS = GROUP_LIMITS.max;
export const nameKey = (n) => n.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export const seatRow = (r) => ({
  id: r.id, groupId: r.group_id, name: r.name, preNamed: r.pre_named, userId: r.user_id, claimedAt: r.claimed_at,
  status: r.travel_status, delayMinutes: r.delay_minutes, share: { ...DEFAULT_SHARE, ...(r.share ?? {}) }, pendingAction: r.pending_action ?? null,
  deliveredSeq: Number(r.delivered_seq), ackedSeq: Number(r.acked_seq), agentUpdatedAt: r.agent_updated_at,
});

export function validateSeatNames(names, { ownerName }) {
  if (names === undefined || names === null) return [];
  if (!Array.isArray(names)) fail(ErrorCode.INVALID_INPUT, 'Participant names must be a list.');
  const cleaned = names.map(n => validateText(n, { min: 1, max: 40, what: 'A participant name' }));
  if (cleaned.length > MAX_SEATS - 1) fail(ErrorCode.INVALID_INPUT, `At most ${MAX_SEATS - 1} other participants can be named (${MAX_SEATS} including you).`);
  const keys = new Set([nameKey(ownerName)]);
  for (const n of cleaned) { const k = nameKey(n); if (keys.has(k)) fail(ErrorCode.INVALID_INPUT, `The name "${n}" appears more than once (your own name counts).`); keys.add(k); }
  return cleaned;
}

export async function createSeats(t, { groupId, ownerId, ownerName, names }) {
  await t.query(`INSERT INTO group_participants (group_id, name, name_key, user_id, claimed_at, travel_status) VALUES ($1,$2,$3,$4,now(),'planning')`, [groupId, ownerName, nameKey(ownerName), ownerId]);
  for (const n of names) await t.query(`INSERT INTO group_participants (group_id, name, name_key, pre_named) VALUES ($1,$2,$3,true)`, [groupId, n, nameKey(n)]);
}

export const groupUsesNamedSeats = async (t, groupId) => (await t.query('SELECT 1 FROM group_participants WHERE group_id=$1 AND pre_named LIMIT 1', [groupId])).rows.length > 0;

// Atomic single claim. Rejects (CONFLICT) when the seat is taken, unknown, belongs to another group, or the account already holds a seat here.
export async function claimNamedSeat(t, { groupId, seatId, userId }) {
  const mine = (await t.query('SELECT id FROM group_participants WHERE group_id=$1 AND user_id=$2', [groupId, userId])).rows[0];
  if (mine) fail(ErrorCode.DUPLICATE_MEMBER, 'Your account already holds a place in this group.');
  const r = await t.query(
    `UPDATE group_participants SET user_id=$3, claimed_at=now(), travel_status='planning', delay_minutes=0, pending_action=NULL, agent_updated_at=now()
      WHERE id=$2 AND group_id=$1 AND pre_named AND user_id IS NULL RETURNING *`, [groupId, seatId, userId]);
  if (!r.rows.length) fail(ErrorCode.CONFLICT, 'That name is not available — it may already be claimed. Pick another or ask the plan creator.');
  return seatRow(r.rows[0]);
}

// Groups created without names (and legacy groups) keep the old open-seat behaviour: the joiner gets a seat named after their account.
export async function openSeat(t, { groupId, userId, displayName }) {
  const existing = (await t.query('SELECT * FROM group_participants WHERE group_id=$1 AND user_id=$2', [groupId, userId])).rows[0];
  if (existing) return seatRow(existing);
  let name = displayName, n = 1;
  for (;;) {
    const key = nameKey(name);
    const row = (await t.query('SELECT * FROM group_participants WHERE group_id=$1 AND name_key=$2', [groupId, key])).rows[0];
    if (!row) return seatRow((await t.query(`INSERT INTO group_participants (group_id, name, name_key, user_id, claimed_at, travel_status) VALUES ($1,$2,$3,$4,now(),'planning') RETURNING *`, [groupId, name, key, userId])).rows[0]);
    if (!row.user_id && !row.pre_named) return seatRow((await t.query(`UPDATE group_participants SET user_id=$2, claimed_at=now(), travel_status='planning', delay_minutes=0, pending_action=NULL WHERE id=$1 RETURNING *`, [row.id, userId])).rows[0]);
    n += 1; name = `${displayName.slice(0, 34)} (${n})`;
  }
}

// Give a seat back (member left, was removed, or deleted their account). Pre-named seats become claimable again.
export async function freeSeat(t, { groupId, userId, status }) {
  const r = await t.query(
    `UPDATE group_participants SET user_id=NULL, claimed_at=NULL, travel_status=$3, delay_minutes=0, pending_action=NULL, agent_updated_at=now()
      WHERE group_id=$1 AND user_id=$2 RETURNING *`, [groupId, userId, status]);
  return r.rows[0] ? seatRow(r.rows[0]) : null;
}

export async function seatOfUser(t, groupId, userId, { lock = false } = {}) {
  const r = (await t.query(`SELECT * FROM group_participants WHERE group_id=$1 AND user_id=$2${lock ? ' FOR UPDATE' : ''}`, [groupId, userId])).rows[0];
  return r ? seatRow(r) : null;
}
export const loadSeats = async (t, groupId) => (await t.query('SELECT * FROM group_participants WHERE group_id=$1 ORDER BY ord', [groupId])).rows.map(seatRow);

// What a viewer is allowed to see of the roster: names, joined/pending, and ONLY the published agent state
// (a delay/arrival the participant chose to share). Never user ids of others, agent cursors of others in detail, or private notes.
export async function roster(t, groupId, viewerUserId, { asOwner = false } = {}) {
  const seats = (await loadSeats(t, groupId)).filter(s => s.preNamed || s.userId);
  const head = Number((await t.query('SELECT COALESCE(MAX(seq),0) AS h FROM group_events WHERE group_id=$1 AND visibility=\'group\'', [groupId])).rows[0].h);
  // Only the plan creator also sees WHICH ACCOUNT holds each seat (to spot a forwarded link used by the wrong person) and may release it.
  const accounts = asOwner ? Object.fromEntries((await t.query(`SELECT p.id, u.display_name FROM group_participants p JOIN users u ON u.id=p.user_id WHERE p.group_id=$1`, [groupId])).rows.map(r => [r.id, r.display_name])) : {};
  return seats.map(s => ({
    id: s.id, name: s.name, claimed: !!s.userId, isMe: s.userId === viewerUserId, status: s.userId ? s.status : s.status === 'withdrawn' ? 'withdrawn' : 'invited',
    delayMinutes: s.userId ? s.delayMinutes : 0,
    sync: s.userId ? { pending: Math.max(0, head - s.ackedSeq), inSync: s.ackedSeq >= head } : null,
    ...(asOwner && s.userId ? { userId: s.userId, accountName: accounts[s.id] ?? null } : {}),
  }));
}
