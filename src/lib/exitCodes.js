/**
 * Documented exit codes — pinned by AI-agent callers.
 *
 *   0 SUCCESS
 *   1 USER_ERROR     bad flags, malformed args
 *   2 AUTH_REQUIRED  no token / missing credentials
 *   3 RATE_LIMITED   429 / billing block
 *   4 UPSTREAM_4XX   not-found, bad-request from server
 *   5 UPSTREAM_5XX   server error
 *   6 NETWORK        connection / timeout
 *   7 INTERNAL       unexpected client-side error
 *   130 SIGINT
 */
export const Exit = Object.freeze({
  SUCCESS: 0,
  USER_ERROR: 1,
  AUTH_REQUIRED: 2,
  RATE_LIMITED: 3,
  UPSTREAM_4XX: 4,
  UPSTREAM_5XX: 5,
  NETWORK: 6,
  INTERNAL: 7,
  SIGINT: 130,
});

/**
 * Map an HTTP status to the documented exit code.
 */
export function exitCodeForStatus(status) {
  if (status === 401 || status === 403) return Exit.AUTH_REQUIRED;
  if (status === 429) return Exit.RATE_LIMITED;
  if (status >= 400 && status < 500) return Exit.UPSTREAM_4XX;
  if (status >= 500 && status < 600) return Exit.UPSTREAM_5XX;
  if (status === 0) return Exit.NETWORK;
  return Exit.INTERNAL;
}

/**
 * Map an envelope error code to the documented exit code.
 */
export function exitCodeForErrCode(code) {
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'AUTH_INVALID':
    case 'AUTH_EXPIRED':
      return Exit.AUTH_REQUIRED;
    // A too-old client is a user-fixable problem (upgrade), not a server fault.
    case 'UPGRADE_REQUIRED':
      return Exit.USER_ERROR;
    case 'RATE_LIMITED':
      return Exit.RATE_LIMITED;
    case 'BAD_REQUEST':
      return Exit.USER_ERROR;
    case 'UPSTREAM_4XX':
      return Exit.UPSTREAM_4XX;
    case 'UPSTREAM_5XX':
      return Exit.UPSTREAM_5XX;
    case 'NETWORK':
      return Exit.NETWORK;
    case 'INTERNAL':
    default:
      return Exit.INTERNAL;
  }
}
