# shumi

Crypto trade intelligence from your terminal. Built for humans **and** AI agents.

```bash
npm install -g shumi
```

## Use Shumi from your AI agent

Shumi is designed to be called by AI agents (Claude Desktop, Cursor, Codex CLI, Aider, opencode, Gemini CLI). Every command supports `--json` output, every command supports `--agent` mode (JSON + no spinner + no color + no update notifier), and stdout auto-switches to JSON when piped — so `shumi coin risk BTC | jq` Just Works™ from inside an agent loop.

```bash
# Tell an agent: "fetch BTC's risk context"
$ shumi coin risk BTC --json | jq .data
{
  "symbol": "BTC",
  "price": 67234.12,
  "funding_apr": 0.0421,
  "trend_daily": "UP",
  "trend_weekly": "UP",
  "sentiment_stance": "bullish",
  "btc_correlation": 1.0
}

# Capability self-discovery
$ shumi commands --json | jq '.commands[].name'

# Health check before a long agent run
$ shumi doctor --json | jq '.data.ok'
```

### Add to your agent

**Claude Code, Cursor, Codex CLI, opencode** — they shell out to anything on `$PATH`. After `npm i -g shumi && shumi login`, prompt your agent: *"Use the `shumi` CLI to fetch the active regime and BTC risk, then summarize."* The agent reads `shumi --help` and `shumi commands --json` to discover the surface; no per-tool wiring required.

**MCP** — `@shumi-ai/mcp` ships the same surface as an MCP server: 31 tools covering prices, trends, funding, sentiment, narratives, regime, signals, pair and delta-neutral ideas, real-world assets, and holder/wallet tracking. Setup is in the [MCP docs](https://docs.shumi.ai/agents/mcp). Reach for it when your client speaks MCP natively; the CLI stays the better fit for anything that shells out.

## Quick start

```bash
# One free query, no account
shumi coin BTC

# Sign in for unlimited
shumi login

# Typed data — deterministic, scriptable
shumi coin risk BTC                       # bundled risk context
shumi funding momentum --symbol BTC       # perpetual funding momentum
shumi regime active                       # active regime positions
shumi signal-quality                      # Sharpe / win-rate envelope
shumi market prices --symbols BTC,ETH,SOL # bulk live prices
shumi billing tier                        # your entitlement

# Or just ask
shumi ask "why is HYPE pumping?"
```

## Commands

### Typed data (deterministic, scriptable, `--json` friendly)

| Command | Endpoint |
|---|---|
| `shumi coin risk <symbol>` | Bundled risk context (price, funding, trend, sentiment, BTC correlation) |
| `shumi funding momentum [--symbol X]` | Funding-rate momentum, market-wide or per coin |
| `shumi regime active\|signals\|history <sym>\|confidence` | Market regime state |
| `shumi signal-quality` | Sharpe, win rate, sample size for the signal layer |
| `shumi market prices [--symbols ...] [--baselines]` | Bulk live prices, optional 4h/24h/7d baselines |

### NLP queries (free-form, AI-routed)

| Command | Description |
|---|---|
| `shumi coin <symbol>` | Coin analysis (trend, sentiment) |
| `shumi market` | Market health overview |
| `shumi sentiment [--coin X\|--category Y\|--narrative Z]` | Sentiment analysis |
| `shumi trends [--fresh\|--stale\|--aligned]` | Trend scanner |
| `shumi scan [filters]` | Filter coins |
| `shumi category [name]` | Category breakdown |
| `shumi narratives [name]` | Emerging narratives |
| `shumi delta-neutral` | Funding-rate arbitrage |
| `shumi tweets <handle>` | Recent tweets |
| `shumi search <query>` | Web search |
| `shumi ask <query>` | Free-form question |

### Meta

| Command | Description |
|---|---|
| `shumi billing tier` | Show entitlement (tier, source, expiry) |
| `shumi doctor` | Diagnostics: auth, network, version |
| `shumi version` | Build info (`--json` returns structured) |
| `shumi commands` | Capability manifest (`--json` for agents) |
| `shumi login\|logout\|whoami` | Wallet auth |
| `shumi keys create\|list\|revoke` | Manage API keys for headless use |
| `shumi wallet create\|balance\|fund` | Local payer wallet for per-query payment (see below) |
| `shumi health` | Service connectivity |

## Paying per query (x402)

When your free quota runs out, priced routes answer `402` with the chains Shumi
accepts payment on, and the CLI can pay the request directly. It signs a gasless
authorization from a local wallet — you never send a transaction yourself and you
never need the chain's gas token.

```bash
shumi wallet create           # one-time: an encrypted local payer wallet
shumi wallet balance          # what it holds
shumi wallet fund             # onramp link (USDC on Base)
```

The first time a query costs money you get a prompt naming the amount, the token,
the chain and the recipient, so a compromised server cannot redirect payment
without you seeing it:

```
💸 Shumi needs 0.05 USDG on Robinhood Chain to run `shumi ask`.
   From  0xD1C8…6f99 (balance 12.00 USDG)
   To    0xc624…b394
   Pay? [Y/n]
```

| Variable | Behavior |
|---|---|
| `SHUMI_X402_PRIVATE_KEY=0x…` | Sign from an env-var key instead of the keystore. **Required** for `--agent` and other non-interactive runs. |
| `SHUMI_X402_NETWORK=<chain>` | Pin which offered chain to pay on (`base`, `robinhood`, …). Otherwise the server's own ordering wins. |
| `SHUMI_MAX_PRICE_USDC=0.10` | Per-call ceiling. A pricier challenge is refused, not paid. |
| `SHUMI_DAILY_USDC_CAP=1.00` | Daily spend cap, so a looping agent cannot drain the wallet. |
| `SHUMI_AUTO_PAY=1` | Skip the prompt (implied by `--agent`). |

### Context guard

Some answers are large — `sentiment market` is close to a megabyte — and in
`--agent` mode that lands straight in a model's context window. Rather than
truncate a response you have already paid for, the CLI writes the **full**
envelope to disk and inlines a shape-preserving preview plus the path:

```json
{ "data": { "verdict": "strong-bull", "raw": { "…": "first few of each list" } },
  "_spill": { "path": "~/.shumi/spill/shumi-….json", "bytes": 938820,
              "preview_is_partial": true,
              "hint": "… read it with a sub-agent or query it with jq …" } }
```

Nothing is lost. The agent decides whether the full file is worth opening, and
can hand it to a sub-agent or `jq` instead of inlining it.

| Variable | Behavior |
|---|---|
| `SHUMI_MAX_OUTPUT_BYTES=50000` | Spill above this size. `0` disables spilling entirely. |
| `SHUMI_SPILL_DIR=~/.shumi/spill` | Where full responses are written. Files older than 24h are pruned. |

Spilling is **on by default only in `--agent` mode**. A plain
`shumi … --json > out.json` is never rewritten — `--json` is auto-enabled for any
non-TTY, so we cannot tell your redirect from an agent's pipe, and corrupting a
file on disk is worse than a large context. Set `SHUMI_MAX_OUTPUT_BYTES` to opt
in anywhere else.

Prices differ per chain, because settlement does: a chain that costs more to
settle on quotes a higher amount, and the prompt always shows the real one.
Receipts are appended to `~/.shumi/payments.log`, one JSON object per line.

## Global flags

| Flag | Behavior |
|---|---|
| `--json` | Force JSON envelope on stdout |
| `--agent` | Machine mode: JSON, no spinner, no color, no update notifier, machine error envelope on stderr |
| `--no-color` | Disable colors (`NO_COLOR=1` env var also honored) |
| `SHUMI_AGENT=1` | Same as `--agent`, but persistent in your shell |
| `SHUMI_NO_UPDATE_NOTIFIER=1` | Suppress the update check |
| `SHUMI_API_URL=<url>` | Override the API endpoint (preview deploys, self-hosting) |
| `SHUMI_TOKEN=shumi_sk_...` | API key for headless / CI use |

## Exit codes

Pinned, documented, AI-agent-safe.

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | User error (bad flags) |
| `2` | Auth required / invalid |
| `3` | Rate-limited / billing block (incl. payment required or declined) |
| `4` | Upstream 4xx |
| `5` | Upstream 5xx |
| `6` | Network / timeout |
| `7` | Internal error |
| `130` | Interrupted (SIGINT), including Ctrl-C at the payment prompt |

## Error envelope

Errors always emit a stable JSON envelope on **stderr**, so `stdout | jq` never breaks:

```json
{
  "schemaVersion": 1,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Authentication required. Run: shumi login"
  }
}
```

`AUTH_EXPIRED` (exit `2`) is distinct from `AUTH_REQUIRED` — the session aged out rather than never existing, and its `details.expiresAt` says when. `UPGRADE_REQUIRED` (exit `1`) means the server refused this client version.

Success envelopes carry `schemaVersion`, `data`, and `meta`. Bump `schemaVersion` on a breaking shape change — pinned clients can detect.

## Authentication

```bash
shumi login           # browser-based wallet auth (Dynamic.xyz)
shumi login --paste   # finish a sign-in whose browser callback failed
shumi keys create     # issue an API key for headless / CI / agent use
```

Set `SHUMI_TOKEN=shumi_sk_...` in environments without a browser. Credentials are stored at `~/.shumi/config.json` (`0600`). Tokens expire and `shumi doctor` will tell you when.

If the browser shows a connection error *after* you signed — the CLI stopped listening before the callback arrived — the token was still issued. Copy that page's URL and run `shumi login --paste`; it is read from a hidden prompt (never a flag, so it stays out of shell history) and verified against the sign-in you started before anything is saved.

### Staying current

Machine consumers can't see the update banner, so a newer version is reported in the JSON envelope itself under `meta.updateAvailable` (on both success and error), and by `shumi doctor`'s `version` check. `SHUMI_NO_UPDATE_NOTIFIER=1` disables the whole thing.

```json
{ "schemaVersion": 1, "data": {}, "meta": { "updateAvailable": { "current": "0.6.2", "latest": "0.7.4", "action": "npm i -g shumi@latest" } } }
```

## Requirements

- Node.js 20+

## Releasing

Releases publish to npm automatically via GitHub Actions OIDC Trusted Publishing
(no token). Bump `version` in `package.json`, then:

```bash
git commit -am "chore(release): shumi-cli X.Y.Z"
git tag -a vX.Y.Z -m "shumi-cli X.Y.Z"   # -a is required, see below
git push --follow-tags                   # triggers .github/workflows/publish.yml
```

The tag must be **annotated** (`-a`). `git push --follow-tags` pushes annotated
tags only and skips lightweight ones **silently** — the commit lands, no tag
reaches the remote, no workflow runs, and nothing reports a failure. That is how
0.7.8 was first "released" without publishing.

Full runbook: [CLAUDE.md](CLAUDE.md#releasing--bumping-the-cli-version).

## License

MIT
