// ═══════════════════════════════════════════════════════════
//  services/events.js — the shared coordination layer.
//  Append-only structured events (never raw private text). 'group' events are readable by every member of the group
//  (each personal agent reads them from here); 'internal' events are coordinator working data and are never returned
//  to participants. Delivery is tracked per agent with two monotonic cursors on the seat: delivered_seq (read by the
//  agent's owner / agent) and acked_seq (acknowledged) — so synchronisation is visible and testable.
// ═══════════════════════════════════════════════════════════
import { EventType, cleanPayload } from '../domain/agentIntents.js';

export async function emit(t, { groupId, participantId = null, type, visibility = 'group', payload = {} }) {
  const r = await t.query('INSERT INTO group_events (group_id, participant_id, type, visibility, payload) VALUES ($1,$2,$3,$4,$5) RETURNING seq', [groupId, participantId, type, visibility, JSON.stringify(cleanPayload(type, payload))]);
  return Number(r.rows[0].seq);
}

export const headSeq = async (t, groupId) => Number((await t.query(`SELECT COALESCE(MAX(seq),0) AS h FROM group_events WHERE group_id=$1 AND visibility='group'`, [groupId])).rows[0].h);

// Human text for an event (deterministic, from the structured fields only).
export function describeEvent(type, name, p = {}) {
  switch (type) {
    case EventType.DELAY: return `${name} is running about ${p.minutes} minute${p.minutes === 1 ? '' : 's'} late.`;
    case EventType.AT_STATION: return `${name} has reached their metro station.`;
    case EventType.AT_MEETUP: return `${name} has arrived at the meetup point.`;
    case EventType.WITHDREW: return `${name} can no longer make it.`;
    case EventType.LOCATION: return `${name} changed their starting point (the plan may be out of date).`;
    case EventType.JOINED: return `${name} joined.`;
    case EventType.RELEASED: return `${name}'s place was released by the plan creator.`;
    case EventType.PLAN_PROPOSED: return `A new plan (version ${p.version}) was proposed.`;
    case EventType.PLAN_CONFIRMED: return `Plan version ${p.version} was confirmed.`;
    case EventType.PLAN_RESPONSE: return `${name} ${p.response === 'agree' ? 'agrees with' : 'objects to'} the current plan${p.version ? ` (version ${p.version})` : ''}.`;
    case EventType.REVIEW: return p.kind === 'shift_time'
      ? `Coordinator: with the reported delay, consider starting about ${p.minutes} minutes later${p.adjusted ? ` (longest trip would be ${p.adjusted.maxAfter} min)` : ''}. The confirmed plan is unchanged.`
      : `Coordinator: ${p.reason === 'withdrawal' ? 'someone withdrew' : 'a starting point changed'} — re-run the optimisation to get a fresh recommendation. The confirmed plan is unchanged.`;
    case EventType.GROUP_CANCELLED: return 'The meetup was cancelled.';
    case EventType.SHARING: return `${name} changed what their agent shares.`;
    default: return 'Update.';
  }
}

// Group-visible events after `since`, with names resolved from seats. Marks the viewer's agent as delivered up to the newest returned.
export async function readGroupEvents(t, { groupId, viewerSeat, since = 0, limit = 100 }) {
  const rows = (await t.query(
    `SELECT e.seq, e.type, e.payload, e.created_at, e.participant_id, p.name
       FROM group_events e LEFT JOIN group_participants p ON p.id = e.participant_id
      WHERE e.group_id=$1 AND e.visibility='group' AND e.seq > $2 ORDER BY e.seq ASC LIMIT $3`, [groupId, since, limit])).rows;
  const events = rows.map(r => ({ seq: Number(r.seq), type: r.type, at: r.created_at, participantId: r.participant_id, by: r.name ?? null, mine: r.participant_id === viewerSeat.id, payload: r.payload, text: describeEvent(r.type, r.name ?? 'Someone', r.payload) }));
  if (events.length) await t.query('UPDATE group_participants SET delivered_seq = GREATEST(delivered_seq, $2) WHERE id=$1', [viewerSeat.id, events[events.length - 1].seq]);
  return events;
}
