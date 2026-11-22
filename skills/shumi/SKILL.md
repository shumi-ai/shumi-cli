---
name: shumi
description: "Crypto research and trade support from the Shumi CLI. Use when the user asks about a coin, the market, trend, funding, sentiment, regime, narratives, categories, token unlocks, delta-neutral funding carry, or wants a trade plan (entry, stop, size) or a check on a coin they hold. Also use when a coin shows no data, an answer looks stale, or Shumi says the session expired. Requires Node.js 22+."
license: MIT
allowed-tools: Bash(shumi *) Bash(npx --yes shumi *) Bash(npx shumi *)
---

# Shumi: crypto research and trade support

Shumi returns structured market readings: trend, funding, sentiment, regime, and
price levels with a trade plan. Use the typed commands below for facts. Use
`shumi ask` only for a question no typed command answers.

## How to run it

- Run `shumi` as one standalone command. No `cd`, no `&&`/`;`, no pipes, no
  redirects, no subshells. It works from any directory.
- Add `--agent` to every call. You get a JSON envelope (`schemaVersion`, `data`,
  `meta`) on stdout and a JSON error envelope on stderr.
- Cut large answers with `--fields <keys>` and `--top <n>`, not with `jq`.
- A response over about 50 KB is written to disk. The envelope then holds a
  preview plus `_spill.path`. Read that file only if the preview lacks what you
  need.
- If `shumi` is not installed, use `npx --yes shumi …` instead.

**Payment warning:** if `SHUMI_X402_PRIVATE_KEY` is set, `--agent` pays priced
queries without a prompt, up to `SHUMI_MAX_PRICE_USDC` per call and
`SHUMI_DAILY_USDC_CAP` per day. Never pass `--auto-pay` or set those variables
yourself. Tell the user before a long run of calls.

## Workflow 1: start of a session

```bash
shumi doctor --agent        # auth, network, CLI version
shumi billing tier --agent  # tier and expiry
```

Only `shumi ask` has a free query without login. Every typed command needs
`shumi login`, which opens a browser. The user must run that step.

## Workflow 2: read one coin

1. **Pin the coin.** Tickers collide and coins migrate. If the user gives a name,
   a contract, or a ticker you are not sure of, run `shumi resolve <query> --agent`
   first. Before you say a coin has no data, resolve it and check for a renamed
   ticker.
2. **Get the verdict.** `shumi signal <SYMBOL> --agent` combines trend, funding,
   sentiment and regime in one call.
   - `verdict` (strong-bull … strong-bear) and `score` (-4 to +4).
   - `coverage` counts how many of the four inputs answered. It does not say
     whether the verdict is right.
   - `evidence` gives the reasons in plain lines.
   - `raw.risk.levels` holds support, resistance, ATR, moving averages, and a
     full plan per side: `plan_long` / `plan_short` with entry zone, stop
     (triggered by a daily close), position size for 1 % account risk, and
     `rr_long` / `rr_short`, `conviction_long` / `conviction_short`.
3. **Go deeper only on the input that matters for the question:**

```bash
shumi coin risk <SYMBOL> --agent             # price, funding, OI, trend, sentiment, BTC correlation, levels
shumi funding momentum --symbol <SYMBOL> --agent
shumi sentiment coin <SYMBOL> --agent
shumi regime history <SYMBOL> --agent
shumi futures history <SYMBOL> --agent
shumi unlocks coin <SYMBOL> --agent          # next unlock, size, recipients
```

Stocks, ETFs, metals, indices and FX perps: `shumi rwa lookup <SYMBOL> --agent`
(also `shumi stock` / `shumi commodity`).

## Workflow 3: check the data before you state it

Each input carries its own time. Read them, and say which one you used.

- `meta.data_age_seconds`: age of the envelope's `as_of`. That stamp comes from
  one input. It is not the oldest input, so check the others too.
- `raw.risk.price_as_of`: the live price.
- `raw.risk.futures_as_of`: funding and open interest.
- `raw.risk.levels.as_of` and `data_age_hours`: levels use the last completed
  daily bar, so they are normally several hours older than the price. That is
  expected, not a fault.

Signs that an input did not land, even when the exit code is 0:

- Any `sources` entry that is not `fulfilled` (the `signal` command).
- A per-symbol `error` inside a multi-symbol `coin risk` answer.
- `raw.risk.price_low_confidence: true`, or `funding_reliable: false`.
- `levels.status` other than `ok`.

Report a missing input as missing. Do not fill the gap from memory.

An empty list from `market crossing`, `funding alerts` or `walkforward` is a
reading: nothing fired. It is not an outage.

## Workflow 4: check several coins or a book

```bash
shumi coin risk BTC ETH SOL --agent                          # one call, one row per coin
shumi market prices --symbols BTC,ETH,SOL --baselines --agent  # price vs 4h / 24h / 7d ago
```

`coin risk` takes symbols, not position sizes. Weight the result by the user's
sizes yourself and say that you did.

## Workflow 5: market backdrop

```bash
shumi market health --agent     # share of coins in UP / HODL / DOWN
shumi market global --agent     # total cap, BTC dominance
shumi regime active --agent
shumi sentiment market --agent  # large: use --fields or read the spill file
shumi brief --agent             # one-screen digest: positions, exits, watch list
```

## Workflow 6: find candidates

```bash
shumi scan --trend UP --category "DeFi" --mcap-min 100000000 --limit 10 --agent
shumi scan --sort change24h --limit 10 --agent        # top 24h gainers
shumi scan --sort change24h --order asc --limit 10 --agent
shumi trends fresh --limit 10 --agent                 # newly started trends
shumi trends stale --limit 10 --agent                 # longest-running trends
shumi trends aligned --agent                          # trend agrees across timeframes
shumi category list --agent
shumi category coins "<name>" --agent
shumi narratives --agent
shumi narratives "<name>" --agent
shumi unlocks calendar --days 14 --insiders --agent   # upcoming supply by % of market cap
```

`scan` has no exchange filter. It refuses `--exchange` with an explanation.
Run `shumi signal` on a candidate before you present it as a setup.

## Workflow 7: "has this worked before?"

Use Shumi's own tracked record. Never ask `shumi ask` to invent a backtest.

```bash
shumi signal-quality --asset <SYMBOL> --agent  # reliability_tier: PRELIMINARY | VALIDATED | INSUFFICIENT_DATA
shumi walkforward outcomes --agent
shumi walkforward positions --agent
shumi futures history <SYMBOL> --agent
shumi pairs history --agent
```

If the tier is `INSUFFICIENT_DATA` or `PRELIMINARY`, say so next to any number
you quote.

## Workflow 8: funding carry and pairs

```bash
shumi pairs delta-neutral --dex-only --limit 10 --agent
shumi pairs delta-neutral --symbol BTC --agent
shumi pairs delta-neutral --exchange Hyperliquid --agent
shumi pairs suggestions --limit 10 --agent
shumi pairs signal --token-a eth --token-b sol --agent
```

State funding as the signed rate (`funding_apr`, positive or negative), not as
which side pays.

## Workflow 9: news, people and free-form questions

```bash
shumi search "<query>" --answer --agent
shumi tweets <handle> --agent
shumi ask "<question>" --agent
```

Use `ask` last, for "why" questions and synthesis the typed commands do not
cover. It is the slowest and costliest call. Multi-tool answers can take
minutes.

## When to stop

Stop when the user's question has an answer backed by fresh inputs. For one coin
that is usually `resolve` (if needed) plus `signal`, plus at most one deeper
call. Each call is metered, so do not fetch inputs the question does not need.

## Not supported yet

Say so plainly instead of improvising:

- Marking an open trade from an entry price or date. There is no price-by-date
  lookup. `market baselines` covers only 4h / 24h / 7d ago.
- Portfolio risk weighted by size, and "what if BTC drops X %" shocks.
  `coin risk` gives BTC correlation, not beta.

## Errors

| Exit | Error code | Meaning | Action |
|------|------------|---------|--------|
| 2 | `AUTH_REQUIRED` | Not logged in, or "Free query used. Sign in to continue" | User runs `shumi login` |
| 2 | `AUTH_EXPIRED` | "Session expired …" | User runs `shumi login` |
| 3 | `RATE_LIMITED` / `PAYMENT_REQUIRED` | Quota or billing block | Tell the user. Do not pay on your own. |
| 1 | `UPGRADE_REQUIRED` | CLI too old for the server | `npm i -g shumi@latest` |
| 4 | `UPSTREAM_4XX` | Not found, for example an unknown symbol | `shumi resolve <query>` |
| 5 / 6 | `UPSTREAM_5XX` / `NETWORK` | Server or network fault | Retry once, then report it |

`shumi commands --agent` lists every command with its output shape.
