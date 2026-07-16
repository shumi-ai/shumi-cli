import { afterEach, describe, expect, it } from 'vitest';
import { formatPercentUnits } from '../../src/commands/funding.js';
import { renderSingleRisk } from '../../src/commands/coinRisk.js';

describe('funding percent units', () => {
  it('does not multiply APR values that are already percentages', () => {
    expect(formatPercentUnits(11)).toBe('11.00%');
    expect(formatPercentUnits(-9.1)).toBe('-9.10%');
    expect(formatPercentUnits(0.25)).toBe('0.25%');
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

  it('renders canonical payer, receiver, and position carry', () => {
    const chunks = [];
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    renderSingleRisk({ data: {
      symbol: 'BTC',
      funding_apr: 7.43505,
      funding_paying_side: 'longs',
      funding_receiving_side: 'shorts',
      carry_if_long: 'Long perpetual positions pay funding at +7.4% APR.',
      carry_if_short: 'Short perpetual positions receive funding at +7.4% APR.',
    } });
    const output = chunks.join('');

    expect(output).toContain('7.44%');
    expect(output).toContain('funding pays     longs');
    expect(output).toContain('funding receives shorts');
    expect(output).toContain('Long perpetual positions pay funding at +7.4% APR.');
    expect(output).toContain('Short perpetual positions receive funding at +7.4% APR.');
  });
});
