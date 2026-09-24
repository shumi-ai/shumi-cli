import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { currentTrendLine, renderCoinLookup } from '../../src/lib/currentTrend.js';
import { scanQuery, scanFetch, registerScanCommand, SCAN_SORT_FIELDS, EMPTY_SCAN_NOTE } from '../../src/commands/scan.js';
import { applyClientFilters } from '../../src/lib/output.js';
import { getSchema } from '../../src/lib/schema.js';
import { applyBulkSchemas } from '../../src/lib/bulkSchemas.js';
import { registerCoinCommand } from '../../src/commands/coin.js';

// Identity "chalk": every style returns its input, so assertions read plain text.
const id = (s) => s;
const c = { dim: id, bold: id, green: id, red: id, yellow: id };

const CURRENT = { trend: 'HODL', since: '2026-09-19', days: 5, asOf: '2026-09-23', incompleteDayExcluded: true };

describe('currentTrendLine', () => {
  it('states the trend, start, length and as-of day', () => {
    expect(currentTrendLine({ currentTrend: CURRENT }, c)).toBe('  current trend  HODL since 2026-09-19 (5 days, as of 2026-09-23)');
  });

  it('adds the weekly trend when the server sends one', () => {
    const line = currentTrendLine({ currentTrend: CURRENT, currentTrendWeekly: { trend: 'UP', since: '2026-08-31' } }, c);
    expect(line).toContain('weekly UP since 2026-08-31');
  });

  it('uses the singular for a one-day trend', () => {
    expect(currentTrendLine({ currentTrend: { ...CURRENT, days: 1 } }, c)).toContain('(1 day, as of');
  });

  it('returns null when the backend sends no currentTrend (older server, or --fields dropped it)', () => {
    expect(currentTrendLine({ trends: [{ trend: 'UP' }] }, c)).toBeNull();
    expect(currentTrendLine({ currentTrend: null }, c)).toBeNull();
    expect(currentTrendLine(null, c)).toBeNull();
  });
});

describe('renderCoinLookup', () => {
  afterEach(() => vi.restoreAllMocks());

  function capture(data) {
    const out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
    renderCoinLookup(data, c, {});
    return out.join('');
  }

  it('prints the current trend before anything else', () => {
    const out = capture({ coin: { id: 'bitcoin' }, trends: [{ trend: 'UP', start: '2026-09-24', end: '2026-09-24', streak: 1 }], currentTrend: CURRENT });
    expect(out.startsWith('  current trend  HODL since 2026-09-19')).toBe(true);
  });

  it('renders exactly as before when currentTrend is absent', () => {
    const out = capture({ coin: { id: 'bitcoin' }, trends: [{ trend: 'UP', start: '2026-09-24', end: '2026-09-24', streak: 1 }] });
    expect(out).not.toContain('current trend');
  });
});

describe('scan', () => {
  it('sends the parameter names /api/coins/filter reads', () => {
    expect(scanQuery({ trend: 'UP', category: 'Meme', mcapMin: '1000000', mcapMax: '5000000', exchange: 'Binance', limit: '10' })).toEqual({
      trend: 'UP',
      categories: 'Meme',
      marketCapMin: '1000000',
      marketCapMax: '5000000',
      exchanges: 'Binance',
      limit: '10',
    });
  });

  it('maps --sort / --order to sortBy / sortOrder', () => {
    expect(scanQuery({ sort: 'change24h', order: 'asc' })).toEqual({ sortBy: 'change24h', sortOrder: 'asc' });
    expect(scanQuery({})).toEqual({});
  });

  it('offers change24h as a sort and rejects unknown sort keys', () => {
    expect(SCAN_SORT_FIELDS).toEqual(expect.arrayContaining(['change24h', 'change7d']));
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerScanCommand(program);
    const scan = program.commands.find((cmd) => cmd.name() === 'scan');
    scan.action(() => {});
    expect(() => program.parse(['node', 'shumi', 'scan', '--sort', 'volume'])).toThrow(/Allowed choices/);
    expect(() => program.parse(['node', 'shumi', 'scan', '--sort', 'change24h'])).not.toThrow();
  });
});

describe('bulk schemas', () => {
  it('advertise currentTrend on every coin lookup shape', () => {
    const program = new Command();
    registerCoinCommand(program);
    applyBulkSchemas(program);
    const coin = program.commands.find((cmd) => cmd.name() === 'coin');
    for (const name of ['lookup', 'by-id', 'by-name']) {
      const schema = getSchema(coin.commands.find((cmd) => cmd.name() === name));
      expect(schema.fields.currentTrend, name).toMatch(/CURRENT trend/);
    }
  });
});

describe('renderCoinLookup does not repeat the trend', () => {
  afterEach(() => vi.restoreAllMocks());
  it('prints the trend line once, with no CURRENTTREND section after it', () => {
    const out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
    renderCoinLookup({ coin: { id: 'bitcoin' }, trends: [{ trend: 'HODL', start: '2026-09-19', end: '2026-09-23', streak: 5 }], currentTrend: CURRENT }, c, {});
    const text = out.join('');
    expect(text).toContain('current trend  HODL');
    expect(text).not.toMatch(/CURRENTTREND/i);
    expect(text).not.toContain('incompleteDayExcluded');
  });
});

describe('scan name handling (local only)', () => {
  const COINS = [
    { name: 'Dogecoin', categories: ['Meme'], exchanges: ['Binance', 'Coinbase Exchange'] },
    { name: 'Arbitrum', categories: ['Layer-2'], exchanges: ['Binance'] },
    { name: 'Tiny', categories: ['Some Small Category'], exchanges: ['Bitstamp'] },
  ];
  // Behaves like /api/coins/filter: exact case-sensitive category, case-insensitive exchange.
  function fakeGet({ coins = COINS, wrap = false } = {}) {
    const calls = [];
    const get = async (route, q = {}) => {
      calls.push({ route, q });
      const rows = coins
        .filter((x) => !q.categories || x.categories.includes(q.categories))
        .filter((x) => !q.exchanges || x.exchanges.some((e) => e.toLowerCase() === String(q.exchanges).toLowerCase()))
        .map((x) => x.name);
      return { schemaVersion: 1, data: wrap ? { rows, coverage: { withChange: rows.length } } : rows };
    };
    return { get, calls };
  }
  const json = { json: true };

  it('is always exactly one call to scan', async () => {
    for (const q of [{ categories: 'Meme' }, { categories: 'meme' }, { categories: 'Nope' }, { exchanges: 'Krakenn' }, {}]) {
      const { get, calls } = fakeGet();
      await scanFetch('scan', q, json, get);
      expect(calls.map((c) => c.route), JSON.stringify(q)).toEqual(['scan']);
    }
  });

  it('sends a correct category unchanged, with no note', async () => {
    const { get, calls } = fakeGet();
    const env = await scanFetch('scan', { categories: 'Meme' }, json, get);
    expect(env.data).toEqual(['Dogecoin']);
    expect(calls[0].q.categories).toBe('Meme');
    expect(env.meta?.note).toBeUndefined();
  });

  it('rewrites known misspellings and short venue names locally', async () => {
    for (const [asked, real, coin] of [['meme', 'Meme', 'Dogecoin'], ['Layer 2', 'Layer-2', 'Arbitrum']]) {
      const { get, calls } = fakeGet();
      const env = await scanFetch('scan', { categories: asked }, json, get);
      expect(calls[0].q.categories).toBe(real);
      expect(env.data).toEqual([coin]);
      expect(env.meta.note).toContain(`"${asked}" sent as "${real}"`);
    }
    const { get, calls } = fakeGet();
    await scanFetch('scan', { exchanges: 'coinbase' }, json, get);
    expect(calls[0].q.exchanges).toBe('Coinbase Exchange');
  });

  it('sends unknown or small names as given, and a real venue outside any list works', async () => {
    const env = await scanFetch('scan', { categories: 'Some Small Category' }, json, fakeGet().get);
    expect(env.data).toEqual(['Tiny']);
    const env2 = await scanFetch('scan', { exchanges: 'Bitstamp' }, json, fakeGet().get);
    expect(env2.data).toEqual(['Tiny']);
  });

  it('returns an empty result with a note, never an error', async () => {
    const env = await scanFetch('scan', { categories: 'Layer Two' }, json, fakeGet().get);
    expect(env.data).toEqual([]);
    expect(env.meta.note).toBe(EMPTY_SCAN_NOTE);
    expect(EMPTY_SCAN_NOTE).toMatch(/exact and case-sensitive/);
    const env2 = await scanFetch('scan', { exchanges: 'Bitstamp', trend: 'UP' }, json, fakeGet({ coins: [] }).get);
    expect(env2.data).toEqual([]);
    expect(env2.meta.note).toBe(EMPTY_SCAN_NOTE);
    const env3 = await scanFetch('scan', { trend: 'UP' }, json, fakeGet({ coins: [] }).get);
    expect(env3.meta?.note).toBeUndefined();
  });

  it('refuses comma-joined categories without a call', async () => {
    const { get, calls } = fakeGet();
    await expect(scanFetch('scan', { categories: 'Meme,AI' }, json, get)).rejects.toThrow(/One category per scan/);
    expect(calls).toHaveLength(0);
  });

  it('unwraps { rows } so --fields and --top apply to the rows', async () => {
    const coins = [{ name: 'Dogecoin', categories: ['Meme'], exchanges: [] }, { name: 'Pepe', categories: ['Meme'], exchanges: [] }];
    const env = await scanFetch('scan', { categories: 'Meme', sortBy: 'change24h' }, json, fakeGet({ coins, wrap: true }).get);
    expect(env.data).toEqual(['Dogecoin', 'Pepe']);
    expect(env.meta.coverage).toEqual({ coverage: { withChange: 2 } });
    expect(applyClientFilters(env, { top: 1 }).data).toEqual(['Dogecoin']);
  });
});

describe('typedAction prints a note after the spinner stops', () => {
  afterEach(() => vi.restoreAllMocks());
  it('writes meta.note to stderr in human mode, after stop()', async () => {
    const order = [];
    const out = await import('../../src/lib/output.js');
    vi.spyOn(out, 'spinner');
    const tty = process.stdout.isTTY;
    process.stdout.isTTY = true;
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((s) => { order.push(`err:${s}`); return true; });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { typedAction } = await import('../../src/lib/typedCmd.js');
    const handler = typedAction({
      route: 'scan',
      fetch: async () => { order.push('fetched'); return { schemaVersion: 1, data: [], meta: { note: 'No coins matched.' } }; },
    });
    const cmd = { name: () => 'scan', parent: null, optsWithGlobals: () => ({}) };
    try {
      await handler({}, cmd);
    } finally {
      process.stdout.isTTY = tty;
    }
    const noteAt = order.findIndex((x) => x.includes('No coins matched.'));
    expect(noteAt).toBeGreaterThan(order.indexOf('fetched'));
    expect(err).toHaveBeenCalled();
  });
});
