import { createRequire } from 'module';
import { API_URL, KEYS_URL, getDeviceId, getToken, getRawToken, getWalletAddress } from './config.js';
import { fetchWithX402, consumeLastPaymentMeta } from './x402-client.js';
import { capture } from './telemetry.js';
import { inspectToken } from './token.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

// Identify the client on every request. The server cannot otherwise tell which
// version a caller is on — which is how a fleet of clients stayed six weeks
// behind a shipped auth fix with nobody able to see it. Also the prerequisite
// for ever refusing a version floor (426) rather than failing cryptically.
const USER_AGENT = `${pkg.name}/${pkg.version} (node ${process.version}; ${process.platform})`;

/**
 * Headers for an authenticated call. Single place so the UA can never be
 * added to some routes and forgotten on others.
 */
function authHeaders(token, extra = {}) {
  return { 'Authorization': `Bearer ${token}`, 'User-Agent': USER_AGENT, ...extra };
}

/**
 * Resolve the credential, distinguishing "expired" from "absent".
 *
 * getToken() collapses the two (it returns null once past expiry), which left
 * a user staring at "Authentication required" with no idea their session had
 * simply aged out. Checking the JWT's own `exp` also catches an expired
 * SHUMI_TOKEN from the environment, which the config-file expiry never saw.
 * Throws ApiError(401) with a distinct code; returns the token otherwise.
 */
function requireToken() {
  const raw = getRawToken();
  if (!raw) {
    throw new ApiError(401, { error: { code: 'AUTH_REQUIRED', message: 'Authentication required. Run: shumi login' } });
  }
  const info = inspectToken(raw);
  // Two independent expiry sources, and both must still gate the send. The
  // JWT's own `exp` is the one getToken() never saw (it catches an aged-out
  // SHUMI_TOKEN too). The config file's `expiresAt` is the one getToken() DID
  // enforce — reading raw here must not quietly start sending a credential the
  // old code refused, so consult getToken() for that verdict rather than
  // re-implementing it. A token with no `exp` claim relies entirely on it.
  const configExpired = getToken() === null;
  if (info.expired || configExpired) {
    throw new ApiError(401, {
      error: {
        code: 'AUTH_EXPIRED',
        message: `Session expired${expiredAgo(info.expiresAt)}. Run: shumi login`,
        details: { expiresAt: info.expiresAt },
      },
    });
  }
  return raw;
}

/** " 13 days ago" — empty when the expiry date isn't knowable client-side. */
function expiredAgo(expiresAt) {
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  if (Number.isNaN(at)) return '';
  const days = Math.max(0, Math.floor((Date.now() - at) / 86_400_000));
  if (days === 0) return ' today';
  return days === 1 ? ' 1 day ago' : ` ${days} days ago`;
}

/**
 * A server enforcing a minimum client version answers 426. Say what to do
 * instead of surfacing a bare status the user cannot act on.
 */
function upgradeRequiredError(body) {
  const min = body?.error?.details?.minVersion || body?.minVersion;
  const floor = min ? ` This server requires ${pkg.name} >= ${min}.` : '';
  return new ApiError(426, {
    error: {
      code: 'UPGRADE_REQUIRED',
      message: `Your ${pkg.name} ${pkg.version} is too old for this server.${floor} Run: npm i -g ${pkg.name}@latest`,
      details: { current: pkg.version, minVersion: min || null },
    },
  });
}

/**
 * Emit an api_request_completed event. Route is the path segment only (never
 * the full URL, which can carry tokens/query values). Never throws.
 */
function captureApiRequest(route, status, elapsedMs) {
  try {
    capture('api_request_completed', { route, status, elapsed_ms: elapsedMs });
  } catch { /* telemetry must never affect the request */ }
}

/**
 * Merge the most recent x402 payment metadata (if any) into a response body
 * so agents/scripts can see what they were charged for this call. We attach
 * under `meta.payment` to follow the envelope shape the server emits
 * (`{ data, meta: { route } }`); NLP responses with no `meta` get a fresh one.
 *
 * Non-mutating: clones via spread. No-op when there was no payment this call
 * (consumeLastPaymentMeta() returned null).
 */
function attachPaymentMeta(body) {
  const payment = consumeLastPaymentMeta();
  if (!payment || body == null || typeof body !== 'object') return body;
  return {
    ...body,
    meta: { ...(body.meta || {}), payment },
  };
}

const TYPED_BASE = API_URL; // already .../api/cli — typed routes nest under it
const TYPED_TIMEOUT_MS = 60_000;

export class ApiError extends Error {
  constructor(status, body) {
    const msg = body?.error?.message || body?.error || body?.message || `API request failed: ${status}`;
    super(msg);
    this.status = status;
    this.body = body;
  }
}

/**
 * GET a typed CLI endpoint (under `${API_URL}/<path>`). Returns the parsed JSON envelope.
 * Throws ApiError on non-2xx. Token is required (typed surface = paid surface).
 */
export async function apiGet(path, query = {}) {
  const route = String(path).replace(/^\//, ''); // path only — never the full URL
  const startedAt = Date.now();
  let token;
  try {
    token = requireToken();
  } catch (err) {
    captureApiRequest(route, 401, Date.now() - startedAt);
    throw err;
  }

  const url = new URL(`${TYPED_BASE}/${route}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== false) url.searchParams.set(k, String(v));
  }

  let response;
  try {
    // fetchWithX402 transparently handles 402 → sign → retry. For non-402
    // responses (including the regular 200 case and other errors) it
    // returns the original response untouched, so this is a one-line swap.
    response = await fetchWithX402(url, {
      method: 'GET',
      headers: authHeaders(token),
      signal: AbortSignal.timeout(TYPED_TIMEOUT_MS),
    });
  } catch (err) {
    // Payment-blocked errors carry .category='PAYMENT_BLOCKED' and a useful
    // .hint; we surface those as a structured ApiError so the renderer can
    // print the hint cleanly and exit with code 3 (rate-limited family).
    if (err?.category === 'PAYMENT_BLOCKED') {
      captureApiRequest(route, 402, Date.now() - startedAt);
      throw new ApiError(402, {
        error: {
          code: err.code,
          message: err.message,
          hint: err.hint,
          // The quota facts the server put on the 402. A machine caller should
          // not have to parse them back out of the prose message.
          ...(err.gate ? { details: err.gate } : {}),
        },
      });
    }
    captureApiRequest(route, 0, Date.now() - startedAt);
    throw new ApiError(0, { error: { code: 'NETWORK', message: `Network error: ${err.message}` } });
  }

  captureApiRequest(route, response.status, Date.now() - startedAt);

  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: { code: 'INTERNAL', message: text || 'invalid response' } }; }

  if (response.status === 426) throw upgradeRequiredError(body);
  if (!response.ok) throw new ApiError(response.status, body);
  return attachPaymentMeta(body);
}

export async function query({ messages, raw = false, archetype = 'base', commandContext = null }) {
  const startedAt = Date.now();
  const route = 'nlp'; // POST /api/cli — never the request body (contains prompt)
  const token = getToken();
  const deviceId = getDeviceId();
  const walletAddress = getWalletAddress();

  // The NLP route serves anonymous callers too, so a missing token is fine
  // here — but an EXPIRED one is not. Silently downgrading to anon is how a
  // paying user ends up hitting the free-tier wall with no explanation.
  const stored = getRawToken();
  if (stored && inspectToken(stored).expired) requireToken();

  const headers = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const body = {
    messages,
    deviceId,
    raw,
    archetype,
  };

  if (walletAddress) body.walletAddress = walletAddress;
  if (commandContext) body.commandContext = commandContext;

  let response;
  try {
    response = await fetchWithX402(`${API_URL}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });
  } catch (err) {
    if (err?.category === 'PAYMENT_BLOCKED') {
      captureApiRequest(route, 402, Date.now() - startedAt);
      throw new ApiError(402, {
        error: {
          code: err.code,
          message: err.message,
          hint: err.hint,
          // The quota facts the server put on the 402. A machine caller should
          // not have to parse them back out of the prose message.
          ...(err.gate ? { details: err.gate } : {}),
        },
      });
    }
    captureApiRequest(route, 0, Date.now() - startedAt);
    // Same shape apiGet throws, so renderErr maps it to exit 6 (NETWORK) and a
    // "check your connection" hint instead of exit 7 and a bare "fetch failed".
    throw new ApiError(0, { error: { code: 'NETWORK', message: `Network error: ${err.message}` } });
  }

  captureApiRequest(route, response.status, Date.now() - startedAt);

  if (!response.ok) {
    // Read body once as text, then try to parse as JSON
    const text = await response.text();
    let errorBody;
    try {
      errorBody = JSON.parse(text);
    } catch {
      errorBody = { error: text || `Request failed: ${response.status}` };
    }

    if (response.status === 426) {
      throw upgradeRequiredError(errorBody);
    }
    if (response.status === 401) {
      throw new ApiError(401, { error: 'Authentication required. Run: shumi login' });
    }
    if (response.status === 429) {
      // Surface the server's ACTUAL reason. The server distinguishes two very
      // different 429s: the per-IP burst limiter ("Rate limit exceeded…") and a
      // tier quota ("Quota exceeded (3/3 on free)…"). Hard-coding the former hid
      // quota/wrong-account problems for days — a free-tier session looked like
      // an IP rate limit. Fall back to the generic text only if the body is empty.
      throw new ApiError(429, { error: errorBody?.error || 'Rate limit exceeded. Please try again later.' });
    }
    if (response.status === 403) {
      throw new ApiError(403, { error: 'Free query used. Sign in to continue: shumi login' });
    }

    throw new ApiError(response.status, errorBody);
  }

  const json = await response.json();
  return attachPaymentMeta(json);
}

export async function createKey(name) {
  const token = requireToken();

  const response = await fetch(KEYS_URL, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: name || 'Default' }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `Request failed: ${response.status}` }));
    throw new ApiError(response.status, body);
  }

  return response.json();
}

export async function listKeys() {
  const token = requireToken();

  const response = await fetch(KEYS_URL, {
    method: 'GET',
    headers: authHeaders(token),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `Request failed: ${response.status}` }));
    throw new ApiError(response.status, body);
  }

  return response.json();
}

export async function revokeKey(prefix) {
  const token = requireToken();

  const response = await fetch(`${KEYS_URL}?prefix=${encodeURIComponent(prefix)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `Request failed: ${response.status}` }));
    throw new ApiError(response.status, body);
  }

  return response.json();
}

export async function healthCheck() {
  try {
    // Unmetered reachability probe: GET the host's /robots.txt rather than POSTing
    // the query endpoint. The old POST hit the metered route and silently spent one
    // of the user's free queries every time `shumi health` ran. A static GET proves
    // the server is up without touching the quota.
    const { protocol, host } = new URL(API_URL);
    const response = await fetch(`${protocol}//${host}/robots.txt`, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    return { ok: response.status < 500, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}
