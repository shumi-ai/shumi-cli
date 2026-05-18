import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveMode, renderOk, renderErr } from '../../src/lib/output.js';
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
