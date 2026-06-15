/**
 * x402 client wrapper around `fetch`.
 *
 * Calls the upstream once. If the response isn't 402, returns it untouched.
 * If it is, we:
 *   1. Decode the x402-accepts requirements
 *   2. Enforce the local max-price ceiling (SHUMI_MAX_PRICE_USDC, default $0.10)
 *   3. In interactive mode, prompt the user; in agent / auto-pay mode, proceed
 *   4. Load the signer (env-var key, or passphrase-decrypted keystore)
 *   5. Sign + retry via x402-fetch's `createPaymentHeader`
 *   6. On 200, decode the X-PAYMENT-RESPONSE header and append a receipt
 *
 * Why we don't just use `wrapFetchWithPayment` directly from x402-fetch:
 *   - No interactive prompt — it pays silently on any 402, regardless of cost
 *   - No receipt logging
 *   - No keystore unlock flow — assumes the caller already has a signer
 *   - maxValue default is a constant; we want env-var overridable
 *
 * Most of the heavy crypto (EIP-712 signing, x402 protocol semantics) is
 * delegated to `x402-fetch` and `x402/client` so we don't reimplement EIP-3009.
 */

import { createPaymentHeader, selectPaymentRequirements } from 'x402/client';
import { PaymentRequirementsSchema } from 'x402/types';
import { decodeXPaymentResponse } from 'x402-fetch';
import {
  hasWallet, hasEnvKey, hasKeystore, readKeystoreAddress,
  loadPrivateKey, createX402Signer, getUsdcBalance, appendPaymentReceipt,
  USDC_DECIMALS,
} from './wallet.js';
import { promptYesNo, promptHidden } from './prompt.js';

const X402_VERSION = 1;
const PRICE_CEILING_DEFAULT_USDC = '0.10';
const DECIMALS_BASE = 10n ** BigInt(USDC_DECIMALS);

function isAgentMode() {
  return process.env.SHUMI_AGENT === '1' || process.argv.includes('--agent');
}

function isAutoPay() {
  return process.env.SHUMI_AUTO_PAY === '1' || process.argv.includes('--auto-pay') || isAgentMode();
}

function maxPriceCeilingUsdc() {
  return process.env.SHUMI_MAX_PRICE_USDC || PRICE_CEILING_DEFAULT_USDC;
}

function usdcStringToBaseUnits(usdcStr) {
  const [whole = '0', frac = ''] = String(usdcStr).split('.');
  const padded = (frac + '000000').slice(0, USDC_DECIMALS);
  const combined = (whole === '0' ? '' : whole) + padded;
  return BigInt(combined.replace(/^0+/, '') || '0');
}

function baseUnitsToUsdcString(units) {
  const u = BigInt(units);
  const whole = u / DECIMALS_BASE;
  const frac = (u % DECIMALS_BASE).toString().padStart(USDC_DECIMALS, '0');
  return `${whole}.${frac}`.replace(/\.?0+$/, '');
}

/**
 * Throw an Error with a category code attached, so the CLI's existing
 * exit-codes layer can map it to a clean exit. RATE_LIMITED is what the
 * existing CLI maps to exit 3 — we reuse it for any payment-block reason.
 */
function paymentBlocked(reason, hint) {
  // Embed the hint in the message so renderErr's interactive mode (which only
  // prints message) still shows the actionable next-step. JSON mode also gets
  // it both ways (the hint stays as a structured field on the envelope).
  const fullMessage = hint ? `${reason}\n  → ${hint}` : reason;
  const err = new Error(fullMessage);
  err.category = 'PAYMENT_BLOCKED';
  err.code = 'RATE_LIMITED';
  err.hint = hint;
  err.reason = reason;
  return err;
}

async function selectRequirement(parsedAccepts) {
  // Prefer USDC on Base (exact scheme). x402-fetch's selectPaymentRequirements
  // does the right ordering when given a network filter.
  return selectPaymentRequirements(parsedAccepts, 'base', 'exact');
}

/**
 * Resolve a passphrase for the keystore. In agent / auto-pay-without-keystore
 * mode, throw — non-interactive runs must use SHUMI_X402_PRIVATE_KEY. In
 * interactive mode, prompt the user (passphrase hidden during input).
 */
async function resolvePassphrase() {
  if (hasEnvKey()) return null; // env-var signer doesn't need a passphrase
  if (!hasKeystore()) {
    throw paymentBlocked(
      'No wallet configured.',
      'Run `shumi wallet create`, or set SHUMI_X402_PRIVATE_KEY in your environment.'
    );
  }
  // Cached for the lifetime of THIS process — avoids re-prompting on a follow-up
  // call. We never persist the passphrase across processes (defense in depth).
  if (passphraseCache) return passphraseCache;
  if (isAgentMode()) {
    throw paymentBlocked(
      'Wallet is locked and running in --agent mode.',
      'Set SHUMI_X402_PRIVATE_KEY=0x<key> for non-interactive flows, or unlock interactively first.'
    );
  }
  const pass = await promptHidden('Wallet passphrase: ');
  if (!pass) throw paymentBlocked('No passphrase provided.', 'Try again or set SHUMI_X402_PRIVATE_KEY.');
  passphraseCache = pass;
  return pass;
}

let passphraseCache = null;

/**
 * Format a human-readable challenge prompt:
 *
 *   💸 Shumi needs $0.005 USDC to run `coin/risk/BTC`.
 *      Wallet 0xc624…b394 has $4.83 USDC on Base.
 *      Pay? [Y/n]
 */
function formatChallengePrompt({ priceUsdcStr, route, balanceFormatted, walletAddress }) {
  const trunc = walletAddress ? walletAddress.slice(0, 6) + '…' + walletAddress.slice(-4) : '?';
  return [
    `💸 Shumi needs $${priceUsdcStr} USDC to run \`${route}\`.`,
    `   Wallet ${trunc} has $${balanceFormatted} USDC on Base.`,
    `   Pay? [Y/n] `,
  ].join('\n');
}

/**
 * Intercepted fetch — the core of Phase 2. Same signature as standard fetch
 * so callers in api-client.js can swap with a one-liner.
 *
 * On 200 (or any non-402): returns the first response untouched.
 * On 402: runs the full payment flow. Throws paymentBlocked on user decline /
 * insufficient funds / wallet not configured / max-price exceeded. Throws
 * the second response status on retry failure.
 */
export async function fetchWithX402(input, init = {}) {
  const firstResponse = await fetch(input, init);
  if (firstResponse.status !== 402) return firstResponse;

  // Clone the body — we'll need to retry the same request with X-PAYMENT.
  const challengeBody = await firstResponse.clone().json().catch(() => ({}));
  const accepts = challengeBody?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw paymentBlocked(
      'Server returned 402 without payment requirements.',
      'This is a server-side bug. Run with --raw to see the response and report it.'
    );
  }

  const parsedAccepts = accepts.map((a) => PaymentRequirementsSchema.parse(a));
  const selected = await selectRequirement(parsedAccepts);

  const priceUnits = BigInt(selected.maxAmountRequired);
  const priceUsdcStr = baseUnitsToUsdcString(priceUnits);
  const ceilingUnits = usdcStringToBaseUnits(maxPriceCeilingUsdc());
  if (priceUnits > ceilingUnits) {
    throw paymentBlocked(
      `Price $${priceUsdcStr} exceeds your max ceiling $${maxPriceCeilingUsdc()}.`,
      `Override with: SHUMI_MAX_PRICE_USDC=${priceUsdcStr} <your command>`
    );
  }

  if (!hasWallet()) {
    throw paymentBlocked(
      'No wallet configured.',
      'Run `shumi wallet create`, or set SHUMI_X402_PRIVATE_KEY in your environment.'
    );
  }

  // Get a quick balance read for the prompt + sanity-check.
  const walletAddress = readKeystoreAddress();
  let balanceFormatted = '?';
  let balanceRaw = 0n;
  try {
    const b = await getUsdcBalance(walletAddress);
    balanceFormatted = b.formatted;
    balanceRaw = b.raw;
  } catch {
    // Don't block on RPC hiccup; we'll find out at sign time anyway.
  }

  if (balanceRaw > 0n && balanceRaw < priceUnits) {
    throw paymentBlocked(
      `Insufficient USDC. You have $${balanceFormatted}; need $${priceUsdcStr}.`,
      `Run \`shumi wallet fund\` for an onramp link, or send USDC on Base to ${walletAddress}.`
    );
  }

  // Decide whether to prompt or just go.
  if (!isAutoPay() && !isAgentMode()) {
    const ok = await promptYesNo(formatChallengePrompt({
      priceUsdcStr, route: selected.resource, balanceFormatted, walletAddress,
    }), { defaultYes: true });
    if (!ok) {
      throw paymentBlocked(
        'Declined.',
        `Set --auto-pay to skip the prompt, or subscribe at https://shumi.ai/pricing for unlimited.`
      );
    }
  }

  // Unlock + sign.
  const passphrase = await resolvePassphrase();
  const privateKey = loadPrivateKey({ passphrase });
  const signer = await createX402Signer(privateKey);

  let paymentHeader;
  try {
    paymentHeader = await createPaymentHeader(signer, X402_VERSION, selected);
  } catch (err) {
    throw paymentBlocked(`Signing failed: ${err.message}`, 'Check your wallet has USDC on Base.');
  }

  const retryInit = {
    ...init,
    headers: { ...(init.headers || {}), 'X-PAYMENT': paymentHeader },
  };
  const retryResponse = await fetch(input, retryInit);

  if (retryResponse.status === 402) {
    // Server rejected our payment. Read the body for a reason.
    let reason = '';
    try {
      const b = await retryResponse.clone().json();
      reason = b?.error || '';
    } catch {}
    throw paymentBlocked(
      `Payment was rejected by server${reason ? `: ${reason}` : '.'}`,
      'Try `shumi wallet balance` to verify funds.'
    );
  }

  // Append receipt on success. Failures are silent (best-effort).
  if (retryResponse.ok) {
    const respHeader = retryResponse.headers.get('x-payment-response');
    let tx = null;
    let payer = null;
    if (respHeader) {
      try {
        const decoded = decodeXPaymentResponse(respHeader);
        tx = decoded?.transaction || null;
        payer = decoded?.payer || null;
      } catch {}
    }
    appendPaymentReceipt({
      route: selected.resource,
      amountUsdc: priceUsdcStr,
      tx,
      payer,
      wallet: walletAddress,
    });
    if (!isAgentMode()) {
      const txDisplay = tx ? ` · tx ${tx.slice(0, 10)}…` : '';
      process.stderr.write(`💸 Paid $${priceUsdcStr} USDC${txDisplay}\n`);
    }
  }

  return retryResponse;
}

// Exported for tests
export const __testing = {
  usdcStringToBaseUnits,
  baseUnitsToUsdcString,
  isAutoPay,
  isAgentMode,
  maxPriceCeilingUsdc,
};
