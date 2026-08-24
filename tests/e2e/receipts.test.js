import { describe, it as baseIt, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';

// Binary spawns share the machine with the other e2e files; the default 5s
// timeout flakes under that contention.
const it = (name, fn) => baseIt(name, fn, 20000);

const BIN = resolve(import.meta.dirname, '../../bin/shumi.js');

// Receipts render from ~/.shumi/payments.log, so point HOME at a tmp dir and
// seed a synthetic log. Piped stdout means machine mode (JSON envelope).
let tmpHome;

function run(args) {
  return execa(BIN, ['wallet', 'receipts', ...args], {
    env: { HOME: tmpHome, USERPROFILE: tmpHome },
  });
}

const LOG_LINES = [
  { ts: '2026-08-01T10:00:00.000Z', route: 'https://api.example/x402/signal', amountUsdc: '0.05', tx: '0xaaa1', payer: '0xp1', wallet: '0xw1' },
  { ts: '2026-08-10T12:30:00.500Z', route: 'https://api.example/x402/ask', amountUsdc: '0.10', tx: '0xbbb2', payer: '0xp1', wallet: '0xw1' },
  // Last second of the day, with milliseconds — the case a string compare
  // against 'T23:59:59' loses.
  { ts: '2026-08-15T23:59:59.900Z', route: 'https://api.example/x402/edge,case', amountUsdc: '0.05', tx: null, payer: null, wallet: '0xw1' },
  { ts: '2026-08-20T08:00:00.000Z', route: 'https://api.example/x402/signal', amountUsdc: '0.05', tx: '0xccc3', payer: '0xp1', wallet: '0xw1' },
];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'shumi-receipts-test-'));
  mkdirSync(join(tmpHome, '.shumi'), { recursive: true });
  const lines = LOG_LINES.map((l) => JSON.stringify(l));
  lines.push('not-json-garbage');
  writeFileSync(join(tmpHome, '.shumi', 'payments.log'), lines.join('\n') + '\n');
});

afterEach(() => {
  if (tmpHome && existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

describe('wallet receipts --since/--until', () => {
  it('filters receipts on or after --since', async () => {
    const { stdout } = await run(['--since', '2026-08-10']);
    const { data } = JSON.parse(stdout);
    expect(data.receipts.map((r) => r.ts)).toEqual([
      '2026-08-10T12:30:00.500Z',
      '2026-08-15T23:59:59.900Z',
      '2026-08-20T08:00:00.000Z',
    ]);
  });

  it('--until keeps the full day, including the final second', async () => {
    const { stdout } = await run(['--until', '2026-08-15']);
    const { data } = JSON.parse(stdout);
    expect(data.receipts.map((r) => r.ts)).toEqual([
      '2026-08-01T10:00:00.000Z',
      '2026-08-10T12:30:00.500Z',
      '2026-08-15T23:59:59.900Z',
    ]);
  });

  it('composes both bounds with --limit', async () => {
    const { stdout } = await run(['--since', '2026-08-10', '--until', '2026-08-15', '--limit', '1']);
    const { data } = JSON.parse(stdout);
    expect(data.receipts.map((r) => r.ts)).toEqual(['2026-08-15T23:59:59.900Z']);
    expect(data.count).toBe(1);
  });
});

describe('wallet receipts --export csv', () => {
  it('writes RFC 4180 CSV with a header, quoting values with commas', async () => {
    const { stdout } = await run(['--export', 'csv']);
    const lines = stdout.split('\n');
    expect(lines[0]).toBe('timestamp,amountUsdc,route,tx,payer,wallet');
    expect(lines[3]).toBe('2026-08-15T23:59:59.900Z,0.05,"https://api.example/x402/edge,case",,,0xw1');
  });

  it('exports all filtered receipts, not just the last 20', async () => {
    const many = [];
    for (let i = 1; i <= 30; i++) {
      const day = String(i).padStart(2, '0');
      many.push(JSON.stringify({ ts: `2026-07-${day}T00:00:00.000Z`, route: 'r', amountUsdc: '0.01', tx: '0x1', payer: '0xp', wallet: '0xw' }));
    }
    writeFileSync(join(tmpHome, '.shumi', 'payments.log'), many.join('\n') + '\n');
    const { stdout } = await run(['--export', 'csv']);
    expect(stdout.split('\n').length).toBe(31); // header + 30 rows

    // An explicit --limit still caps the export.
    const capped = await run(['--export', 'csv', '--limit', '5']);
    expect(capped.stdout.split('\n').length).toBe(6);
  });

  it('rejects formats other than csv', async () => {
    const result = await run(['--export', 'xlsx']).catch((e) => e);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Unsupported export format/);
  });
});
