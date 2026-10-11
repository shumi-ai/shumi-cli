import { afterEach, describe, expect, it } from 'vitest';
import { formatPercentUnits } from '../../src/commands/funding.js';
import { renderSingleRisk } from '../../src/commands/coinRisk.js';

describe('funding percent units', () => {
  it('does not multiply APR values that are already percentages', () => {
    expect(formatPercentUnits(11)).toBe('+11.00%');
    expect(formatPercentUnits(-9.1)).toBe('-9.10%');
    expect(formatPercentUnits(0.25)).toBe('+0.25%');
    expect(formatPercentUnits(0)).toBe('0.00%');
    expect(formatPercentUnits(-0.001)).toBe('0.00%');
  });

  it('renders unavailable values safely', () => {
    expect(formatPercentUnits(null)).toBe('—');
    expect(formatPercentUnits(undefined)).toBe('—');
    expect(formatPercentUnits('bad')).toBe('—');
  });
});

describe('coin risk funding contract', () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  afterEach(() => { process.stdout.write = originalWrite; });

  it('renders the signed APR and position carry, never who pays', () => {
    const chunks = [];
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    renderSingleRisk({ data: {
      symbol: 'BTC',
      funding_apr: 7.43505,
      // Older backends still send these; they must not be printed.
      funding_paying_side: 'longs',
      funding_receiving_side: 'shorts',
      carry_if_long: 'A long perp position costs about $61 per $10k a month in funding (+7.4% APR).',
      carry_if_short: 'A short perp position earns about $61 per $10k a month in funding (+7.4% APR).',
    } });
    const output = chunks.join('');

    expect(output).toContain('+7.44%');
    expect(output).not.toMatch(/funding pays|funding receives|longs|shorts/);
    expect(output).toContain('A long perp position costs about $61 per $10k a month in funding (+7.4% APR).');
    expect(output).toContain('A short perp position earns about $61 per $10k a month in funding (+7.4% APR).');
  });

  it('renders without the removed payer fields', () => {
    const chunks = [];
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    renderSingleRisk({ data: { symbol: 'ETH', funding_apr: -3.2 } });
    const output = chunks.join('');
    expect(output).toContain('-3.20%');
    expect(output).not.toMatch(/funding pays|funding receives/);
  });
});
