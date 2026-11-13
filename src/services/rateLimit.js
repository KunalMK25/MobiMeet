// DB-backed fixed-window limiter: works across serverless instances (in-memory counters would not).
import { DomainError, ErrorCode } from '../domain/errors.js';

export async function consume(db, { key, limit, windowSec, now }) {
  const windowStart = new Date(Math.floor(now / (windowSec * 1000)) * windowSec * 1000);
  const r = await db.query(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1,$2,1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`, [key, windowStart]);
  if (r.rows[0].count > limit) throw new DomainError(ErrorCode.RATE_LIMITED, 'Too many requests. Please wait and try again.');
  return r.rows[0].count;
}
// Atomic "take `amount` units from this window if they fit" — never over-spends and a refused request does NOT use up the budget.
// Works across serverless instances because the counter lives in the database. Returns true/false.
export async function reserve(db, { key, limit, windowSec, now, amount = 1 }) {
  if (!(amount > 0) || amount > limit) return false;
  const windowStart = new Date(Math.floor(now / (windowSec * 1000)) * windowSec * 1000);
  const r = await db.query(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1,$2,$3)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + $3 WHERE rate_limits.count + $3 <= $4 RETURNING count`, [key, windowStart, amount, limit]);
  return r.rows.length > 0;
}
export async function release(db, { key, windowSec, now, amount = 1 }) {      // give back units reserved moments ago (a later check failed)
  const windowStart = new Date(Math.floor(now / (windowSec * 1000)) * windowSec * 1000);
  await db.query('UPDATE rate_limits SET count = GREATEST(count - $3, 0) WHERE key=$1 AND window_start=$2', [key, windowStart, amount]);
}
// Rows older than the longest window we use (24 h daily budgets) plus a margin are removed.
export async function purgeOld(db, now, olderThanSec = 26 * 3600) {
  await db.query('DELETE FROM rate_limits WHERE window_start < $1', [new Date(now - olderThanSec * 1000)]);
}
