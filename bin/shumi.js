#!/usr/bin/env node

import { createRequire } from 'module';
import { program } from 'commander';
import { initUpdateCheck } from '../src/lib/updateCheck.js';
import { authExpiryNotice, describeExpiry } from '../src/lib/authNotice.js';
import { registerCommands } from '../src/index.js';
import { initTelemetry, captureError, flush, shutdown } from '../src/lib/telemetry.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// Update check. Run it for EVERYONE (env opt-out aside), not just on a TTY.
// The old `isTty &&` guard here meant agent-driven users never even performed
// the background check, so they sat on a known-broken version indefinitely —
// see src/lib/updateCheck.js. The result now reaches machines through the JSON
// envelope and `shumi doctor`; notify() below is only the human surface, and
// the library self-gates it on stdout.isTTY, so piped output stays clean.
const isAgent = process.argv.includes('--agent') || process.env.SHUMI_AGENT === '1';
const notifier = initUpdateCheck(pkg);
if (notifier && !isAgent) notifier.notify({ defer: true });

// Telemetry (PostHog) — safe no-op if disabled / no key. Must be initialized
// before any command runs so capture() at the chokepoints has a live client.
// All of its network I/O is async/background and never touches stdout.
initTelemetry();

// SIGINT / SIGTERM: clean exit so spinners don't leave dangling state. Flush
// telemetry best-effort (bounded by its own hard timeout) before exiting.
async function handleSignal(code) {
  process.stderr.write('\n');
  await flush();
  process.exit(code);
}
process.on('SIGINT', () => { handleSignal(130); });
process.on('SIGTERM', () => { handleSignal(143); });

// Last-resort error hooks: record the crash, flush best-effort, then preserve
// the real exit behavior (non-zero exit). We do NOT swallow the error.
process.on('unhandledRejection', (reason) => {
  captureError(reason instanceof Error ? reason : new Error(String(reason)), { hook: 'unhandledRejection' });
  flush().finally(() => {
    process.stderr.write(`shumi: unhandled rejection: ${reason?.message || reason}\n`);
    process.exit(1);
  });
});
process.on('uncaughtException', (err) => {
  captureError(err, { hook: 'uncaughtException' });
  flush().finally(() => {
    process.stderr.write(`shumi: uncaught exception: ${err?.message || err}\n`);
    process.exit(1);
  });
});

program
  .name('shumi')
  .description('Shumi — crypto trade intelligence from your terminal')
  .version(pkg.version)
  .option('--json', 'emit JSON envelope on stdout (auto-enabled when stdout is not a TTY)')
  .option('--agent', 'machine mode: JSON output, no spinner, no color, no update notifier')
  .option('--no-color', 'disable colored output')
  .option('--fields <list>', 'comma-separated top-level keys to keep (filter response)')
  .option('--top <n>', 'keep first N items if response is an array', (v) => parseInt(v, 10))
  .option('--auto-pay', 'pay x402 paywalls without confirmation (use up to SHUMI_MAX_PRICE_USDC = $0.10 default)');

registerCommands(program);

/**
 * Human-facing pre-expiry warning, printed once per invocation on stderr so it
 * cannot corrupt piped stdout. Machines get the same fact as
 * `meta.authExpiring` in the JSON envelope instead — this is only the TTY half.
 *
 * Placed here rather than in each command: one warning per process, on every
 * command, is the whole point. A session that ends with no warning reads as an
 * outage, not as "log in again".
 */
function warnIfSessionExpiring() {
  try {
    if (!process.stdout.isTTY || isAgent) return;
    const notice = authExpiryNotice();
    if (notice) {
      process.stderr.write(`\nshumi: your session ${describeExpiry(notice)} (${notice.expiresAt.slice(0, 10)}). Run: ${notice.action}\n`);
    }
  } catch { /* a warning must never be able to fail a command */ }
}

program
  .parseAsync()
  .then(async () => {
    warnIfSessionExpiring();
    // Normal completion: flush queued telemetry (bounded so it never hangs).
    await shutdown();
    // Force-exit: the PostHog client can leave a pending socket open that keeps
    // the event loop alive for seconds after our bounded flush resolves. Exit
    // explicitly, preserving whatever exitCode commands set (default 0).
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    captureError(err, { hook: 'parse_catch' });
    await flush();
    process.stderr.write(`shumi: ${err?.message || err}\n`);
    process.exit(1);
  });
