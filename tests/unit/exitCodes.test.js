import { describe, it, expect } from 'vitest';
import { Exit, exitCodeForStatus, exitCodeForErrCode } from '../../src/lib/exitCodes.js';

describe('Exit constants', () => {
  it('matches the documented numeric mapping', () => {
    expect(Exit.SUCCESS).toBe(0);
    expect(Exit.USER_ERROR).toBe(1);
    expect(Exit.AUTH_REQUIRED).toBe(2);
    expect(Exit.RATE_LIMITED).toBe(3);
    expect(Exit.UPSTREAM_4XX).toBe(4);
    expect(Exit.UPSTREAM_5XX).toBe(5);
    expect(Exit.NETWORK).toBe(6);
    expect(Exit.INTERNAL).toBe(7);
    expect(Exit.SIGINT).toBe(130);
  });
});

describe('exitCodeForStatus', () => {
  it.each([
    [401, Exit.AUTH_REQUIRED],
    [403, Exit.AUTH_REQUIRED],
    [429, Exit.RATE_LIMITED],
    [400, Exit.UPSTREAM_4XX],
    [404, Exit.UPSTREAM_4XX],
    [500, Exit.UPSTREAM_5XX],
    [502, Exit.UPSTREAM_5XX],
    [0,   Exit.NETWORK],
  ])('maps %d → %d', (status, expected) => {
    expect(exitCodeForStatus(status)).toBe(expected);
  });
});

describe('exitCodeForErrCode', () => {
  it.each([
    ['AUTH_REQUIRED', Exit.AUTH_REQUIRED],
    ['AUTH_INVALID',  Exit.AUTH_REQUIRED],
    ['RATE_LIMITED',  Exit.RATE_LIMITED],
    ['BAD_REQUEST',   Exit.USER_ERROR],
    ['UPSTREAM_4XX',  Exit.UPSTREAM_4XX],
    ['UPSTREAM_5XX',  Exit.UPSTREAM_5XX],
    ['NETWORK',       Exit.NETWORK],
    ['INTERNAL',      Exit.INTERNAL],
    ['UNKNOWN_CODE',  Exit.INTERNAL],
  ])('maps "%s" → %d', (code, expected) => {
    expect(exitCodeForErrCode(code)).toBe(expected);
  });
});
