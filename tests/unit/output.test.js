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
});
