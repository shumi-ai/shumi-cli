/**
 * x402 payment wallet management.
 *
 * Two modes, picked at signer-creation time:
 *
 *   1. **Env-var override** — `SHUMI_X402_PRIVATE_KEY=0x...`
 *      Wins over the keystore. Designed for agents, CI, and `npx awal`-style
 *      ephemeral invocations. No interactive prompts; no on-disk state.
 *
 *   2. **Local keystore** — `~/.shumi/wallet.json`, 0600
 *      Passphrase-encrypted via scrypt + AES-256-GCM. Standard pattern for
 *      funded-spending CLIs (Foundry, Hardhat). Custom format because
 *      Ethereum's Web3 Secret Storage v3 carries unnecessary complexity
 *      (KDF variants, MAC schemes) for a single-key single-user CLI.
 *
 * Future Phase 2.5: optionally back the signer with Dynamic Server Wallets
 * (provisioned per logged-in user, signs via Dynamic API) so users don't
 * have to manage a passphrase. Out of scope today — Server Wallets require
 * per-user provisioning flow + Dynamic API integration.
 *
 * The address derivation, signing, and on-chain reads all go through viem.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { createSigner } from 'x402-fetch';

const CONFIG_DIR = join(homedir(), '.shumi');
const KEYSTORE_PATH = join(CONFIG_DIR, 'wallet.json');
const PAYMENTS_LOG_PATH = join(CONFIG_DIR, 'payments.log');

const KEYSTORE_FORMAT = 'shumi-keystore-v1';
const KDF_N = 32768;     // scrypt CPU/mem cost — ~50ms on a recent laptop
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;       // 256 bits for AES-256
const SALT_LEN = 16;
const IV_LEN = 12;        // GCM standard

// USDC on Base — Coinbase canonical address. Same constant the server uses.
export const USDC_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_DECIMALS = 6;

const ERC20_BALANCE_ABI = [{
  type: 'function',
  name: 'balanceOf',
  stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}];

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function deriveKey(passphrase, salt) {
  // OpenSSL's scrypt needs ~128 * N * r bytes plus working overhead. With our
  // params (N=32768, r=8) that's 32MiB + slack; we give it 64MiB to be safe.
  return scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_LEN, {
    N: KDF_N, r: KDF_R, p: KDF_P, maxmem: 64 * 1024 * 1024,
  });
}

/**
 * Encrypt a hex private key with a user passphrase. Returns the keystore JSON
 * envelope. Format:
 *   {
 *     format: 'shumi-keystore-v1',
 *     address: '0x...',         // public address for quick lookup without decrypt
 *     kdf: { n, r, p, salt },   // scrypt parameters + salt
 *     cipher: { iv, ciphertext, authTag }, // AES-256-GCM
 *     createdAt: ISO string
 *   }
 */
function encryptKeystore(privateKey, passphrase, address) {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(privateKey.replace(/^0x/, ''), 'hex');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    format: KEYSTORE_FORMAT,
    address,
    kdf: {
      n: KDF_N, r: KDF_R, p: KDF_P,
      salt: salt.toString('hex'),
    },
    cipher: {
      iv: iv.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
      authTag: authTag.toString('hex'),
    },
    createdAt: new Date().toISOString(),
  };
}

function decryptKeystore(keystore, passphrase) {
  if (keystore.format !== KEYSTORE_FORMAT) {
    throw new Error(`Unknown keystore format: ${keystore.format}. Expected ${KEYSTORE_FORMAT}.`);
  }
  const salt = Buffer.from(keystore.kdf.salt, 'hex');
  const key = deriveKey(passphrase, salt);
  const iv = Buffer.from(keystore.cipher.iv, 'hex');
  const ciphertext = Buffer.from(keystore.cipher.ciphertext, 'hex');
  const authTag = Buffer.from(keystore.cipher.authTag, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new Error('Invalid passphrase or corrupted keystore.');
  }
  return '0x' + plaintext.toString('hex');
}

export function hasKeystore() {
  return existsSync(KEYSTORE_PATH);
}

export function hasEnvKey() {
  const k = process.env.SHUMI_X402_PRIVATE_KEY;
  return typeof k === 'string' && k.length > 0;
}

/**
 * Returns true if any signing mechanism is configured. Used for early UX:
 *   if (!hasWallet()) → "No wallet. Run `shumi wallet create` or set SHUMI_X402_PRIVATE_KEY"
 */
export function hasWallet() {
  return hasEnvKey() || hasKeystore();
}

/**
 * Generate a fresh wallet, encrypt with passphrase, write to disk (0600).
 * Returns the address. Throws if a keystore already exists.
 */
export function createKeystore(passphrase) {
  if (hasKeystore()) {
    throw new Error(`A wallet already exists at ${KEYSTORE_PATH}. Delete it first if you really want a new one.`);
  }
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters.');
  }
  ensureConfigDir();

  // Generate a fresh secp256k1 private key
  const pkBytes = randomBytes(32);
  const privateKey = '0x' + pkBytes.toString('hex');
  const account = privateKeyToAccount(privateKey);

  const keystore = encryptKeystore(privateKey, passphrase, account.address);
  writeFileSync(KEYSTORE_PATH, JSON.stringify(keystore, null, 2), { mode: 0o600 });
  chmodSync(KEYSTORE_PATH, 0o600);

  return account.address;
}

/**
 * Read the keystore's address WITHOUT decrypting. Available even when locked.
 * Used by `shumi wallet address` and the paywall confirmation prompt header.
 */
export function readKeystoreAddress() {
  if (hasEnvKey()) {
    const account = privateKeyToAccount(process.env.SHUMI_X402_PRIVATE_KEY);
    return account.address;
  }
  if (!hasKeystore()) return null;
  const keystore = JSON.parse(readFileSync(KEYSTORE_PATH, 'utf8'));
  return keystore.address;
}

/**
 * Load private key from env var (fast path) OR decrypt keystore with passphrase.
 * The passphrase callback is only invoked when keystore decryption is required —
 * env-var path skips it entirely.
 */
export function loadPrivateKey({ passphrase = null } = {}) {
  if (hasEnvKey()) {
    const k = process.env.SHUMI_X402_PRIVATE_KEY;
    if (!k.startsWith('0x') || k.length !== 66) {
      throw new Error('SHUMI_X402_PRIVATE_KEY must be 32 bytes (0x + 64 hex chars).');
    }
    return k;
  }
  if (!hasKeystore()) {
    throw new Error('No wallet configured. Run `shumi wallet create` or set SHUMI_X402_PRIVATE_KEY.');
  }
  if (!passphrase) {
    throw new Error('Wallet is locked. Passphrase required to sign.');
  }
  const keystore = JSON.parse(readFileSync(KEYSTORE_PATH, 'utf8'));
  return decryptKeystore(keystore, passphrase);
}

/**
 * Build a viem walletClient on Base mainnet. Used by x402-fetch's
 * `wrapFetchWithPayment` — the signing happens through viem's typed-data
 * machinery against the standard EIP-3009 USDC domain.
 *
 * Most callers want createX402Signer below; this is the lower-level escape
 * hatch if anyone needs the raw viem client.
 */
export function buildWalletClient(privateKey) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: base,
    transport: http(process.env.SHUMI_BASE_RPC_URL || 'https://mainnet.base.org'),
  });
}

/**
 * Create the signer that x402-fetch expects. Wraps viem + USDC-on-Base setup.
 */
export async function createX402Signer(privateKey) {
  // x402-fetch's createSigner takes a network string + the raw private key
  // and returns a viem-compatible signer pre-configured for that network.
  return createSigner('base', privateKey);
}

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.SHUMI_BASE_RPC_URL || 'https://mainnet.base.org'),
});

/**
 * Read USDC balance for an address on Base. Returns the human-readable string
 * (e.g. "4.83") and the raw BigInt for downstream comparisons.
 */
export async function getUsdcBalance(address) {
  const raw = await publicClient.readContract({
    address: USDC_ADDRESS_BASE,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
  return {
    formatted: formatUnits(raw, USDC_DECIMALS),
    raw,
  };
}

/**
 * Build a Coinbase Onramp deep link pre-filled for USDC-on-Base, targeting
 * the user's wallet. Free product; no API key needed for the URL itself.
 *
 * Sticky: Coinbase has changed this URL shape twice in the last 12 months.
 * If they change it again, update the constants here.
 */
export function buildOnrampUrl(destinationAddress, presetUsdAmount = 25) {
  const url = new URL('https://pay.coinbase.com/buy/select-asset');
  url.searchParams.set(
    'destinationWallets',
    JSON.stringify([{ address: destinationAddress, blockchains: ['base'], assets: ['USDC'] }])
  );
  url.searchParams.set('defaultAsset', 'USDC');
  url.searchParams.set('defaultNetwork', 'base');
  if (presetUsdAmount > 0) url.searchParams.set('presetCryptoAmount', String(presetUsdAmount));
  return url.toString();
}

/**
 * Append a payment receipt to ~/.shumi/payments.log (JSON-per-line). One row
 * per successful x402 settlement. Users can grep this offline for cost
 * reconciliation. Not load-bearing — failures are silent.
 */
export function appendPaymentReceipt(fields) {
  try {
    ensureConfigDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n';
    writeFileSync(PAYMENTS_LOG_PATH, line, { flag: 'a', mode: 0o600 });
  } catch {
    // Receipt logging is best-effort; never break the request flow.
  }
}

// Exported for tests
export const __testing = {
  encryptKeystore,
  decryptKeystore,
  KEYSTORE_PATH,
};
