import { describe, it, expect } from 'vitest';
import { inspectToken } from '../../src/lib/token.js';

/**
 * Direct coverage for the offline credential inspector. authNotice.test.js
 * exercises it indirectly; this suite pins the classification contract itself.
 * The stateless-JWT design means an expired/malformed token is invisible
 * server-side — this function is the ONLY place the user learns why auth fails.
 */

/** Minimal unsigned JWT — inspectToken only decodes the payload segment. */
function makeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

const NOW_MS = Date.parse('2026-08-25T00:00:00Z');
const NOW_S = Math.floor(NOW_MS / 1000);

describe('inspectToken — absent and opaque credentials', () => {
  it('null/undefined/empty → kind none, invalid, not expired', () => {
    for (const t of [null, undefined, '']) {
      expect(inspectToken(t)).toEqual({ kind: 'none', valid: false, expired: false, reason: 'no token' });
    }
  });

  it('shumi_sk_* API keys pass on format alone (opaque, not decodable)', () => {
    const r = inspectToken('shumi_sk_abc123');
    expect(r.kind).toBe('API key');
    expect(r.valid).toBe(true);
    expect(r.expired).toBe(false);
  });
});

describe('inspectToken — malformed JWTs', () => {
  it('wrong segment count is malformed, never "expired"', () => {
    const r = inspectToken('a.b');
    expect(r).toMatchObject({ kind: 'JWT', valid: false, expired: false });
    expect(r.reason).toContain('malformed');
  });

  it('undecodable payload is reported as such', () => {
    const r = inspectToken('aaa.%%%not-base64%%%.ccc');
    expect(r).toMatchObject({ kind: 'JWT', valid: false, expired: false, reason: 'undecodable payload' });
  });

  it('valid base64 that is not JSON is undecodable', () => {
    const bad = Buffer.from('not json at all').toString('base64url');
    expect(inspectToken(`h.${bad}.s`).reason).toBe('undecodable payload');
  });
});

describe('inspectToken — expiry against the injected clock', () => {
  it('future exp is valid and surfaces email/sub', () => {
    const r = inspectToken(makeJwt({ exp: NOW_S + 3600, email: 'a@b.c', sub: 'user-1' }), NOW_MS);
    expect(r.valid).toBe(true);
    expect(r.expired).toBe(false);
    expect(r.email).toBe('a@b.c');
    expect(r.sub).toBe('user-1');
    expect(r.expiresAt).toBe(new Date((NOW_S + 3600) * 1000).toISOString());
  });

  it('past exp is expired with the timestamp in the reason', () => {
    const r = inspectToken(makeJwt({ exp: NOW_S - 60 }), NOW_MS);
    expect(r.valid).toBe(false);
    expect(r.expired).toBe(true);
    expect(r.reason).toContain('expired');
  });

  it('exp exactly at now is NOT expired (strict less-than)', () => {
    const r = inspectToken(makeJwt({ exp: NOW_S }), NOW_MS);
    expect(r.expired).toBe(false);
    expect(r.valid).toBe(true);
  });

  it('uses the injected clock, not wall time — the 2026-08-16 regression', () => {
    // exp is in the real past but the injected "now" is before it → valid.
    const past = Math.floor(Date.parse('2020-06-01T00:00:00Z') / 1000);
    const r = inspectToken(makeJwt({ exp: past }), (past - 100) * 1000);
    expect(r.expired).toBe(false);
  });

  it('no exp claim → valid, null exp/expiresAt (never treated as expired)', () => {
    const r = inspectToken(makeJwt({ sub: 'x' }), NOW_MS);
    expect(r.valid).toBe(true);
    expect(r.expired).toBe(false);
    expect(r.exp).toBeNull();
    expect(r.expiresAt).toBeNull();
  });

  it('non-numeric exp is ignored rather than coerced', () => {
    const r = inspectToken(makeJwt({ exp: 'tomorrow' }), NOW_MS);
    expect(r.expired).toBe(false);
    expect(r.exp).toBeNull();
  });
});
