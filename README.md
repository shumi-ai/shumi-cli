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
| `shumi coin <symbol>` | Coin analysis (trend, bands, sentiment) |
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
| `shumi health` | Service connectivity |

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
| `3` | Rate-limited / billing block |
| `4` | Upstream 4xx |
| `5` | Upstream 5xx |
| `6` | Network / timeout |
| `7` | Internal error |
| `130` | Interrupted (SIGINT) |

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
git tag vX.Y.Z          # must match package.json version
git push --follow-tags  # triggers .github/workflows/publish.yml
```

Full runbook: [CLAUDE.md](CLAUDE.md#releasing--bumping-the-cli-version).

## License

MIT
