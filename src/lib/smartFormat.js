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

function formatNumber(n, key) {
  if (!Number.isFinite(n)) return chalk.dim(String(n));
  const k = (key || '').toLowerCase();

  // Price-like fields
  if (k.includes('price') || k === 'priceusd' || k === 'usd') {
    return formatPrice(n);
  }
  // Fraction-unit fields carry 0..1 values (winRate 0.47, percentile 0.65) —
  // render as whole percent so 0.47 shows "47%", not "0.47%". Checked BEFORE
  // the percent-unit branch since these names also match `includes('rate')`.
  // NO directional color: win-rate/accuracy aren't funding-signed, so the
  // funding red/green thresholds would invert the meaning (a 90% win rate is
  // good but would render red).
  if (k === 'winrate' || k === 'win_rate' || k === 'percentile' || k === 'hitrate' || k === 'hit_rate' || k === 'accuracy') {
    return (n * 100).toFixed(2) + '%';
  }
  // Percent-like fields (already in percent units like funding.apr=1.7 = 1.7%)
  if (k.includes('apr') || k.includes('pct') || k.includes('rate')) {
    return formatPctMaybeColored(n);
  }
  // Market cap / volume / OI — big-number compact format
  if (k.includes('marketcap') || k.includes('volume') || k.includes('openinterest') || k.includes('mcap') || k.includes('cap')) {
    return formatBigNumber(n);
  }
  // Correlation — 2-decimal
  if (k.includes('correlation') || k.includes('corr')) {
    return n.toFixed(2);
  }
  if (k.includes('score')) {
    return n >= 0 ? chalk.green(n.toFixed(1)) : chalk.red(n.toFixed(1));
  }

  // Generic number heuristic
  if (Number.isInteger(n) && Math.abs(n) < 1e6) return String(n);
  if (Math.abs(n) >= 1e9) return formatBigNumber(n);
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  return Number(n.toPrecision(6)).toString();
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

export function formatPrice(n) {
  if (n >= 1000)  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1)     return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 0.01)  return '$' + n.toFixed(4);
  return '$' + n.toPrecision(4);
}

function formatPctMaybeColored(n) {
  // n is already in percent units (e.g. 1.7 = 1.7%)
  const s = n.toFixed(2) + '%';
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
