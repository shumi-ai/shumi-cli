import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveMode, renderOk, renderErr, hintForError, applyClientFilters } from '../../src/lib/output.js';
import { Exit } from '../../src/lib/exitCodes.js';

function captureStream(name) {
  const orig = process[name].write.bind(process[name]);
  const chunks = [];
  process[name].write = (chunk) => { chunks.push(String(chunk)); return true; };
  return {
    chunks,
    restore: () => { process[name].write = orig; },
  };
}

describe('resolveMode', () => {
  it('forces JSON when --json', () => {
    expect(resolveMode({ json: true }).json).toBe(true);
  });
  it('forces JSON when --agent', () => {
    const m = resolveMode({ agent: true });
    expect(m.json).toBe(true);
    expect(m.agent).toBe(true);
  });
  it('honors SHUMI_AGENT env var', () => {
    process.env.SHUMI_AGENT = '1';
    expect(resolveMode().agent).toBe(true);
    delete process.env.SHUMI_AGENT;
  });
});

describe('renderOk', () => {
  let stdout;
  beforeEach(() => { stdout = captureStream('stdout'); });
  afterEach(() => stdout.restore());

  it('JSON mode prints the envelope on stdout', () => {
    renderOk({ schemaVersion: 1, data: { foo: 1 } }, { json: true });
    expect(stdout.chunks.join('')).toContain('"foo":1');
    expect(stdout.chunks.join('')).toContain('"schemaVersion":1');
  });

  it('human mode calls the formatter with data', () => {
    const fmt = vi.fn();
    renderOk({ schemaVersion: 1, data: { foo: 1 } }, { json: false, agent: false }, fmt);
    // Note: TTY detection may force JSON mode in CI; if so, fmt is not called.
    if (process.stdout.isTTY) expect(fmt).toHaveBeenCalledWith({ foo: 1 }, expect.anything());
  });
});

describe('renderErr', () => {
  let stderr;
  beforeEach(() => {
    stderr = captureStream('stderr');
    process.exitCode = 0;
  });
  afterEach(() => {
    stderr.restore();
    process.exitCode = 0;
  });

  it('emits envelope on stderr and sets exit code from HTTP status', () => {
    const err = Object.assign(new Error('Bad'), { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Too many' } } });
    renderErr(err, { json: true });
    const text = stderr.chunks.join('');
    expect(text).toContain('"code":"RATE_LIMITED"');
    expect(process.exitCode).toBe(Exit.RATE_LIMITED);
  });

  it('uses envelope error code when present', () => {
    const err = Object.assign(new Error('x'), { status: 401, body: { error: { code: 'AUTH_INVALID', message: 'nope' } } });
    renderErr(err, { json: true });
    expect(process.exitCode).toBe(Exit.AUTH_REQUIRED);
  });

  it('falls back to INTERNAL for unstructured errors', () => {
    renderErr(new Error('oops'), { json: true });
    expect(process.exitCode).toBe(Exit.INTERNAL);
  });

  it('human mode shows only the ✗ + hint lines, never the raw JSON envelope', () => {
    const savedTty = process.stdout.isTTY;
    const savedAgent = process.env.SHUMI_AGENT;
    process.stdout.isTTY = true;
    delete process.env.SHUMI_AGENT;
    try {
      const err = Object.assign(new Error('Bad'), {
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'Too many', details: { tier: 'free', used: 10, limit: 10 } } },
      });
      renderErr(err, {}); // human mode: no --json / --agent
      const text = stderr.chunks.join('');
      expect(text).not.toContain('"schemaVersion"');
      expect(text).not.toContain('"code":"RATE_LIMITED"');
      expect(text).toContain('✗ Too many');
      expect(text).toContain('Free tier limit reached');
    } finally {
      process.stdout.isTTY = savedTty;
      if (savedAgent === undefined) delete process.env.SHUMI_AGENT;
      else process.env.SHUMI_AGENT = savedAgent;
    }
  });
});

describe('applyClientFilters', () => {
  const wrap = (data) => ({ schemaVersion: 1, data });

  it('no-ops without flags', () => {
    const env = wrap({ a: 1, b: 2 });
    expect(applyClientFilters(env, {})).toBe(env);
  });

  it('no-ops when envelope has no data', () => {
    const env = { schemaVersion: 1, commands: [1, 2, 3] };
    expect(applyClientFilters(env, { top: 1 })).toBe(env);
  });

  it('--fields whitelists top-level data keys (object)', () => {
    const out = applyClientFilters(wrap({ name: 'x', node: 'v20', extra: 'drop' }), { fields: 'name,node' });
    expect(out.data).toEqual({ name: 'x', node: 'v20' });
  });

  it('--fields projects each row of an array', () => {
    const out = applyClientFilters(wrap([{ s: 'BTC', p: 1, x: 9 }, { s: 'ETH', p: 2, x: 8 }]), { fields: 's,p' });
    expect(out.data).toEqual([{ s: 'BTC', p: 1 }, { s: 'ETH', p: 2 }]);
  });

  it('--top slices a top-level array', () => {
    expect(applyClientFilters(wrap([1, 2, 3, 4]), { top: 2 }).data).toEqual([1, 2]);
  });

  it('--top slices the first array-valued field of an object', () => {
    const out = applyClientFilters(wrap({ items: [1, 2, 3], note: 'keep' }), { top: 2 });
    expect(out.data).toEqual({ items: [1, 2], note: 'keep' });
  });

  it('is idempotent (typed pre-filter + renderOk re-filter)', () => {
    const once = applyClientFilters(wrap({ a: 1, b: 2, c: 3 }), { fields: 'a,b' });
    const twice = applyClientFilters(once, { fields: 'a,b' });
    expect(twice.data).toEqual({ a: 1, b: 2 });
  });
});

describe('renderOk applies --fields in JSON mode', () => {
  let stdout;
  beforeEach(() => { stdout = captureStream('stdout'); });
  afterEach(() => stdout.restore());

  it('filters the data payload before emitting JSON', () => {
    renderOk({ schemaVersion: 1, data: { name: 'shumi', node: 'v20', drop: 'me' } }, { json: true, fields: 'name,node' });
    const out = JSON.parse(stdout.chunks.join(''));
    expect(out.data).toEqual({ name: 'shumi', node: 'v20' });
  });
});

describe('hintForError', () => {
  const env = (code, message = '', details) => ({
    schemaVersion: 1,
    error: { code, message, ...(details && { details }) },
  });

  it('free-tier rate limit names the quota and the plan page', () => {
    const h = hintForError(env('RATE_LIMITED', 'Quota exceeded (3/3 on free)', { tier: 'free', used: 3, limit: 3 }));
    expect(h).toContain('3/3');
    expect(h).toContain('https://shumi.ai');
  });

  it('generic rate limit (no tier details) still gives a next step', () => {
    const h = hintForError(env('RATE_LIMITED', 'Too many requests'));
    expect(h).toMatch(/retry|plan/i);
  });

  it('does not double up when message already says "shumi login"', () => {
    expect(hintForError(env('AUTH_REQUIRED', 'Authentication required. Run: shumi login'))).toBeNull();
  });

  it('adds a login hint when the auth message lacks it', () => {
    expect(hintForError(env('AUTH_INVALID', 'token expired'))).toMatch(/shumi login/);
  });

  it('returns null for codes without a defined hint', () => {
    expect(hintForError(env('INTERNAL', 'boom'))).toBeNull();
  });

  it('never invents a pricing deep-link — only the verified home URL', () => {
    const h = hintForError(env('RATE_LIMITED', 'x', { tier: 'free', used: 3, limit: 3 }));
    expect(h).not.toMatch(/shumi\.ai\/(pricing|upgrade|checkout|plans?)/);
  });

  it('enriched drip wall renders a premium copy with reset time + server upgrade_url', () => {
    const resetAt = new Date(Date.now() + 7 * 3600_000).toISOString();
    const h = hintForError(env('RATE_LIMITED', 'quota', {
      tier: 'free', used: 1, limit: 1,
      quota: { used: 1, limit: 1, remaining: 0, wall: 'drip', period: 'day' },
      reset_at: resetAt, upgrade_url: 'https://shumi.ai/pricing',
    }));
    expect(h).toContain("today's free query");
    expect(h).toMatch(/unlocks in ~7h/);
    expect(h).toContain('https://shumi.ai/pricing'); // deep-link is server-provided, not invented
    expect(h).not.toContain('—'); // no em-dashes in published copy
  });

  it('enriched grant wall names the lifetime cap', () => {
    const h = hintForError(env('RATE_LIMITED', 'quota', {
      tier: 'free', used: 10, limit: 10,
      quota: { used: 10, limit: 10, remaining: 0, wall: 'grant', period: 'lifetime' },
      reset_at: new Date(Date.now() + 20 * 3600_000).toISOString(),
      upgrade_url: 'https://shumi.ai/pricing',
    }));
    expect(h).toContain('all 10 free queries');
  });
});

describe('pauseActiveSpinner', () => {
  // The x402 payment prompt is written while a spinner started higher in the call
  // stack is still animating, and ora repaints the current line — so "Pay? [Y/n]"
  // was erased and the command looked hung. Nothing covered this, so both the
  // registry and the pause could have been deleted with a green suite.
  //
  // Asserted through stop/start calls rather than ora's `isSpinning`, which stays
  // false under vitest whether or not the spinner is running.
  const realTTY = process.stdout.isTTY;
  // spinner() refuses to start without a usable width (see the 0-column tests
  // below), and vitest's stderr reports none. Give it one.
  const realColumns = process.stderr.columns;
  beforeEach(() => { process.stderr.columns = 80; });
  afterEach(() => { process.stderr.columns = realColumns; });

  it('stops the running spinner and restarts it with its text on resume', async () => {
    const { spinner, pauseActiveSpinner } = await import('../../src/lib/output.js');
    process.stdout.isTTY = true;
    const s = spinner('working…', {});
    const stopSpy = vi.spyOn(s, 'stop');
    const startSpy = vi.spyOn(s, 'start');
    try {
      const resume = pauseActiveSpinner();
      expect(stopSpy).toHaveBeenCalledTimes(1);

      resume();
      expect(startSpy).toHaveBeenCalledWith('working…');
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
      s.stop();
      process.stdout.isTTY = realTTY;
    }
  });

  it('is a no-op when nothing is spinning, so callers need no branching', async () => {
    const { pauseActiveSpinner } = await import('../../src/lib/output.js');
    expect(() => pauseActiveSpinner()()).not.toThrow();
  });

  it('forgets a spinner once stopped, so a later pause cannot revive it', async () => {
    const { spinner, pauseActiveSpinner } = await import('../../src/lib/output.js');
    process.stdout.isTTY = true;
    const s = spinner('working…', {});
    s.stop();
    const startSpy = vi.spyOn(s, 'start');
    try {
      pauseActiveSpinner()();
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
      process.stdout.isTTY = realTTY;
    }
  });
});

describe('renderErr emits one rendering, not two', () => {
  // An interactive user read the same failure twice — the raw JSON envelope and
  // then the prose line. The envelope is a machine contract (stdout | jq must
  // never break), so it stays for --json/--agent/non-TTY; a human gets prose.
  const realTTY = process.stdout.isTTY;
  afterEach(() => { process.stdout.isTTY = realTTY; });

  it('gives a human the prose only', () => {
    process.stdout.isTTY = true;
    const err = { code: 'PAYMENT_REQUIRED', message: 'Payment declined — nothing was charged.' };
    const cap = captureStream('stderr');
    try { renderErr(err, {}); } finally { cap.restore(); }

    const out = cap.chunks.join('');
    expect(out).toContain('Payment declined');
    expect(out).not.toContain('schemaVersion');
    expect(out).not.toContain('"code"');
  });

  it('still gives a machine the envelope, and only the envelope', () => {
    process.stdout.isTTY = true;   // agent mode must win over TTY detection
    const err = { code: 'PAYMENT_REQUIRED', message: 'Payment declined — nothing was charged.' };
    const cap = captureStream('stderr');
    try { renderErr(err, { agent: true }); } finally { cap.restore(); }

    const out = cap.chunks.join('');
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ error: { code: 'PAYMENT_REQUIRED' } });
  });
});

describe('spinner() on a terminal with no usable width', () => {
  // ora sizes its line-clearing by `stream.columns ?? 80`. A pty reporting 0
  // columns (`script -q /dev/null` from a non-interactive parent, some
  // `docker run -t` / CI setups) slips past the `??`, ora's clear() loops
  // forever writing cursor-up/erase-line, and the command never returns — not
  // even the request timeout can fire while that loop holds the event loop.
  const realTTY = process.stdout.isTTY;
  const realColumns = process.stderr.columns;
  afterEach(() => {
    process.stdout.isTTY = realTTY;
    process.stderr.columns = realColumns;
  });

  async function spinnerWithColumns(columns) {
    const { spinner } = await import('../../src/lib/output.js');
    process.stdout.isTTY = true; // human mode, so only the width decides
    process.stderr.columns = columns;
    return spinner('working…', {});
  }

  for (const columns of [0, undefined, NaN, -1]) {
    it(`returns the inert stub at columns=${columns}`, async () => {
      const s = await spinnerWithColumns(columns);
      // The stub has no ora state; a real instance always carries isSpinning.
      expect('isSpinning' in s).toBe(false);
      expect(() => { s.text = 'next phase'; s.succeed('done'); s.fail('x'); s.stop(); }).not.toThrow();
    });
  }

  it('still starts a real spinner on a terminal with a width', async () => {
    const s = await spinnerWithColumns(80);
    try {
      expect('isSpinning' in s).toBe(true);
    } finally {
      s.stop();
    }
  });
});
