import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { smartFormat } from '../../src/lib/smartFormat.js';

/**
 * smartFormat is the default human renderer for every typed command that has
 * no hand-tuned formatter — the single largest data→screen transform in the
 * CLI, previously untested. The suite pins shape detection (wrapper / array /
 * kv / JSON fallback) and the empty/null/mixed edge cases, where an
 * `arr.every(...)` on the wrong branch silently renders garbage.
 */

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

// chalk stand-in: every style resolves to identity, so assertions match plain
// text and the real chalk's TTY detection can't flake the suite (same trick as
// walkforward.test.js).
const identity = (s) => String(s);
const chalk = new Proxy(identity, {
  get: (_t, prop) => (prop === 'then' ? undefined : chalk),
  apply: (_t, _this, args) => String(args[0]),
});

let stdout;
function capture() {
  const orig = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stdout.write = orig; } };
}
const out = () => stdout.chunks.join('').replace(ANSI, '');

beforeEach(() => { stdout = capture(); });
afterEach(() => stdout.restore());

describe('nullish and scalar input', () => {
  it('null and undefined render the (no data) placeholder, never "null"', () => {
    smartFormat(null, chalk);
    smartFormat(undefined, chalk);
    const text = out();
    expect(text).toContain('(no data)');
    expect(text).not.toContain('null');
  });

  it('bare scalars print as-is', () => {
    smartFormat(42, chalk);
    smartFormat('hello', chalk);
    expect(out()).toBe('42\nhello\n');
  });
});

describe('arrays', () => {
  it('empty array → explicit (empty), not a blank table (the .every([])===true trap)', () => {
    // [].every(isScalar) AND [].every(isObject) are both true — only the
    // length guard keeps this from rendering as an empty scalar list.
    smartFormat([], chalk);
    expect(out()).toContain('(empty)');
  });

  it('array of scalars renders one per line', () => {
    smartFormat(['ai', 'meme', 'depin'], chalk);
    expect(out()).toBe('  ai\n  meme\n  depin\n');
  });

  it('scalar list over 50 rows is truncated with a --json hint', () => {
    smartFormat(Array.from({ length: 60 }, (_, i) => `row${i}`), chalk);
    const text = out();
    expect(text).toContain('row49');
    expect(text).not.toContain('row50');
    expect(text).toContain('… and 10 more');
  });

  it('array of objects becomes a table with priority columns first', () => {
    smartFormat([
      { volume: 1, symbol: 'BTC', name: 'Bitcoin' },
      { volume: 2, symbol: 'ETH', name: 'Ethereum' },
    ], chalk);
    const text = out();
    const header = text.split('\n')[0];
    // symbol/name are PRIORITY columns and must precede volume regardless of key order
    expect(header.indexOf('symbol')).toBeGreaterThan(-1);
    expect(header.indexOf('symbol')).toBeLessThan(header.indexOf('volume'));
    expect(text).toContain('BTC');
    expect(text).toContain('Ethereum');
  });

  it('null and missing fields render as a dash, not "null"/"undefined"', () => {
    smartFormat([
      { symbol: 'BTC', trend: 'UP' },
      { symbol: 'ETH', trend: null },
    ], chalk);
    const text = out();
    expect(text).toContain('—');
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('mixed scalar/object array falls back to JSON, losing nothing', () => {
    smartFormat(['a', { b: 1 }], chalk);
    expect(JSON.parse(out())).toEqual(['a', { b: 1 }]);
  });

  it('caps columns at 6 and says how many are hidden', () => {
    const row = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]));
    smartFormat([row, row], chalk);
    expect(out()).toContain('(3 more columns hidden');
  });
});

describe('wrapper shapes', () => {
  it('renders known wrapper key as table plus scalar meta header', () => {
    smartFormat({ count: 2, interval: '1d', items: [{ symbol: 'BTC' }, { symbol: 'ETH' }] }, chalk);
    const text = out();
    expect(text).toContain('count: 2');
    expect(text).toContain('interval: 1d');
    expect(text).toContain('BTC');
  });

  it('empty wrapper array still shows (empty) rather than nothing', () => {
    smartFormat({ signals: [] }, chalk);
    expect(out()).toContain('(empty)');
  });

  it('falls back to ANY key holding an array of objects', () => {
    smartFormat({ weirdKey: [{ symbol: 'SOL', mcap: 1 }] }, chalk);
    expect(out()).toContain('SOL');
  });
});

describe('flat objects', () => {
  it('≤14 scalar keys → aligned kv list', () => {
    smartFormat({ symbol: 'BTC', price: 'high', trendDaily: 'UP' }, chalk);
    const text = out();
    expect(text).toMatch(/symbol\s+BTC/);
    expect(text).toMatch(/trendDaily\s+UP/);
  });

  it('>14 scalar keys falls back to JSON', () => {
    const wide = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i]));
    smartFormat(wide, chalk);
    expect(JSON.parse(out())).toEqual(wide);
  });

  it('giant nested objects and long nested arrays are summarized, not dumped', () => {
    // NB: the long array's key must not be a wrapper key ('log', 'items', …)
    // and must hold scalars, or findArrayKey routes to the wrapper branch.
    const giant = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
    smartFormat({ name: 'x', details: giant, series: Array.from({ length: 30 }, (_, i) => i) }, chalk);
    const text = out();
    expect(text).toContain('details: (25 keys — use --json)');
    expect(text).toContain('series: 30 items — use --json or --top N');
    expect(text).not.toContain('k24');
  });

  it('small nested objects recurse under an uppercased header', () => {
    smartFormat({ name: 'x', stats: { up: 1, down: 2 } }, chalk);
    const text = out();
    expect(text).toContain('STATS');
    expect(text).toMatch(/up\s+1/);
  });
});

describe('value formatting heuristics', () => {
  it('price-like keys get dollar formatting across magnitude bands', () => {
    smartFormat([
      { symbol: 'BTC', price: 78157.4 },
      { symbol: 'DOGE', price: 0.2512345 },
    ], chalk);
    const text = out();
    expect(text).toContain('$78,157');
    expect(text).toContain('$0.2512');
  });

  it('marketcap-like keys get compact big-number formatting', () => {
    smartFormat([{ symbol: 'BTC', marketCap: 1_540_000_000_000 }, { symbol: 'PEPE', marketCap: 8_420_000 }], chalk);
    const text = out();
    expect(text).toContain('1.54T');
    expect(text).toContain('8.42M');
  });

  it('apr/rate keys render as percentages with 2 decimals', () => {
    smartFormat([{ symbol: 'X', apr: 1.7 }, { symbol: 'Y', apr: -0.25 }], chalk);
    const text = out();
    expect(text).toContain('1.70%');
    expect(text).toContain('-0.25%');
  });

  it('booleans read as yes/no', () => {
    smartFormat({ active: true, paused: false }, chalk);
    const text = out();
    expect(text).toMatch(/active\s+yes/);
    expect(text).toMatch(/paused\s+no/);
  });

  it('recent *_at timestamps become relative; old ones stay literal', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    smartFormat({ created_at: twoHoursAgo, launched_at: '2020-01-01T00:00:00.000Z' }, chalk);
    const text = out();
    expect(text).toContain('2h ago');
    expect(text).toContain('2020-01-01');
    expect(text).not.toContain('ago (2020');
  });

  it('long strings truncate with an ellipsis instead of breaking the table', () => {
    smartFormat([{ symbol: 'X', note: 'a'.repeat(100) }, { symbol: 'Y', note: 'short' }], chalk);
    const text = out();
    expect(text).toContain('…');
    expect(text).not.toContain('a'.repeat(40));
  });

  it('non-finite numbers do not crash the renderer', () => {
    smartFormat({ value: NaN, other: Infinity }, chalk);
    const text = out();
    expect(text).toContain('NaN');
    expect(text).toContain('Infinity');
  });
});

// ── Percent-unit and scaling behaviour ──────────────────────────────────────
/**
 * Field names and value ranges here are not invented — they were taken from a
 * census of every numeric key returned by a live sweep of all 37 CLI commands
 * on a pro-tier account (2026-08-24). Each case below is a value the CLI
 * actually rendered wrongly, at the magnitudes the API actually returns.
 */

const PCT_ESC = String.fromCharCode(27);
const PCT_ANSI = new RegExp(`${PCT_ESC}\\[[0-9;]*m`, 'g');

/** Render one key/value pair and return the printed text, ANSI stripped. */
function renderPct(key, value) {
  let buf = '';
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { buf += a.join(' ') + '\n'; });
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { buf += chunk; return true; });
  try {
    smartFormat({ [key]: value });
  } finally {
    spy.mockRestore();
    write.mockRestore();
  }
  return buf.replace(PCT_ANSI, '');
}

describe('percent formatting is keyed on whole words, not substrings', () => {
  // A price map keyed by coin id: `microstrategy` contains "rate",
  // `ultrapro`/`apriori` contain "apr". These are prices, not percentages.
  it.each([
    ['microstrategy-xstock', 119.74],
    ['proshares-ultrapro-qqq-ondo-tokenized', 69.65],
    ['apriori', 0.19968],
    ['strategy-stretch-preferred-ondo-tokenized', 100.9],
  ])('does not render coin id %s as a percentage', (key, value) => {
    expect(renderPct(key, value)).not.toMatch(/%/);
  });

  it('still renders genuine percent fields as percentages', () => {
    expect(renderPct('fundingApr', 10.95)).toMatch(/10\.95%/);
    expect(renderPct('change_24h_pct', 1.5961)).toMatch(/1\.60%/);
    expect(renderPct('spreadPct', 58.36)).toMatch(/58\.36%/);
  });
});

describe('0-1 fractions are scaled, not printed as sub-1% values', () => {
  // walkforwardAdapter.js stores winRate as wins/trades. 5 of 8 is 0.625;
  // the old formatter printed "0.63%" directly under "wins 5 / trades 8".
  it('scales winRate from a fraction to a percentage', () => {
    expect(renderPct('winRate', 0.635)).toMatch(/63\.50%/);
  });

  it('renders a perfect winRate as 100%, not 1%', () => {
    expect(renderPct('winRate', 1)).toMatch(/100\.00%/);
  });

  it('passes through a rate already expressed in percent units', () => {
    expect(renderPct('winRate', 62)).toMatch(/62\.00%/);
  });

  it('prints percentile bare, since a percentile has no percent unit', () => {
    const out = renderPct('percentile', 0.92);
    expect(out).toMatch(/92/);
    expect(out).not.toMatch(/%/);
  });
});

describe('magnitudes survive formatting', () => {
  it('keeps sub-basis-point rates legible instead of collapsing to 0.00%', () => {
    expect(renderPct('hourlyRate', 0.0000107878)).not.toMatch(/\b0\.00%/);
  });

  it('keeps sub-unit scores instead of flattening them to 0.0', () => {
    expect(renderPct('freshness_score', 0.711401)).toMatch(/0\.711/);
    expect(renderPct('freshness_score', 0.000007)).not.toMatch(/^\s*freshness_score\s+0\.0\s*$/m);
  });

  it('leaves large composite scores on one decimal', () => {
    expect(renderPct('compositeScore', 96)).toMatch(/96\.0/);
  });

  it('renders a ratio as a multiple, not a price', () => {
    const out = renderPct('priceRatioLongOverShort', 5971.13);
    expect(out).not.toMatch(/\$/);
    expect(out).toMatch(/5971/);
  });
});

describe('usd-suffixed big numbers stay compact', () => {
  // `usd` is matched only as the whole key. Treating it as a mere token also
  // caught market_cap_usd and volume_usd and sent them to the price formatter,
  // turning "2.24T" into "$2,242,903,464,384".
  it('formats market_cap_usd and volume_usd compactly, not as prices', () => {
    expect(renderPct('market_cap_usd', 2242903464384)).toMatch(/2\.24T/);
    expect(renderPct('volume_usd', 42000000000)).toMatch(/42\.00B/);
    expect(renderPct('market_cap_usd', 2242903464384)).not.toMatch(/\$/);
  });

  it('still treats a bare usd key and price_usd as prices', () => {
    expect(renderPct('usd', 79028.9)).toMatch(/\$79,029/);
    expect(renderPct('price_usd', 79028.9)).toMatch(/\$79,029/);
  });
});
