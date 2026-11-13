// ═══════════════════════════════════════════════════════════
//  services/agents.js — one lightweight personal agent per participant (hybrid, event-driven)
//
//  • Deterministic core: intent rules → validation → state update → sharing policy → structured event.
//  • The LLM (optional, server-side) is consulted ONLY when no rule matches, to classify into the same whitelist;
//    answers about other people never come from an LLM — they are built from authorised shared events.
//  • Private conversation (agent_messages) is readable only by its owner and is never joined into group queries.
//  • Agents do not talk to each other directly: they publish structured events to the shared coordination layer
//    (services/events.js) and read the events of the others from it. No group chat exists.
// ═══════════════════════════════════════════════════════════
import { ErrorCode, fail } from '../domain/errors.js';
import { Intent, EventType, MAX_MESSAGE_CHARS, classifyMessage, parseMinutes, validateLlmIntent, validateShare, INTENTS } from '../domain/agentIntents.js';
import { GroupStatus } from '../domain/group.js';
import { consume } from './rateLimit.js';
import { reserveLlmCall, DEFAULT_LLM_BUDGET, LLM_TOKEN_ESTIMATE } from './llmBudget.js';
import { audit } from './audit.js';
import { emit, headSeq, readGroupEvents, describeEvent } from './events.js';
import { react } from './coordination.js';
import { seatOfUser, loadSeats, roster, openSeat } from './participants.js';

const STATUS_TEXT = { invited: 'invited', planning: 'getting ready', en_route: 'on the way', at_station: 'at their metro station', arrived: 'at the meetup point', withdrawn: 'unable to make it' };
const ago = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const closed = (g) => [GroupStatus.CANCELLED, GroupStatus.EXPIRED].includes(g.status);

const CLASSIFY_SYSTEM = `Classify ONE short message that a person sent to their own meetup assistant. Reply with ONLY JSON: {"intent": <one of ${INTENTS.filter(i => !['yes', 'no', 'query'].includes(i)).join(', ')}>, "minutes": <integer or null>}. "late" = they are running late (minutes if stated). "at_station" = they reached a metro station. "at_meetup" = they are at the meetup place. "withdraw" = they cannot attend. "location_change" = their starting location changed. "preference_change" = they want to change travel preferences. "agree"/"object" = they accept or reject the current plan. "other" = anything else, including private or unrelated talk.`;

export function createAgentService({ db, groups, clock = Date.now, llm = null, budget = DEFAULT_LLM_BUDGET }) {
  async function mine(t, userId, groupId, { lock = false } = {}) {
    const { group, me } = await groups.loadForMember(t, userId, groupId, { lock });
    let seat = await seatOfUser(t, group.id, userId, { lock });
    // Groups that predate seats: the member gets one on first use.
    if (!seat) seat = await openSeat(t, { groupId: group.id, userId, displayName: (await t.query('SELECT display_name FROM users WHERE id=$1', [userId])).rows[0].display_name });
    return { group, me, seat };
  }

  async function classify(text, { userId, groupId }) {
    const rule = classifyMessage(text);
    if (rule.intent !== Intent.OTHER || !llm || /^\d{1,3}$/.test(text.trim()) || text.trim().length < 8) return { ...rule, via: 'rules' };
    if (!(await reserveLlmCall(db, { userId, groupId, now: clock(), estTokens: LLM_TOKEN_ESTIMATE.agent, budget }))) return { ...rule, via: 'rules', budget: 'exhausted' };   // stay within cost/rate limits
    try {
      const raw = await llm.complete({ system: CLASSIFY_SYSTEM, messages: [{ role: 'user', content: text }], maxTokens: 60 });
      const json = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? 'null');
      const ok = validateLlmIntent(json);
      return ok ? { ...ok, via: 'llm' } : { ...rule, via: 'rules' };
    } catch { return { ...rule, via: 'rules' }; }
  }

  // Publish one structured event for a seat and let the coordinator react. Returns {seq, review}.
  async function publish(t, { group, seat, type, payload = {}, patch = {} }) {
    // Fixed column set (no dynamic SQL): only the published state an event may change.
    await t.query(`UPDATE group_participants SET travel_status=COALESCE($2,travel_status), delay_minutes=COALESCE($3,delay_minutes), pending_action=NULL, agent_updated_at=now() WHERE id=$1`, [seat.id, patch.travel_status ?? null, patch.delay_minutes ?? null]);
    const seq = await emit(t, { groupId: group.id, participantId: seat.id, type, payload });
    const review = await react(t, { groupId: group.id, seatId: seat.id, type });
    // The publisher's own agent has trivially seen what it wrote.
    await t.query('UPDATE group_participants SET delivered_seq=GREATEST(delivered_seq,$2), acked_seq=GREATEST(acked_seq,$2) WHERE id=$1', [seat.id, seq]);
    return { seq, review };
  }

  async function currentPlan(t, group) {
    if (!group.selectedPlanId) return null;
    const p = (await t.query('SELECT version, status, result FROM meetup_plans WHERE id=$1', [group.selectedPlanId])).rows[0];
    return p ? { version: p.version, status: p.status, label: p.result?.recommended?.label ?? null } : null;
  }

  // ── answering questions: only from what the group's agents have shared ──
  async function answerQuery(t, { group, seat, text }) {
    const lc = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, ' ')} `;
    const seats = (await loadSeats(t, group.id)).filter(s => s.preNamed || s.userId);
    const now = clock();
    const evLines = async (s) => {
      const rows = (await t.query(`SELECT type, payload, created_at FROM group_events WHERE group_id=$1 AND participant_id=$2 AND visibility='group' AND type NOT IN ('review_recommended') ORDER BY seq DESC LIMIT 3`, [group.id, s.id])).rows;
      return rows.map(r => `${describeEvent(r.type, s.name, r.payload)} (${ago(now - new Date(r.created_at).getTime())})`);
    };
    const person = async (s) => {
      if (!s.userId) return s.status === 'withdrawn' ? `${s.name} can no longer make it.` : `${s.name} hasn't joined yet.`;
      const lines = await evLines(s);
      const state = `${s.name} is ${STATUS_TEXT[s.status] ?? s.status}${s.delayMinutes ? `, running about ${s.delayMinutes} min late` : ''}.`;
      return lines.length ? `${state} Latest shared updates: ${lines.join(' ')}` : `${state} They haven't shared any updates yet.`;
    };
    const named = seats.filter(s => lc.includes(` ${s.name.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, ' ').trim()} `) || lc.split(' ').includes(s.name.toLowerCase().split(' ')[0])).filter(s => s.id !== seat.id).slice(0, 3);
    let reply;
    if (named.length) reply = (await Promise.all(named.map(person))).join('\n');
    else if (/\b(my|me|myself|i)\b/.test(lc) && /\b(status|state|delay|late|doing)\b/.test(lc)) reply = `You are ${STATUS_TEXT[seat.status]}${seat.delayMinutes ? `, with a shared delay of about ${seat.delayMinutes} min` : ''}. Sharing: delays ${seat.share.delays ? 'on' : 'off'}, arrival ${seat.share.arrival ? 'on' : 'off'}, location changes ${seat.share.location ? 'on' : 'off'}.`;
    else if (/\b(late|delay|delayed|behind)\b/.test(lc)) {
      const late = seats.filter(s => s.userId && s.delayMinutes > 0 && s.status !== 'arrived' && s.status !== 'withdrawn');
      reply = late.length ? `Shared delays: ${late.map(s => `${s.name} (~${s.delayMinutes} min)`).join(', ')}.` : 'Nobody has shared a delay.';
    } else if (/\b(arrived|here|reached|there)\b/.test(lc) && /\b(who|everyone|anyone|all|everybody)\b/.test(lc)) {
      const here = seats.filter(s => s.userId && s.status === 'arrived');
      reply = here.length ? `At the meetup point: ${here.map(s => s.name).join(', ')}. (${here.length} of ${seats.filter(s => s.userId && s.status !== 'withdrawn').length} so far.)` : 'Nobody has said they have arrived yet.';
    } else if (/\b(joined|pending|waiting|missing|claimed|invited)\b/.test(lc)) {
      const pend = seats.filter(s => !s.userId && s.status !== 'withdrawn');
      reply = `${seats.filter(s => s.userId).length} joined${pend.length ? `; still waiting for ${pend.map(s => s.name).join(', ')}` : '; everyone has joined'}.`;
    } else if (/\b(plan|meetup|where|which station|venue|point)\b/.test(lc)) {
      const p = await currentPlan(t, group);
      reply = p ? `Plan version ${p.version} (${p.status})${p.label ? `: ${p.label}` : ''}.` : 'There is no plan yet.';
    } else {
      const rows = (await t.query(`SELECT e.type, e.payload, e.created_at, p.name FROM group_events e LEFT JOIN group_participants p ON p.id=e.participant_id WHERE e.group_id=$1 AND e.visibility='group' ORDER BY e.seq DESC LIMIT 5`, [group.id])).rows;
      reply = rows.length ? `Latest updates: ${rows.reverse().map(r => `${describeEvent(r.type, r.name ?? 'Someone', r.payload)} (${ago(now - new Date(r.created_at).getTime())})`).join(' ')}` : 'No updates have been shared yet.';
    }
    // Reading the shared layer brings this agent up to date.
    const head = await headSeq(t, group.id);
    await t.query('UPDATE group_participants SET delivered_seq=GREATEST(delivered_seq,$2) WHERE id=$1', [seat.id, head]);
    return `${reply}\n(Only information that people chose to share with the group.)`;
  }

  async function handle(t, { group, seat, text, cls }) {
    const share = seat.share;
    const say = (reply, extra = {}) => ({ reply, intent: cls.intent, ...extra });
    const pending = seat.pendingAction;
    const clearPending = () => t.query('UPDATE group_participants SET pending_action=NULL WHERE id=$1', [seat.id]);

    // ── follow-ups to a question the agent asked ──
    if (pending?.type === 'withdraw') {
      await clearPending();
      if (cls.intent === Intent.YES) {
        await t.query(`UPDATE group_memberships SET join_status='left', updated_at=now() WHERE group_id=$1 AND user_id=$2`, [group.id, seat.userId]);
        const { seq } = await publish(t, { group, seat, type: EventType.WITHDREW, patch: { travel_status: 'withdrawn', delay_minutes: 0 } });
        await audit(t, { actorId: seat.userId, groupId: group.id, type: 'agent.withdrew' });
        return say('Done — I told the group that you can no longer make it. You are no longer part of this meetup.', { published: { seq, type: EventType.WITHDREW } });
      }
      return say('Okay, nothing changed — you are still in.');
    }
    if (pending?.type === 'late_minutes') {
      const bare = /^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : parseMinutes(text);
      if (bare >= 1 && bare <= 240) { await clearPending(); cls = { intent: Intent.LATE, minutes: bare }; }
      else if (cls.intent === Intent.NO) { await clearPending(); return say('Okay, I will not share a delay.'); }
    }

    switch (cls.intent) {
      case Intent.LATE: {
        if (!cls.minutes) { await t.query(`UPDATE group_participants SET pending_action='{"type":"late_minutes"}'::jsonb WHERE id=$1`, [seat.id]); return say('How many minutes late do you expect to be? (a number from 1 to 240)'); }
        if (seat.status === 'arrived') return say('You are marked as already at the meetup point, so I did not record a delay.');
        if (!share.delays) return say(`Noted — about ${cls.minutes} minutes late. Your settings keep delays private, so I have not told anyone. Turn delay sharing on if you want the group to know.`);
        const { seq, review } = await publish(t, { group, seat, type: EventType.DELAY, payload: { minutes: cls.minutes }, patch: { delay_minutes: cls.minutes } });
        return say(`Got it — about ${cls.minutes} minutes late. I told the other agents only that (not your message).${review ? ' The coordinator suggests a later start; see the group status.' : ''}`, { published: { seq, type: EventType.DELAY }, review: !!review });
      }
      case Intent.AT_STATION: case Intent.AT_MEETUP: {
        const meetup = cls.intent === Intent.AT_MEETUP;
        if (!share.arrival) return say('Noted. Your settings keep arrival updates private, so nobody was told.');
        const { seq } = await publish(t, { group, seat, type: meetup ? EventType.AT_MEETUP : EventType.AT_STATION, patch: { travel_status: meetup ? 'arrived' : 'at_station', ...(meetup ? { delay_minutes: 0 } : {}) } });
        return say(meetup ? 'Great — I told the group that you are at the meetup point.' : 'Thanks — I told the group that you reached your station.', { published: { seq, type: meetup ? EventType.AT_MEETUP : EventType.AT_STATION } });
      }
      case Intent.WITHDRAW: {
        if (seat.userId === group.ownerId) return say('You created this meetup, so it cannot be dropped from here. To call it off, use "Cancel meetup" on the group page.');
        await t.query(`UPDATE group_participants SET pending_action='{"type":"withdraw"}'::jsonb WHERE id=$1`, [seat.id]);
        return say('Do you want me to tell the group that you can\'t make it and remove you from this meetup? Reply "yes" to confirm or "no" to keep your place.');
      }
      case Intent.LOCATION_CHANGE:
        return say('To change your starting point, update it on the group page (Your starting point). When you save, I will tell the group that your starting point changed — without the exact location — and the plan will be marked out of date.');
      case Intent.PREFERENCE_CHANGE:
        return say('Preferences are private to you. Change them on the group page under your starting point and preferences; the plan is marked out of date when you save, and the plan creator can re-run the optimisation.');
      case Intent.AGREE: case Intent.OBJECT: {
        const plan = await currentPlan(t, group);
        if (!plan) return say('There is no plan to respond to yet.');
        const response = cls.intent === Intent.AGREE ? 'agree' : 'object';
        const { seq } = await publish(t, { group, seat, type: EventType.PLAN_RESPONSE, payload: { response, version: plan.version } });
        return say(`Recorded: you ${response === 'agree' ? 'agree with' : 'object to'} plan version ${plan.version}. The group can see your response, not your message.`, { published: { seq, type: EventType.PLAN_RESPONSE } });
      }
      case Intent.QUERY: return say(await answerQuery(t, { group, seat, text }));
      case Intent.YES: case Intent.NO: return say('There is nothing waiting for your confirmation.');
      default: return say('That stays between us — I only pass on meetup updates (running late, arrivals, not being able to come, your view of the plan), and only the facts, never your words. You can also ask me about the others, e.g. "who is late?".');
    }
  }

  return {
    llmEnabled: !!llm,

    async sendMessage(user, groupId, rawText) {
      const text = typeof rawText === 'string' ? rawText.trim() : '';
      if (!text || text.length > MAX_MESSAGE_CHARS) fail(ErrorCode.INVALID_INPUT, `Message must be 1-${MAX_MESSAGE_CHARS} characters.`);
      await consume(db, { key: `agent:${user.id}`, limit: 40, windowSec: 600, now: clock() });
      const cls = await classify(text, { userId: user.id, groupId });
      return db.tx(async (t) => {
        const { group, seat } = await mine(t, user.id, groupId, { lock: true });
        if (closed(group)) fail(ErrorCode.GROUP_CLOSED, 'This meetup is closed.');
        await t.query(`INSERT INTO agent_messages (group_id, participant_id, user_id, role, body, intent) VALUES ($1,$2,$3,'user',$4,$5)`, [group.id, seat.id, user.id, text, cls.intent]);
        const out = await handle(t, { group, seat, text, cls });
        const m = (await t.query(`INSERT INTO agent_messages (group_id, participant_id, user_id, role, body, intent, event_seq) VALUES ($1,$2,$3,'agent',$4,$5,$6) RETURNING created_at`, [group.id, seat.id, user.id, out.reply, out.intent, out.published?.seq ?? null])).rows[0];
        return { reply: out.reply, intent: out.intent, understoodBy: cls.via, published: out.published ?? null, at: m.created_at };
      });
    },

    // Only the owner's own conversation (user_id AND participant both match the caller).
    async listMessages(user, groupId, { limit = 50 } = {}) {
      return db.tx(async (t) => {
        const { group, seat } = await mine(t, user.id, groupId);
        const rows = (await t.query(`SELECT role, body, intent, event_seq, created_at FROM agent_messages WHERE group_id=$1 AND participant_id=$2 AND user_id=$3 ORDER BY created_at DESC, id DESC LIMIT $4`, [group.id, seat.id, user.id, Math.min(Math.max(Number(limit) || 50, 1), 200)])).rows.reverse();
        return rows.map(r => ({ role: r.role, body: r.body, intent: r.intent, published: r.event_seq != null, at: r.created_at }));
      });
    },

    async getAgent(user, groupId) {
      return db.tx(async (t) => {
        const { group, seat } = await mine(t, user.id, groupId);
        const head = await headSeq(t, group.id);
        return { participant: { id: seat.id, name: seat.name, status: seat.status, delayMinutes: seat.delayMinutes }, sharing: seat.share,
          sync: { head, delivered: seat.deliveredSeq, acked: seat.ackedSeq, pending: Math.max(0, head - seat.ackedSeq), inSync: seat.ackedSeq >= head }, awaiting: seat.pendingAction?.type ?? null };
      });
    },

    async setSharing(user, groupId, input) {
      return db.tx(async (t) => {
        const { group, seat } = await mine(t, user.id, groupId, { lock: true });
        let next; try { next = validateShare(input, seat.share); } catch (e) { fail(ErrorCode.INVALID_INPUT, e.message); }
        await t.query('UPDATE group_participants SET share=$2, agent_updated_at=now() WHERE id=$1', [seat.id, JSON.stringify(next)]);
        await audit(t, { actorId: user.id, groupId: group.id, type: 'agent.sharing_changed' });
        return { sharing: next };
      });
    },

    // The agent's inbox: shared events after `since`; reading marks them delivered to THIS agent.
    async pullEvents(user, groupId, { since = 0 } = {}) {
      const s = Math.max(0, Number.isFinite(Number(since)) ? Math.floor(Number(since)) : 0);
      await consume(db, { key: `events:${user.id}`, limit: 300, windowSec: 600, now: clock() });   // ≈ one poll every 15 s per open group, with headroom
      return db.tx(async (t) => {
        const { group, seat } = await mine(t, user.id, groupId);
        const events = await readGroupEvents(t, { groupId: group.id, viewerSeat: seat, since: s });
        return { events, head: await headSeq(t, group.id) };
      });
    },

    async ack(user, groupId, seq) {
      const n = Number(seq);
      if (!Number.isInteger(n) || n < 0) fail(ErrorCode.INVALID_INPUT, 'seq must be a non-negative integer.');
      return db.tx(async (t) => {
        const { group, seat } = await mine(t, user.id, groupId, { lock: true });
        const upto = Math.min(n, await headSeq(t, group.id), Math.max(seat.deliveredSeq, 0));   // only what was actually delivered can be acknowledged
        await t.query('UPDATE group_participants SET acked_seq=GREATEST(acked_seq,$2) WHERE id=$1', [seat.id, upto]);
        return { acked: Math.max(seat.ackedSeq, upto) };
      });
    },

    async dashboard(user, groupId) {
      await consume(db, { key: `dash:${user.id}`, limit: 600, windowSec: 600, now: clock() });
      return db.tx(async (t) => {
        const { group, me, seat } = await mine(t, user.id, groupId);
        const people = await roster(t, group.id, user.id, { asOwner: me.role === 'owner' });
        const plan = await currentPlan(t, group);
        const head = await headSeq(t, group.id);
        const claimed = people.filter(p => p.claimed);
        let responses = null;
        if (plan) {
          const rows = (await t.query(`SELECT DISTINCT ON (participant_id) participant_id, payload->>'response' AS r FROM group_events WHERE group_id=$1 AND type='plan_response' AND (payload->>'version')::int=$2 ORDER BY participant_id, seq DESC`, [group.id, plan.version])).rows;
          const active = claimed.filter(p => p.status !== 'withdrawn');
          responses = { version: plan.version, agree: rows.filter(r => r.r === 'agree').length, object: rows.filter(r => r.r === 'object').length, waiting: Math.max(0, active.length - rows.length) };
        }
        const rec = (await t.query(`SELECT seq, payload, created_at FROM group_events WHERE group_id=$1 AND type='review_recommended' ORDER BY seq DESC LIMIT 1`, [group.id])).rows[0];
        const lastPlanEvt = Number((await t.query(`SELECT COALESCE(MAX(seq),0) AS s FROM group_events WHERE group_id=$1 AND type IN ('plan_proposed','plan_confirmed')`, [group.id])).rows[0].s);
        const recommendation = rec && Number(rec.seq) > lastPlanEvt ? { text: describeEvent('review_recommended', '', rec.payload), ...rec.payload } : null;
        return {
          group: { id: group.id, name: group.name, mode: group.mode, status: group.status }, isOwner: me.role === 'owner', me: seat.id,
          totals: { seats: people.length, joined: claimed.length, pending: people.length - claimed.length, arrived: people.filter(p => p.status === 'arrived').length, delayed: people.filter(p => p.delayMinutes > 0 && p.status !== 'arrived').length, withdrawn: people.filter(p => p.status === 'withdrawn').length },
          roster: people, plan, responses, recommendation, sync: { head, allInSync: claimed.every(p => p.sync?.inSync) },
        };
      });
    },
  };
}
