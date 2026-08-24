import { describe, it, expect, vi } from 'vitest';
import { smartFormat } from '../../src/lib/smartFormat.js';

/**
 * Field names and value ranges here are not invented — they were taken from a
 * census of every numeric key returned by a live sweep of all 37 CLI commands
 * on a pro-tier account (2026-08-24). Each case below is a value the CLI
 * actually rendered wrongly, at the magnitudes the API actually returns.
 */

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Render one key/value pair and return the printed text, ANSI stripped. */
function render(key, value) {
  let buf = '';
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { buf += a.join(' ') + '\n'; });
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { buf += chunk; return true; });
  try {
    smartFormat({ [key]: value });
  } finally {
    spy.mockRestore();
    write.mockRestore();
  }
  return buf.replace(ANSI, '');
}

describe('percent formatting is keyed on whole words, not substrings', () => {
  // A price map keyed by coin id: `microstrategy` contains "rate",
  // `ultrapro`/`apriori` contain "apr". These are prices, not percentages.
  it.each([
    ['microstrategy-xstock', 119.74],
    ['proshares-ultrapro-qqq-ondo-tokenized', 69.65],
    ['apriori', 0.19968],
    ['strategy-stretch-preferred-ondo-tokenized', 100.9],
  ])('does not render coin id %s as a percentage', (key, value) => {
    expect(render(key, value)).not.toMatch(/%/);
  });

  it('still renders genuine percent fields as percentages', () => {
    expect(render('fundingApr', 10.95)).toMatch(/10\.95%/);
    expect(render('change_24h_pct', 1.5961)).toMatch(/1\.60%/);
    expect(render('spreadPct', 58.36)).toMatch(/58\.36%/);
  });
});

describe('0-1 fractions are scaled, not printed as sub-1% values', () => {
  // walkforwardAdapter.js stores winRate as wins/trades. 5 of 8 is 0.625;
  // the old formatter printed "0.63%" directly under "wins 5 / trades 8".
  it('scales winRate from a fraction to a percentage', () => {
    expect(render('winRate', 0.635)).toMatch(/63\.50%/);
  });

  it('renders a perfect winRate as 100%, not 1%', () => {
    expect(render('winRate', 1)).toMatch(/100\.00%/);
  });

  it('passes through a rate already expressed in percent units', () => {
    expect(render('winRate', 62)).toMatch(/62\.00%/);
  });

  it('prints percentile bare, since a percentile has no percent unit', () => {
    const out = render('percentile', 0.92);
    expect(out).toMatch(/92/);
    expect(out).not.toMatch(/%/);
  });
});

describe('magnitudes survive formatting', () => {
  it('keeps sub-basis-point rates legible instead of collapsing to 0.00%', () => {
    expect(render('hourlyRate', 0.0000107878)).not.toMatch(/\b0\.00%/);
  });

  it('keeps sub-unit scores instead of flattening them to 0.0', () => {
    expect(render('freshness_score', 0.711401)).toMatch(/0\.711/);
    expect(render('freshness_score', 0.000007)).not.toMatch(/^\s*freshness_score\s+0\.0\s*$/m);
  });

  it('leaves large composite scores on one decimal', () => {
    expect(render('compositeScore', 96)).toMatch(/96\.0/);
  });

  it('renders a ratio as a multiple, not a price', () => {
    const out = render('priceRatioLongOverShort', 5971.13);
    expect(out).not.toMatch(/\$/);
    expect(out).toMatch(/5971/);
  });
});
