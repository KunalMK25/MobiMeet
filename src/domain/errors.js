// Domain error convention: every rejection carries a stable machine code
// (for API responses/tests) and a safe human message (no private data).
export const ErrorCode = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_MODE: 'INVALID_MODE',
  MODE_MISMATCH: 'MODE_MISMATCH',
  MODE_LOCKED: 'MODE_LOCKED',
  GROUP_CLOSED: 'GROUP_CLOSED',
  DUPLICATE_MEMBER: 'DUPLICATE_MEMBER',
  MISSING_ORIGIN: 'MISSING_ORIGIN',
  INVITE_INVALID: 'INVITE_INVALID',
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  INVITE_REVOKED: 'INVITE_REVOKED',
  FORBIDDEN: 'FORBIDDEN',
  BAD_TRANSITION: 'BAD_TRANSITION',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFLICT: 'CONFLICT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  NOT_READY: 'NOT_READY',
});

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export const fail = (code, message) => { throw new DomainError(code, message); };
