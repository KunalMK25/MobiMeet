import { ErrorCode, fail } from './errors.js';

// Invitation tokens: 256-bit random, URL-safe. Only the SHA-256 hash is stored.
// Uses the Web Crypto API (global in Node >=18 and browsers).
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function generateInviteToken() {
  return b64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashInviteToken(token) {
  const data = new TextEncoder().encode(String(token));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createInvitation({ groupId, createdBy, now = Date.now(), ttlMs = DEFAULT_INVITE_TTL_MS }) {
  if (!groupId || !createdBy) fail(ErrorCode.INVALID_INPUT, 'groupId and createdBy are required.');
  const token = generateInviteToken();
  return {
    token, // returned once to the creator; never persisted
    record: { groupId, createdBy, tokenHash: await hashInviteToken(token), expiresAt: now + ttlMs, revokedAt: null },
  };
}

// Constant-shape failure for unknown tokens so link holders learn nothing about groups.
export function assertInvitationUsable(record, now = Date.now()) {
  if (!record) fail(ErrorCode.INVITE_INVALID, 'This invitation is not valid.');
  if (record.revokedAt != null) fail(ErrorCode.INVITE_REVOKED, 'This invitation has been revoked.');
  if (now >= record.expiresAt) fail(ErrorCode.INVITE_EXPIRED, 'This invitation has expired.');
  return record;
}
