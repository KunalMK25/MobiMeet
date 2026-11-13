import { ErrorCode, fail } from '../domain/errors.js';
import { hashPassword, verifyPassword, dummyVerify, randomToken, sha256hex } from './crypto.js';
import { validateEmail, validatePassword, validateText, validatePrefs } from './validation.js';
import { consume } from './rateLimit.js';
import { audit } from './audit.js';

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const publicUser = (r) => ({ id: r.id, email: r.email, displayName: r.display_name, createdAt: r.created_at });

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

export function createAuthService({ db, clock = Date.now, mailer = null, resetUrl = (t) => `/app/#/reset/${t}` }) {
  async function startSession(t, userId) {
    const token = randomToken(32);
    await t.query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [userId, sha256hex(token), new Date(clock() + SESSION_TTL_MS)]);
    return token;
  }
  return {
    async register({ email, password, displayName }, { ip = 'unknown' } = {}) {
      await consume(db, { key: `register:${ip}`, limit: 10, windowSec: 3600, now: clock() });
      const e = validateEmail(email), n = validateText(displayName, { max: 60, what: 'Display name' }), p = validatePassword(password, { email: e, name: n });
      const hash = await hashPassword(p);
      try {
        return await db.tx(async (t) => {
          const u = (await t.query('INSERT INTO users (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING *', [e, n, hash])).rows[0];
          await t.query('INSERT INTO user_profiles (user_id) VALUES ($1)', [u.id]);
          const token = await startSession(t, u.id);
          await audit(t, { actorId: u.id, type: 'user.registered' });
          return { user: publicUser(u), sessionToken: token };
        });
      } catch (err) {
        if (/unique/i.test(String(err.message))) fail(ErrorCode.CONFLICT, 'That email is already registered.');
        throw err;
      }
    },

    async login({ email, password }, { ip = 'unknown' } = {}) {
      await consume(db, { key: `login:${ip}`, limit: 30, windowSec: 900, now: clock() });
      const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
      await consume(db, { key: `login-acct:${e}`, limit: 10, windowSec: 900, now: clock() });
      const u = (await db.query('SELECT * FROM users WHERE lower(email) = $1', [e])).rows[0];
      const ok = u && typeof password === 'string' ? await verifyPassword(password, u.password_hash) : await dummyVerify(String(password ?? ''));
      if (!ok) { await audit(db, { actorId: u?.id ?? null, type: 'login.failed' }); fail(ErrorCode.UNAUTHENTICATED, 'Incorrect email or password.'); }
      const token = await db.tx((t) => startSession(t, u.id));
      await audit(db, { actorId: u.id, type: 'login.succeeded' });
      return { user: publicUser(u), sessionToken: token };
    },

    // ── password management ────────────────────────────────
    // Whether password reset by email can work on this server (the UI says so instead of pretending).
    capabilities() { return { passwordReset: !!mailer?.enabled, mailMode: mailer?.mode ?? 'disabled' }; },

    // Always answers the same way — whether or not the address is registered — so it cannot be used to discover accounts.
    async requestPasswordReset({ email }, { ip = 'unknown' } = {}) {
      if (!mailer?.enabled) fail(ErrorCode.PROVIDER_UNAVAILABLE, 'Password reset by email is not available on this server yet.');
      const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
      await consume(db, { key: `forgot-ip:${ip}`, limit: 10, windowSec: 3600, now: clock() });
      await consume(db, { key: `forgot:${sha256hex(e)}`, limit: 3, windowSec: 3600, now: clock() });
      const u = e && e.length <= 254 ? (await db.query('SELECT id, email, display_name FROM users WHERE lower(email) = $1', [e])).rows[0] : null;
      if (u) {
        const token = randomToken(32);
        await db.tx(async (t) => {
          await t.query('UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL', [u.id, new Date(clock())]);   // only the newest link works
          await t.query('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [u.id, sha256hex(token), new Date(clock() + RESET_TOKEN_TTL_MS)]);
          await audit(t, { actorId: u.id, type: 'password.reset_requested' });
        });
        try { await mailer.send({ to: u.email, subject: 'Reset your MobiMeet password', text: `Hi ${u.display_name},\n\nUse this link within 30 minutes to choose a new password:\n${resetUrl(token)}\n\nIf you did not ask for this, you can ignore this email — your password stays the same.` }); }
        catch { /* delivery failure is not revealed to the requester */ }
      }
      return { ok: true };
    },

    async resetPassword({ token, password }, { ip = 'unknown' } = {}) {
      await consume(db, { key: `reset-ip:${ip}`, limit: 20, windowSec: 3600, now: clock() });
      const bad = () => fail(ErrorCode.INVALID_INPUT, 'This reset link is invalid or has expired. Request a new one.');
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) bad();
      return db.tx(async (t) => {
        const r = (await t.query('SELECT * FROM password_resets WHERE token_hash = $1 FOR UPDATE', [sha256hex(token)])).rows[0];
        if (!r || r.used_at || new Date(r.expires_at).getTime() <= clock()) bad();
        const u = (await t.query('SELECT id, email, display_name FROM users WHERE id = $1', [r.user_id])).rows[0];
        const pw = validatePassword(password, { email: u.email, name: u.display_name });
        await t.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, await hashPassword(pw)]);
        await t.query('UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL', [u.id, new Date(clock())]);
        await t.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);                    // everyone is signed out
        await audit(t, { actorId: u.id, type: 'password.reset_completed' });
        return { ok: true };
      });
    },

    // Signed-in password change: needs the current password; every OTHER session is signed out.
    async changePassword(userId, { currentPassword, newPassword }, { sessionToken } = {}) {
      await consume(db, { key: `chpw:${userId}`, limit: 10, windowSec: 3600, now: clock() });
      const u = (await db.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
      if (!u || typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, u.password_hash))) fail(ErrorCode.UNAUTHENTICATED, 'Your current password is not correct.');
      const pw = validatePassword(newPassword, { email: u.email, name: u.display_name });
      if (pw === currentPassword) fail(ErrorCode.INVALID_INPUT, 'Choose a password that is different from the current one.');
      await db.tx(async (t) => {
        await t.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, await hashPassword(pw)]);
        await t.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2', [userId, sha256hex(sessionToken ?? '')]);
        await audit(t, { actorId: userId, type: 'password.changed' });
      });
      return { ok: true };
    },

    async logoutEverywhere(userId) {
      const r = await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id', [userId]);
      await audit(db, { actorId: userId, type: 'session.logout_everywhere' });
      return { ok: true, sessionsEnded: r.rows.length };
    },

    async logout(sessionToken) {
      if (!sessionToken) return;
      await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256hex(sessionToken)]);
    },

    // Returns the user for a valid session token, or null.
    async authenticate(sessionToken) {
      if (!sessionToken || typeof sessionToken !== 'string') return null;
      const r = await db.query(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`, [sha256hex(sessionToken), new Date(clock())]);
      return r.rows[0] ? publicUser(r.rows[0]) : null;
    },

    async getProfile(userId) {
      const r = await db.query('SELECT u.*, p.default_prefs, p.saved_places FROM users u JOIN user_profiles p ON p.user_id = u.id WHERE u.id = $1', [userId]);
      if (!r.rows[0]) fail(ErrorCode.NOT_FOUND, 'Profile not found.');
      return { ...publicUser(r.rows[0]), defaultPrefs: r.rows[0].default_prefs, savedPlaces: r.rows[0].saved_places };
    },

    async updateProfile(userId, { displayName, defaultPrefs, savedPlaces } = {}) {
      return db.tx(async (t) => {
        if (displayName !== undefined) await t.query('UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1', [userId, validateText(displayName, { max: 60, what: 'Display name' })]);
        if (defaultPrefs !== undefined) await t.query('UPDATE user_profiles SET default_prefs = $2, updated_at = now() WHERE user_id = $1', [userId, JSON.stringify(validatePrefs(defaultPrefs))]);
        if (savedPlaces !== undefined) {
          if (!Array.isArray(savedPlaces) || savedPlaces.length > 10) fail(ErrorCode.INVALID_INPUT, 'At most 10 saved places.');
          const clean = savedPlaces.map(sp => {
            const label = validateText(sp?.label, { max: 60, what: 'Place label' });
            if (typeof sp.lat !== 'number' || typeof sp.lon !== 'number' || Math.abs(sp.lat) > 90 || Math.abs(sp.lon) > 180) fail(ErrorCode.INVALID_INPUT, 'Saved place needs valid coordinates.');
            return { label, lat: sp.lat, lon: sp.lon };
          });
          await t.query('UPDATE user_profiles SET saved_places = $2, updated_at = now() WHERE user_id = $1', [userId, JSON.stringify(clean)]);
        }
        return { ok: true };
      });
    },
  };
}
