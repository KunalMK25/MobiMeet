// Server-side crypto helpers (Node built-ins only; no third-party crypto).
import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(_scrypt);

const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, n, r, p, saltB64, keyB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +r, p: +p });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch { return false; }
}

// A real hash of a random string, used to equalise timing when an email does not exist.
let dummy;
export async function dummyVerify(password) {
  dummy ??= await hashPassword(randomBytes(8).toString('hex'));
  await verifyPassword(password, dummy);
  return false;
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');
export const constantTimeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
