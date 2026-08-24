import { describe, it, expect } from 'vitest';
import { symbolDidNotResolve } from '../../src/commands/signal.js';

/**
 * `/api/cli/signal/<symbol>` answers 200 for a symbol that does not exist, with
 * verdict "neutral", score 0 and confidence "medium". The miss is only visible
 * inside raw.risk. Payloads below are trimmed from real responses (2026-08-24).
 */
describe('a signal for an unresolved symbol is not a verdict', () => {
  const unresolved = {
    symbol: 'ZZZQQQFAKE',
    verdict: 'neutral',
    score: 0,
    confidence: 'medium',
    as_of: null,
    evidence: [],
    sources: { risk_context: 'fulfilled', regime_active: 'fulfilled' },
    raw: { risk: { error: 'Unknown symbol: ZZZQQQFAKE', stale_fields: [], data: null }, funding: null },
  };

  it('detects the miss the envelope reports as fulfilled', () => {
    expect(symbolDidNotResolve(unresolved)).toBe(true);
  });

  it('does not fire on a real coin', () => {
    expect(symbolDidNotResolve({
      symbol: 'BTC', verdict: 'bull', score: 1.5, confidence: 'high',
      as_of: '2026-08-24T12:28:21.237Z',
      evidence: ['trend (daily) is UP since 2026-08-19'],
      sources: { risk_context: 'fulfilled' },
      raw: { risk: { error: null, data: { price: 78530 } } },
    })).toBe(false);
  });

  it('does not fire on a thin but genuine reading', () => {
    // Risk resolved and there is evidence — a real coin with sparse upstreams
    // must still produce its verdict rather than be rejected as unknown.
    expect(symbolDidNotResolve({
      symbol: 'SOME', verdict: 'neutral', score: 0, confidence: 'low',
      as_of: '2026-08-24T12:00:00Z', evidence: ['funding APR 3.1%'],
      raw: { risk: { error: null, data: { price: 1 } } },
    })).toBe(false);
  });

  it('does not fire when risk errored but other inputs still resolved', () => {
    expect(symbolDidNotResolve({
      symbol: 'SOME', verdict: 'bull', score: 1, confidence: 'medium',
      as_of: '2026-08-24T12:00:00Z', evidence: ['regime is risk-on'],
      raw: { risk: { error: 'upstream timeout', data: null } },
    })).toBe(false);
  });

  it('tolerates a malformed payload rather than throwing', () => {
    expect(symbolDidNotResolve(null)).toBe(false);
    expect(symbolDidNotResolve({})).toBe(false);
  });
});
