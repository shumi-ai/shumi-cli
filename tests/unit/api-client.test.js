import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiGet, ApiError } from '../../src/lib/api-client.js';

describe('apiGet', () => {
  let origToken;
  let fetchSpy;

  beforeEach(() => {
    origToken = process.env.SHUMI_TOKEN;
    process.env.SHUMI_TOKEN = 'shumi_sk_test.secret';
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    if (origToken === undefined) delete process.env.SHUMI_TOKEN; else process.env.SHUMI_TOKEN = origToken;
    fetchSpy.mockRestore();
  });

  it('throws ApiError(401, AUTH_REQUIRED) when no token', async () => {
    delete process.env.SHUMI_TOKEN;
    process.env.SHUMI_NO_CONFIG = '1'; // suppress config-file fallback so test sees the no-token path
    try {
      await expect(apiGet('coin/risk/BTC')).rejects.toMatchObject({
        status: 401,
        body: { error: { code: 'AUTH_REQUIRED' } },
      });
    } finally {
      delete process.env.SHUMI_NO_CONFIG;
    }
  });

  it('returns parsed body on 2xx', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ schemaVersion: 1, data: { ok: true } }), { status: 200 }));
    const body = await apiGet('coin/risk/BTC');
    expect(body).toEqual({ schemaVersion: 1, data: { ok: true } });
  });

  it('sends Bearer token in Authorization header', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    await apiGet('signal-quality');
    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs[1].headers.Authorization).toBe('Bearer shumi_sk_test.secret');
  });

  it('appends query params, skipping nullish/false', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    await apiGet('funding/momentum', { symbol: 'BTC', missing: null, off: false, on: true });
    const url = fetchSpy.mock.calls[0][0];
    const u = new URL(url);
    expect(u.searchParams.get('symbol')).toBe('BTC');
    expect(u.searchParams.get('on')).toBe('true');
    expect(u.searchParams.has('missing')).toBe(false);
    expect(u.searchParams.has('off')).toBe(false);
  });

  it('throws ApiError with status on 4xx', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'nope' } }), { status: 400 }));
    await expect(apiGet('regime')).rejects.toMatchObject({ status: 400 });
  });

  it('wraps network error as ApiError(0, NETWORK)', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(apiGet('regime')).rejects.toMatchObject({
      status: 0,
      body: { error: { code: 'NETWORK' } },
    });
  });
});

describe('ApiError', () => {
  it('extracts error.message from envelope body', () => {
    const e = new ApiError(429, { error: { code: 'RATE_LIMITED', message: 'Too many' } });
    expect(e.message).toBe('Too many');
    expect(e.status).toBe(429);
  });

  it('falls back to error string', () => {
    const e = new ApiError(500, { error: 'oops' });
    expect(e.message).toBe('oops');
  });
});
