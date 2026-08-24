import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * typedAction's client-side filters (--top / --fields) rewrite the envelope
 * every typed command prints. They run between apiGet and renderOk, so a bug
 * here corrupts ALL typed output at once. Collaborators are mocked at module
 * seams — no network, no spinner, no telemetry.
 */

vi.mock('../../src/lib/api-client.js', () => ({ apiGet: vi.fn() }));
vi.mock('../../src/lib/output.js', () => ({
  renderOk: vi.fn(),
  renderErr: vi.fn(),
  spinner: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock('../../src/lib/telemetry.js', () => ({ capture: vi.fn(), captureError: vi.fn() }));
vi.mock('../../src/lib/config.js', () => ({ getToken: vi.fn(() => null) }));

const { apiGet } = await import('../../src/lib/api-client.js');
const { renderOk, renderErr } = await import('../../src/lib/output.js');
const { typedAction } = await import('../../src/lib/typedCmd.js');

/** Minimal Commander-shaped command. */
function fakeCmd(globalOpts = {}) {
  return {
    name: () => 'futures',
    parent: null,
    optsWithGlobals: () => globalOpts,
  };
}

async function run({ data, globalOpts = {}, localOpts = {} }) {
  apiGet.mockResolvedValueOnce({ schemaVersion: 1, data });
  const handler = typedAction({ route: 'futures', query: {}, spinner: 'x…' });
  await handler(localOpts, fakeCmd(globalOpts));
  return renderOk.mock.calls.at(-1)[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('--top', () => {
  it('slices a top-level array', async () => {
    const env = await run({ data: [1, 2, 3, 4], globalOpts: { top: 2 } });
    expect(env.data).toEqual([1, 2]);
    expect(env.schemaVersion).toBe(1);
  });

  it('slices the FIRST array-valued field of an object envelope', async () => {
    const env = await run({
      data: { count: 3, items: ['a', 'b', 'c'], other: ['x', 'y'] },
      globalOpts: { top: 1 },
    });
    expect(env.data.items).toEqual(['a']);
    expect(env.data.other).toEqual(['x', 'y']); // only the first array is sliced
    expect(env.data.count).toBe(3);
  });

  it('leaves data alone when there is nothing to slice', async () => {
    const env = await run({ data: { note: 'scalar only' }, globalOpts: { top: 5 } });
    expect(env.data).toEqual({ note: 'scalar only' });
  });
});

describe('--fields', () => {
  it('projects top-level keys of an object', async () => {
    const env = await run({
      data: { symbol: 'BTC', price: 1, noise: 'x' },
      globalOpts: { fields: 'symbol,price' },
    });
    expect(env.data).toEqual({ symbol: 'BTC', price: 1 });
  });

  it('projects row-wise on arrays and survives spaces and empty segments', async () => {
    const env = await run({
      data: [{ a: 1, b: 2 }, { a: 3, b: 4 }],
      globalOpts: { fields: ' a, ,' },
    });
    expect(env.data).toEqual([{ a: 1 }, { a: 3 }]);
  });

  it('a requested key that is absent is simply omitted, not set to undefined', async () => {
    const env = await run({ data: { a: 1 }, globalOpts: { fields: 'a,missing' } });
    expect(env.data).toEqual({ a: 1 });
    expect('missing' in env.data).toBe(false);
  });

  it('non-object rows pass through untouched', async () => {
    const env = await run({ data: ['plain', { a: 1, b: 2 }], globalOpts: { fields: 'a' } });
    expect(env.data).toEqual(['plain', { a: 1 }]);
  });
});

describe('error path', () => {
  it('renders the error and never renderOk when apiGet rejects', async () => {
    apiGet.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    const handler = typedAction({ route: 'futures', query: {} });
    await handler({}, fakeCmd({}));
    expect(renderErr).toHaveBeenCalledTimes(1);
    expect(renderOk).not.toHaveBeenCalled();
  });
});
