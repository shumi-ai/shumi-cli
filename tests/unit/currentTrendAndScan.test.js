import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { currentTrendLine, renderCoinLookup } from '../../src/lib/currentTrend.js';
import { scanQuery, scanFetch, registerScanCommand, SCAN_SORT_FIELDS } from '../../src/commands/scan.js';
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

describe('scan name resolution', () => {
  // Real names from the Coin table (2026-09-24).
  const CATEGORIES = ['Meme', 'Layer-2', 'BTC Layer 2', 'GMCI Layer 2 Index'];
  const COINS = [
    { name: 'Dogecoin', categories: ['Meme'], exchanges: ['Binance', 'Coinbase Exchange'] },
    { name: 'Arbitrum', categories: ['Layer-2'], exchanges: ['Binance'] },
  ];
  // Behaves like /api/coins/filter: exact case-sensitive category, case-insensitive exchange.
  function fakeGet({ coins = COINS, wrap = false } = {}) {
    const calls = [];
    const get = async (route, q = {}) => {
      calls.push({ route, q });
      if (route === 'category/list') return { data: CATEGORIES };
      const rows = coins
        .filter((x) => !q.categories || x.categories.includes(q.categories))
        .filter((x) => !q.exchanges || x.exchanges.some((e) => e.toLowerCase() === String(q.exchanges).toLowerCase()))
        .map((x) => x.name);
      return { schemaVersion: 1, data: wrap ? { rows } : rows };
    };
    return { get, calls };
  }
  const json = { json: true };

  it('sends a correct category once, unchanged', async () => {
    const { get, calls } = fakeGet();
    const env = await scanFetch('scan', { categories: 'Meme' }, json, get);
    expect(env.data).toEqual(['Dogecoin']);
    expect(calls).toHaveLength(1);
  });

  it('resolves --category meme / "Layer 2" to the real name and re-runs', async () => {
    for (const [asked, real, coin] of [['meme', 'Meme', 'Dogecoin'], ['Layer 2', 'Layer-2', 'Arbitrum']]) {
      const { get, calls } = fakeGet();
      const env = await scanFetch('scan', { categories: asked }, json, get);
      expect(env.data).toEqual([coin]);
      expect(calls.at(-1).q.categories).toBe(real);
      expect(env.meta.resolved[0]).toContain(`matched as "${real}"`);
    }
  });

  it('errors with the closest names for an unknown category instead of printing an empty list', async () => {
    const { get } = fakeGet();
    await expect(scanFetch('scan', { categories: 'Layer Two' }, json, get)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/No category named "Layer Two".*"Layer-2"/),
    });
  });

  it('refuses comma-joined categories', async () => {
    const { get, calls } = fakeGet();
    await expect(scanFetch('scan', { categories: 'Meme,AI' }, json, get)).rejects.toThrow(/One category per scan/);
    expect(calls).toHaveLength(0);
  });

  it('keeps a genuinely empty result for a valid category', async () => {
    const { get } = fakeGet({ coins: [] });
    const env = await scanFetch('scan', { categories: 'Meme', trend: 'UP' }, json, get);
    expect(env.data).toEqual([]);
  });

  it('maps "coinbase" to "Coinbase Exchange" and errors on an unknown venue', async () => {
    const { get, calls } = fakeGet();
    const env = await scanFetch('scan', { exchanges: 'coinbase' }, json, get);
    expect(calls[0].q.exchanges).toBe('Coinbase Exchange');
    expect(env.data).toEqual(['Dogecoin']);
    await expect(scanFetch('scan', { exchanges: 'Krakenn' }, json, fakeGet().get)).rejects.toThrow(/Closest known: "Kraken"/);
  });

  it('treats { rows: [...] } as rows', async () => {
    const { get, calls } = fakeGet({ wrap: true });
    const env = await scanFetch('scan', { categories: 'Meme', sortBy: 'change24h' }, json, get);
    expect(env.data.rows).toEqual(['Dogecoin']);
    expect(calls).toHaveLength(1);
  });
});
