/**
 * Offline credential inspection. Performs NO network call, so it NEVER consumes
 * the user's query quota — diagnostics (`doctor`, `init`) use this instead of
 * hitting a metered endpoint just to confirm "is my token usable".
 *
 * Note: the JWT signature is NOT verified here (that requires the server's JWKS
 * over the network). This validates structure and expiry only — enough to tell
 * a user whether their token is well-formed and unexpired before they spend a
 * real query. The server remains the source of truth for acceptance.
 */
export function inspectToken(token) {
  if (!token) return { kind: 'none', valid: false, expired: false, reason: 'no token' };

  // Opaque API keys (shumi_sk_*) can't be decoded client-side — format check only.
  if (token.startsWith('shumi_sk_')) {
    return { kind: 'API key', valid: true, expired: false, reason: 'format ok (not verified locally)' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { kind: 'JWT', valid: false, expired: false, reason: 'malformed (expected 3 segments)' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { kind: 'JWT', valid: false, expired: false, reason: 'undecodable payload' };
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  const expired = exp != null && exp < now;
  const expiresAt = exp != null ? new Date(exp * 1000).toISOString() : null;

  return {
    kind: 'JWT',
    valid: !expired,
    expired,
    exp,
    expiresAt,
    email: payload.email || null,
    sub: payload.sub || null,
    reason: expired ? `expired ${expiresAt}` : 'valid (signature not verified)',
  };
}
