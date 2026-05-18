import { API_URL, KEYS_URL, getDeviceId, getToken, getWalletAddress } from './config.js';

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
  const token = getToken();
  if (!token) throw new ApiError(401, { error: { code: 'AUTH_REQUIRED', message: 'Authentication required. Run: shumi login' } });

  const url = new URL(`${TYPED_BASE}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== false) url.searchParams.set(k, String(v));
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(TYPED_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(0, { error: { code: 'NETWORK', message: `Network error: ${err.message}` } });
  }

  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: { code: 'INTERNAL', message: text || 'invalid response' } }; }

  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export async function query({ messages, raw = false, archetype = 'base', commandContext = null }) {
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

  const response = await fetch(`${API_URL}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });

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
      throw new ApiError(429, { error: 'Rate limit exceeded. Please try again later.' });
    }
    if (response.status === 403) {
      throw new ApiError(403, { error: 'Free query used. Sign in to continue: shumi login' });
    }

    throw new ApiError(response.status, errorBody);
  }

  return response.json();
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
    // Check if the CLI endpoint is reachable with a minimal request
    // A 400 (bad request) still means the server is up
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
    return { ok: response.status < 500, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}
