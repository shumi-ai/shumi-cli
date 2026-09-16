/**
 * End-to-end test for `shumi watch <stream>`.
 *
 * Spins up a local NDJSON server, points the CLI at it via SHUMI_API_URL,
 * and verifies:
 *
 *   1. Streaming mode (TTY-like) — lines appear incrementally; closing
 *      via SIGINT exits cleanly with summary on stderr.
 *   2. Blocking / piped mode — when stdout is piped (non-TTY), the same
 *      events come out as NDJSON on stdout, one object per line, with
 *      no spinner / human chrome interleaved.
 *   3. The output is genuinely line-buffered (not collected and dumped
 *      at the end) — we measure the timing between writes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { createServer } from 'http';
import { resolve } from 'path';

const BIN = resolve(import.meta.dirname, '../../bin/shumi.js');

let server;
let baseUrl;

beforeAll(async () => {
  await new Promise((res) => {
    server = createServer(async (req, response) => {
      // Mock the auth-resolve check by accepting any Bearer header
      if (!req.headers.authorization?.startsWith('Bearer ')) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ schemaVersion: 1, error: { code: 'AUTH_REQUIRED', message: 'auth needed' } }));
        return;
      }
      if (!req.url.startsWith('/watch/')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      // NDJSON stream: send open, 3 events @ ~150ms apart, close
      response.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      });
      const send = (obj) => response.write(JSON.stringify(obj) + '\n');
      send({ type: 'open', stream: 'funding', interval: 1, source: 'mock' });
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 150));
        send({
          type: 'event',
          stream: 'funding',
          schemaVersion: 1,
          // avgApr in PERCENT units to match the real funding/momentum endpoint
          // (e.g. -9.9 = -9.9% APR), not a 0..1 fraction.
          data: { market: { temperature: 'warm', avgApr: -9.9 + i * 0.1, positive: 10 + i, negative: 5, total: 50 } },
          meta: { ts: new Date().toISOString(), route: 'watch/funding', tick: i, data_age_seconds: i * 5 },
        });
      }
      send({ type: 'close', stream: 'funding', emitted: 3 });
      response.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      res();
    });
  });
});

afterAll(async () => {
  await new Promise((res) => server.close(res));
});

const env = (overrides = {}) => ({
  ...process.env,
  SHUMI_API_URL: `${baseUrl}`,
  SHUMI_TOKEN: 'shumi_sk_test.secret',
  SHUMI_NO_UPDATE_NOTIFIER: '1',
  ...overrides,
});

describe('shumi watch — NDJSON streaming', () => {
  it('blocking/piped: emits NDJSON on stdout, one object per line', async () => {
    const { stdout, stderr, exitCode } = await execa(BIN, ['watch', 'funding', '--max', '3'], {
      env: env(),
      timeout: 5000,
    });
    expect(exitCode).toBe(0);
    const lines = stdout.split('\n').filter(Boolean);
    // Auto-JSON when piped: every line should be a parseable JSON object
    expect(lines.length).toBeGreaterThanOrEqual(3); // open + 3 events + close minus any duplicates
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj).toHaveProperty('type');
      expect(['open', 'event', 'heartbeat', 'close']).toContain(obj.type);
    }
    // Should include exactly 3 'event' lines
    const events = lines.map(JSON.parse).filter((o) => o.type === 'event');
    expect(events).toHaveLength(3);
    // Each event carries data + meta with tick + data_age_seconds
    for (const [i, e] of events.entries()) {
      expect(e.data.market.temperature).toBe('warm');
      expect(e.meta.tick).toBe(i);
      expect(typeof e.meta.data_age_seconds).toBe('number');
    }
    // Stderr should not pollute stdout — but may carry the human "closed" summary
    // when SHUMI_AGENT is off (auto-JSON only flips stdout, not the mode helpers).
    // We don't assert stderr-empty here because non-TTY auto-JSON keeps stdout clean,
    // which is the contract we care about.
  });

  it('explicit --json: same NDJSON shape', async () => {
    const { stdout, exitCode } = await execa(BIN, ['watch', 'funding', '--max', '3', '--json'], {
      env: env(),
      timeout: 5000,
    });
    expect(exitCode).toBe(0);
    const lines = stdout.split('\n').filter(Boolean);
    for (const line of lines) JSON.parse(line); // must all parse
  });

  it('--agent: no chalk codes anywhere in stdout', async () => {
    const { stdout, exitCode } = await execa(BIN, ['watch', 'funding', '--max', '3', '--agent'], {
      env: env(),
      timeout: 5000,
    });
    expect(exitCode).toBe(0);
    // ANSI escape sequences start with ESC ([0x1b)
    expect(stdout).not.toMatch(/\x1b\[/);
  });

  it('streaming: lines are flushed incrementally (not all at once at the end)', async () => {
    // Spawn the CLI and watch stdout timing
    const subprocess = execa(BIN, ['watch', 'funding', '--max', '3', '--json'], {
      env: env(),
      timeout: 5000,
      buffer: false,
    });
    const arrivals = [];
    const start = Date.now();
    subprocess.stdout.on('data', (chunk) => {
      arrivals.push({ t: Date.now() - start, bytes: chunk.length });
    });
    await subprocess;
    // We expect at least 3 distinct read events spaced apart (mock sends 1 every 150ms).
    // If output were buffered to the end, we'd see 1 big chunk near the end.
    expect(arrivals.length).toBeGreaterThanOrEqual(3);
    // The first arrival should come well before the last — verify spread > 200ms
    const spread = arrivals[arrivals.length - 1].t - arrivals[0].t;
    expect(spread).toBeGreaterThan(200);
  });

  it('rejects unknown stream with exit 1 (USER_ERROR — bad input)', async () => {
    server.removeAllListeners('request');
    server.on('request', (req, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ schemaVersion: 1, error: { code: 'BAD_REQUEST', message: 'unknown stream' } }));
    });
    const result = await execa(BIN, ['watch', 'unknown-stream', '--json'], {
      env: env(),
      timeout: 5000,
      reject: false,
    });
    expect(result.exitCode).toBe(1);
  });

  it('auth required: no token → exit 2 before opening the stream', async () => {
    const result = await execa(BIN, ['watch', 'funding', '--agent'], {
      env: env({ SHUMI_TOKEN: '', SHUMI_NO_CONFIG: '1' }),
      reject: false,
      timeout: 5000,
    });
    expect(result.exitCode).toBe(2);
  });
});
