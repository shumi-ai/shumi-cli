/**
 * Warn BEFORE the session dies, not after.
 *
 * `exp === refreshExp` on these tokens — there is no silent refresh, so a
 * session ends hard at ~30 days. Until now nothing said so in advance: the
 * first signal was every command failing at once, which read as an outage
 * rather than "log in again". One customer's dashboard rendered stale data
 * for 13 days on the strength of that ambiguity.
 *
 * Deliberately reports only the pre-expiry window. Once a token IS expired,
 * api-client's AUTH_EXPIRED owns the message, and two surfaces saying it at
 * once is how you train people to ignore both.
 */
import { getRawToken } from './config.js';
import { inspectToken } from './token.js';

export const EXPIRY_WARN_DAYS = 5;

const DAY_MS = 86_400_000;

/**
 * `{ expiresAt, daysRemaining, action }` when a JWT is valid but inside the
 * warning window, otherwise null. `now` is injectable for tests.
 *
 * API keys (`shumi_sk_*`) are skipped: they cannot be decoded client-side, so
 * there is no expiry to read and guessing at one would be worse than silence.
 */
export function authExpiryNotice(now = Date.now()) {
  const raw = getRawToken();
  if (!raw) return null;

  const info = inspectToken(raw, now);
  if (info.kind !== 'JWT' || info.expired || !info.expiresAt) return null;

  const msLeft = Date.parse(info.expiresAt) - now;
  if (!(msLeft > 0)) return null;

  const daysRemaining = Math.floor(msLeft / DAY_MS);
  if (daysRemaining >= EXPIRY_WARN_DAYS) return null;

  return { expiresAt: info.expiresAt, daysRemaining, action: 'shumi login' };
}

/** "expires today" / "expires in 1 day" / "expires in 4 days". */
export function describeExpiry({ daysRemaining }) {
  if (daysRemaining <= 0) return 'expires today';
  return daysRemaining === 1 ? 'expires in 1 day' : `expires in ${daysRemaining} days`;
}
