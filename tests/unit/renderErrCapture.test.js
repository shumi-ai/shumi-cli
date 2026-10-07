import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Which renderErr calls become a PostHog `$exception`. Only real faults do:
 * thrown Errors, 5xx and network failures. Hand-built user messages (a
 * cancelled prompt, a passphrase mismatch) and expected 4xx do not.
 */

const telemetry = vi.hoisted(() => ({ captureError: vi.fn(), capture: vi.fn() }));
vi.mock('../../src/lib/telemetry.js', () => telemetry);
vi.mock('../../src/lib/updateCheck.js', () => ({ getUpdateInfo: () => null }));

const { renderErr, shouldCaptureError } = await import('../../src/lib/output.js');
const { ApiError } = await import('../../src/lib/api-client.js');

describe('renderErr → $exception', () => {
  const origWrite = process.stderr.write;
  beforeEach(() => {
    telemetry.captureError.mockClear();
    process.stderr.write = () => true;
  });
  afterEach(() => {
    process.stderr.write = origWrite;
    process.exitCode = 0;
  });

  it.each([
    ['cancelled prompt', { message: 'Cancelled.' }],
    ['passphrase mismatch', { message: 'Passphrases do not match. Try again.' }],
    ['message with hint', { message: 'No wallet configured.', hint: 'run shumi wallet create' }],
    ['bad-request envelope', { envelope: { schemaVersion: 1, error: { code: 'BAD_REQUEST', message: 'unknown command' } } }],
    ['400', new ApiError(400, { error: { code: 'BAD_REQUEST', message: 'bad' } })],
    ['404', new ApiError(404, { error: { message: 'not found' } })],
    ['401', new ApiError(401, { error: { code: 'AUTH_REQUIRED', message: 'login' } })],
    ['429', new ApiError(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } })],
    ['payment blocked', Object.assign(new Error('declined'), { category: 'PAYMENT_BLOCKED', code: 'PAYMENT_REQUIRED' })],
  ])('does not capture: %s', (_label, err) => {
    renderErr(err, { json: true });
    expect(telemetry.captureError).not.toHaveBeenCalled();
  });

  it.each([
    ['thrown Error', new Error('boom')],
    ['TypeError', new TypeError('x is undefined')],
    ['500', new ApiError(500, { error: { message: 'server fell over' } })],
    ['503', new ApiError(503, {})],
    ['network status 0', new ApiError(0, { error: { code: 'NETWORK', message: 'fetch failed' } })],
    ['network envelope', { envelope: { schemaVersion: 1, error: { code: 'NETWORK', message: 'timeout' } } }],
  ])('captures: %s', (_label, err) => {
    renderErr(err, { json: true });
    expect(telemetry.captureError).toHaveBeenCalledTimes(1);
  });

  it('never throws on odd input', () => {
    expect(shouldCaptureError(null)).toBe(false);
    expect(shouldCaptureError(undefined)).toBe(false);
    expect(shouldCaptureError('a string')).toBe(false);
  });
});
