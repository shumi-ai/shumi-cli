/**
 * Context guard: bound what goes into an agent's context without discarding what
 * the caller paid for.
 *
 * Measured on 0.8.1 against production: `shumi sentiment market` returns 939 KB,
 * `signal BTC` 287 KB — of which 292,842 bytes are 1,518 raw tweet objects
 * wrapped around a 13-byte verdict. In `--agent` mode that lands directly in a
 * model's context window.
 *
 * Truncating would be the wrong fix. The caller has already paid for that
 * response, and an answer silently cut at 50 KB is indistinguishable from a
 * complete one — the failure mode this whole codebase keeps hitting. So the full
 * envelope is written to disk and the in-context payload becomes a bounded
 * preview plus the path, which the agent can hand to a sub-agent, `jq`, or a
 * paged read. Nothing is lost; only what is *inlined* is bounded.
 *
 * Trigger is deliberately narrow. `--agent` is documented machine mode, so it
 * spills by default. A plain `shumi … --json > out.json` does NOT: `json` mode
 * is auto-enabled for any non-TTY, and we cannot tell a redirect to a file from
 * an agent's pipe. Rewriting someone's redirect would corrupt data on disk,
 * which is worse than a large context. Those callers opt in with
 * SHUMI_MAX_OUTPUT_BYTES; setting it to 0 disables spilling everywhere.
 */

import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

export const DEFAULT_MAX_BYTES = 50_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Bytes of JSON above which a response spills. 0 disables. */
export function spillThreshold(env = process.env) {
  const raw = env.SHUMI_MAX_OUTPUT_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  // A malformed value must not silently disable the guard, so fall back to the
  // default rather than to 0.
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_BYTES;
}

export function spillDir(env = process.env) {
  if (env.SHUMI_SPILL_DIR) return env.SHUMI_SPILL_DIR;
  const home = env.HOME || homedir();
  return home ? join(home, '.shumi', 'spill') : join(tmpdir(), 'shumi-spill');
}

/**
 * Recursively cap arrays so the preview keeps the SHAPE of the answer.
 *
 * A head-of-string preview would cut mid-token and tell the model nothing about
 * what it is looking at. Capping arrays instead keeps every key, every scalar
 * and the first few items of each list, which is usually enough to decide
 * whether the full file is even worth opening.
 */
function capArrays(value, cap, dropped, path = 'data') {
  if (Array.isArray(value)) {
    const kept = value.slice(0, cap).map((v, i) => capArrays(v, cap, dropped, `${path}[${i}]`));
    if (value.length > cap) dropped.push({ path, kept: kept.length, of: value.length });
    return kept;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = capArrays(v, cap, dropped, `${path}.${k}`);
    return out;
  }
  return value;
}

/**
 * Shrink `data` until its JSON fits `limit`, trying progressively harsher caps.
 * Returns the preview and what was dropped. If even a cap of 1 does not fit —
 * one enormous string, say — the preview is dropped entirely rather than
 * emitting something that still blows the budget.
 */
export function boundedPreview(data, limit) {
  for (const cap of [25, 10, 5, 2, 1]) {
    const dropped = [];
    const out = capArrays(data, cap, dropped);
    if (JSON.stringify(out ?? null).length <= limit) return { preview: out, dropped };
  }
  return { preview: null, dropped: [{ path: 'data', kept: 0, of: null }] };
}

/** Best-effort removal of spill files older than a day. Never throws. */
export function pruneSpills(dir, now = Date.now()) {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('shumi-') || !name.endsWith('.json')) continue;
      const full = join(dir, name);
      try {
        if (now - statSync(full).mtimeMs > RETENTION_MS) unlinkSync(full);
      } catch { /* raced with another process; nothing to do */ }
    }
  } catch { /* dir does not exist yet */ }
}

/**
 * Decide whether to spill, and do it.
 *
 * @returns the envelope to print — the original when it fits or spilling is off,
 *   otherwise a bounded one carrying `_spill`. Never throws: if the file cannot
 *   be written (read-only home, full disk) the caller gets the FULL envelope
 *   back, because a large answer beats a lost one.
 */
export function applyContextGuard(envelope, { mode, env = process.env, now = Date.now, writeFile = writeFileSync } = {}) {
  const threshold = spillThreshold(env);
  if (threshold === 0) return envelope;
  // Only machine mode spills by default; everyone else opts in explicitly.
  const optedIn = env.SHUMI_MAX_OUTPUT_BYTES !== undefined && env.SHUMI_MAX_OUTPUT_BYTES !== '';
  if (!mode?.agent && !optedIn) return envelope;

  const full = JSON.stringify(envelope);
  if (full.length <= threshold) return envelope;

  const dir = spillDir(env);
  const stamp = now();
  const file = join(dir, `shumi-${stamp}-${process.pid}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFile(file, full);
    pruneSpills(dir, stamp);
  } catch {
    // Could not persist it. Returning the full envelope is the honest failure:
    // the caller keeps everything they paid for and merely pays the context.
    return envelope;
  }

  // Leave room for the envelope's own keys and the _spill block.
  const { preview, dropped } = boundedPreview(envelope?.data, Math.floor(threshold * 0.6));
  return {
    ...envelope,
    data: preview,
    _spill: {
      path: file,
      bytes: full.length,
      preview_is_partial: true,
      dropped,
      hint:
        `This response was ${full.length} bytes, over the ${threshold}-byte context guard. ` +
        `\`data\` above is a shape-preserving preview, NOT the full answer. ` +
        `The complete envelope is at ${file} — read it with a sub-agent or query it with jq ` +
        `(e.g. \`jq '.data' ${file}\`) rather than inlining it. ` +
        `Raise or disable the guard with SHUMI_MAX_OUTPUT_BYTES (0 = never spill).`,
    },
  };
}
