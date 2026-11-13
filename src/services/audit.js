// Security-relevant events. `detail` must never contain coordinates or secrets.
const FORBIDDEN_KEYS = /lat|lon|origin|password|token|secret|key/i;
export async function audit(db, { actorId = null, groupId = null, type, detail = {}, }) {
  const safe = Object.fromEntries(Object.entries(detail).filter(([k]) => !FORBIDDEN_KEYS.test(k)));
  await db.query('INSERT INTO audit_events (actor_id, group_id, event_type, detail) VALUES ($1,$2,$3,$4)', [actorId, groupId, type, JSON.stringify(safe)]);
}
