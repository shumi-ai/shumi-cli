import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, rmSync, mkdtempSync } from 'fs';

// Same HOME-isolation trick as wallet.test.js: config.js resolves CONFIG_DIR
// from homedir() at import time, and these tests write pending-login state.
// Without this they would clobber the developer's real ~/.shumi/config.json.
const tmpHome = mkdtempSync(join(tmpdir(), 'shumi-auth-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { parseCallbackUrl, acceptCallbackCredential } = await import('../../src/lib/auth.js');
const { savePendingLoginState, clearPendingLoginState, getToken, clearCredentials } =
  await import('../../src/lib/config.js');
const { isNewer, __setUpdateInfo } = await import('../../src/lib/updateCheck.js');
const { renderOk } = await import('../../src/lib/output.js');

/** Minimal unsigned JWT — inspectToken only decodes the payload. */
function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);

function callbackUrl({ state = 'st-1', token = jwt({ exp: now() + HOUR, email: 'a@b.co' }), wallet = '0xabcdef0123456789abcdef0123456789abcdef01' } = {}) {
  const u = new URL('http://127.0.0.1:54321/callback');
  if (state !== null) u.searchParams.set('state', state);
  if (token !== null) u.searchParams.set('token', token);
  if (wallet !== null) u.searchParams.set('wallet', wallet);
  return u.toString();
}

describe('parseCallbackUrl — stranded-token recovery', () => {
  beforeEach(() => {
    clearCredentials();
    savePendingLoginState('st-1');
  });
  afterEach(() => clearPendingLoginState());

  it('accepts a callback whose state matches the pending sign-in', () => {
    const cred = parseCallbackUrl(callbackUrl());
    expect(cred.walletAddress).toMatch(/^0xabcdef/);
    expect(cred.email).toBe('a@b.co');
    expect(cred.token.split('.')).toHaveLength(3);
  });

  // The whole point of persisting state: recovery must not become login-CSRF.
  it('rejects a URL from a different sign-in (state mismatch)', () => {
    expect(() => parseCallbackUrl(callbackUrl({ state: 'attacker-state' }))).toThrow(/State mismatch/);
  });

  it('rejects when no sign-in is pending', () => {
    clearPendingLoginState();
    expect(() => parseCallbackUrl(callbackUrl())).toThrow(/No sign-in is pending/);
  });

  it('rejects an expired token instead of saving a dead credential', () => {
    const stale = jwt({ exp: now() - 5 * 24 * HOUR });
    expect(() => parseCallbackUrl(callbackUrl({ token: stale }))).toThrow(/already expired/);
  });

  it('rejects a URL with no token', () => {
    expect(() => parseCallbackUrl(callbackUrl({ token: null }))).toThrow(/no token in it/);
  });

  it('rejects input that is not a URL', () => {
    expect(() => parseCallbackUrl('the sign-in failed')).toThrow(/not a URL/);
  });

  it('does not write anything until the credential is accepted', () => {
    parseCallbackUrl(callbackUrl());
    expect(getToken()).toBeNull();
    acceptCallbackCredential(parseCallbackUrl(callbackUrl()));
    expect(getToken()).not.toBeNull();
  });
});

describe('isNewer', () => {
  it('detects a newer release', () => {
    expect(isNewer('0.7.4', '0.6.2')).toBe(true);
    expect(isNewer('0.8.0', '0.7.9')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
  });

  it('is quiet when current or ahead', () => {
    expect(isNewer('0.7.4', '0.7.4')).toBe(false);
    expect(isNewer('0.7.4', '0.8.0')).toBe(false);
  });

  // This runs on every invocation now, so a false positive would be permanent
  // noise on a maintainer's machine.
  it('does not nag a local prerelease that is ahead of the registry', () => {
    expect(isNewer('0.7.4', '0.8.0-dev')).toBe(false);
  });
});

// The whole point of the update work: this envelope field is the ONLY channel
// that reaches a caller whose stdout is piped, which is every AI-agent user.
describe('meta.updateAvailable in the JSON envelope', () => {
  const update = { current: '0.6.2', latest: '0.7.4', action: 'npm i -g shumi@latest' };
  let written;

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { written.push(s); return true; });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __setUpdateInfo(null);
  });

  it('attaches the notice without disturbing data', () => {
    __setUpdateInfo(update);
    renderOk({ schemaVersion: 1, data: { ok: true } }, { json: true });
    const env = JSON.parse(written.join(''));
    expect(env.data).toEqual({ ok: true });
    expect(env.meta.updateAvailable).toEqual(update);
  });

  it('preserves any meta the command already set', () => {
    __setUpdateInfo(update);
    renderOk({ schemaVersion: 1, data: {}, meta: { route: 'coin/risk' } }, { json: true });
    const env = JSON.parse(written.join(''));
    expect(env.meta).toEqual({ route: 'coin/risk', updateAvailable: update });
  });

  it('adds nothing when up to date', () => {
    __setUpdateInfo(null);
    renderOk({ schemaVersion: 1, data: { ok: true } }, { json: true });
    expect(JSON.parse(written.join(''))).toEqual({ schemaVersion: 1, data: { ok: true } });
  });
});

describe('expired vs missing credential', () => {
  let origToken;
  beforeEach(() => { origToken = process.env.SHUMI_TOKEN; });
  afterEach(() => {
    if (origToken === undefined) delete process.env.SHUMI_TOKEN; else process.env.SHUMI_TOKEN = origToken;
  });

  // The reported failure mode: a session that aged out reported the same
  // "Authentication required" as never having logged in, so the user had no
  // idea a re-login was all that was needed.
  it('reports AUTH_EXPIRED with the age, not a bare AUTH_REQUIRED', async () => {
    process.env.SHUMI_TOKEN = jwt({ exp: now() - 13 * 24 * HOUR });
    const { apiGet } = await import('../../src/lib/api-client.js');
    await expect(apiGet('coin/risk/BTC')).rejects.toMatchObject({
      status: 401,
      body: { error: { code: 'AUTH_EXPIRED', message: expect.stringContaining('13 days ago') } },
    });
  });

  // Regression guard: reading the raw token must not start sending a
  // credential that getToken()'s config-file expiry check used to block. A
  // token with no `exp` claim has no other gate.
  it('still refuses a token the config file marks expired, even with no JWT exp', async () => {
    const { saveCredentials, clearCredentials: clear } = await import('../../src/lib/config.js');
    delete process.env.SHUMI_TOKEN;
    clear();
    saveCredentials({
      token: jwt({ sub: 'no-exp-claim' }),
      walletAddress: '0xdeadbeef',
      expiresAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    try {
      const { apiGet } = await import('../../src/lib/api-client.js');
      await expect(apiGet('coin/risk/BTC')).rejects.toMatchObject({
        status: 401,
        body: { error: { code: 'AUTH_EXPIRED' } },
      });
    } finally {
      clear();
    }
  });

  it('still reports AUTH_REQUIRED when there is no credential at all', async () => {
    delete process.env.SHUMI_TOKEN;
    process.env.SHUMI_NO_CONFIG = '1';
    try {
      const { apiGet } = await import('../../src/lib/api-client.js');
      await expect(apiGet('coin/risk/BTC')).rejects.toMatchObject({
        status: 401,
        body: { error: { code: 'AUTH_REQUIRED' } },
      });
    } finally {
      delete process.env.SHUMI_NO_CONFIG;
    }
  });
});

process.on('exit', () => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});
