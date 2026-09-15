/**
 * Smart-default human formatter. Auto-detects the response shape and renders
 * it nicely without each command having to hand-tune its output.
 *
 * Recognized shapes (in priority order):
 *   1. Standard wrapper: { items|signals|positions|movements|events|highlights|
 *       suggestions|watchlist|snapshots|outcomes|matches|categories|... : [...] }
 *      → render the inner array as a table, surface meta line separately.
 *   2. Flat array of objects → table with auto columns.
 *   3. Array of scalars → one per line.
 *   4. Flat object (≤14 scalar keys) → aligned kv list (with nested obj
 *      headers and one-level recursion).
 *   5. Fallback → pretty JSON.
 *
 * Numbers get human formatting (8.42M, 0.025%, $78,157). Timestamps within
 * 7 days become relative ("2h ago"). Long strings wrap at ~80 chars.
 */
import chalk from 'chalk';

const MAX_TABLE_COLS = 6;
const MAX_VALUE_WIDTH = 32;
const MAX_TABLE_ROWS = 50;
const COL_PAD = 2;

// Common wrapper keys that hold the actual array we want to render
const ARRAY_KEYS = [
  'items', 'data', 'results', 'rows',
  'signals', 'positions', 'movements', 'events', 'highlights',
  'suggestions', 'watchlist', 'snapshots', 'outcomes', 'matches',
  'categories', 'narratives', 'sources', 'log', 'history', 'assets', 'coins',
  'trades', 'active', 'resolved',
];

export function smartFormat(data, chalkArg, opts = {}) {
  const c = chalkArg || chalk;
  if (data === null || data === undefined) {
    return process.stdout.write(c.dim('(no data)\n'));
  }

  // Pure scalar
  if (typeof data !== 'object') {
    return process.stdout.write(String(data) + '\n');
  }

  // Top-level array
  if (Array.isArray(data)) return renderArrayAsTableOrList(data, c);

  // Wrapper-shape: data has a known array key alongside scalar meta fields
  const arrayKey = findArrayKey(data);
  if (arrayKey) {
    const arr = data[arrayKey];
    // Render any leading scalar fields as a brief header
    const scalarMeta = Object.entries(data).filter(([k, v]) => k !== arrayKey && isScalar(v));
    if (scalarMeta.length > 0 && scalarMeta.length <= 6) {
      const parts = scalarMeta.map(([k, v]) => `${c.dim(k)}: ${formatValue(v)}`);
      process.stdout.write(parts.join('  ') + '\n');
    }
    process.stdout.write('\n');
    renderArrayAsTableOrList(arr, c, { wrapperKey: arrayKey });
    // Render any remaining nested objects as separate sections
    for (const [k, v] of Object.entries(data)) {
      if (k === arrayKey || isScalar(v)) continue;
      if (Array.isArray(v) || typeof v !== 'object') continue;
      process.stdout.write('\n' + c.dim(k.toUpperCase()) + '\n');
      smartFormat(v, c, opts);
    }
    return;
  }

  // Flat object
  const entries = Object.entries(data);
  const scalarEntries = entries.filter(([, v]) => isScalar(v));
  const nestedEntries = entries.filter(([, v]) => !isScalar(v));

  if (scalarEntries.length > 0 && scalarEntries.length <= 14) {
    renderKv(scalarEntries, c);
    for (const [k, v] of nestedEntries) {
      // Skip giant nested objects (>20 keys) — too noisy
      if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 20) {
        process.stdout.write('\n' + c.dim(`${k}: (${Object.keys(v).length} keys — use --json)\n`));
        continue;
      }
      if (Array.isArray(v) && v.length > 20) {
        process.stdout.write('\n' + c.dim(`${k}: ${v.length} items — use --json or --top N\n`));
        continue;
      }
      process.stdout.write('\n' + c.bold(k.toUpperCase()) + '\n');
      smartFormat(v, c, opts);
    }
    return;
  }

  // Too wide — fall back to JSON
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

// ──────────────────────── helpers ────────────────────────

function findArrayKey(obj) {
  for (const k of ARRAY_KEYS) {
    if (Array.isArray(obj[k])) return k;
  }
  // Fall back: any key whose value is an array of objects
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') return k;
  }
  return null;
}

function isScalar(v) {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean';
}

function renderArrayAsTableOrList(arr, c, ctx = {}) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return process.stdout.write(c.dim('  (empty)\n'));
  }
  if (arr.every((v) => isScalar(v))) {
    const head = arr.slice(0, MAX_TABLE_ROWS);
    for (const v of head) process.stdout.write(`  ${formatValue(v)}\n`);
    if (arr.length > MAX_TABLE_ROWS) {
      process.stdout.write(c.dim(`  … and ${arr.length - MAX_TABLE_ROWS} more — use --json for all\n`));
    }
    return;
  }
  if (arr.every((v) => v && typeof v === 'object')) {
    renderTable(arr, c);
    if (arr.length > MAX_TABLE_ROWS) {
      process.stdout.write(c.dim(`  showing ${MAX_TABLE_ROWS} of ${arr.length} — use --json or --top N\n`));
    }
    return;
  }
  // Mixed — fall back to JSON
  process.stdout.write(JSON.stringify(arr, null, 2) + '\n');
}

function renderKv(entries, c) {
  const keyWidth = Math.min(20, Math.max(...entries.map(([k]) => k.length)));
  for (const [k, v] of entries) {
    const key = c.dim(k.padEnd(keyWidth));
    const val = formatValue(v, k);
    process.stdout.write(`  ${key}  ${val}\n`);
  }
}

function renderTable(rows, c) {
  const sample = rows.slice(0, MAX_TABLE_ROWS);
  const allCols = pickColumns(sample);
  if (allCols.length === 0) {
    return process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  }

  // Compute widths
  const widths = allCols.map((col) => Math.min(
    MAX_VALUE_WIDTH,
    Math.max(col.length, ...sample.map((r) => String(formatValue(r[col], col)).length)),
  ));

  // Header
  const header = allCols.map((col, i) => col.padEnd(widths[i])).join(' '.repeat(COL_PAD));
  process.stdout.write('  ' + c.bold(header) + '\n');
  process.stdout.write('  ' + c.dim(widths.map((w) => '─'.repeat(w)).join(' '.repeat(COL_PAD))) + '\n');

  for (const r of sample) {
    const line = allCols.map((col, i) => String(formatValue(r[col], col)).slice(0, MAX_VALUE_WIDTH).padEnd(widths[i])).join(' '.repeat(COL_PAD));
    process.stdout.write('  ' + line + '\n');
  }

  const allKeys = new Set();
  for (const r of sample) for (const k of Object.keys(r)) allKeys.add(k);
  if (allKeys.size > allCols.length) {
    process.stdout.write(c.dim(`  (${allKeys.size - allCols.length} more columns hidden — use --json)\n`));
  }
}

function pickColumns(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    for (const [k, v] of Object.entries(r)) {
      if (!isScalar(v)) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  // Prefer common, scalar-valued columns. Special-case: symbol/name/id first.
  const PRIORITY = ['symbol', 'name', 'id', 'asset', 'ticker', 'pair'];
  return [...counts.entries()]
    .sort((a, b) => {
      const pa = PRIORITY.indexOf(a[0]); const pb = PRIORITY.indexOf(b[0]);
      if (pa !== -1 && pb !== -1) return pa - pb;
      if (pa !== -1) return -1;
      if (pb !== -1) return 1;
      return b[1] - a[1];
    })
    .map(([k]) => k)
    .slice(0, MAX_TABLE_COLS);
}

// ──────────────────────── value formatting ────────────────────────

function formatValue(v, key) {
  if (v === null || v === undefined) return chalk.dim('—');
  if (typeof v === 'boolean') return v ? chalk.green('yes') : chalk.dim('no');
  if (typeof v === 'number') return formatNumber(v, key);
  if (typeof v === 'string') return formatString(v, key);
  if (Array.isArray(v)) return chalk.dim(`[${v.length}]`);
  if (typeof v === 'object') return chalk.dim(`{${Object.keys(v).length}}`);
  return String(v);
}

/**
 * Split a key into lowercase word tokens — camelCase, snake_case and
 * kebab-case all reduce to discrete words.
 *
 * Substring matching is the bug this exists to prevent. `key.includes('rate')`
 * also matched the coin id `microst[rate]gy-xstock`, and `key.includes('apr')`
 * matched `[apr]iori` and `proshares-ult[rapr]o-qqq`, so a price map keyed by
 * coin id rendered prices as percentages — $119.74 printed as "119.74%".
 * Whole-token matching cannot collide with an arbitrary identifier that merely
 * happens to contain those letters.
 */
function keyTokens(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Qualifiers that mark a `*Rate` field as a 0–1 fraction rather than a value
 * already expressed in percent units. walkforward/futures/regime all store
 * winRate as `wins / trades` (see walkforwardAdapter.js), so 5 wins of 8 is
 * 0.625 — which the percent formatter printed as "0.63%", directly under the
 * rows "wins 5" and "trades 8" that contradict it.
 */
const FRACTION_RATE_QUALIFIERS = new Set(['win', 'hit', 'success', 'loss', 'fail', 'error']);

/**
 * Scale a genuine 0–1 fraction to percent units, and pass anything else
 * through untouched. A route that already sends 0–100 stays correct, so this
 * is safe against both conventions rather than trading one bug for another.
 */
function fractionToPct(n) {
  return n >= 0 && n <= 1 ? n * 100 : n;
}

function formatNumber(n, key) {
  if (!Number.isFinite(n)) return chalk.dim(String(n));
  const t = keyTokens(key);
  const has = (w) => t.includes(w);

  // A ratio is a bare multiple — never a price, never a percent. Checked first
  // because these keys often carry `price` too (priceRatioLongOverShort), and
  // formatting 5971.13 as "$5,971" invents a currency the field does not have.
  if (has('ratio')) return formatRatio(n);

  // Price-like fields. `usd` is matched only as the WHOLE key, mirroring the
  // original `k === 'usd'`: as a mere token it also caught market_cap_usd and
  // volume_usd, which are big numbers and belong to the compact branch below.
  // Widening that check turned "2.24T" into "$2,242,903,464,384".
  const joined = t.join('');
  if (has('price') || joined === 'usd' || joined === 'priceusd') {
    return formatPrice(n);
  }

  // Percentile ships as a 0–1 fraction on most routes and 0–100 on a few.
  // Printed bare: "92" reads as the 92nd percentile, whereas "92%" asserts a
  // unit a percentile does not have.
  if (has('percentile')) return formatPercentile(n);

  // Fraction-valued rates → percent units. Must precede the generic percent
  // branch below, which assumes the value already is a percentage.
  //
  // Rendered WITHOUT directional color. formatPctMaybeColored is calibrated for
  // funding, where above +5% is expensive and therefore red. A win rate is not
  // funding-signed: on that scale every win rate above 5% prints red, so a 90%
  // win rate — the best number on the screen — renders as the alarm color.
  if (has('rate') && t.some((w) => FRACTION_RATE_QUALIFIERS.has(w))) {
    return formatPctPlain(fractionToPct(n));
  }

  // `accuracy` is the same class of number but carries no `rate` token, so the
  // qualifier check above cannot reach it.
  if (has('accuracy')) {
    return formatPctPlain(fractionToPct(n));
  }

  // Percent-like fields, already in percent units (funding.apr=1.7 means 1.7%).
  // A bare `rate` belongs here: funding rate and apr share units, since
  // rate x (24/interval) x 365 = apr only holds when both are percentages.
  if (has('apr') || has('pct') || has('percent') || has('rate')) {
    return formatPctMaybeColored(n);
  }

  // Market cap / volume / OI — big-number compact format
  if (has('cap') || has('mcap') || has('marketcap') || has('volume') || (has('open') && has('interest'))) {
    return formatBigNumber(n);
  }

  // Correlation — 2-decimal
  if (has('correlation') || has('corr')) {
    return n.toFixed(2);
  }

  if (has('score')) return formatScore(n);

  // Generic number heuristic
  if (Number.isInteger(n) && Math.abs(n) < 1e6) return String(n);
  if (Math.abs(n) >= 1e9) return formatBigNumber(n);
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  return Number(n.toPrecision(6)).toString();
}

function formatRatio(n) {
  return Number(n.toPrecision(4)).toString();
}

function formatPercentile(n) {
  return Number(fractionToPct(n).toFixed(1)).toString();
}

/**
 * Scores span very different ranges — compositeScore runs 49–98 while
 * freshness_score runs 0.000007–0.71. A flat toFixed(1) collapsed the whole
 * low range to "0.0", so sub-unit scores keep significant digits instead.
 */
function formatScore(n) {
  const s = n !== 0 && Math.abs(n) < 1 ? Number(n.toPrecision(3)).toString() : n.toFixed(1);
  return n >= 0 ? chalk.green(s) : chalk.red(s);
}

function formatString(s, key) {
  // Color trend/direction-like values
  const lower = s.toLowerCase();
  if (lower === 'up' || lower === 'bull' || lower === 'bullish' || lower === 'long' || lower === 'accumulation') return chalk.green(s);
  if (lower === 'down' || lower === 'bear' || lower === 'bearish' || lower === 'short' || lower === 'distribution' || lower === 'euphoria') return chalk.red(s);
  if (lower === 'hodl' || lower === 'neutral' || lower === 'sideways' || lower === 'flat') return chalk.yellow(s);
  if (lower === 'hot' || lower === 'overheated') return chalk.red(s);
  if (lower === 'cool' || lower === 'cold') return chalk.cyan(s);

  // Timestamp → relative if recent
  if (key && (key.toLowerCase().includes('time') || key.toLowerCase().includes('at') || key.toLowerCase().endsWith('_at'))) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const ago = (Date.now() - d.getTime()) / 1000;
      if (ago >= 0 && ago < 7 * 86400) return chalk.dim(formatRelative(ago)) + ' ' + chalk.dim('(' + s.slice(0, 19) + 'Z)');
    }
  }

  // Truncate long strings
  if (s.length > MAX_VALUE_WIDTH) return s.slice(0, MAX_VALUE_WIDTH - 1) + '…';
  return s;
}

// Exported: `market` renders its own table rather than going through
// smartFormat, and must use the same price and age rules as every other command.
export function formatPrice(n) {
  if (n >= 1000)  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1)     return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 0.01)  return '$' + n.toFixed(4);
  return '$' + n.toPrecision(4);
}

/**
 * Percent units, same precision rules as formatPctMaybeColored, no color.
 * For percentages whose sign carries no direction — win rate, hit rate,
 * accuracy — where the funding color scale would invert the meaning.
 */
function formatPctPlain(n) {
  const mag = Math.abs(n);
  return (mag !== 0 && mag < 0.01 ? Number(n.toPrecision(2)).toString() : n.toFixed(2)) + '%';
}

function formatPctMaybeColored(n) {
  // n is already in percent units (e.g. 1.7 = 1.7%)
  // toFixed(2) erased every sub-basis-point value: an hourly funding rate of
  // 0.0000107 printed as "0.00%", which reads as zero rather than as small.
  const mag = Math.abs(n);
  const s = (mag !== 0 && mag < 0.01 ? Number(n.toPrecision(2)).toString() : n.toFixed(2)) + '%';
  if (n > 5) return chalk.red(s);
  if (n > 0) return chalk.green(s);
  if (n < -5) return chalk.green(s); // negative funding favors longs — green
  if (n < 0) return chalk.red(s);
  return chalk.dim(s);
}

function formatBigNumber(n) {
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9)  return (n / 1e9).toFixed(2)  + 'B';
  if (a >= 1e6)  return (n / 1e6).toFixed(2)  + 'M';
  if (a >= 1e3)  return (n / 1e3).toFixed(2)  + 'K';
  return n.toString();
}

export function formatRelative(s) {
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
