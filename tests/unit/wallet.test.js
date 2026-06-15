import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, rmSync, mkdtempSync } from 'fs';

// Force ~/.shumi/ to a tmp dir so we don't touch the developer's real keystore.
// Must happen BEFORE the wallet module imports. HOME env override is the
// least-invasive way — wallet.js reads `homedir()` at import time.
let tmpHome;

function isolateHome() {
  tmpHome = mkdtempSync(join(tmpdir(), 'shumi-wallet-test-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // Windows compat for completeness
}

function cleanupHome() {
  if (tmpHome && existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
  tmpHome = null;
}

// Pre-isolate the HOME so wallet.js's `homedir()` resolves into the tmpdir
// before the dynamic import below.
isolateHome();

const wallet = await import('../../src/lib/wallet.js');
const {
  createKeystore, loadPrivateKey, readKeystoreAddress,
  hasKeystore, hasEnvKey, hasWallet,
  __testing: { encryptKeystore, decryptKeystore, KEYSTORE_PATH },
} = wallet;

describe('keystore — encrypt/decrypt round-trip', () => {
  it('encrypts then decrypts back to the same key', () => {
    const pk = '0x' + 'ab'.repeat(32);
    const ks = encryptKeystore(pk, 'correct horse battery staple', '0xPlaceholder');
    expect(ks.format).toBe('shumi-keystore-v1');
    expect(ks.kdf.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(ks.cipher.iv).toMatch(/^[0-9a-f]{24}$/);
    const back = decryptKeystore(ks, 'correct horse battery staple');
    expect(back).toBe(pk);
  });

  it('throws on wrong passphrase (AES-GCM auth tag mismatch)', () => {
    const pk = '0x' + 'cd'.repeat(32);
    const ks = encryptKeystore(pk, 'right', '0xPlaceholder');
    expect(() => decryptKeystore(ks, 'wrong')).toThrow(/Invalid passphrase|corrupted/);
  });

  it('throws on unknown format', () => {
    const ks = encryptKeystore('0x' + '11'.repeat(32), 'pass', '0xPlaceholder');
    ks.format = 'unexpected-v9';
    expect(() => decryptKeystore(ks, 'pass')).toThrow(/Unknown keystore format/);
  });
});

describe('createKeystore — fresh wallet generation', () => {
  beforeEach(() => {
    if (existsSync(KEYSTORE_PATH)) rmSync(KEYSTORE_PATH);
    delete process.env.SHUMI_X402_PRIVATE_KEY;
  });

  it('creates a valid encrypted keystore + derivable address', () => {
    expect(hasKeystore()).toBe(false);
    const address = createKeystore('long-enough-passphrase');
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(hasKeystore()).toBe(true);
    expect(readKeystoreAddress()).toBe(address);
  });

  it('rejects passphrase < 8 chars', () => {
    expect(() => createKeystore('short')).toThrow(/at least 8/);
  });

  it('refuses to overwrite an existing keystore', () => {
    createKeystore('first-pass-long');
    expect(() => createKeystore('second-pass-long')).toThrow(/already exists/);
  });

  it('loadPrivateKey requires correct passphrase', () => {
    createKeystore('the-right-passphrase');
    const pk = loadPrivateKey({ passphrase: 'the-right-passphrase' });
    expect(pk).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(() => loadPrivateKey({ passphrase: 'wrong' })).toThrow();
  });

  it('loadPrivateKey without passphrase throws "locked"', () => {
    createKeystore('any-passphrase');
    expect(() => loadPrivateKey({})).toThrow(/locked|passphrase/i);
  });
});

describe('env-var override — SHUMI_X402_PRIVATE_KEY beats keystore', () => {
  beforeEach(() => {
    if (existsSync(KEYSTORE_PATH)) rmSync(KEYSTORE_PATH);
  });
  afterEach(() => {
    delete process.env.SHUMI_X402_PRIVATE_KEY;
  });

  it('hasEnvKey detects env var presence', () => {
    expect(hasEnvKey()).toBe(false);
    process.env.SHUMI_X402_PRIVATE_KEY = '0x' + 'ef'.repeat(32);
    expect(hasEnvKey()).toBe(true);
  });

  it('hasWallet returns true when env var set even without keystore', () => {
    process.env.SHUMI_X402_PRIVATE_KEY = '0x' + 'ef'.repeat(32);
    expect(hasKeystore()).toBe(false);
    expect(hasWallet()).toBe(true);
  });

  it('readKeystoreAddress returns env-key derived address (skips disk)', () => {
    process.env.SHUMI_X402_PRIVATE_KEY = '0x' + 'ef'.repeat(32);
    const address = readKeystoreAddress();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('loadPrivateKey returns env key without passphrase', () => {
    const k = '0x' + 'ef'.repeat(32);
    process.env.SHUMI_X402_PRIVATE_KEY = k;
    expect(loadPrivateKey({})).toBe(k);
  });

  it('rejects malformed env key (wrong length)', () => {
    process.env.SHUMI_X402_PRIVATE_KEY = '0xdeadbeef';
    expect(() => loadPrivateKey({})).toThrow(/32 bytes/);
  });
});

afterEach(() => {
  // Don't fully cleanup — vitest runs tests in parallel and the keystore
  // path is process-scoped. Per-test rm in beforeEach handles isolation.
});

// Final cleanup at process exit
process.on('beforeExit', cleanupHome);
