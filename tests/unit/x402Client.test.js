import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { __testing, commandLabelFor } from '../../src/lib/x402-client.js';

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
  it('shows price, token, chain, from-address, to-address, and balance', () => {
    const prompt = formatChallengePrompt({
      priceStr: '0.005',
      symbol: 'USDC',
      route: 'coin/risk/BTC',
      chainLabel: 'Base',
      balanceFormatted: '4.83',
      walletAddress: '0xc624d24d17CF22ece0487101eD58B1d4742bb394',
      payToAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    });
    expect(prompt).toContain('0.005 USDC on Base');
    expect(prompt).toContain('coin/risk/BTC');
    expect(prompt).toContain('0xc624…b394'); // truncated from-address
    expect(prompt).toContain('0xabcd…ef12'); // truncated to-address
    expect(prompt).toContain('4.83 USDC');
    expect(prompt).toContain('Pay? [Y/n]');
  });

  it('names the actual token and chain, not a hard-coded USDC-on-Base', () => {
    // The whole point of the multi-chain work: a payer on Robinhood Chain is
    // paying USDG, and a prompt that says "USDC on base" is simply lying to
    // them at the moment they authorise a transfer.
    const prompt = formatChallengePrompt({
      priceStr: '0.05',
      symbol: 'USDG',
      route: 'ask',
      chainLabel: 'Robinhood Chain',
      balanceFormatted: '12.00',
      walletAddress: '0xc624d24d17CF22ece0487101eD58B1d4742bb394',
      payToAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    });
    expect(prompt).toContain('0.05 USDG on Robinhood Chain');
    expect(prompt).not.toContain('USDC');
  });

  it('truncAddress shows first 6 + last 4 chars', () => {
    expect(truncAddress('0xc624d24d17CF22ece0487101eD58B1d4742bb394')).toBe('0xc624…b394');
    expect(truncAddress(null)).toBe('?');
    expect(truncAddress(undefined)).toBe('?');
  });
});

describe('commandLabelFor — what the payment prompt shows', () => {
  // `resource` became an absolute URL because the x402 v2 spec requires one and the CDP
  // facilitator rejects a bare path. Printed raw, the prompt read
  // "…to run `https://coinrotator-ai.onrender.com/api/cli/coin/risk/DOGE`" — an internal
  // hostname, in the one message where the user is deciding whether to spend money.
  it('renders the command the user typed, not the internal URL', () => {
    expect(commandLabelFor('https://api.shumi.ai/api/cli/coin/risk/DOGE')).toBe('shumi coin risk DOGE');
  });

  it('names the NLP route, which lives at /api/cli itself', () => {
    expect(commandLabelFor('https://api.shumi.ai/api/cli')).toBe('shumi ask');
  });

  it('is unaffected by which host served the challenge', () => {
    expect(commandLabelFor('https://coinrotator-ai.onrender.com/api/cli/pairs')).toBe('shumi pairs');
  });

  it('falls back to the raw value rather than throwing inside a payment prompt', () => {
    expect(commandLabelFor('coin/risk/BTC')).toBe('coin/risk/BTC');
  });
});

describe('usableRequirements — tolerant parsing across protocol versions', () => {
  const { usableRequirements, selectRequirement, amountOf } = __testing;
  const v1Base = {
    scheme: 'exact', network: 'base', maxAmountRequired: '50000',
    resource: 'https://api.shumi.ai/api/cli',
    payTo: '0xc624d24d17CF22ece0487101eD58B1d4742bb394',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  };
  const v2Rh = {
    scheme: 'exact', network: 'eip155:4663', amount: '50000',
    payTo: '0x1111111111111111111111111111111111111111',
    asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  };

  it('reads the amount from either version field', () => {
    expect(amountOf(v1Base)).toBe('50000');
    expect(amountOf(v2Rh)).toBe('50000');
    expect(amountOf({})).toBe(null);
  });

  it('accepts v2 rows, which use `amount` rather than `maxAmountRequired`', () => {
    // Checking only the v1 field rejected every v2 row as "incomplete", which
    // surfaced to the user as "no payment option this client can use" — a
    // client bug wearing a server bug's clothes.
    const { usable, skipped } = usableRequirements([v2Rh]);
    expect(usable).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it('skips rows it cannot service instead of rejecting the whole challenge', () => {
    // The regression this whole change exists to prevent: under x402@1.2.0 an
    // unknown network threw, so ONE unpayable row cost the client every payable
    // one alongside it.
    const { usable, skipped } = usableRequirements([
      v1Base,
      { scheme: 'exact', network: 'eip155:999999', amount: '1', payTo: '0xa', asset: '0xb' },
      { scheme: 'upto', network: 'base', amount: '1', payTo: '0xa', asset: '0xb' },
      null,
    ]);
    expect(usable.map((r) => r.network)).toEqual(['base']);
    expect(skipped).toHaveLength(3);
  });

  it('returns nothing usable rather than throwing when no row is payable', () => {
    const { usable } = usableRequirements([{ scheme: 'exact', network: 'eip155:999999', amount: '1', payTo: '0xa', asset: '0xb' }]);
    expect(usable).toHaveLength(0);
  });

  it('honours SHUMI_X402_NETWORK, and falls back to the server ordering', () => {
    const usable = [v1Base, v2Rh];
    delete process.env.SHUMI_X402_NETWORK;
    expect(selectRequirement(usable).network).toBe('base');

    process.env.SHUMI_X402_NETWORK = 'robinhood';
    expect(selectRequirement(usable).network).toBe('eip155:4663');

    // Pinning a chain the server did not offer must not silently pay elsewhere
    // — it falls back to the server's first choice, which the user still sees
    // named in the prompt before approving.
    process.env.SHUMI_X402_NETWORK = 'polygon';
    expect(selectRequirement(usable).network).toBe('base');
    delete process.env.SHUMI_X402_NETWORK;
  });
});
