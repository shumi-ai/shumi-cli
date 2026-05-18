import chalk from 'chalk';
import ora from 'ora';
import { Exit, exitCodeForStatus, exitCodeForErrCode } from './exitCodes.js';

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
  process.stderr.write(JSON.stringify(envelope) + '\n');
  if (!mode.json && !mode.agent) {
    process.stderr.write(chalk.red(`✗ ${envelope.error.message}\n`));
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
