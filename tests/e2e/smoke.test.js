import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { createServer } from 'http';
import { resolve } from 'path';

const BIN = resolve(import.meta.dirname, '../../bin/shumi.js');

/**
 * Spin up a localhost HTTP mock server, point the CLI at it via SHUMI_API_URL
 * (handled in the test runner via env), and exercise the typed commands.
 *
 * Note: today the CLI's API_URL is hardcoded in config.js. For this test to fully
 * exercise the network path, that constant would need to honor an env var. For
 * Phase 1 we cover the non-network paths (help, version, commands) and rely on
 * unit tests for api-client behavior.
 */

let server;
let baseUrl;

beforeAll(async () => {
  await new Promise((res) => {
    server = createServer((req, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ schemaVersion: 1, data: { ok: true, path: req.url } }));
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

describe('binary smoke', () => {
  it('shumi --version prints the package version', async () => {
    const { stdout, exitCode } = await execa(BIN, ['--version']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('shumi --help lists the typed commands', async () => {
    const { stdout, exitCode } = await execa(BIN, ['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('coin');
    expect(stdout).toContain('funding');
    expect(stdout).toContain('regime');
    expect(stdout).toContain('signal-quality');
    expect(stdout).toContain('billing');
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('commands');
  });

  it('shumi version --json returns a structured envelope', async () => {
    const { stdout, exitCode } = await execa(BIN, ['version', '--json']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.data.name).toBe('shumi');
    expect(parsed.data.node).toMatch(/^v\d+/);
  });

  it('shumi commands --json emits a capability manifest', async () => {
    const { stdout, exitCode } = await execa(BIN, ['commands', '--json']);
    expect(exitCode).toBe(0);
    const m = JSON.parse(stdout);
    expect(m.schemaVersion).toBe(1);
    expect(m.commands.length).toBeGreaterThan(10);
    const coin = m.commands.find((c) => c.name === 'coin');
    expect(coin.subcommands.some((s) => s.name === 'risk')).toBe(true);
  });

  it('typed command without auth exits with code 2 (AUTH_REQUIRED)', async () => {
    const result = await execa(BIN, ['coin', 'risk', 'BTC', '--agent'], { reject: false, env: { ...process.env, SHUMI_TOKEN: '', SHUMI_NO_CONFIG: '1', SHUMI_NO_UPDATE_NOTIFIER: '1' } });
    expect(result.exitCode).toBe(2);
    // The error envelope is on stderr in agent mode.
    const stderrEnv = JSON.parse(result.stderr.trim().split('\n').pop());
    expect(stderrEnv.error.code).toBe('AUTH_REQUIRED');
  });

  it('piped (non-TTY) output is JSON without --json flag', async () => {
    // execa runs in pipe mode by default — stdout is non-TTY.
    const { stdout, exitCode } = await execa(BIN, ['version']);
    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

describe('help command', () => {
  it('shumi help (piped) emits the capability manifest as JSON', async () => {
    const { stdout, exitCode } = await execa(BIN, ['help']);
    expect(exitCode).toBe(0);
    const m = JSON.parse(stdout);
    expect(m.schemaVersion).toBe(1);
    expect(m.commands.length).toBeGreaterThan(10);
  });

  it('shumi help <command> shows that command’s detailed usage', async () => {
    const { stdout, exitCode } = await execa(BIN, ['help', 'signal']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: shumi signal');
    expect(stdout).toContain('<symbol>');
  });

  it('shumi help <unknown> exits non-zero', async () => {
    const result = await execa(BIN, ['help', 'definitely-not-a-command'], { reject: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Unknown command');
  });
});

describe('bare-ticker shortcut', () => {
  const noAuthEnv = { ...process.env, SHUMI_TOKEN: '', SHUMI_NO_CONFIG: '1', SHUMI_NO_UPDATE_NOTIFIER: '1' };

  it('shumi <TICKER> routes to the signal path (auth-gated like `signal`)', async () => {
    // Without a token the signal path exits 2 (AUTH_REQUIRED). This proves the
    // bare ticker dispatches to signal rather than the (token-less) dashboard,
    // which would instead fall back to help with exit 0.
    const result = await execa(BIN, ['ZEC', '--agent'], { reject: false, env: noAuthEnv });
    expect(result.exitCode).toBe(2);
    const env = JSON.parse(result.stderr.trim().split('\n').pop());
    expect(env.error.code).toBe('AUTH_REQUIRED');
  });

  it('lowercase ticker is normalized (shumi zec → ZEC)', async () => {
    const result = await execa(BIN, ['zec', '--agent'], { reject: false, env: noAuthEnv });
    expect(result.exitCode).toBe(2);
  });

  it('no argument does NOT trigger the signal path', async () => {
    // No token + no arg → dashboard falls back to help (exit 0), not a signal call.
    const result = await execa(BIN, [], { reject: false, env: noAuthEnv });
    expect(result.exitCode).toBe(0);
  });
});
