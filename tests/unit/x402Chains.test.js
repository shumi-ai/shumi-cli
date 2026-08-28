import { describe, it, expect, afterEach } from 'vitest';
import { CHAINS, KNOWN_ASSETS, knownAsset, chainForNetwork, rpcUrlFor } from '../../src/lib/x402-chains.js';

/**
 * The chain/asset tables are a payment-safety boundary: an unknown chain or
 * asset must resolve to null so the payer DECLINES instead of guessing. These
 * are the pure decision functions — the network readers (getTokenMeta,
 * getTokenBalance) are deliberately untested here.
 */

const BASE = CHAINS[8453];
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

describe('chainForNetwork', () => {
  it('resolves human name and CAIP-2 id to the same chain', () => {
    expect(chainForNetwork('base')).toBe(BASE);
    expect(chainForNetwork('eip155:8453')).toBe(BASE);
  });

  it('is case-insensitive (servers vary)', () => {
    expect(chainForNetwork('Base')).toBe(BASE);
    expect(chainForNetwork('EIP155:84532')).toBe(CHAINS[84532]);
  });

  it('declines chains not in the table — even well-formed CAIP-2 ids', () => {
    expect(chainForNetwork('eip155:1')).toBeNull();      // Ethereum mainnet: not listed
    expect(chainForNetwork('solana')).toBeNull();
  });

  it('declines empty/nullish input instead of matching anything', () => {
    expect(chainForNetwork('')).toBeNull();
    expect(chainForNetwork(null)).toBeNull();
    expect(chainForNetwork(undefined)).toBeNull();
  });
});

describe('knownAsset', () => {
  it('accepts a listed asset and returns its pricing record', () => {
    expect(knownAsset(BASE, BASE_USDC)).toEqual({ symbol: 'USDC', decimals: 6, usdPerUnit: 1 });
  });

  it('normalizes address case and whitespace (checksummed addresses must match)', () => {
    expect(knownAsset(BASE, `  ${BASE_USDC.toUpperCase().replace('0X', '0x')} `))
      .toEqual({ symbol: 'USDC', decimals: 6, usdPerUnit: 1 });
  });

  it('declines an unlisted asset — the "1 token = $1 for anything" hole', () => {
    // WETH on Base: real token, absent from the table on purpose.
    expect(knownAsset(BASE, '0x4200000000000000000000000000000000000006')).toBeNull();
  });

  it('declines when the asset is listed on a DIFFERENT chain only', () => {
    // Base-Sepolia USDC address queried against mainnet Base.
    const sepoliaUsdc = Object.keys(KNOWN_ASSETS[84532])[0];
    expect(knownAsset(BASE, sepoliaUsdc)).toBeNull();
  });

  it('declines nullish chain or non-string asset', () => {
    expect(knownAsset(null, BASE_USDC)).toBeNull();
    expect(knownAsset(BASE, null)).toBeNull();
    expect(knownAsset(BASE, 42)).toBeNull();
  });
});

describe('rpcUrlFor', () => {
  afterEach(() => { delete process.env.SHUMI_BASE_RPC_URL; });

  it('uses the chain default when no env override', () => {
    expect(rpcUrlFor(BASE)).toBe('https://mainnet.base.org');
  });

  it('env override wins', () => {
    process.env.SHUMI_BASE_RPC_URL = 'http://localhost:8545';
    expect(rpcUrlFor(BASE)).toBe('http://localhost:8545');
  });
});
