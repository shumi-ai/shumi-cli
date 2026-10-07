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
 * Identity model (canonical person id = lowercased wallet address, the same id
 * the web/Dynamic session identifies by, so one human is one PostHog person
 * across web + CLI):
 *   - Logged out: distinct_id = the machine fingerprint (getDeviceId), and every
 *     event carries `$process_person_profile: false` so no identified person is
 *     created from the anonymous bootstrap id (matches `identified_only`).
 *   - On `shumi login`: identifyWallet() aliases the device id into the wallet
 *     person and identifies as the wallet, folding the anonymous session in.
 *   - Logged in: distinct_id = the wallet; a truncated wallet is also kept as a
 *     person `$set` property for display.
 *
 * Privacy: callers are responsible for never passing raw query/prompt text,
 * private keys, API-key contents, JWTs, or full token-bearing URLs. This module
 * additionally truncates wallet addresses it derives itself.
 */

import { createRequire } from 'module';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { PostHog } from 'posthog-node';
import { getDeviceId, getWalletAddress, isTelemetryOptedOut } from './config.js';

const require = createRequire(import.meta.url);

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
const pendingExceptions = new Set(); // in-flight $exception sends, awaited by flush()

/** CLI version from package.json — the `app_version` on every $exception. */
function readAppVersion() {
  try {
    return require('../../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}
const APP_VERSION = readAppVersion();

/**
 * 'production' when running from an installed package (npm i -g / npx put the
 * code under node_modules), 'development' when running from a git checkout
 * (`node bin/shumi.js`, `npm link`). Exported for tests.
 */
export function resolveReleaseStage(moduleUrl = import.meta.url) {
  try {
    const path = moduleUrl.startsWith('file:') ? fileURLToPath(moduleUrl) : moduleUrl;
    return /[\\/]node_modules[\\/]/.test(path) ? 'production' : 'development';
  } catch {
    return 'production';
  }
}
const RELEASE_STAGE = resolveReleaseStage();

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

/** Lowercased wallet address if known, else null. Never throws. */
function walletId() {
  try {
    const w = getWalletAddress();
    return w && typeof w === 'string' ? w.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The machine fingerprint (anonymous bootstrap id). Never throws. */
function deviceId() {
  try {
    return getDeviceId() || 'unknown-device';
  } catch {
    return 'unknown-device';
  }
}

/**
 * Canonical distinct_id: the wallet (lowercased) once logged in — the same id
 * the web session identifies by — else the machine fingerprint.
 */
export function getDistinctId() {
  return walletId() || deviceId();
}

/**
 * Build the common property/`$set` envelope. When logged in, attaches a
 * truncated wallet for display. When logged out, marks the event
 * `$process_person_profile: false` so the anonymous device id doesn't create a
 * standalone identified person that could never merge with the wallet.
 */
function baseProps(extra = {}) {
  // `surface` is the canonical cross-surface tag (all Shumi surfaces share one
  // PostHog project + key), so it's the property to group/filter by in insights.
  // Peer surfaces: 'coinrotator' / 'shumi-landing' (web), 'api' (coinrotator-ai
  // backend), 'mcp' (shumi-mcp).
  const props = { surface: 'cli', ...extra };
  const wallet = walletId();
  if (wallet) {
    const tw = truncWallet(wallet);
    if (tw) {
      props.wallet_truncated = tw;
      props.$set = { ...(props.$set || {}), wallet_truncated: tw };
    }
  } else {
    props.$process_person_profile = false;
  }
  return props;
}

/**
 * Stitch the anonymous device session into the wallet person, then identify as
 * the wallet. Call once on successful `shumi login`. Fire-and-forget.
 */
export function identifyWallet(wallet) {
  try {
    if (!initialized) initTelemetry();
    if (!enabled || !client) return;
    const w = wallet && typeof wallet === 'string' ? wallet.toLowerCase() : null;
    if (!w) return;
    const dev = deviceId();
    captured = true;
    // alias: events from the anonymous device id now belong to the wallet person.
    if (dev && dev !== w) client.alias({ distinctId: w, alias: dev });
    client.identify({ distinctId: w, properties: { $set: { wallet_truncated: truncWallet(w) } } });
  } catch {
    // swallow — telemetry must never affect auth
  }
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
 * Copy of the error safe to send to PostHog Error Tracking: message capped at
 * 500 chars (as for `cli_error`) and the user's home directory replaced by `~`
 * in message and stack, so a local username never leaves the machine.
 */
export function sanitizeError(error) {
  const src = error instanceof Error ? error : new Error(String(error?.message ?? error));
  let home = '';
  try {
    home = homedir();
  } catch {
    home = '';
  }
  const scrub = (s) => (home && typeof s === 'string' ? s.split(home).join('~') : s);
  const out = new Error(scrub(String(src.message ?? '').slice(0, 500)));
  out.name = src.name || 'Error';
  if (typeof src.stack === 'string') out.stack = scrub(src.stack);
  return out;
}

/**
 * Capture an exception. Records two things, both fire-and-forget:
 *   - the existing `cli_error` analytics event (name/message/code + context);
 *   - a PostHog Error Tracking `$exception` with the cross-service contract
 *     (surface, severity, release_stage, app_version, handled).
 * Callers pass `{ handled: false }` from the last-resort process hooks.
 * Respects the same opt-outs as every other event. Never throws.
 */
export function captureError(error, context = {}, { handled = true, severity = 'error' } = {}) {
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
    // `surface` must stay 'cli' on $exception (Doctor groups by it); a caller's
    // own `surface` (e.g. 'nlp', 'renderErr') is kept as `error_source`.
    const { surface: errorSource, ...rest } = context;
    const props = baseProps({
      ...rest,
      ...(errorSource ? { error_source: errorSource } : {}),
      error_code: err.code ?? err.envelope?.error?.code ?? err.body?.error?.code,
      http_status: typeof err.status === 'number' ? err.status : undefined,
      severity,
      release_stage: RELEASE_STAGE,
      app_version: APP_VERSION,
      handled,
    });
    props.surface = 'cli';
    // Immediate send (not batched) so flush() before exit can await it.
    const p = Promise.resolve(client.captureExceptionImmediate(sanitizeError(error), getDistinctId(), props))
      .catch(() => {})
      .finally(() => pendingExceptions.delete(p));
    pendingExceptions.add(p);
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
      Promise.allSettled([...pendingExceptions]).then(() => client?.flush().catch(() => {})),
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
      Promise.allSettled([...pendingExceptions]).then(() => client?.shutdown().catch(() => {})),
      new Promise((resolve) => setTimeout(resolve, FLUSH_HARD_TIMEOUT_MS)),
    ]);
  } catch {
    // swallow
  } finally {
    client = null;
  }
}

/** Test helper: inject a fake client (or null) and mark telemetry enabled/disabled. */
export function _setClientForTests(fake) {
  initialized = true;
  enabled = Boolean(fake);
  client = fake;
  captured = false;
  pendingExceptions.clear();
}

/** Test/introspection helper — whether telemetry is currently active. */
export function isEnabled() {
  if (!initialized) initTelemetry();
  return Boolean(enabled && client);
}
