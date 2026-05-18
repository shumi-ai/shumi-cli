import { apiGet } from './api-client.js';
import { renderOk, renderErr, spinner } from './output.js';
import { smartFormat } from './smartFormat.js';

/**
 * Build a Commander action handler for typed endpoints.
 *
 *   .action(typedAction({
 *     route: 'futures',
 *     query: (ctx, opts) => ({ action: 'state' }),
 *     spinner: 'futures state…',
 *     human: (data, chalk) => ...,   // optional — falls back to smartFormat
 *   }))
 *
 * Universal flags (added to the parent command via addUniversalFlags):
 *   --fields <list>  — comma-separated keys to keep (top-level)
 *   --top <n>        — keep first N items if data is an array
 */
export function typedAction({ route, query, spinner: spinnerText, human }) {
  return async function (...args) {
    const cmd = args[args.length - 1];
    const opts = cmd.optsWithGlobals();
    const cmdArgs = args.slice(0, -2);
    const localOpts = args[args.length - 2];
    const ctx = { args: cmdArgs, opts: localOpts };

    const r = typeof route === 'function' ? route(ctx, opts) : route;
    const q = typeof query === 'function' ? query(ctx, opts) : (query || {});
    const sp = typeof spinnerText === 'function' ? spinnerText(ctx, opts) : (spinnerText || `${r}…`);

    const s = spinner(sp, opts);
    try {
      const env = await apiGet(r, q);
      s.stop();
      const filtered = applyClientFilters(env, opts);
      renderOk(filtered, opts, human || ((data, chalk) => smartFormat(data, chalk, opts)));
    } catch (err) {
      s.stop();
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

function applyClientFilters(env, opts) {
  if (!env?.data) return env;
  let d = env.data;

  // --top: slice if array
  if (opts.top && Array.isArray(d)) {
    d = d.slice(0, opts.top);
  } else if (opts.top && d && typeof d === 'object') {
    // Slice the first array-valued field (common shape: { items: [...] }, { results: [...] })
    for (const k of Object.keys(d)) {
      if (Array.isArray(d[k])) { d = { ...d, [k]: d[k].slice(0, opts.top) }; break; }
    }
  }

  // --fields: project (whitelist) top-level keys
  if (opts.fields) {
    const keep = new Set(opts.fields.split(',').map((s) => s.trim()).filter(Boolean));
    if (Array.isArray(d)) {
      d = d.map((row) => row && typeof row === 'object' ? pick(row, keep) : row);
    } else if (d && typeof d === 'object') {
      d = pick(d, keep);
    }
  }

  return { ...env, data: d };
}

function pick(obj, keep) {
  const out = {};
  for (const k of keep) if (k in obj) out[k] = obj[k];
  return out;
}
