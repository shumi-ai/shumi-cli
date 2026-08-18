import chalk from 'chalk';
import ora from 'ora';
import { Exit, exitCodeForStatus, exitCodeForErrCode } from './exitCodes.js';
import { captureError } from './telemetry.js';
import { getUpdateInfo } from './updateCheck.js';
import { authExpiryNotice, describeExpiry } from './authNotice.js';

/**
 * Decide whether an error is a real fault worth capturing (5xx, network,
 * internal/parse) vs. routine user-gating noise (401/403/429, payment blocks)
 * that is a product event, not an error. Never throws.
 */
function shouldCaptureError(err) {
  try {
    const status = typeof err?.status === 'number' ? err.status : null;
    if (status === 401 || status === 403 || status === 429 || status === 402) return false;
    if (err?.category === 'PAYMENT_BLOCKED') return false;
    const code = err?.envelope?.error?.code || err?.body?.error?.code || err?.code;
    if (code === 'AUTH_REQUIRED' || code === 'RATE_LIMITED' || code === 'PAYMENT_REQUIRED') return false;
    if (status === 0 || code === 'NETWORK') return true; // network failure
    if (status !== null && status >= 500) return true; // upstream 5xx
    if (status === null) return true; // no HTTP status → internal/unexpected
    return false; // other 4xx are user errors, not faults
  } catch {
    return false;
  }
}

/**
 * Centralized output policy.
 *
 *   --json     force JSON on stdout
 *   --agent    machine mode: JSON, no spinner, no color, no update-notifier, machine error envelope
 *   non-TTY    auto-JSON (so `shumi … | jq …` works without --json)
 *   NO_COLOR   suppresses chalk (chalk reads env natively)
 *
 * Pass `opts` through from Commander: `cmd.opts()` already includes program-wide --json/--agent.
 */

export function resolveMode(opts = {}) {
  const isTty = Boolean(process.stdout.isTTY);
  const agent = Boolean(opts.agent) || process.env.SHUMI_AGENT === '1';
  const json = Boolean(opts.json) || agent || !isTty;
  if (agent || !isTty || process.env.NO_COLOR) chalk.level = 0;
  return { json, agent, isTty };
}

// The x402 payment prompt happens deep inside apiGet while a spinner started out
// here is still animating. ora repaints the current line, so it overwrote the
// "Pay? [Y/n]" question: the user saw a payment notice with no question and no
// sign that anything was waiting on them. Tracking the live instance lets the
// prompt pause it — see pauseActiveSpinner.
let activeSpinner = null;

export function spinner(text, opts = {}) {
  const mode = resolveMode(opts);
  if (mode.agent || mode.json) {
    return { start() { return this; }, stop() {}, succeed() {}, fail() {}, set text(_) {} };
  }
  const instance = ora({ text, spinner: 'dots' }).start();
  activeSpinner = instance;
  for (const method of ['stop', 'succeed', 'fail']) {
    const original = instance[method].bind(instance);
    instance[method] = (...args) => {
      if (activeSpinner === instance) activeSpinner = null;
      return original(...args);
    };
  }
  return instance;
}

/**
 * Stop the running spinner, if any, and return a function that restarts it.
 * A no-op when nothing is spinning, so callers need no branching.
 *
 * Use around anything that reads from the terminal: otherwise the prompt and the
 * spinner fight over the same line, and the prompt loses.
 */
export function pauseActiveSpinner() {
  const instance = activeSpinner;
  if (!instance) return () => {};
  const { text } = instance;
  instance.stop();
  return () => { instance.start(text); activeSpinner = instance; };
}

/**
 * Emit a successful response. JSON mode prints the full envelope; human mode lets
 * the caller print however they like (and ignores `human`).
 */
export function renderOk(envelope, opts = {}, human) {
  const mode = resolveMode(opts);
  if (mode.json) {
    process.stdout.write(JSON.stringify(withNotices(envelope)) + '\n');
    return;
  }
  if (typeof human === 'function') human(envelope?.data ?? envelope, chalk);
  else process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
}

/**
 * Attach out-of-band notices to a JSON envelope: a newer version is available,
 * or the session is about to expire.
 *
 * This is the only channel that reaches a machine consumer: `notify()` prints
 * nothing when stdout is piped, and `resolveMode()` forces JSON for exactly
 * those runs. Both are nested under `meta` so they can never collide with a
 * command's `data` payload. No-op when there is nothing to say.
 */
function withNotices(env) {
  if (!env || typeof env !== 'object') return env;
  const update = getUpdateInfo();
  const expiring = authExpiryNotice();
  if (!update && !expiring) return env;
  return {
    ...env,
    meta: {
      ...(env.meta || {}),
      ...(update && { updateAvailable: update }),
      ...(expiring && { authExpiring: expiring }),
    },
  };
}

/**
 * Emit a machine error on stderr (always JSON envelope), set exit code, and return.
 * Caller decides whether to also print a friendly human line.
 */
export function renderErr(err, opts = {}) {
  const mode = resolveMode(opts);
  const envelope = errEnvelopeFromError(err);
  if (shouldCaptureError(err)) {
    try {
      captureError(err, { surface: 'renderErr', error_code: envelope?.error?.code });
    } catch { /* telemetry must never affect error rendering */ }
  }
  // One rendering, not two. Both were emitted before, so an interactive user read
  // the same failure twice — once as raw JSON, once as prose:
  //
  //   {"schemaVersion":1,"error":{"code":"PAYMENT_REQUIRED","message":"Payment declined…"}}
  //   ✗ Payment declined — nothing was charged.
  //
  // The envelope is a machine contract (README: errors always emit a stable JSON
  // envelope on stderr so `stdout | jq` never breaks). It stays exactly as it was
  // for --json, --agent and any non-TTY, which is every consumer that parses it.
  // A human at a terminal is not that consumer.
  if (mode.json || mode.agent) {
    // The error path matters more than the success path here: a client stuck on a
    // version whose bug makes every command fail would otherwise never see the
    // notice, because renderOk never runs for it.
    process.stderr.write(JSON.stringify(withNotices(envelope)) + '\n');
  } else {
    process.stderr.write(chalk.red(`✗ ${envelope.error.message}\n`));
    // withNotices carried this, and dropping the envelope would have dropped it
    // silently. update-notifier prints its own banner for TTYs, so only the auth
    // warning needs a prose form — otherwise it would reach humans through
    // `shumi doctor` alone.
    const expiring = authExpiryNotice();
    if (expiring) {
      process.stderr.write(chalk.yellow(`  ⚠ session ${describeExpiry(expiring)} — run: ${expiring.action}\n`));
    }
  }
  process.exitCode = exitCodeFromError(err);
}

function errEnvelopeFromError(err) {
  if (err?.envelope) return err.envelope;
  if (err?.status === undefined && err?.code) {
    return { schemaVersion: 1, error: { code: err.code, message: err.message } };
  }
  if (err?.status !== undefined) {
    return {
      schemaVersion: 1,
      error: {
        code: err.body?.error?.code || codeForStatus(err.status),
        message: err.body?.error?.message || err.message,
        ...(err.body?.error?.details && { details: err.body.error.details }),
      },
    };
  }
  return { schemaVersion: 1, error: { code: 'INTERNAL', message: err?.message || String(err) } };
}

function exitCodeFromError(err) {
  if (err?.envelope?.error?.code) return exitCodeForErrCode(err.envelope.error.code);
  if (err?.body?.error?.code) return exitCodeForErrCode(err.body.error.code);
  if (typeof err?.status === 'number') return exitCodeForStatus(err.status);
  return Exit.INTERNAL;
}

function codeForStatus(s) {
  if (s === 401 || s === 403) return 'AUTH_REQUIRED';
  if (s === 429) return 'RATE_LIMITED';
  if (s >= 400 && s < 500) return 'UPSTREAM_4XX';
  if (s >= 500) return 'UPSTREAM_5XX';
  return 'INTERNAL';
}
