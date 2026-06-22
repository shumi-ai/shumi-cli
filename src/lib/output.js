import chalk from 'chalk';
import ora from 'ora';
import { Exit, exitCodeForStatus, exitCodeForErrCode } from './exitCodes.js';
import { captureError } from './telemetry.js';

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

export function spinner(text, opts = {}) {
  const mode = resolveMode(opts);
  if (mode.agent || mode.json) {
    return { start() { return this; }, stop() {}, succeed() {}, fail() {}, set text(_) {} };
  }
  return ora({ text, spinner: 'dots' }).start();
}

/**
 * Emit a successful response. JSON mode prints the full envelope; human mode lets
 * the caller print however they like (and ignores `human`).
 */
export function renderOk(envelope, opts = {}, human) {
  const mode = resolveMode(opts);
  if (mode.json) {
    process.stdout.write(JSON.stringify(envelope) + '\n');
    return;
  }
  if (typeof human === 'function') human(envelope?.data ?? envelope, chalk);
  else process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
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
  process.stderr.write(JSON.stringify(envelope) + '\n');
  if (!mode.json && !mode.agent) {
    process.stderr.write(chalk.red(`✗ ${envelope.error.message}\n`));
    const hint = hintForError(envelope);
    if (hint) process.stderr.write(chalk.yellow(`→ ${hint}\n`));
  }
  process.exitCode = exitCodeFromError(err);
}

/**
 * Map an error envelope to a single actionable next-step line shown to humans
 * (suppressed in --json / --agent modes — machines parse the envelope instead).
 * Returns null when the message is already self-explanatory, so we never echo
 * a redundant second line. URLs are limited to the verified product home; no
 * pricing/upgrade deep-links are invented here.
 */
export function hintForError(envelope) {
  const code = envelope?.error?.code;
  const msg = envelope?.error?.message || '';
  const d = envelope?.error?.details || {};
  switch (code) {
    case 'RATE_LIMITED':
      if (d.tier === 'free' && d.limit != null) {
        return `Free tier limit reached (${d.used}/${d.limit}). Manage your plan at https://shumi.ai`;
      }
      return 'Rate limit hit. Wait a moment and retry, or review your plan at https://shumi.ai';
    case 'AUTH_REQUIRED':
    case 'AUTH_INVALID':
      // The server message usually already says "Run: shumi login" — don't double up.
      return /shumi login/i.test(msg) ? null : 'Run: shumi login  (or set SHUMI_TOKEN=shumi_sk_… for headless use)';
    case 'BAD_REQUEST':
      return 'Check your flags and arguments — run the command with --help.';
    case 'UPSTREAM_5XX':
      return 'Upstream server error. Retry shortly; run `shumi doctor` if it persists.';
    case 'NETWORK':
      return 'Network or timeout problem. Check your connection, then run `shumi doctor`.';
    default:
      return null;
  }
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
