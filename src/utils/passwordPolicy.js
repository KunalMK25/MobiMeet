// ═══════════════════════════════════════════════════════════
//  utils/passwordPolicy.js — ONE password policy, shared by the server (enforcement) and the browser (live feedback)
//  Following current NIST guidance: length matters, arbitrary "must contain a symbol" rules do not. We require ≥10
//  characters, reject very common passwords and passwords that merely repeat the user's own email or name.
// ═══════════════════════════════════════════════════════════
export const PASSWORD = Object.freeze({ min: 10, max: 200 });

const COMMON = new Set(['password', 'password1', 'password123', 'passw0rd123', 'qwertyuiop', 'qwerty123456', 'qwertyuiopasdf', '1234567890', '12345678910', '0123456789', '1q2w3e4r5t', 'iloveyou123',
  'letmein1234', 'welcome1234', 'welcome123', 'admin12345', 'administrator', 'abcdefghij', 'abcd123456', 'abc1234567', 'monkey1234', 'dragon1234', 'football123', 'baseball123', 'princess123',
  'changeme123', 'trustno1234', 'bangalore123', 'bengaluru123', 'mobimeet123', 'metromeet123', 'india12345', 'india123456', 'sunshine123', 'superman123', 'master12345', 'shadow12345']);

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// → list of plain-language problems (empty = acceptable). `context` = {email, name} to stop passwords built from them.
export function passwordProblems(pw, context = {}) {
  const out = [];
  if (typeof pw !== 'string' || pw.length < PASSWORD.min) out.push(`Use at least ${PASSWORD.min} characters.`);
  if (typeof pw === 'string' && pw.length > PASSWORD.max) out.push(`Use at most ${PASSWORD.max} characters.`);
  if (typeof pw === 'string' && pw.length >= PASSWORD.min) {
    const flat = squash(pw);
    if (COMMON.has(flat) || COMMON.has(pw.toLowerCase())) out.push('That password is too common — choose something less guessable.');
    if (/^(.)\1+$/.test(pw)) out.push('Do not repeat a single character.');
    const local = squash(String(context.email ?? '').split('@')[0]), nm = squash(context.name);
    if (local.length >= 4 && flat.includes(local) && flat.length - local.length <= 6) out.push('Do not build your password from your email address.');
    if (nm.length >= 4 && flat.includes(nm) && flat.length - nm.length <= 6) out.push('Do not build your password from your name.');
  }
  return out;
}

// Rough, honest strength hint for the UI meter (not a security guarantee): length first, then variety.
export function passwordStrength(pw) {
  if (typeof pw !== 'string' || !pw) return { score: 0, label: '' };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  const words = pw.trim().split(/\s+/).length;                         // passphrases are good
  const score = pw.length < PASSWORD.min ? 1 : pw.length >= 16 || words >= 4 ? 4 : pw.length >= 13 || classes >= 3 ? 3 : 2;
  return { score, label: ['', 'Too short', 'Okay', 'Good', 'Strong'][score] };
}
