import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * execute() is the chokepoint for the NLP commands (ask, coin <sym>, tweets,
 * search). Its catch used to do only `spinner.fail(error.message)`, and
 * spinner() is an inert stub whenever output is JSON (stdout piped, --json,
 * --agent). So on exactly those paths every failure exited 1 with nothing on
 * stdout and nothing on stderr: a real 402 "Out of quota" was invisible to the
 * agent that hit it.
 *
 * The API is mocked at its module seam; the real output.js renders.
 */

vi.mock('../../src/lib/api-client.js', () => ({ query: vi.fn() }));
vi.mock('../../src/lib/telemetry.js', () => ({ capture: vi.fn(), captureError: vi.fn() }));
vi.mock('../../src/lib/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getToken: vi.fn(() => null),
  getRawToken: vi.fn(() => null),
}));
// No update notice riding on the envelope: its presence depends on this machine.
vi.mock('../../src/lib/updateCheck.js', () => ({ getUpdateInfo: () => null }));

const { query } = await import('../../src/lib/api-client.js');
const { execute } = await import('../../src/lib/execute.js');
const { Exit } = await import('../../src/lib/exitCodes.js');

function captureStream(name) {
  const orig = process[name].write;
  const chunks = [];
  process[name].write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, text: () => chunks.join(''), restore: () => { process[name].write = orig; } };
}

/** The shape api-client's ApiError takes for a payment block on a 402. */
function quotaError() {
  const err = new Error('Out of quota');
  err.status = 402;
  err.body = {
    error: {
      code: 'PAYMENT_REQUIRED',
      message: 'Out of quota: 10 of 10 lifetime queries used on the free tier.\n  Payment needed, but this is not an interactive terminal.',
      details: { tier: 'free', quota: { used: 10, limit: 10, period: 'lifetime', wall: 'grant' } },
    },
  };
  return err;
}

describe('execute() reports its failures', () => {
  const realTTY = process.stdout.isTTY;
  let out;
  let err;

  beforeEach(() => {
    process.exitCode = undefined;
    out = captureStream('stdout');
    err = captureStream('stderr');
  });
  afterEach(() => {
    out.restore();
    err.restore();
    process.stdout.isTTY = realTTY;
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  it('piped (non-TTY): writes the JSON envelope to stderr and exits 3 on a payment block', async () => {
    process.stdout.isTTY = false;
    query.mockRejectedValueOnce(quotaError());

    await execute({ queryText: 'analyze INJ', commandContext: 'coin' });

    expect(out.text()).toBe('');
    const lines = err.chunks.join('').trim().split('\n');
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0]);
    expect(envelope.error.code).toBe('PAYMENT_REQUIRED');
    expect(envelope.error.message).toContain('Out of quota');
    expect(envelope.error.details.quota.wall).toBe('grant');
    expect(process.exitCode).toBe(Exit.RATE_LIMITED);
  });

  it('--agent at a terminal: opts reach resolveMode, so the envelope is still emitted', async () => {
    process.stdout.isTTY = true;
    query.mockRejectedValueOnce(quotaError());

    await execute({ queryText: 'x', opts: { agent: true } });

    expect(JSON.parse(err.text()).error.code).toBe('PAYMENT_REQUIRED');
    expect(process.exitCode).toBe(Exit.RATE_LIMITED);
  });

  it('a network failure maps to its own exit code, not a blanket 1', async () => {
    process.stdout.isTTY = false;
    const netErr = new Error('Network error: fetch failed');
    netErr.status = 0;
    netErr.body = { error: { code: 'NETWORK', message: 'Network error: fetch failed' } };
    query.mockRejectedValueOnce(netErr);

    await execute({ queryText: 'x' });

    expect(JSON.parse(err.text()).error.code).toBe('NETWORK');
    expect(process.exitCode).toBe(Exit.NETWORK);
  });

  it('at a terminal: one prose rendering, no raw JSON and no duplicate line', async () => {
    process.stdout.isTTY = true;
    query.mockRejectedValueOnce(quotaError());

    await execute({ queryText: 'x' });

    const text = err.text();
    expect(text).not.toContain('{"schemaVersion"');
    expect(text.match(/Out of quota/g)).toHaveLength(1);
    expect(process.exitCode).toBe(Exit.RATE_LIMITED);
  });
});
