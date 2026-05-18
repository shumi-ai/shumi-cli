import { homedir, hostname, userInfo, platform, arch } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';

// The data/CLI surface talks to coinrotator-ai (Fastify on Render). Vercel was
// the wrong runtime — cold starts, streaming flakiness, and a 300s max-duration
// cap that broke `shumi watch`. Render keeps Fastify warm and supports proper
// NDJSON streaming via reply.raw.
const DEFAULT_API_URL = 'https://coinrotator-ai.onrender.com/api/cli';
const API_URL = (process.env.SHUMI_API_URL || DEFAULT_API_URL).replace(/\/$/, '');

// API key management (/keys) stays on the Next.js app — that's where the JWT
// verification flow lives (Dynamic.xyz wallet auth issues a JWT, the user
// trades it for one or more shumi_sk_* keys). Override via SHUMI_KEYS_URL.
const DEFAULT_KEYS_URL = 'https://coinrotator.app/api/keys';
const KEYS_URL = (process.env.SHUMI_KEYS_URL || DEFAULT_KEYS_URL).replace(/\/$/, '');
const CONFIG_DIR = join(homedir(), '.shumi');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function readConfig() {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Derive a deterministic device ID from stable machine properties.
 * Survives config deletion — same machine always produces the same ID.
 */
function getMachineFingerprint() {
  const data = [
    hostname(),
    userInfo().username,
    platform(),
    arch(),
    homedir(),
  ].join('|');
  return createHash('sha256').update(data).digest('hex').slice(0, 24);
}

export function getDeviceId() {
  return getMachineFingerprint();
}

export function getToken() {
  if (process.env.SHUMI_TOKEN) return process.env.SHUMI_TOKEN;
  // Skip config-file fallback when explicitly requested. Useful for tests that
  // want to verify the "no token" code path even when the developer's
  // ~/.shumi/config.json holds a real JWT.
  if (process.env.SHUMI_NO_CONFIG === '1') return null;
  const config = readConfig();
  if (!config.token) return null;
  if (config.expiresAt && new Date(config.expiresAt) < new Date()) {
    return null;
  }
  return config.token;
}

export function getWalletAddress() {
  return process.env.SHUMI_WALLET || readConfig().walletAddress || null;
}

export function saveCredentials({ token, walletAddress, expiresAt }) {
  const config = readConfig();
  writeConfig({ ...config, token, walletAddress, expiresAt });
}

export function clearCredentials() {
  const config = readConfig();
  const { token, walletAddress, expiresAt, ...rest } = config;
  writeConfig(rest);
}

export { API_URL, KEYS_URL, CONFIG_DIR, CONFIG_FILE };
