import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Out of free quota, no terminal, and only a passphrase-locked keystore.
 *
 * promptYesNo answers its default ("yes") off-TTY and promptHidden returns
 * null, so this used to end in "No passphrase provided." — about input nobody
 * was asked for. It must now fail before any prompt, say why, and name the
 * ways out the 402 offered.
 */

const wallet = vi.hoisted(() => ({ envKey: false, keystore: true }));
const promptMocks = vi.hoisted(() => ({ canPrompt: vi.fn(() => false), promptYesNo: vi.fn(), promptHidden: vi.fn() }));

vi.mock('../../src/lib/wallet.js', async (importOriginal) => ({
  ...(await importOriginal()),
  hasEnvKey: () => wallet.envKey,
  hasKeystore: () => wallet.keystore,
  hasWallet: () => wallet.envKey || wallet.keystore,
  readKeystoreAddress: () => '0x1111111111111111111111111111111111111111',
  balanceOnChain: vi.fn(async () => { throw new Error('no RPC in tests'); }),
  sumSpendSinceUtcMidnight: () => 0,
}));
vi.mock('../../src/lib/prompt.js', () => promptMocks);
vi.mock('../../src/lib/telemetry.js', () => ({ capture: vi.fn(), captureError: vi.fn() }));

const { fetchWithX402, __testing } = await import('../../src/lib/x402-client.js');

const GATE = {
  tier: 'free',
  used: 10,
  limit: 10,
  quota: { used: 10, limit: 10, remaining: 0, period: 'lifetime', wall: 'grant' },
  reset_at: new Date(Date.now() + 8 * 3600_000).toISOString(),
  this_query: { route: 'coin/INJ', price_usdc: '0.005' },
  upgrade_url: 'https://shumi.ai/pricing',
  unlock: [
    { method: 'x402', label: 'Pay $0.005 for this call', price_usdc: '0.005' },
    { method: 'subscription', label: 'Subscribe for a daily allowance', tier: 'access', upgrade_url: 'https://shumi.ai/pricing' },
  ],
};

function challenge402() {
  return new Response(JSON.stringify({
    x402Version: 1,
    accepts: [{
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '5000',
      resource: 'https://coinrotator-ai.onrender.com/api/cli/ai',
      payTo: '0x2222222222222222222222222222222222222222',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    }],
    gate: GATE,
  }), { status: 402, headers: { 'content-type': 'application/json' } });
}

describe('non-interactive payment with a locked keystore', () => {
  const realFetch = globalThis.fetch;
  const realArgv = process.argv;

  beforeEach(() => {
    wallet.envKey = false;
    wallet.keystore = true;
    promptMocks.canPrompt.mockReturnValue(false);
    process.argv = [realArgv[0], realArgv[1]];
    delete process.env.SHUMI_AGENT;
    delete process.env.SHUMI_AUTO_PAY;
    delete process.env.SHUMI_X402_NETWORK;
    globalThis.fetch = vi.fn(async () => challenge402());
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.argv = realArgv;
    vi.clearAllMocks();
  });

  it('fails up front, before any prompt, with the quota and the ways out', async () => {
    const err = await fetchWithX402('https://example.test/api/cli/ai').catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.category).toBe('PAYMENT_BLOCKED');
    expect(err.code).toBe('PAYMENT_REQUIRED');
    expect(err.message).toContain('Out of quota: 10 of 10 lifetime queries used on the free tier.');
    expect(err.message).toContain('not an interactive terminal');
    expect(err.message).toContain('SHUMI_X402_PRIVATE_KEY');
    expect(err.message).toContain('https://shumi.ai/pricing');
    expect(err.message).not.toContain('No passphrase provided');
    expect(err.gate).toEqual(GATE);
    expect(promptMocks.promptYesNo).not.toHaveBeenCalled();
    expect(promptMocks.promptHidden).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no paid retry
  });

  it('also fails up front under --auto-pay, which skips the Y/n but still needs a passphrase', async () => {
    process.argv.push('--auto-pay');
    const err = await fetchWithX402('https://example.test/api/cli/ai').catch((e) => e);
    expect(err.message).toContain('not an interactive terminal');
    expect(promptMocks.promptHidden).not.toHaveBeenCalled();
  });

  it('leaves --agent on its own existing message', async () => {
    process.argv.push('--agent');
    const err = await fetchWithX402('https://example.test/api/cli/ai').catch((e) => e);
    expect(err.message).toContain('--agent mode');
    expect(err.message).not.toContain('not an interactive terminal');
  });

  it('does not block a terminal user, who can still be asked', async () => {
    promptMocks.canPrompt.mockReturnValue(true);
    promptMocks.promptYesNo.mockResolvedValueOnce(false); // declines at the prompt
    const err = await fetchWithX402('https://example.test/api/cli/ai').catch((e) => e);
    expect(promptMocks.promptYesNo).toHaveBeenCalledTimes(1);
    expect(err.message).toContain('Payment declined');
  });
});

describe('the unlock hint', () => {
  const { nonInteractiveUnlockHint } = __testing;

  it('uses the price and subscription link the 402 offered', () => {
    const hint = nonInteractiveUnlockHint(GATE);
    expect(hint).toContain('pay $0.005 per call');
    expect(hint).toContain('subscribe at https://shumi.ai/pricing');
  });

  it('falls back cleanly when the gate block is missing', () => {
    const hint = nonInteractiveUnlockHint(null);
    expect(hint).toContain('SHUMI_X402_PRIVATE_KEY');
    expect(hint).toContain('https://shumi.ai/pricing');
  });
});
