import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { currentTrendLine, renderCoinLookup } from '../../src/lib/currentTrend.js';
import { scanQuery, registerScanCommand, SCAN_SORT_FIELDS } from '../../src/commands/scan.js';
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
