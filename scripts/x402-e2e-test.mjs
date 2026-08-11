#!/usr/bin/env node
/**
 * x402 end-to-end test harness  —  run with:  node scripts/x402-e2e-test.mjs
 *
 * WHAT IT PROVES
 * --------------
 * It exercises the CLI's real x402 client (`src/lib/x402-client.js` →
 * `fetchWithX402`) against a local mock server that speaks the x402 protocol and
 * acts as its own facilitator: it returns a 402 with USDC-on-Base payment
 * requirements, then — on the retry — CRYPTOGRAPHICALLY VERIFIES the EIP-3009
 * `TransferWithAuthorization` signature the CLI produced (recovers the signer,
 * checks to/value/time-window), exactly like a real facilitator would, minus the
 * on-chain settlement. No real funds, no real network, fully deterministic.
 *
 * WHY IT EXISTS
 * -------------
 * The whole point of the planned `x402` v1 → `@x402/core` v2 migration is to swap
 * the library under `fetchWithX402` without changing behaviour. This harness pins
 * that behaviour: run it on `main` now (baseline = all green), do the migration,
 * run it again. If a signed payment is still accepted (and the guard/rejection
 * paths still fire), the migration didn't break the money path.
 *
 * It tests THREE things:
 *   1. Happy path   — 402 → sign → server verifies the real signature → 200 + receipt
 *   2. Rejection    — server rejects the payment → CLI surfaces a clean PAYMENT_BLOCKED
 *   3. Price guard  — price over the local ceiling → CLI refuses BEFORE signing
 *
 * It needs NO internet and NO funded wallet: a throwaway key is generated, and the
 * mock server also answers the wallet's balance RPC (as $0) so nothing leaves the box.
 */

import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generatePrivateKey,
  privateKeyToAccount,
} from 'viem/accounts'
import { verifyTypedData } from 'viem'

// ── Isolate all CLI state (config, receipts) into a throwaway HOME ────────────
// wallet.js/config.js compute ~/.shumi at module-eval, so HOME must be set BEFORE
// the CLI modules are imported → we use a dynamic import below.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'shumi-x402-test-'))
process.env.HOME = TEST_HOME
process.env.USERPROFILE = TEST_HOME // windows parity

// ── Throwaway signer ─────────────────────────────────────────────────────────
const PRIVATE_KEY = generatePrivateKey()
const account = privateKeyToAccount(PRIVATE_KEY)
const SIGNER = account.address

// Constants the CLI also uses (USDC on Base).
const USDC_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAY_TO = '0x000000000000000000000000000000000000dEaD' // mock treasury
const PRICE_ATOMIC = '5000' // $0.005 (6dp)
const BASE_CHAIN_ID = 8453

// EIP-712 pieces for EIP-3009 TransferWithAuthorization on USDC (Base).
const EIP3009_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: BASE_CHAIN_ID,
  verifyingContract: USDC_ADDRESS_BASE,
}
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

// Build an x402 (v1) payment-requirements object for the "exact" EVM scheme.
function buildRequirements(resource) {
  return {
    scheme: 'exact',
    network: 'base',
    maxAmountRequired: PRICE_ATOMIC,
    resource,
    description: 'x402 e2e test',
    mimeType: 'application/json',
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    asset: USDC_ADDRESS_BASE,
    // exact-evm carries the EIP-712 domain name/version here so the client can
    // sign without an on-chain read.
    extra: { name: EIP3009_DOMAIN.name, version: EIP3009_DOMAIN.version },
  }
}

function b64json(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}
function decodeXPayment(header) {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
}

/**
 * The facilitator check: verify the CLI's payment is a real, valid EIP-3009
 * authorization signed by the wallet, paying the right recipient/amount, in a
 * sane time window. Returns { ok, reason }.
 */
async function verifyPayment(xPaymentHeader, requirements) {
  let decoded
  try {
    decoded = decodeXPayment(xPaymentHeader)
  } catch {
    return { ok: false, reason: 'X-PAYMENT not valid base64 JSON' }
  }
  const auth = decoded?.payload?.authorization
  const signature = decoded?.payload?.signature
  if (!auth || !signature) return { ok: false, reason: 'missing authorization/signature' }

  // Field checks against what we demanded.
  if (auth.to?.toLowerCase() !== requirements.payTo.toLowerCase())
    return { ok: false, reason: `wrong payTo (got ${auth.to})` }
  if (String(auth.value) !== String(requirements.maxAmountRequired))
    return { ok: false, reason: `wrong value (got ${auth.value}, want ${requirements.maxAmountRequired})` }
  const now = Math.floor(Date.now() / 1000)
  if (Number(auth.validAfter) > now) return { ok: false, reason: 'validAfter in the future' }
  if (Number(auth.validBefore) <= now) return { ok: false, reason: 'authorization already expired' }

  // The real crypto: does the signature recover to auth.from over the EIP-3009 domain?
  let valid
  try {
    valid = await verifyTypedData({
      address: auth.from,
      domain: EIP3009_DOMAIN,
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature,
    })
  } catch (e) {
    return { ok: false, reason: `signature verify threw: ${e.shortMessage || e.message}` }
  }
  if (!valid) return { ok: false, reason: 'signature does not recover to authorization.from' }
  if (auth.from.toLowerCase() !== SIGNER.toLowerCase())
    return { ok: false, reason: `signed by unexpected wallet ${auth.from}` }

  return { ok: true, reason: 'valid EIP-3009 authorization' }
}

// ── Mock server: x402 resource + facilitator + a benign Base RPC stub ─────────
let mode = 'accept' // 'accept' | 'reject' — flipped per scenario
let lastVerify = null

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const bodyRaw = Buffer.concat(chunks).toString('utf8')

      // Benign JSON-RPC stub so the CLI's USDC balance read resolves to $0
      // without touching the real chain (keeps the test fully offline).
      if (req.url === '/rpc') {
        let method = ''
        try { method = JSON.parse(bodyRaw).method } catch {}
        const result =
          method === 'eth_chainId' ? '0x2105'
          : method === 'eth_call' ? '0x' + '0'.repeat(64) // balanceOf → 0
          : '0x1'
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
        return
      }

      const resource = `http://127.0.0.1:${server.address().port}/paid`
      const requirements = buildRequirements(resource)
      const xPayment = req.headers['x-payment']

      if (!xPayment) {
        // First hit → 402 challenge.
        res.writeHead(402, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ x402Version: 1, accepts: [requirements], error: 'payment required' }))
        return
      }

      // Retry with payment → verify (the facilitator step).
      lastVerify = await verifyPayment(xPayment, requirements)
      if (!lastVerify.ok || mode === 'reject') {
        res.writeHead(402, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          x402Version: 1,
          accepts: [requirements],
          error: mode === 'reject' ? 'facilitator rejected (simulated)' : lastVerify.reason,
        }))
        return
      }
      const settlement = b64json({
        success: true,
        transaction: '0x' + 'ab'.repeat(32),
        network: 'base',
        payer: SIGNER,
      })
      res.writeHead(200, { 'content-type': 'application/json', 'x-payment-response': settlement })
      res.end(JSON.stringify({ ok: true, data: 'the paid secret' }))
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// ── Test runner ──────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  const server = await startServer()
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  // Drive the CLI exactly as production would, but pointed at the mock.
  process.env.SHUMI_X402_PRIVATE_KEY = PRIVATE_KEY
  process.env.SHUMI_AUTO_PAY = '1'              // skip the interactive prompt
  process.env.SHUMI_MAX_PRICE_USDC = '1.00'     // well above the $0.005 price
  process.env.SHUMI_DAILY_USDC_CAP = '100.00'
  process.env.SHUMI_BASE_RPC_URL = `${base}/rpc`
  process.env.SHUMI_NO_TELEMETRY = '1'

  // Import AFTER HOME + env are set (module-eval reads them).
  const { fetchWithX402, consumeLastPaymentMeta } = await import('../src/lib/x402-client.js')

  console.log(`\nx402 e2e — signer ${SIGNER}`)
  console.log(`mock server ${base}  ·  isolated HOME ${TEST_HOME}\n`)

  // ── Scenario 1: happy path ──────────────────────────────────────────────────
  console.log('1) happy path: 402 → sign → facilitator verifies → 200')
  mode = 'accept'; lastVerify = null
  try {
    const resp = await fetchWithX402(`${base}/paid`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const body = await resp.json().catch(() => ({}))
    check('response is 200', resp.status === 200, `got ${resp.status}`)
    check('paid content returned', body?.data === 'the paid secret')
    check('facilitator cryptographically verified the signature', lastVerify?.ok === true, lastVerify?.reason)
    const meta = consumeLastPaymentMeta()
    check('payment meta recorded ($0.005 to payTo)', meta?.amountUsdc === '0.005' && meta?.payTo?.toLowerCase() === PAY_TO.toLowerCase(), JSON.stringify(meta))
  } catch (e) {
    check('happy path did not throw', false, e.message)
  }

  // ── Scenario 2: facilitator rejects the payment ─────────────────────────────
  console.log('\n2) rejection: server rejects payment → clean PAYMENT_BLOCKED')
  mode = 'reject'
  try {
    await fetchWithX402(`${base}/paid`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    check('rejection surfaced as an error', false, 'expected a throw, got success')
  } catch (e) {
    check('threw PAYMENT_BLOCKED', e.category === 'PAYMENT_BLOCKED', `category=${e.category}`)
    check('message mentions server rejection', /reject/i.test(e.message), e.message)
  }

  // ── Scenario 3: price ceiling guard fires BEFORE signing ────────────────────
  console.log('\n3) price guard: price over ceiling → refuse before signing')
  mode = 'accept'; lastVerify = null
  process.env.SHUMI_MAX_PRICE_USDC = '0.001' // below the $0.005 price
  try {
    await fetchWithX402(`${base}/paid`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    check('ceiling blocked the payment', false, 'expected a throw, got success')
  } catch (e) {
    check('threw PAYMENT_BLOCKED on ceiling', e.category === 'PAYMENT_BLOCKED', `category=${e.category}`)
    check('did NOT sign (no facilitator verification ran)', lastVerify === null)
  }
  process.env.SHUMI_MAX_PRICE_USDC = '1.00'

  server.close()
  console.log(`\n${fail === 0 ? '\x1b[32mALL PASS\x1b[0m' : '\x1b[31mFAILURES\x1b[0m'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\x1b[31mharness crashed:\x1b[0m', e)
  process.exit(2)
})
