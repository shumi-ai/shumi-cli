/**
 * PostHog telemetry — server-side (`posthog-node`) wrapper for the Shumi CLI.
 *
 * Design constraints (all hard):
 *   - Fire-and-forget. A telemetry failure must NEVER crash or slow a command.
 *     Every public function is wrapped so it can throw at most internally; the
 *     caller always sees a resolved/void return. This is the one place where
 *     try/catch-around-everything is the correct pattern.
 *   - Never writes to stdout. The CLI emits machine JSON on stdout in --agent /
 *     non-TTY mode; any stray write there corrupts piped output. PostHog's
 *     network I/O is async/background; we never console.log.
 *   - Safe no-op when disabled: empty API key, SHUMI_TELEMETRY=0/false, or
 *     `telemetry_opt_out: true` in ~/.shumi/config.json fully disables it.
 *
 * distinct_id = the deterministic machine fingerprint (getDeviceId). When a
 * wallet/user is known we attach a truncated wallet address as a property and
 * set it as a person property via `$set`.
 *
 * Privacy: callers are responsible for never passing raw query/prompt text,
 * private keys, API-key contents, JWTs, or full token-bearing URLs. This module
 * additionally truncates wallet addresses it derives itself.
 */

import { PostHog } from 'posthog-node';
import { getDeviceId, getWalletAddress, isTelemetryOptedOut } from './config.js';

const DEFAULT_POSTHOG_KEY = 'phc_xBnChEMGfPyg3CUKngxDcQsespURUnWKaUrfBdOOCyI';
const DEFAULT_POSTHOG_HOST = 'https://t.shumi.ai';

// Short-lived CLI: don't batch on a timer, flush explicitly before exit.
const FLUSH_AT = 1; // send as soon as we have an event queued
const FLUSH_INTERVAL_MS = 0; // disable interval flushing; we flush manually
const REQUEST_TIMEOUT_MS = 1000; // keep network I/O snappy
const FLUSH_HARD_TIMEOUT_MS = 800; // never let flush() add noticeable CLI latency

let client = null; // posthog-node instance, or null when disabled
let initialized = false;
let enabled = false;
let captured = false; // whether any event was queued this process

/** First6…last4 wallet truncation. Exported for reuse by event-emitting code. */
export function truncWallet(addr) {
  if (!addr || typeof addr !== 'string') return null;
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function resolveEnabled() {
  const flag = (process.env.SHUMI_TELEMETRY || '').toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return false;
  let optedOut = false;
  try {
    optedOut = isTelemetryOptedOut();
  } catch {
    optedOut = false;
  }
  if (optedOut) return false;
  const key = process.env.POSTHOG_API_KEY ?? DEFAULT_POSTHOG_KEY;
  if (!key || !String(key).trim()) return false;
  return true;
}

/**
 * Lazy-init the PostHog client. Idempotent and never throws. Safe no-op when
 * telemetry is disabled. Must be called once near process start (bin/shumi.js);
 * capture() also self-initializes defensively.
 */
export function initTelemetry() {
  if (initialized) return;
  initialized = true;
  try {
    enabled = resolveEnabled();
    if (!enabled) return;

    const key = process.env.POSTHOG_API_KEY ?? DEFAULT_POSTHOG_KEY;
    const host = process.env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST;

    client = new PostHog(key, {
      host,
      flushAt: FLUSH_AT,
      flushInterval: FLUSH_INTERVAL_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    });
  } catch {
    enabled = false;
    client = null;
  }
}

/**
 * Anonymous, stable distinct_id for this machine. Falls back to a constant if
 * the fingerprint can't be derived (never throws).
 */
export function getDistinctId() {
  try {
    return getDeviceId() || 'unknown-device';
  } catch {
    return 'unknown-device';
  }
}

/**
 * Build the common property/`$set` envelope. Attaches a truncated wallet
 * address (property + person `$set`) when one is known.
 */
function baseProps(extra = {}) {
  const props = { source: 'cli', ...extra };
  try {
    const wallet = getWalletAddress();
    const tw = truncWallet(wallet);
    if (tw) {
      props.wallet_truncated = tw;
      props.$set = { ...(props.$set || {}), wallet_truncated: tw };
    }
  } catch {
    // ignore — wallet is optional context
  }
  return props;
}

/**
 * Capture an analytics event. Fire-and-forget; never throws, never blocks.
 */
export function capture(event, properties = {}) {
  try {
    if (!initialized) initTelemetry();
    if (!enabled || !client) return;
    captured = true;
    client.capture({
      distinctId: getDistinctId(),
      event,
      properties: baseProps(properties),
    });
  } catch {
    // swallow — telemetry must never affect the command
  }
}

/**
 * Capture an exception as a structured error event. Strips messages of obvious
 * secret-bearing shapes is the caller's job; here we only record the error
 * name/message/code and provided context. Never throws.
 */
export function captureError(error, context = {}) {
  try {
    if (!initialized) initTelemetry();
    if (!enabled || !client) return;
    const err = error || {};
    capture('cli_error', {
      error_name: err.name || 'Error',
      error_message: typeof err.message === 'string' ? err.message.slice(0, 500) : undefined,
      error_code: err.code ?? err.envelope?.error?.code ?? err.body?.error?.code,
      http_status: typeof err.status === 'number' ? err.status : undefined,
      ...context,
    });
  } catch {
    // swallow
  }
}

/**
 * Flush queued events, racing against a hard timeout so the CLI never hangs on
 * exit. Resolves (never rejects) in all cases.
 */
export async function flush() {
  try {
    if (!enabled || !client || !captured) return;
    await Promise.race([
      client.flush().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, FLUSH_HARD_TIMEOUT_MS)),
    ]);
  } catch {
    // swallow
  }
}

/**
 * Shut down the client (flush + close). Resolves (never rejects), bounded by a
 * hard timeout.
 */
export async function shutdown() {
  try {
    if (!enabled || !client || !captured) return;
    await Promise.race([
      client.shutdown().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, FLUSH_HARD_TIMEOUT_MS)),
    ]);
  } catch {
    // swallow
  } finally {
    client = null;
  }
}

/** Test/introspection helper — whether telemetry is currently active. */
export function isEnabled() {
  if (!initialized) initTelemetry();
  return Boolean(enabled && client);
}
