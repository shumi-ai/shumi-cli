import { describe, it, expect } from 'vitest';
import { inspectToken } from '../../src/lib/token.js';

// Build a JWT with a given payload (header/sig are dummy — we only decode payload).
function makeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

describe('inspectToken', () => {
  it('reports no token', () => {
    const r = inspectToken(null);
    expect(r).toMatchObject({ kind: 'none', valid: false });
  });

  it('treats shumi_sk_ as a valid API key (format only)', () => {
    const r = inspectToken('shumi_sk_abc.def');
    expect(r.kind).toBe('API key');
    expect(r.valid).toBe(true);
  });

  it('flags a malformed JWT', () => {
    const r = inspectToken('not.a.jwt.too.many');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/malformed/);
  });

  it('flags undecodable payload', () => {
    const r = inspectToken('aaa.@@@.ccc');
    expect(r.valid).toBe(false);
  });

  it('accepts an unexpired JWT', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const r = inspectToken(makeJwt({ exp: future, email: 'x@y.z', sub: 'u1' }));
    expect(r.valid).toBe(true);
    expect(r.expired).toBe(false);
    expect(r.email).toBe('x@y.z');
    expect(r.expiresAt).toMatch(/^\d{4}-/);
  });

  it('rejects an expired JWT and names the expiry in the reason', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const r = inspectToken(makeJwt({ exp: past }));
    expect(r.valid).toBe(false);
    expect(r.expired).toBe(true);
    expect(r.reason).toMatch(/expired/);
  });

  it('makes NO network call (pure/offline)', () => {
    // If inspectToken ever reached for fetch, this would throw — it must not.
    const orig = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('inspectToken must not hit the network'); };
    try {
      const future = Math.floor(Date.now() / 1000) + 60;
      expect(inspectToken(makeJwt({ exp: future })).valid).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
