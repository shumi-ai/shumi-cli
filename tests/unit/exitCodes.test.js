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

describe('payment exit codes', () => {
  // Exit 3 is documented as "rate-limited / billing block" and the README calls the
  // table pinned for agent callers. A declined payment IS a billing block, so it
  // stays on 3 even though its code string changed from RATE_LIMITED (no limit was
  // hit) to PAYMENT_REQUIRED. Moving it to 1 would have made a declined payment
  // indistinguishable from a bad flag.
  it('keeps a payment block on the documented billing-block code', () => {
    expect(exitCodeForErrCode('PAYMENT_REQUIRED')).toBe(Exit.RATE_LIMITED);
  });

  // Ctrl-C at the payment prompt used to report "Declined." and exit 3, claiming a
  // decision the user never made. An interrupt is 130 by shell convention.
  it('reports an aborted payment as an interrupt, not a decision', () => {
    expect(exitCodeForErrCode('PAYMENT_ABORTED')).toBe(Exit.SIGINT);
    expect(exitCodeForErrCode('PAYMENT_ABORTED')).not.toBe(exitCodeForErrCode('PAYMENT_REQUIRED'));
  });
});
