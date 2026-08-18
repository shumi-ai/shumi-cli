/**
 * x402 client wrapper around `fetch`.
 *
 * Calls the upstream once. If the response isn't 402, returns it untouched.
 * If it is, we:
 *   1. Decode the x402-accepts requirements, skipping rows we cannot service
 *   2. Pick a chain (SHUMI_X402_NETWORK pins one; otherwise the server's order)
 *   3. Enforce the local max-price ceiling (SHUMI_MAX_PRICE_USDC, default $0.10)
 *   4. In interactive mode, prompt the user; in agent / auto-pay mode, proceed
 *   5. Load the signer (env-var key, or passphrase-decrypted keystore)
 *   6. Sign the chosen row via @x402/core's client and retry
 *   7. On 200, decode the payment-response header and append a receipt
 *
 * Why we don't just use `wrapFetchWithPayment` directly from x402-fetch:
 *   - No interactive prompt — it pays silently on any 402, regardless of cost
 *   - No receipt logging
 *   - No keystore unlock flow — assumes the caller already has a signer
 *   - maxValue default is a constant; we want env-var overridable
 *
 * Most of the heavy crypto (EIP-712 signing, x402 protocol semantics) is
 * delegated to `@x402/core` + `@x402/evm` so we don't reimplement EIP-3009.
 * Those replaced `x402`/`x402-fetch` v1.2.0, whose network field was a closed
 * 17-entry enum: it could not express a chain like `eip155:4663` at all, and it
 * threw on a challenge containing one instead of ignoring the row.
 */

import { encodePaymentSignatureHeader, decodePaymentResponseHeader } from '@x402/core/http';
import {
  hasWallet, hasEnvKey, hasKeystore, readKeystoreAddress,
  loadPrivateKey, createPaymentClient, balanceOnChain, appendPaymentReceipt,
  sumSpendSinceUtcMidnight,
  USDC_DECIMALS,
} from './wallet.js';
import { chainForNetwork } from './x402-chains.js';
import { promptYesNo, promptHidden } from './prompt.js';
import { capture } from './telemetry.js';

/** Truncate a tx hash / wallet for telemetry — never the full value. */
function truncHash(h) {
  return h && typeof h === 'string' ? `${h.slice(0, 10)}…` : null;
}

function safeCapture(event, props) {
  try { capture(event, props); } catch { /* telemetry must never affect payment */ }
}

const X402_VERSION = 1;
const PRICE_CEILING_DEFAULT_USDC = '0.10';
const DAILY_CAP_DEFAULT_USDC = '1.00';
const DECIMALS_BASE = 10n ** BigInt(USDC_DECIMALS);

/**
 * Last completed payment for this process — surfaced via getLastPaymentMeta()
 * so callers (api-client.js) can merge it into the response envelope. Cleared
 * before every fetch so old meta never leaks into a fetch that didn't pay.
 */
let lastPaymentMeta = null;
export function consumeLastPaymentMeta() {
  const m = lastPaymentMeta;
  lastPaymentMeta = null;
  return m;
}

function isAgentMode() {
  return process.env.SHUMI_AGENT === '1' || process.argv.includes('--agent');
}

function isAutoPay() {
  return process.env.SHUMI_AUTO_PAY === '1' || process.argv.includes('--auto-pay') || isAgentMode();
}

function maxPriceCeilingUsdc() {
  return process.env.SHUMI_MAX_PRICE_USDC || PRICE_CEILING_DEFAULT_USDC;
}

function dailyCapUsdc() {
  return process.env.SHUMI_DAILY_USDC_CAP || DAILY_CAP_DEFAULT_USDC;
}

function usdcStringToBaseUnits(usdcStr) {
  const [whole = '0', frac = ''] = String(usdcStr).split('.');
  const padded = (frac + '000000').slice(0, USDC_DECIMALS);
  const combined = (whole === '0' ? '' : whole) + padded;
  return BigInt(combined.replace(/^0+/, '') || '0');
}

/**
 * Render base units as a decimal string using the TOKEN's decimals.
 *
 * The 402 gives an amount in base units and never says what they are in. USDC
 * and USDG both happen to use 6, but that is a coincidence of two tokens and not
 * a property of the protocol — hard-coding it means the first token with 18
 * decimals renders a price a trillion times too small, in the prompt where the
 * user decides to spend money.
 */
function baseUnitsToAmountString(units, decimals = USDC_DECIMALS) {
  const scale = 10n ** BigInt(decimals);
  const u = BigInt(units);
  const whole = u / scale;
  const frac = (u % scale).toString().padStart(decimals, '0');
  return `${whole}.${frac}`.replace(/\.?0+$/, '');
}

/** Back-compat alias — the ceiling and cap arithmetic still works in 6dp USD. */
function baseUnitsToUsdcString(units) {
  return baseUnitsToAmountString(units, USDC_DECIMALS);
}

/** Ctrl-C at the payment prompt. Distinct from declining: no decision was made. */
function paymentAborted() {
  const err = new Error('Aborted — nothing was charged.');
  err.category = 'PAYMENT_BLOCKED';
  err.code = 'PAYMENT_ABORTED';
  err.reason = 'aborted';
  return err;
}

/**
 * Throw an Error with a category code attached, so the CLI's existing exit-codes
 * layer can map it to a clean exit. The code is PAYMENT_REQUIRED — nothing was
 * rate limited — but it still maps to exit 3, which the README documents as the
 * billing-block code and pins for agent callers.
 */
function paymentBlocked(reason, hint) {
  // Embed the hint in the message so renderErr's interactive mode (which only
  // prints message) still shows the actionable next-step. JSON mode also gets
  // it both ways (the hint stays as a structured field on the envelope).
  const fullMessage = hint ? `${reason}\n  → ${hint}` : reason;
  const err = new Error(fullMessage);
  err.category = 'PAYMENT_BLOCKED';
  // Not RATE_LIMITED: no limit was hit. Declining a payment, or lacking funds, is
  // a user-side condition, and calling it rate limiting sent both readers and
  // exit codes looking for a quota problem that does not exist.
  err.code = 'PAYMENT_REQUIRED';
  err.hint = hint;
  err.reason = reason;
  // Every payment-block path funnels through here, so this is the single
  // chokepoint for payment_declined. `reason` is a short, value-free label.
  safeCapture('payment_declined', { reason });
  return err;
}

/**
 * Which of the offered rows are we actually able to pay?
 *
 * Tolerant on purpose. The previous implementation ran
 * `accepts.map((a) => PaymentRequirementsSchema.parse(a))` against `x402@1.2.0`'s
 * CLOSED network enum, which is all-or-nothing: one row naming a chain outside
 * the enum threw, and the client could then pay on NO row — including the Base
 * row it understood perfectly. Measured before changing it:
 *
 *   accepts = [base]                  → parsed 1, selected base
 *   accepts = [base, eip155:4663]     → THROWS invalid_enum_value
 *
 * So a server adding a chain would have removed the only payment option every
 * installed client had. Skipping rows we cannot service — rather than rejecting
 * the whole challenge — is both the spec-compatible behaviour and the only one
 * that degrades safely.
 */
/** The offered amount, whichever protocol version wrote the row. */
function amountOf(row) {
  return row?.maxAmountRequired ?? row?.amount ?? null;
}

function usableRequirements(accepts) {
  const usable = [];
  const skipped = [];
  for (const row of accepts) {
    if (!row || typeof row !== 'object') { skipped.push('malformed row'); continue; }
    if (row.scheme !== 'exact') { skipped.push(`scheme ${row.scheme}`); continue; }
    // v1 calls the amount `maxAmountRequired`; v2 calls it `amount`. Checking
    // only one silently rejects every row of the other version — which reads as
    // "the server offered nothing I can use", not as a client bug.
    if (!row.network || !row.payTo || !row.asset || amountOf(row) == null) {
      skipped.push(`incomplete row for ${row.network || 'unknown network'}`);
      continue;
    }
    // No RPC for the chain means no honest prompt: we could not read the token's
    // decimals, its symbol, or the wallet's balance there.
    if (!chainForNetwork(row.network)) { skipped.push(`unsupported chain ${row.network}`); continue; }
    usable.push(row);
  }
  return { usable, skipped };
}

/**
 * Pick the row to pay. `SHUMI_X402_NETWORK` lets a user pin a chain — useful
 * when their funds are on one of them and not the other. Otherwise we take the
 * server's own ordering, which puts the most widely supported chain first.
 */
function selectRequirement(usable) {
  const preferred = (process.env.SHUMI_X402_NETWORK || '').trim().toLowerCase();
  if (preferred) {
    const wanted = chainForNetwork(preferred);
    const match = wanted && usable.find((r) => chainForNetwork(r.network)?.chainId === wanted.chainId);
    if (match) return match;
  }
  return usable[0];
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

function truncAddress(addr) {
  return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '?';
}

/**
 * Turn the challenge's `resource` into the command the user actually typed.
 *
 * `resource` is an absolute URL — the x402 v2 spec requires one and the CDP
 * facilitator rejects anything else. Printed raw it read
 * `https://coinrotator-ai.onrender.com/api/cli/coin/risk/DOGE`, which names an
 * internal host and answers a question nobody asked. What the user wants to see
 * before paying is what they are paying for.
 *
 * Falls back to the raw value on an unfamiliar shape — an odd string beats
 * throwing inside a payment prompt.
 */
export function commandLabelFor(resource) {
  let pathname;
  try {
    ({ pathname } = new URL(resource));
  } catch {
    return resource;
  }
  // Anchored to a whole segment. An unanchored /^\/api\/cli\/?/ also matched
  // mid-segment, so /api/climate/x rendered as `shumi mate x` — a confident,
  // wrong command in the one message where the user decides to spend money.
  const match = /^\/api\/cli(?=\/|$)(.*)$/.exec(pathname);
  // An unfamiliar shape means we cannot name the command. SHUMI_API_URL can point
  // anywhere, so this is reachable in normal use — show the raw value rather than
  // inventing a command that does not exist.
  if (!match) return resource;

  const rest = match[1].replace(/^\/+/, '').replace(/\/+$/, '');
  if (!rest) return 'shumi ask';            // the NLP route lives at /api/cli itself
  return `shumi ${decodeURIComponent(rest).split('/').join(' ')}`;
}

/**
 * Format a human-readable challenge prompt. Shows the recipient address +
 * network as an anti-phishing measure — if a compromised server tries to
 * redirect payment to an unexpected address, the user sees it before signing.
 *
 *   💸 Shumi needs $0.005 USDC on base to run `shumi coin risk DOGE`.
 *      From  0xc624…b394 (balance $4.83)
 *      To    0xshumitreasuryaddress…1234
 *      Pay? [Y/n]
 */
function formatChallengePrompt({ priceStr, symbol, route, chainLabel, balanceFormatted, walletAddress, payToAddress }) {
  return [
    `💸 Shumi needs ${priceStr} ${symbol} on ${chainLabel} to run \`${route}\`.`,
    `   From  ${truncAddress(walletAddress)} (balance ${balanceFormatted} ${symbol})`,
    `   To    ${truncAddress(payToAddress)}`,
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
  lastPaymentMeta = null;
  // Tell the server we can read rows outside the frozen v1 network enum. It
  // withholds those rows from clients that do not say this, because an older
  // client that meets one cannot pay on ANY row — see usableRequirements.
  const announced = {
    ...init,
    headers: { ...(init.headers || {}), 'X-X402-Max-Version': '2' },
  };
  const firstResponse = await fetch(input, announced);
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

  const { usable, skipped } = usableRequirements(accepts);
  if (!usable.length) {
    throw paymentBlocked(
      `No payment option this client can use${skipped.length ? ` (offered: ${skipped.join(', ')})` : '.'}`,
      'Upgrade with `npm i -g shumi@latest`, or subscribe at https://shumi.ai/pricing.'
    );
  }
  const selected = selectRequirement(usable);
  // v2 lifts the resource out of the row and onto the challenge body, so read it
  // from whichever place this version put it. It is what the prompt names as the
  // thing being bought, so an empty label here is a prompt that says nothing.
  const resourceUrl = selected.resource || challengeBody?.resource?.url || '';

  // Read decimals from the token itself rather than assuming six, and take the
  // balance on the chain being paid — not on Base, which may not be where the
  // money is going.
  const walletAddress = readKeystoreAddress();
  let onChain = null;
  try {
    onChain = await balanceOnChain(selected.network, selected.asset, walletAddress);
  } catch {
    // An RPC hiccup must not block a payment; we find out at sign time anyway.
  }
  const decimals = onChain?.decimals ?? USDC_DECIMALS;
  const symbol = onChain?.symbol ?? 'USDC';
  const chainLabel = chainForNetwork(selected.network)?.label ?? selected.network;

  const priceUnits = BigInt(amountOf(selected));
  const priceStr = baseUnitsToAmountString(priceUnits, decimals);
  // The ceiling and the daily cap are expressed in dollars, so compare in a
  // single canonical scale rather than in whatever decimals the token uses.
  const priceUsdcStr = priceStr;
  const priceUsdUnits = usdcStringToBaseUnits(priceStr);
  safeCapture('payment_required', {
    amount_usdc: priceUsdcStr,
    network: selected.network,
    route: resourceUrl,
    auto_pay: isAutoPay(),
  });
  const ceilingUnits = usdcStringToBaseUnits(maxPriceCeilingUsdc());
  if (priceUsdUnits > ceilingUnits) {
    throw paymentBlocked(
      `Price $${priceUsdcStr} exceeds your max ceiling $${maxPriceCeilingUsdc()}.`,
      `Override with: SHUMI_MAX_PRICE_USDC=${priceUsdcStr} <your command>`
    );
  }

  // Daily cap: spent-today + this-call must stay under SHUMI_DAILY_USDC_CAP.
  // Protects against an autonomous agent looping calls and burning the wallet.
  // The per-call ceiling above is necessary but not sufficient — at $0.005 a
  // call an agent could still spend $5/min within the ceiling.
  const spentToday = sumSpendSinceUtcMidnight();
  const capUnits = usdcStringToBaseUnits(dailyCapUsdc());
  const spentTodayUnits = usdcStringToBaseUnits(spentToday.toFixed(USDC_DECIMALS));
  if (spentTodayUnits + priceUsdUnits > capUnits) {
    throw paymentBlocked(
      `Daily cap reached: $${spentToday.toFixed(4)} spent + $${priceUsdcStr} would exceed $${dailyCapUsdc()}.`,
      `Raise with: SHUMI_DAILY_USDC_CAP=5.00 <your command>, or wait until UTC midnight.`
    );
  }

  if (!hasWallet()) {
    throw paymentBlocked(
      'No wallet configured.',
      'Run `shumi wallet create`, or set SHUMI_X402_PRIVATE_KEY in your environment.'
    );
  }

  const balanceFormatted = onChain?.formatted ?? '?';
  const balanceRaw = onChain?.raw ?? 0n;

  if (balanceRaw > 0n && balanceRaw < priceUnits) {
    throw paymentBlocked(
      `Insufficient ${symbol} on ${chainLabel}. You have ${balanceFormatted}; need ${priceStr}.`,
      // Name the chain: the funding advice for Base is not the advice for
      // another chain, and "send funds" without saying where is not advice.
      `Send ${symbol} on ${chainLabel} to ${walletAddress}` +
        (chainForNetwork(selected.network)?.chainId === 8453 ? ', or run `shumi wallet fund` for an onramp link.' : '.')
    );
  }

  // Decide whether to prompt or just go.
  if (!isAutoPay() && !isAgentMode()) {
    const answer = await promptYesNo(formatChallengePrompt({
      priceStr,
      symbol,
      route: commandLabelFor(resourceUrl),
      chainLabel,
      balanceFormatted,
      walletAddress,
      payToAddress: selected.payTo,
    }), { defaultYes: true });
    // null means Ctrl-C. Telling someone who aborted that they "Declined"
    // claims a decision they never made, and it is the difference between a
    // choice (exit 1) and an interrupt (exit 130).
    if (answer === null) {
      throw paymentAborted();
    }
    if (!answer) {
      throw paymentBlocked(
        'Payment declined — nothing was charged.',
        `Run with --auto-pay to skip this prompt, or subscribe at https://shumi.ai/pricing for unlimited queries.`
      );
    }
  }

  // Unlock + sign.
  const passphrase = await resolvePassphrase();
  const privateKey = loadPrivateKey({ passphrase });
  const paymentClient = createPaymentClient(privateKey);

  let paymentHeader;
  try {
    // Hand the client a challenge containing only the row we chose, so the
    // signature is unambiguously for that chain and its EIP-712 domain. The
    // version comes from the challenge: our server still speaks v1 for the Base
    // row, and signing a v1 row as v2 produces a payload the server cannot match.
    const payload = await paymentClient.createPaymentPayload({
      x402Version: Number(challengeBody?.x402Version) || X402_VERSION,
      ...(challengeBody?.resource && { resource: challengeBody.resource }),
      accepts: [selected],
    });
    paymentHeader = encodePaymentSignatureHeader(payload);
  } catch (err) {
    throw paymentBlocked(
      `Signing failed: ${err.message}`,
      `Check your wallet holds ${symbol} on ${chainLabel}.`
    );
  }

  const retryInit = {
    ...announced,
    headers: { ...(announced.headers || {}), 'X-PAYMENT': paymentHeader },
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
        const decoded = decodePaymentResponseHeader(respHeader);
        tx = decoded?.transaction || null;
        payer = decoded?.payer || null;
      } catch {}
    }
    appendPaymentReceipt({
      route: resourceUrl,
      amountUsdc: priceUsdcStr,
      tx,
      payer,
      wallet: walletAddress,
    });
    // Surface payment metadata so agent-mode callers can merge it into their
    // JSON envelope (api-client.js does this). Silent in agent mode otherwise
    // would mean a paying agent has no programmatic visibility into spend.
    lastPaymentMeta = {
      amountUsdc: priceUsdcStr,
      asset: symbol,
      route: resourceUrl,
      network: selected.network,
      chain: chainLabel,
      tx,
      payer,
      wallet: walletAddress,
      payTo: selected.payTo,
    };
    safeCapture('payment_completed', {
      amount_usdc: priceUsdcStr,
      network: selected.network,
      route: resourceUrl,
      tx_hash: truncHash(tx),
      wallet_truncated: truncAddress(walletAddress),
    });
    if (!isAgentMode()) {
      const txDisplay = tx ? ` · tx ${tx.slice(0, 10)}…` : '';
      process.stderr.write(`💸 Paid ${priceStr} ${symbol} on ${chainLabel}${txDisplay}\n`);
    }
  }

  return retryResponse;
}

// Exported for tests
export const __testing = {
  usdcStringToBaseUnits,
  baseUnitsToUsdcString,
  baseUnitsToAmountString,
  usableRequirements,
  selectRequirement,
  amountOf,
  isAutoPay,
  isAgentMode,
  maxPriceCeilingUsdc,
  dailyCapUsdc,
  formatChallengePrompt,
  truncAddress,
};
