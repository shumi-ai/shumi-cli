import { describe, it, expect } from 'vitest';
import { __testing } from '../../src/lib/x402-client.js';

const { describeGate, resetPhrase } = __testing;

/**
 * The server attaches a `gate` block to every 402. The CLI used to discard it
 * and report only the payment-flow failure, so a user out of free quota was
 * told "No passphrase provided." — a sentence about wallets, when what actually
 * happened is that they hit their daily limit. Fixture below is a real 402 body
 * from production (2026-08-24).
 */
const LIVE_GATE = {
  tier: 'free',
  used: 1,
  limit: 1,
  quota: { used: 1, limit: 1, remaining: 0, period: 'day', wall: 'drip' },
  reset_at: '2026-08-25T00:00:00.000Z',
  this_query: { route: 'coin/risk/BTC', price_usdc: '0.005' },
  upgrade_url: 'https://shumi.ai/pricing',
};

describe('the quota block is turned into something a user can act on', () => {
  it('names the limit, the tier and the upgrade path', () => {
    const out = describeGate(LIVE_GATE);
    expect(out).toContain('1 of 1 per day');
    expect(out).toContain('free tier');
    expect(out).toContain('https://shumi.ai/pricing');
  });

  it('says nothing when there is nothing useful to say', () => {
    // Callers fall back to the bare reason, rather than printing an empty
    // preamble above it.
    expect(describeGate(null)).toBe(null);
    expect(describeGate({})).toBe(null);
    expect(describeGate({ tier: 'free' })).toBe(null);
    expect(describeGate('nonsense')).toBe(null);
  });

  it('reads the counters off a flat gate as well as a nested quota', () => {
    expect(describeGate({ tier: 'access', used: 40, limit: 50, period: 'day' }))
      .toContain('40 of 50 per day');
  });
});

describe('the lifetime grant is not described as resetting', () => {
  // The free tier is a lifetime grant plus a one-a-day drip. Only the drip
  // refills; `reset_at` is when it next does. "10 of 10 per lifetime used.
  // Resets in 8h" promised ten queries back and delivered one.
  const GRANT_GATE = {
    tier: 'free',
    used: 10,
    limit: 10,
    quota: { used: 10, limit: 10, remaining: 0, period: 'lifetime', wall: 'grant' },
    reset_at: new Date(Date.now() + 8 * 3600_000).toISOString(),
    upgrade_url: 'https://shumi.ai/pricing',
  };

  it('says the grant is used up and that one free query comes back', () => {
    const out = describeGate(GRANT_GATE);
    expect(out).toContain('all 10 lifetime queries used on the free tier');
    expect(out).toContain('Your next free query unlocks in 8h.');
    expect(out).not.toMatch(/Resets/);
    expect(out).not.toContain('per lifetime');
  });

  it('keys off the wall too, for a gate that carries no period', () => {
    const out = describeGate({ ...GRANT_GATE, quota: { used: 10, limit: 10, wall: 'grant' } });
    expect(out).toContain('all 10 lifetime queries used');
    expect(out).not.toMatch(/Resets/);
  });

  it('keeps "Resets" for a daily quota, which does reset', () => {
    const out = describeGate({ ...LIVE_GATE, reset_at: GRANT_GATE.reset_at });
    expect(out).toContain('1 of 1 per day');
    expect(out).toContain('Resets in 8h.');
  });
});

describe('reset time is phrased relatively', () => {
  it('uses minutes under an hour and hours under two days', () => {
    expect(resetPhrase(new Date(Date.now() + 30 * 60_000).toISOString())).toMatch(/in 30m/);
    expect(resetPhrase(new Date(Date.now() + 10 * 3600_000).toISOString())).toMatch(/in 10h/);
  });

  it('falls back to a date further out', () => {
    const far = new Date(Date.now() + 5 * 86400_000).toISOString();
    expect(resetPhrase(far)).toBe(`on ${far.slice(0, 10)}`);
  });

  it('treats an elapsed reset as now, and tolerates garbage', () => {
    expect(resetPhrase(new Date(Date.now() - 1000).toISOString())).toBe('now');
    expect(resetPhrase('not a date')).toBe(null);
    expect(resetPhrase(undefined)).toBe(null);
  });
});
