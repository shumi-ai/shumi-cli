import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Which exit code a failure during the request gets. Agents retry on 6
 * (NETWORK), so only a request that genuinely failed to reach the server may
 * land there. A wallet that will not unlock is a billing-side user problem (3);
 * any other thrown error is a client fault (7).
 *
 * Runs the real execute → api-client → x402-client chain. Only fetch, the
 * wallet, the prompts and telemetry are mocked.
 */

const state = vi.hoisted(() => ({ token: null, envKey: false }));
const walletMocks = vi.hoisted(() => ({ loadPrivateKey: vi.fn(), createPaymentClient: vi.fn() }));
const telemetry = vi.hoisted(() => ({ capture: vi.fn(), captureError: vi.fn() }));

vi.mock('../../src/lib/wallet.js', async (importOriginal) => ({
  ...(await importOriginal()),
  hasEnvKey: () => state.envKey,
  hasKeystore: () => !state.envKey,
  hasWallet: () => true,
  readKeystoreAddress: () => '0x1111111111111111111111111111111111111111',
  balanceOnChain: async () => { throw new Error('no RPC in tests'); },
  sumSpendSinceUtcMidnight: () => 0,
  loadPrivateKey: walletMocks.loadPrivateKey,
  createPaymentClient: walletMocks.createPaymentClient,
}));
vi.mock('../../src/lib/prompt.js', () => ({
  canPrompt: () => true,
  promptYesNo: vi.fn(async () => true),
  promptHidden: vi.fn(async () => 'not-the-passphrase'),
}));
vi.mock('../../src/lib/telemetry.js', () => telemetry);
vi.mock('../../src/lib/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getToken: () => state.token,
  getRawToken: () => state.token,
  getWalletAddress: () => null,
  getDeviceId: () => 'test-device',
}));
vi.mock('../../src/lib/updateCheck.js', () => ({ getUpdateInfo: () => null }));

const { execute } = await import('../../src/lib/execute.js');
const { apiGet, isNetworkFailure } = await import('../../src/lib/api-client.js');
const { Exit } = await import('../../src/lib/exitCodes.js');

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
  }), { status: 402, headers: { 'content-type': 'application/json' } });
}

function fetchFailure() {
  return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
}

describe('failures during the request get the right exit code', () => {
  const realFetch = globalThis.fetch;
  const realArgv = process.argv;
  const realTTY = process.stdout.isTTY;
  let stderr;
  const origWrite = process.stderr.write;

  beforeEach(() => {
    state.token = null;
    state.envKey = false;
    process.argv = [realArgv[0], realArgv[1]];
    delete process.env.SHUMI_AGENT;
    delete process.env.SHUMI_AUTO_PAY;
    process.stdout.isTTY = false; // JSON envelope on stderr
    process.exitCode = undefined;
    stderr = '';
    process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.argv = realArgv;
    process.stdout.isTTY = realTTY;
    process.stderr.write = origWrite;
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  const envelope = () => JSON.parse(stderr.trim().split('\n').pop());

  it('a wrong passphrase exits 3 with a clear message, not "Network error"', async () => {
    globalThis.fetch = vi.fn(async () => challenge402());
    walletMocks.loadPrivateKey.mockImplementation(() => { throw new Error('Invalid passphrase or corrupted keystore.'); });

    await execute({ queryText: 'x' });

    expect(process.exitCode).toBe(Exit.RATE_LIMITED);
    expect(envelope().error.code).toBe('PAYMENT_REQUIRED');
    expect(envelope().error.message).toContain('Could not unlock wallet: Invalid passphrase');
    expect(envelope().error.message).not.toContain('Network error');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // nothing was retried with a payment
  });

  it('a malformed SHUMI_X402_PRIVATE_KEY exits 3', async () => {
    state.envKey = true;
    globalThis.fetch = vi.fn(async () => challenge402());
    walletMocks.loadPrivateKey.mockImplementation(() => '0xnothex');
    walletMocks.createPaymentClient.mockImplementation(() => { throw new Error('invalid private key, expected hex or 32 bytes'); });

    await execute({ queryText: 'x' });

    expect(process.exitCode).toBe(Exit.RATE_LIMITED);
    expect(envelope().error.message).toContain('Could not unlock wallet: invalid private key');
  });

  it('a thrown non-network error exits 7 (INTERNAL), not 6', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('boom'); });

    await execute({ queryText: 'x' });

    expect(process.exitCode).toBe(Exit.INTERNAL);
    expect(envelope().error.code).toBe('INTERNAL');
  });

  it('a real fetch TypeError still exits 6 (NETWORK)', async () => {
    globalThis.fetch = vi.fn(async () => { throw fetchFailure(); });

    await execute({ queryText: 'x' });

    expect(process.exitCode).toBe(Exit.NETWORK);
    expect(envelope().error.code).toBe('NETWORK');
  });

  it('apiGet classifies the same way', async () => {
    state.token = 'shumi_sk_test_not_a_real_key';

    globalThis.fetch = vi.fn(async () => { throw new Error('boom'); });
    const internal = await apiGet('coin/risk/BTC').catch((e) => e);
    expect(internal.message).toBe('boom');
    expect(internal.status).toBeUndefined();

    globalThis.fetch = vi.fn(async () => { throw fetchFailure(); });
    const network = await apiGet('coin/risk/BTC').catch((e) => e);
    expect(network.status).toBe(0);
    expect(network.body.error.code).toBe('NETWORK');
  });
});

describe('isNetworkFailure', () => {
  it('accepts what fetch and AbortSignal.timeout throw', () => {
    expect(isNetworkFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isNetworkFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isNetworkFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(isNetworkFailure(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(true);
  });

  it('rejects client-side bugs', () => {
    expect(isNetworkFailure(new Error('boom'))).toBe(false);
    expect(isNetworkFailure(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isNetworkFailure(null)).toBe(false);
  });
});

describe('NLP telemetry parity', () => {
  const realFetch = globalThis.fetch;
  const realTTY = process.stdout.isTTY;
  const origWrite = process.stderr.write;

  beforeEach(() => {
    state.token = null;
    process.stdout.isTTY = false;
    process.stderr.write = () => true;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.stdout.isTTY = realTTY;
    process.stderr.write = origWrite;
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  function respond(status) {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'X', message: 'nope' } }), { status }));
  }

  for (const status of [400, 404, 413, 422]) {
    it(`captures a ${status} with command and surface 'nlp'`, async () => {
      respond(status);
      await execute({ queryText: 'x', commandContext: 'coin' });
      expect(telemetry.captureError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ command: 'coin', surface: 'nlp' }),
      );
    });
  }

  it('tags faults renderErr reports (5xx) with the NLP context too', async () => {
    respond(502);
    await execute({ queryText: 'x', commandContext: 'coin' });
    expect(telemetry.captureError).toHaveBeenCalledTimes(1);
    expect(telemetry.captureError.mock.calls[0][1]).toMatchObject({ command: 'coin', surface: 'nlp' });
  });

  for (const status of [401, 429]) {
    it(`does not capture paywall / auth ${status}s`, async () => {
      respond(status);
      await execute({ queryText: 'x', commandContext: 'coin' });
      expect(telemetry.captureError).not.toHaveBeenCalled();
    });
  }
});
