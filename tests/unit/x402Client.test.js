import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { __testing } from '../../src/lib/x402-client.js';

const { usdcStringToBaseUnits, baseUnitsToUsdcString, isAutoPay, isAgentMode, maxPriceCeilingUsdc } = __testing;

describe('USDC <-> base unit conversions (6 decimals on Base)', () => {
  it('$0.005 → 5000 units', () => {
    expect(usdcStringToBaseUnits('0.005')).toBe(5000n);
  });
  it('$0.05 → 50000 units', () => {
    expect(usdcStringToBaseUnits('0.05')).toBe(50000n);
  });
  it('$0.10 → 100000 units', () => {
    expect(usdcStringToBaseUnits('0.10')).toBe(100000n);
  });
  it('$1 → 1_000_000 units', () => {
    expect(usdcStringToBaseUnits('1')).toBe(1_000_000n);
  });
  it('round trip — normalized to no trailing zeros', () => {
    // Round-trip strips trailing zeros: 0.10 → 0.1, 1.000 → 1
    // (mathematically equivalent, just normalized for display).
    const cases = [
      ['0.005', '0.005'],
      ['0.05', '0.05'],
      ['0.10', '0.1'],
      ['1', '1'],
      ['2.5', '2.5'],
    ];
    for (const [input, normalized] of cases) {
      expect(baseUnitsToUsdcString(usdcStringToBaseUnits(input).toString())).toBe(normalized);
    }
  });
  it('truncates past 6 decimals (does NOT round up)', () => {
    expect(usdcStringToBaseUnits('0.0050001')).toBe(5000n);
  });
  it('handles 0', () => {
    expect(usdcStringToBaseUnits('0')).toBe(0n);
    expect(baseUnitsToUsdcString('0')).toBe('0');
  });
});

describe('flag resolution: agent mode, auto-pay, max price', () => {
  let origArgv;
  beforeEach(() => {
    origArgv = process.argv;
    process.argv = [process.argv[0], process.argv[1]];
    delete process.env.SHUMI_AGENT;
    delete process.env.SHUMI_AUTO_PAY;
    delete process.env.SHUMI_MAX_PRICE_USDC;
  });
  afterEach(() => {
    process.argv = origArgv;
    delete process.env.SHUMI_AGENT;
    delete process.env.SHUMI_AUTO_PAY;
    delete process.env.SHUMI_MAX_PRICE_USDC;
  });

  it('SHUMI_AGENT=1 → isAgentMode true + isAutoPay implied true', () => {
    process.env.SHUMI_AGENT = '1';
    expect(isAgentMode()).toBe(true);
    expect(isAutoPay()).toBe(true);
  });

  it('--agent flag → same as env var', () => {
    process.argv.push('--agent');
    expect(isAgentMode()).toBe(true);
    expect(isAutoPay()).toBe(true);
  });

  it('--auto-pay alone → autopay true, agent false', () => {
    process.argv.push('--auto-pay');
    expect(isAutoPay()).toBe(true);
    expect(isAgentMode()).toBe(false);
  });

  it('SHUMI_AUTO_PAY=1 alone → autopay true, agent false', () => {
    process.env.SHUMI_AUTO_PAY = '1';
    expect(isAutoPay()).toBe(true);
    expect(isAgentMode()).toBe(false);
  });

  it('neither set → interactive (both false)', () => {
    expect(isAutoPay()).toBe(false);
    expect(isAgentMode()).toBe(false);
  });

  it('SHUMI_MAX_PRICE_USDC override beats default', () => {
    expect(maxPriceCeilingUsdc()).toBe('0.10');
    process.env.SHUMI_MAX_PRICE_USDC = '0.025';
    expect(maxPriceCeilingUsdc()).toBe('0.025');
  });
});
