import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { __testing } from '../../src/lib/x402-client.js';

const {
  usdcStringToBaseUnits, baseUnitsToUsdcString,
  isAutoPay, isAgentMode, maxPriceCeilingUsdc,
  dailyCapUsdc, formatChallengePrompt, truncAddress,
} = __testing;

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

  it('SHUMI_DAILY_USDC_CAP override beats default $1.00', () => {
    expect(dailyCapUsdc()).toBe('1.00');
    process.env.SHUMI_DAILY_USDC_CAP = '5.00';
    expect(dailyCapUsdc()).toBe('5.00');
    delete process.env.SHUMI_DAILY_USDC_CAP;
  });
});

describe('formatChallengePrompt — anti-phishing prompt shape', () => {
  it('shows price, network, from-address, to-address, and balance', () => {
    const prompt = formatChallengePrompt({
      priceUsdcStr: '0.005',
      route: 'coin/risk/BTC',
      network: 'base',
      balanceFormatted: '4.83',
      walletAddress: '0xc624d24d17CF22ece0487101eD58B1d4742bb394',
      payToAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    });
    expect(prompt).toContain('$0.005 USDC on base');
    expect(prompt).toContain('coin/risk/BTC');
    expect(prompt).toContain('0xc624…b394'); // truncated from-address
    expect(prompt).toContain('0xabcd…ef12'); // truncated to-address
    expect(prompt).toContain('$4.83');
    expect(prompt).toContain('Pay? [Y/n]');
  });

  it('truncAddress shows first 6 + last 4 chars', () => {
    expect(truncAddress('0xc624d24d17CF22ece0487101eD58B1d4742bb394')).toBe('0xc624…b394');
    expect(truncAddress(null)).toBe('?');
    expect(truncAddress(undefined)).toBe('?');
  });
});
