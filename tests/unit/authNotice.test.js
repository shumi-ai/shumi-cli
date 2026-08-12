import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { authExpiryNotice, describeExpiry, EXPIRY_WARN_DAYS } =
  await import('../../src/lib/authNotice.js');

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-12T12:00:00.000Z');

/** Unsigned JWT expiring `days` from NOW. */
function tokenExpiringIn(days) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor((NOW + days * DAY) / 1000);
  return `${b64({ alg: 'none' })}.${b64({ exp })}.sig`;
}

describe('authExpiryNotice', () => {
  let orig;
  beforeEach(() => {
    orig = process.env.SHUMI_TOKEN;
    process.env.SHUMI_NO_CONFIG = '1'; // ignore the developer's real config
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.SHUMI_TOKEN; else process.env.SHUMI_TOKEN = orig;
    delete process.env.SHUMI_NO_CONFIG;
  });

  it('warns inside the window', () => {
    process.env.SHUMI_TOKEN = tokenExpiringIn(4);
    const n = authExpiryNotice(NOW);
    expect(n).toMatchObject({ daysRemaining: 4, action: 'shumi login' });
  });

  it('stays silent outside it', () => {
    process.env.SHUMI_TOKEN = tokenExpiringIn(EXPIRY_WARN_DAYS);
    expect(authExpiryNotice(NOW)).toBeNull();
    process.env.SHUMI_TOKEN = tokenExpiringIn(29);
    expect(authExpiryNotice(NOW)).toBeNull();
  });

  // AUTH_EXPIRED owns the already-expired case. Two surfaces announcing the
  // same failure is how you teach people to ignore both.
  it('says nothing once the token has actually expired', () => {
    process.env.SHUMI_TOKEN = tokenExpiringIn(-1);
    expect(authExpiryNotice(NOW)).toBeNull();
  });

  it('says nothing with no credential', () => {
    delete process.env.SHUMI_TOKEN;
    expect(authExpiryNotice(NOW)).toBeNull();
  });

  // API keys can't be decoded client-side; inventing an expiry is worse than
  // staying quiet.
  it('skips opaque API keys', () => {
    process.env.SHUMI_TOKEN = 'shumi_sk_live.abc123';
    expect(authExpiryNotice(NOW)).toBeNull();
  });

  it('handles the last day without going negative', () => {
    process.env.SHUMI_TOKEN = tokenExpiringIn(0.5);
    const n = authExpiryNotice(NOW);
    expect(n.daysRemaining).toBe(0);
    expect(describeExpiry(n)).toBe('expires today');
  });
});

describe('describeExpiry', () => {
  it('reads naturally at each boundary', () => {
    expect(describeExpiry({ daysRemaining: 0 })).toBe('expires today');
    expect(describeExpiry({ daysRemaining: 1 })).toBe('expires in 1 day');
    expect(describeExpiry({ daysRemaining: 4 })).toBe('expires in 4 days');
  });
});
