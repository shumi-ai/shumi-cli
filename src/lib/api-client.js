import { API_URL, KEYS_URL, getDeviceId, getToken, getWalletAddress } from './config.js';
import { fetchWithX402, consumeLastPaymentMeta } from './x402-client.js';
import { capture } from './telemetry.js';

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
  const token = getToken();
  if (!token) {
    captureApiRequest(route, 401, Date.now() - startedAt);
    throw new ApiError(401, { error: { code: 'AUTH_REQUIRED', message: 'Authentication required. Run: shumi login' } });
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
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(TYPED_TIMEOUT_MS),
    });
  } catch (err) {
    // Payment-blocked errors carry .category='PAYMENT_BLOCKED' and a useful
    // .hint; we surface those as a structured ApiError so the renderer can
    // print the hint cleanly and exit with code 3 (rate-limited family).
    if (err?.category === 'PAYMENT_BLOCKED') {
      captureApiRequest(route, 402, Date.now() - startedAt);
      throw new ApiError(402, { error: { code: err.code, message: err.message, hint: err.hint } });
    }
    captureApiRequest(route, 0, Date.now() - startedAt);
    throw new ApiError(0, { error: { code: 'NETWORK', message: `Network error: ${err.message}` } });
  }

  captureApiRequest(route, response.status, Date.now() - startedAt);

  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: { code: 'INTERNAL', message: text || 'invalid response' } }; }

  if (!response.ok) throw new ApiError(response.status, body);
  return attachPaymentMeta(body);
}

export async function query({ messages, raw = false, archetype = 'base', commandContext = null }) {
  const startedAt = Date.now();
  const route = 'nlp'; // POST /api/cli — never the request body (contains prompt)
  const token = getToken();
  const deviceId = getDeviceId();
  const walletAddress = getWalletAddress();

  const headers = { 'Content-Type': 'application/json' };
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
      throw new ApiError(402, { error: { code: err.code, message: err.message, hint: err.hint } });
    }
    captureApiRequest(route, 0, Date.now() - startedAt);
    throw err;
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
  const token = getToken();
  if (!token) throw new ApiError(401, { error: 'Authentication required. Run: shumi login' });

  const response = await fetch(KEYS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
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
  const token = getToken();
  if (!token) throw new ApiError(401, { error: 'Authentication required. Run: shumi login' });

  const response = await fetch(KEYS_URL, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `Request failed: ${response.status}` }));
    throw new ApiError(response.status, body);
  }

  return response.json();
}

export async function revokeKey(prefix) {
  const token = getToken();
  if (!token) throw new ApiError(401, { error: 'Authentication required. Run: shumi login' });

  const response = await fetch(`${KEYS_URL}?prefix=${encodeURIComponent(prefix)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
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
      signal: AbortSignal.timeout(10000),
    });
    return { ok: response.status < 500, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}
