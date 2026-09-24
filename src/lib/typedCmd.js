import { apiGet } from './api-client.js';
import chalk from 'chalk';
import { renderOk, renderErr, spinner, applyClientFilters, resolveMode } from './output.js';
import { smartFormat } from './smartFormat.js';
import { capture, captureError } from './telemetry.js';
import { getToken } from './config.js';

/**
 * Resolve the agent-mode flag the same way output.js does, without writing to
 * stdout. Used only to tag telemetry events.
 */
function resolveIsAgent(opts) {
  return Boolean(opts?.agent) || process.env.SHUMI_AGENT === '1' || process.argv.includes('--agent');
}

/**
 * Best-effort, never-throws derivation of the command + subcommand names from a
 * Commander command instance. Returns names only (never argument values).
 */
function commandNames(cmd) {
  try {
    const name = cmd?.name?.() || 'unknown';
    const parent = cmd?.parent;
    // A subcommand has a parent that is itself a real command (not the program).
    const isSub = parent && typeof parent.name === 'function' && parent.parent;
    if (isSub) return { command: parent.name(), subcommand: name };
    return { command: name, subcommand: null };
  } catch {
    return { command: 'unknown', subcommand: null };
  }
}

/**
 * Build a Commander action handler for typed endpoints.
 *
 *   .action(typedAction({
 *     route: 'futures',
 *     query: (ctx, opts) => ({ action: 'state' }),
 *     spinner: 'futures state…',
 *     human: (data, chalk, opts) => ...,   // optional — falls back to smartFormat
 *     fetch: (route, query, opts) => env, // optional — replaces the single apiGet
 *   }))
 *
 * Universal flags (added to the parent command via addUniversalFlags):
 *   --fields <list>  — comma-separated keys to keep (top-level)
 *   --top <n>        — keep first N items if data is an array
 */
export function typedAction({ route, query, spinner: spinnerText, human, fetch }) {
  return async function (...args) {
    const cmd = args[args.length - 1];
    const opts = cmd.optsWithGlobals();
    const cmdArgs = args.slice(0, -2);
    const localOpts = args[args.length - 2];
    const ctx = { args: cmdArgs, opts: localOpts };

    const r = typeof route === 'function' ? route(ctx, opts) : route;
    const q = typeof query === 'function' ? query(ctx, opts) : (query || {});
    const sp = typeof spinnerText === 'function' ? spinnerText(ctx, opts) : (spinnerText || `${r}…`);

    // Telemetry: single chokepoint for all typed commands. Flag names only,
    // never values; never any query/argument content. Wrapped so a telemetry
    // issue can't affect the command (capture itself is also internally safe).
    const { command, subcommand } = commandNames(cmd);
    const startedAt = Date.now();
    try {
      capture('command_invoked', {
        command,
        subcommand,
        has_args: Array.isArray(cmdArgs) && cmdArgs.some((a) => a != null && a !== ''),
        flag_keys: Object.keys(localOpts || {}),
        is_agent: resolveIsAgent(opts),
        has_token: Boolean(getToken()),
      });
    } catch { /* telemetry must never break the command */ }

    const s = spinner(sp, opts);
    try {
      const env = fetch ? await fetch(r, q, opts) : await apiGet(r, q);
      s.stop();
      // A command's note for a human (JSON consumers read it from meta.note). Written only
      // now, after the spinner has stopped, so ora cannot repaint over it.
      if (env?.meta?.note && !resolveMode(opts).json) process.stderr.write(chalk.dim(`  ${env.meta.note}\n`));
      const filtered = applyClientFilters(env, opts);
      renderOk(filtered, opts, human ? (data, chalk) => human(data, chalk, opts) : (data, chalk) => smartFormat(data, chalk, opts));
      try {
        capture('command_completed', {
          command,
          subcommand,
          status: 'ok',
          duration_ms: Date.now() - startedAt,
        });
      } catch { /* ignore */ }
    } catch (err) {
      s.stop();
      try {
        capture('command_failed', {
          command,
          subcommand,
          error_code: err?.body?.error?.code || err?.code,
          http_status: typeof err?.status === 'number' ? err.status : undefined,
          duration_ms: Date.now() - startedAt,
        });
        captureError(err, { command, subcommand, surface: 'typed_command' });
      } catch { /* ignore */ }
      renderErr(err, opts);
    }
  };
}

/**
 * Add --fields / --top to a command. Call this on every typed command that
 * could return list-shaped or wide-record data. Safe to add to all commands;
 * the flags are no-ops when irrelevant.
 */
export function addUniversalFlags(cmd) {
  return cmd
    .option('--fields <list>', 'comma-separated keys to keep (top-level)')
    .option('--top <n>', 'keep first N items if response is an array', (v) => parseInt(v, 10));
}
