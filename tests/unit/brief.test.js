import { describe, it, expect } from 'vitest';
import { __test } from '../../src/commands/brief.js';

const { pnlPct, fmtPrice, dirGlyph, clampInt, byExitDateDesc, positionLine, exitLine, watchLine } = __test;

// strip ANSI so assertions read the plain text the user sees
const plain = (s) => s.replace(/\[[0-9;]*m/g, '');

describe('pnlPct — P&L computed from entry/current/direction', () => {
  it('long: gain when price rises', () => {
    expect(pnlPct(100, 110, 'long')).toBeCloseTo(10);
  });
  it('short: gain when price falls', () => {
    expect(pnlPct(100, 90, 'short')).toBeCloseTo(10);
  });
  it('long: loss when price falls', () => {
    expect(pnlPct(100, 90, 'long')).toBeCloseTo(-10);
  });
  it('returns null on missing/zero/NaN inputs', () => {
    expect(pnlPct(100, null, 'long')).toBeNull();
    expect(pnlPct(0, 50, 'long')).toBeNull();
    expect(pnlPct('x', 50, 'long')).toBeNull();
  });
});

describe('fmtPrice — tiered price formatting', () => {
  it.each([
    [98500, '$98,500'],
    [12.34, '$12.34'],
    [0.0001234, '$0.0001234'],
  ])('formats %s → %s', (n, expected) => {
    expect(fmtPrice(n)).toBe(expected);
  });
  it('handles missing price', () => {
    expect(fmtPrice(null)).toBe('—');
    expect(fmtPrice(undefined)).toBe('—');
  });
});

describe('dirGlyph', () => {
  it('maps direction to colored glyph', () => {
    expect(plain(dirGlyph('long'))).toBe('▲');
    expect(plain(dirGlyph('short'))).toBe('▼');
    expect(plain(dirGlyph('weird'))).toBe('•');
  });
});

describe('clampInt — flag parsing bounds', () => {
  it('parses valid ints, falls back, and caps at 50', () => {
    expect(clampInt('7', 5)).toBe(7);
    expect(clampInt('notanumber', 5)).toBe(5);
    expect(clampInt('0', 5)).toBe(5);
    expect(clampInt('999', 5)).toBe(50);
  });
});

describe('byExitDateDesc — most recent exits first', () => {
  it('sorts descending by exitDate', () => {
    const rows = [{ exitDate: '2026-01-10' }, { exitDate: '2026-01-20' }, { exitDate: '2026-01-15' }];
    const sorted = rows.slice().sort(byExitDateDesc);
    expect(sorted.map((r) => r.exitDate)).toEqual(['2026-01-20', '2026-01-15', '2026-01-10']);
  });
});

// Fixtures mirror the verified coinrotator-ai response shapes.
describe('positionLine — open position (regime/active + walkforward/positions shape)', () => {
  it('renders symbol, entry→current, computed P&L%, hold days', () => {
    const p = { symbol: 'btc', direction: 'long', entryPrice: 98500, currentPrice: 99200, holdDays: 3 };
    const line = plain(positionLine(p));
    expect(line).toContain('▲');
    expect(line).toContain('BTC');
    expect(line).toContain('$98,500');
    expect(line).toContain('$99,200');
    expect(line).toContain('+0.7%');
    expect(line).toContain('3d');
  });
  it('degrades gracefully when currentPrice is null', () => {
    const p = { symbol: 'eth', direction: 'long', entryPrice: 3450, currentPrice: null, holdDays: 1 };
    const line = plain(positionLine(p));
    expect(line).toContain('ETH');
    expect(line).toContain('no live price');
  });
});

describe('exitLine — closed trade (walkforward/outcomes shape)', () => {
  it('renders returnPct (already a percent), hold days, exit reason', () => {
    const e = { symbol: 'sol', direction: 'long', returnPct: -0.9, holdDays: 2, exitReason: 'band_touch_exit', exitDate: '2026-01-20' };
    const line = plain(exitLine(e));
    expect(line).toContain('SOL');
    expect(line).toContain('-0.9%');
    expect(line).toContain('2d');
    expect(line).toContain('band_touch_exit');
  });
});

describe('watchLine — pending signal (futures/state shape)', () => {
  it('renders asset, signalType, regime, conviction', () => {
    const w = { asset: 'bnb', direction: 'long', signalType: 'st_flip', regime: 'OVEREXTENDED', conviction: 'high', resolvedAt: null };
    const line = plain(watchLine(w));
    expect(line).toContain('BNB');
    expect(line).toContain('st_flip');
    expect(line).toContain('OVEREXTENDED');
    expect(line).toContain('high');
  });
});
