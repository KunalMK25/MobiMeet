// ═══════════════════════════════════════════════════════════
//  services/coordination.js — the coordinator's REACTIONS to shared events (deterministic, bounded).
//  It may RECOMMEND (a coordinator event with numbers) and may mark a proposal out of date, but it never creates,
//  edits, confirms or supersedes a plan: a confirmed plan only changes when the plan creator re-runs the optimisation
//  and the group confirms the new version (existing plan service rules).
// ═══════════════════════════════════════════════════════════
import { EventType, MATERIAL_DELAY_MIN } from '../domain/agentIntents.js';
import { groupMetrics } from '../optimizer/fairness.js';
import { emit } from './events.js';

// Burdens (minutes) per participant for the selected plan, shifted by each person's reported delay.
export function delayAdjusted(journeys, delayByUser) {
  const base = journeys.map(j => j.burdenMin ?? j.timeMin ?? 0);
  const adj = journeys.map(j => (j.burdenMin ?? j.timeMin ?? 0) + (delayByUser[j.participantId] ?? 0));
  const b = groupMetrics(base), a = groupMetrics(adj);
  return { maxBefore: b.max, maxAfter: a.max, jainBefore: b.jain, jainAfter: a.jain, minutes: Math.max(0, ...Object.values(delayByUser)) };
}

// type: the event type that was just published for `seatId`. Returns the recommendation event seq or null.
export async function react(t, { groupId, seatId, type }) {
  const g = (await t.query('SELECT status, selected_plan_id FROM groups WHERE id=$1', [groupId])).rows[0];
  if (!g?.selected_plan_id || ['cancelled', 'expired'].includes(g.status)) return null;
  const plan = (await t.query('SELECT result FROM meetup_plans WHERE id=$1', [g.selected_plan_id])).rows[0];
  if (type === EventType.DELAY) {
    const seats = (await t.query('SELECT user_id, delay_minutes FROM group_participants WHERE group_id=$1 AND user_id IS NOT NULL', [groupId])).rows;
    const delays = Object.fromEntries(seats.map(s => [s.user_id, s.delay_minutes]));
    const worst = Math.max(0, ...Object.values(delays));
    if (worst < MATERIAL_DELAY_MIN || !plan?.result?.recommended?.journeys?.length) return null;
    const adjusted = delayAdjusted(plan.result.recommended.journeys, delays);
    return emit(t, { groupId, participantId: seatId, type: EventType.REVIEW, payload: { reason: 'delay', kind: 'shift_time', minutes: adjusted.minutes, adjusted: { maxBefore: adjusted.maxBefore, maxAfter: adjusted.maxAfter, jainBefore: adjusted.jainBefore, jainAfter: adjusted.jainAfter } } });
  }
  if (type === EventType.WITHDREW || type === EventType.LOCATION) {
    // A proposal built on old inputs is no longer current (same rule as editing your own starting point).
    if (g.status === 'proposed') await t.query(`UPDATE groups SET status='open', updated_at=now() WHERE id=$1`, [groupId]);
    return emit(t, { groupId, participantId: seatId, type: EventType.REVIEW, payload: { reason: type === EventType.WITHDREW ? 'withdrawal' : 'location', kind: 'reoptimise' } });
  }
  return null;
}
