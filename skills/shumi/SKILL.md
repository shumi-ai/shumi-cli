---
name: shumi
description: "Crypto trade intelligence powered by AI. Use when the user asks about crypto markets, coin analysis, price trends, market sentiment, funding rates, delta-neutral strategies, narratives, category breakdowns, or any crypto trading question. Requires Node.js 18+."
license: MIT
allowed-tools: Bash(shumi *) Bash(npx --yes shumi *) Bash(npx shumi *)
---

# Shumi — Crypto Trade Intelligence

Shumi is an AI-powered crypto analysis engine. It classifies queries, fetches real-time market data from multiple sources, and generates formatted analysis. Use it to answer any crypto market question.

## Invocation Rules

**IMPORTANT:** Always run `shumi` as a simple, standalone command. Do NOT:
- Use `cd` before running shumi — it works from any directory
- Chain commands with `&&`, `||`, or `;`
- Redirect output with `>`, `2>`, or `2>/dev/null`
- Pipe output with `|`
- Wrap in subshells `$(...)` or backticks

Correct: `npx --yes shumi sentiment --coin BTC`
Also correct (if globally installed): `shumi sentiment --coin BTC`
Wrong: `cd /some/path && npx --yes shumi sentiment --coin BTC 2>/dev/null`

## Setup

One free query works without authentication. For continued use:

```bash
shumi login
```

This opens a browser for wallet authentication. Check status with `shumi health`.

## Commands

### Coin Analysis

```bash
shumi coin BTC                    # Full analysis: trend, streak, sentiment
shumi coin ETH --interval 1w     # Weekly interval
shumi coin SOL --history          # With 24h historical comparison
shumi coin BTC --raw              # Raw JSON (structured data for programmatic use)
```

### Market Overview

```bash
shumi market                      # Market health: UP/HODL/DOWN distribution
shumi market --crossing           # Include trend crossing data
shumi market --interval 1w        # Weekly view
```

### Sentiment

```bash
shumi sentiment                   # Overall market sentiment
shumi sentiment --coin BTC        # Sentiment for a specific coin
shumi sentiment --category "AI"   # Sentiment for a category
shumi sentiment --narrative "RWA" # Sentiment for a narrative
```

### Trends

```bash
shumi trends                      # Fresh trends (newly started)
shumi trends --stale              # Stale trends (longest running)
shumi trends --aligned            # Coins aligned across all timeframes
shumi trends --limit 10           # Limit results
```

### Scan / Filter

```bash
shumi scan --trend UP --category "DeFi"    # Uptrending DeFi coins
shumi scan --category "Layer 2"            # Category names are matched forgivingly
shumi scan --mcap-min 100000000            # Market cap > $100M
shumi scan --trend DOWN --limit 5          # Top 5 downtrending
```

### Categories & Narratives

```bash
shumi category                    # All categories
shumi category "DeFi"             # DeFi trend breakdown
shumi narratives                  # All current narratives
shumi narratives "AI"             # AI narrative sentiment
```

### Delta-Neutral (Funding Rate Arbitrage)

```bash
shumi delta-neutral                        # All opportunities
shumi delta-neutral --exchange Hyperliquid # Filter by exchange
shumi delta-neutral --dex-only             # DEX only
shumi delta-neutral --symbol BTC           # Specific coin
```

### Web Search & Tweets

```bash
shumi search "Ethereum ETF approval"      # Web search
shumi search "ETH merge" --answer          # Direct answer instead of results
shumi tweets elonmusk                      # Recent tweets from handle
```

### Free-Form

```bash
shumi ask "Why is HYPE pumping?"           # Any crypto question
shumi ask "Compare SOL vs ETH L2 fees"    # Complex analysis
```

## Using --raw for Structured Data

Add `--raw` to any command to get JSON tool execution results instead of formatted text. Use this when you need to process the data programmatically:

```bash
shumi coin BTC --raw    # Returns: { "steps": [{ "id": "btc", "tool": "getCoinBySymbol", "result": {...} }, ...] }
shumi market --raw      # Returns: { "steps": [{ "id": "health", "tool": "getMarketHealth", "result": {...} }, ...] }
```

The `steps` array contains each tool's raw output with the full data payload.

## Common Options

| Flag | Available On | Description |
|------|-------------|-------------|
| `--raw` | All commands | JSON output instead of markdown |
| `--interval <1d\|1w>` | coin, market, sentiment, trends, scan, category, narratives | Time interval |
| `--limit <n>` | trends, scan, delta-neutral | Max results |

## Error Handling

| Error | Meaning | Action |
|-------|---------|--------|
| "Authentication required" | Free query used up | Run `shumi login` |
| "Rate limit exceeded" | Too many requests | Wait and retry |
| "Authentication failed" | Token expired | Run `shumi login` again |
| Command hangs > 30s | Server processing complex query | Normal for multi-tool queries, wait up to 5 min |

## Tips

- Use `--raw` when you need to extract specific data points from the response
- `shumi ask` accepts any natural language query — use it for questions that don't fit a specific command
- Combine scan filters: `shumi scan --trend UP --category "AI" --mcap-min 100000000 --limit 10`
- `shumi scan` has no exchange filter yet; `--exchange` is refused with an explanation rather than returning spot-only listings
- `shumi health` is a quick way to verify connectivity and auth status
