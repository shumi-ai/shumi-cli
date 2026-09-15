/**
 * Client-side chain table for x402 payments.
 *
 * The 402 challenge tells us the network, the token address and the amount in
 * base units — but NOT the token's decimals, symbol, or an RPC to reach it.
 * Without decimals we cannot render "$0.005" from "5000", and rendering the
 * wrong number in a payment prompt is the one place a display bug costs money.
 *
 * So the client keeps its own small table of chains it is willing to pay on,
 * and reads the token's `symbol()` / `decimals()` from that chain when it meets
 * an asset it does not already know. An unknown chain is declined rather than
 * guessed at: paying on a chain we cannot read is paying blind.
 */

import { createPublicClient, http } from 'viem';

/**
 * Chains this CLI can pay on. Every field is either protocol-fixed (chainId) or
 * verified against the live chain, not copied from a docs page.
 *
 * `label` is what the user reads before they approve a payment, so it is the
 * chain's public name rather than its CAIP-2 id.
 */
export const CHAINS = {
  8453: {
    chainId: 8453,
    names: ['base', 'eip155:8453'],
    label: 'Base',
    rpcEnv: 'SHUMI_BASE_RPC_URL',
    defaultRpc: 'https://mainnet.base.org',
    explorerTx: 'https://basescan.org/tx/',
  },
  84532: {
    chainId: 84532,
    names: ['base-sepolia', 'eip155:84532'],
    label: 'Base Sepolia',
    rpcEnv: 'SHUMI_BASE_SEPOLIA_RPC_URL',
    defaultRpc: 'https://sepolia.base.org',
    explorerTx: 'https://sepolia.basescan.org/tx/',
  },
  4663: {
    chainId: 4663,
    names: ['robinhood', 'eip155:4663'],
    label: 'Robinhood Chain',
    rpcEnv: 'SHUMI_ROBINHOOD_RPC_URL',
    defaultRpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorerTx: 'https://robinhoodchain.blockscout.com/tx/',
  },
  46630: {
    chainId: 46630,
    names: ['robinhood-testnet', 'eip155:46630'],
    label: 'Robinhood Chain testnet',
    rpcEnv: 'SHUMI_ROBINHOOD_TESTNET_RPC_URL',
    defaultRpc: 'https://rpc.testnet.chain.robinhood.com',
    explorerTx: 'https://explorer.testnet.chain.robinhood.com/tx/',
  },
};

/**
 * Assets we are willing to pay in, per chain.
 *
 * This table is a safety boundary, not a convenience. The price ceiling and the
 * daily cap are expressed in DOLLARS, but a challenge states an amount in some
 * token's own base units — so converting one to the other requires knowing both
 * the decimals and what the token is worth. Reading `decimals()` from the chain
 * gives the first and never the second.
 *
 * Without this table the CLI asserted "1 token = $1" for whatever asset a server
 * named. A challenge for 0.03 WETH (~$100 at 18 decimals) rendered as "0.03" and
 * passed a $0.10 ceiling unchallenged — and under `--agent` there is no prompt to
 * catch it. That was a regression against the old code, which compared raw base
 * units and blocked it by accident.
 *
 * So: an asset we do not recognise is declined. Adding one is a deliberate act.
 * `decimals` here is authoritative for pricing; the on-chain read is only used to
 * cross-check and to show a balance.
 */
export const KNOWN_ASSETS = {
  8453: { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6, usdPerUnit: 1 } },
  84532: { '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { symbol: 'USDC', decimals: 6, usdPerUnit: 1 } },
  4663: { '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { symbol: 'USDG', decimals: 6, usdPerUnit: 1 } },
  46630: { '0x7e955252e15c84f5768b83c41a71f9eba181802f': { symbol: 'USDG', decimals: 6, usdPerUnit: 1 } },
};

/** The known asset record for a chain + address, or null if we do not accept it. */
export function knownAsset(chain, asset) {
  if (!chain || typeof asset !== 'string') return null;
  return KNOWN_ASSETS[chain.chainId]?.[asset.trim().toLowerCase()] || null;
}

/** Resolve whatever the server called the network to a chain we know, or null. */
export function chainForNetwork(network) {
  const n = String(network || '').toLowerCase();
  if (!n) return null;
  for (const chain of Object.values(CHAINS)) {
    if (chain.names.includes(n)) return chain;
  }
  // An unlisted CAIP-2 id is still a well-formed chain reference, but we have no
  // RPC for it and therefore cannot read the token or show a truthful prompt.
  return null;
}

export function rpcUrlFor(chain) {
  return process.env[chain.rpcEnv] || chain.defaultRpc;
}

const clients = new Map();
function clientFor(chain) {
  const url = rpcUrlFor(chain);
  const key = `${chain.chainId}|${url}`;
  if (!clients.has(key)) {
    // No `chain` object passed to viem: we only ever do eth_call reads here, and
    // supplying a chain would mean vendoring a definition for every chain we add.
    clients.set(key, createPublicClient({ transport: http(url) }));
  }
  return clients.get(key);
}

const ERC20_META_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
];

/**
 * Token metadata, memoised per (chain, asset) for the life of the process.
 *
 * Deliberately read from the chain rather than taken from the challenge's
 * `extra.name`: `extra` carries the EIP-712 *domain* name, which is a signing
 * parameter and not a display name — USDG's is "Global Dollar" while its symbol
 * is "USDG". Showing the domain name to a user would be showing them a field
 * that exists for a different purpose.
 */
const metaCache = new Map();
export async function getTokenMeta(chain, asset) {
  const key = `${chain.chainId}|${String(asset).toLowerCase()}`;
  if (metaCache.has(key)) return metaCache.get(key);

  const client = clientFor(chain);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: asset, abi: ERC20_META_ABI, functionName: 'symbol' }),
    client.readContract({ address: asset, abi: ERC20_META_ABI, functionName: 'decimals' }),
  ]);
  const meta = { symbol: String(symbol), decimals: Number(decimals) };
  metaCache.set(key, meta);
  return meta;
}

/** Token balance for an address on a given chain. */
export async function getTokenBalance(chain, asset, address) {
  return clientFor(chain).readContract({
    address: asset,
    abi: ERC20_META_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
}

/** Test seam — drop memoised metadata and RPC clients between cases. */
export function __resetChainCaches() {
  metaCache.clear();
  clients.clear();
}
