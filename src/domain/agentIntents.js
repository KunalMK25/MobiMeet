// ═══════════════════════════════════════════════════════════
//  domain/agentIntents.js — what a participant's personal agent understands (pure, deterministic)
//
//  A participant writes ONE private message to their OWN agent. This module turns it into a small structured
//  intent (never the raw text) and the sharing policy decides what — if anything — may be published to the group.
//  Rules cover the common updates; an optional LLM (agents service) is only consulted when no rule matches, and its
//  answer is validated against the same whitelist below.
// ═══════════════════════════════════════════════════════════

export const Intent = Object.freeze({
  LATE: 'late', AT_STATION: 'at_station', AT_MEETUP: 'at_meetup', WITHDRAW: 'withdraw', LOCATION_CHANGE: 'location_change',
  PREFERENCE_CHANGE: 'preference_change', AGREE: 'agree', OBJECT: 'object', YES: 'yes', NO: 'no', QUERY: 'query', OTHER: 'other',
});
export const INTENTS = Object.freeze(Object.values(Intent));
export const MAX_DELAY_MIN = 240;
export const MATERIAL_DELAY_MIN = 15;           // a delay this long (or longer) makes the coordinator review the plan
export const MAX_MESSAGE_CHARS = 500;

// What a participant may switch off. Withdrawal is NOT optional: the group cannot plan around someone who silently left.
export const SHARE_KEYS = Object.freeze(['delays', 'arrival', 'location']);
export const DEFAULT_SHARE = Object.freeze({ delays: true, arrival: true, location: true });
export function validateShare(input, current = DEFAULT_SHARE) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Sharing settings must be an object.');
  const out = { ...DEFAULT_SHARE, ...current };
  for (const [k, v] of Object.entries(input)) {
    if (!SHARE_KEYS.includes(k)) throw new TypeError(`Unknown sharing setting "${k}".`);
    if (typeof v !== 'boolean') throw new TypeError(`Sharing setting "${k}" must be true or false.`);
    out[k] = v;
  }
  return out;
}

const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45, sixty: 60 };

// Minutes of delay stated in the text, or null. Handles "15 minutes", "20 mins", "an hour", "half an hour", "1.5 hours", "two hours".
export function parseMinutes(text) {
  const t = text.toLowerCase().replace(/[,]/g, ' ');
  let m;
  if (/\bhalf (an )?hour\b/.test(t)) return 30;
  if ((m = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/.exec(t))) return clamp(Math.round(Number(m[1]) * 60));
  if ((m = /\b(a|an|one|two|three)\s+(?:and a half\s+)?hours?\b/.exec(t))) return clamp(NUM_WORDS[m[1]] * 60 + (/and a half/.test(m[0]) ? 30 : 0));
  if ((m = /(\d{1,3})\s*(?:min(?:ute)?s?|m)\b/.exec(t))) return clamp(Number(m[1]));
  if ((m = /\b(ten|fifteen|twenty|thirty|forty[- ]?five|forty|sixty|five)\s+(?:min(?:ute)?s?)\b/.exec(t))) return clamp(NUM_WORDS[m[1].replace(/[- ]/g, '')]);
  return null;
}
const clamp = (n) => (Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_DELAY_MIN) : null);

const FIRST_PERSON = /\b(i|i'm|im|i've|ive|i'll|ill|i am|i have|my|me|we're|we are)\b/;
const QUESTION_START = /^(what|who|where|when|why|how|is|are|was|were|has|have|did|does|do|any|anyone|anybody|status|update|tell|show|give)\b/;

// → { intent, minutes? }.  The raw text is never stored in the result.
export function classifyMessage(raw) {
  const text = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return { intent: Intent.OTHER };
  const yn = /^(yes|yep|yeah|yup|confirm|confirmed|sure|do it|go ahead|please do)\b/.test(text) ? Intent.YES : /^(no|nope|nah|cancel|never ?mind|don'?t|stop)\b/.test(text) ? Intent.NO : null;
  if (yn && text.length <= 40) return { intent: yn };

  const withdraw = /\b(can(?:'|no)?t|cannot|can not|won'?t|will not|unable to|not able to|am not able to)\b[^.]{0,20}\b(make it|come|attend|join|be there|go)\b|\bnot (coming|going to make it|attending)\b|\b(drop(?:ping)? out|pull(?:ing)? out|withdraw|opt(?:ing)? out)\b|\bcancel (my|for me|my attendance)\b/;
  const late = /\b(late|delayed|behind|stuck in traffic|held up)\b/;
  const meetup = /\b(meetup|meeting|venue|rendezvous|meet-?up)\b/;
  const arrived = /\b(arrived|reached|reaching|here|there|at)\b/;
  const station = /\b(station|metro|stop)\b/;
  const loc = /\b(location|origin|start(?:ing)? (?:point|location|place)|address|where i(?:'m| am) starting)\b[^.]{0,40}\b(changed|different|moved|update|new)\b|\b(i(?:'ve| have)? moved|i'?m now (?:at|in|near|starting)|starting from (?:somewhere|a different))\b/;
  const pref = /\b(change|update|switch|edit)\b[^.]{0,30}\b(preferences?|travel preference|how i travel|route preference)\b|\bi (?:now )?prefer\b/;
  const agree = /\b(i agree|sounds good|works for me|i'?m (?:fine|ok|okay|good) with (?:it|that|the plan)|i accept|i approve)\b/;
  const object = /\b(doesn'?t work for me|does not work for me|i object|i disagree|i'?m not (?:fine|ok|okay) with|not good for me|i don'?t agree)\b/;

  if (FIRST_PERSON.test(text) || /^(running|stuck|delayed|reached|arrived)\b/.test(text)) {
    if (withdraw.test(text)) return { intent: Intent.WITHDRAW };
    if (object.test(text)) return { intent: Intent.OBJECT };
    if (agree.test(text)) return { intent: Intent.AGREE };
    if (loc.test(text)) return { intent: Intent.LOCATION_CHANGE };
    if (pref.test(text)) return { intent: Intent.PREFERENCE_CHANGE };
    if (late.test(text) && !/\bnot late\b|\bwon'?t be late\b/.test(text)) return { intent: Intent.LATE, minutes: parseMinutes(text) };
    if (/\bearly\b/.test(text) && !late.test(text)) { /* "I'm early" is an arrival-ish note; handled below by arrived */ }
    if (meetup.test(text) && arrived.test(text)) return { intent: Intent.AT_MEETUP };
    if (/\b(i'?m|i am|i'?ve|i have) (?:just )?(?:arrived|here)\b/.test(text)) return { intent: Intent.AT_MEETUP };
    if (station.test(text) && /\b(reached|arrived|at|got to|reaching|boarded|on)\b/.test(text)) return { intent: Intent.AT_STATION };
  }
  if (QUESTION_START.test(text) || text.endsWith('?')) return { intent: Intent.QUERY };
  return { intent: Intent.OTHER };
}

// Validate an intent object produced by an optional LLM against the whitelist.
export function validateLlmIntent(v) {
  if (!v || typeof v !== 'object') return null;
  if (!INTENTS.includes(v.intent) || [Intent.YES, Intent.NO, Intent.QUERY].includes(v.intent)) return null;   // classification fallback may not confirm/deny or query
  const out = { intent: v.intent };
  if (v.intent === Intent.LATE) {
    if (v.minutes == null) out.minutes = null;
    else if (Number.isInteger(v.minutes) && v.minutes >= 1 && v.minutes <= MAX_DELAY_MIN) out.minutes = v.minutes; else return null;
  }
  return out;
}

// ── sharing policy ────────────────────────────────────────
// Four classes of data (spec §10F):
//   private    — the conversation itself: stored for its owner only, never published, never sent to other agents
//   group      — a structured update, safe for the whole group (below)
//   visible    — what another participant's agent may tell its owner (only 'group' events + the roster projection)
//   internal   — coordinator working data (reviews, per-agent delivery cursors); never returned to participants as-is
export const EventType = Object.freeze({
  DELAY: 'delay_reported', AT_STATION: 'arrived_at_station', AT_MEETUP: 'arrived_at_meetup', WITHDREW: 'participant_withdrew',
  LOCATION: 'location_changed', JOINED: 'participant_joined', RELEASED: 'seat_released', PLAN_PROPOSED: 'plan_proposed', PLAN_CONFIRMED: 'plan_confirmed',
  PLAN_RESPONSE: 'plan_response', REVIEW: 'review_recommended', GROUP_CANCELLED: 'group_cancelled', SHARING: 'sharing_changed',
});

// Decide what an intent may publish. Returns { publish, type?, shareKey?, required? }.
export function publishPolicy(intent) {
  switch (intent) {
    case Intent.LATE: return { publish: true, type: EventType.DELAY, shareKey: 'delays' };
    case Intent.AT_STATION: return { publish: true, type: EventType.AT_STATION, shareKey: 'arrival' };
    case Intent.AT_MEETUP: return { publish: true, type: EventType.AT_MEETUP, shareKey: 'arrival' };
    case Intent.WITHDRAW: return { publish: true, type: EventType.WITHDREW, required: true };
    case Intent.AGREE: case Intent.OBJECT: return { publish: true, type: EventType.PLAN_RESPONSE, required: true };
    default: return { publish: false };
  }
}

// The exact keys a published payload may carry — anything else is dropped (a free-text reason can never leak through).
export const PAYLOAD_KEYS = Object.freeze({
  [EventType.DELAY]: ['minutes'], [EventType.AT_STATION]: [], [EventType.AT_MEETUP]: [], [EventType.WITHDREW]: [],
  [EventType.LOCATION]: [], [EventType.JOINED]: [], [EventType.RELEASED]: [], [EventType.PLAN_PROPOSED]: ['version'],
  [EventType.PLAN_CONFIRMED]: ['version'], [EventType.PLAN_RESPONSE]: ['response', 'version'], [EventType.REVIEW]: ['reason', 'kind', 'minutes', 'adjusted'],
  [EventType.GROUP_CANCELLED]: [], [EventType.SHARING]: [],
});
export function cleanPayload(type, payload = {}) {
  const allowed = PAYLOAD_KEYS[type] ?? [];
  return Object.fromEntries(Object.entries(payload).filter(([k]) => allowed.includes(k)));
}
