#!/usr/bin/env bash
# Live smoke test for shumi-cli against a deployed coinrotator-ai instance.
#
# Usage:
#   SHUMI_TOKEN=shumi_sk_xxx ./tests/smoke-live.sh
#
# Override:
#   SHUMI_API_URL=...              # default: https://coinrotator-ai.onrender.com/api/cli
#   SHUMI_BIN=/path/to/shumi       # default: node bin/shumi.js (relative to repo root)
#   SMOKE_SYMBOL=ETH               # default: BTC (for single-symbol probes)
#   SMOKE_WATCH=0                  # set to 0 to skip the streaming check
#   SMOKE_NLP=1                    # set to 1 to also exercise `shumi ask`
#
# Exits non-zero if any check fails. Prints PASS/FAIL per check with timing.

set -uo pipefail

# ─── Setup ────────────────────────────────────────────────────────────────
if [[ -z "${SHUMI_TOKEN:-}" ]]; then
  echo "✗ SHUMI_TOKEN is required. Get one with: shumi keys create smoke" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SHUMI_BIN_DEFAULT="node $REPO_ROOT/bin/shumi.js"
SHUMI_BIN="${SHUMI_BIN:-$SHUMI_BIN_DEFAULT}"
SHUMI_API_URL="${SHUMI_API_URL:-https://coinrotator-ai.onrender.com/api/cli}"
SMOKE_SYMBOL="${SMOKE_SYMBOL:-BTC}"
SMOKE_WATCH="${SMOKE_WATCH:-1}"
SMOKE_NLP="${SMOKE_NLP:-0}"

export SHUMI_API_URL SHUMI_TOKEN
export SHUMI_NO_UPDATE_NOTIFIER=1

PASS=0
FAIL=0
FAILED_CHECKS=()

# ─── Helpers ──────────────────────────────────────────────────────────────
# run_check <name> <expected-shape: envelope|ndjson|raw> <command...>
run_check() {
  local name="$1"; shift
  local expect="$1"; shift
  local start_ms end_ms elapsed_ms output exit_code

  start_ms=$(python3 -c 'import time;print(int(time.time()*1000))')
  output=$("$@" 2>&1)
  exit_code=$?
  end_ms=$(python3 -c 'import time;print(int(time.time()*1000))')
  elapsed_ms=$((end_ms - start_ms))

  local status="PASS"
  local reason=""
  if [[ $exit_code -ne 0 ]]; then
    status="FAIL"
    reason="exit=$exit_code"
  else
    case "$expect" in
      envelope)
        # First line must be a JSON object with schemaVersion: 1
        if ! echo "$output" | head -n 1 | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    assert d.get('schemaVersion') == 1, f'no schemaVersion=1 (got {d.get(\"schemaVersion\")})'
    if 'error' in d and 'data' not in d:
        raise SystemExit(2)
except Exception as e:
    print(str(e), file=sys.stderr); sys.exit(1)
" >/dev/null 2>&1; then
          status="FAIL"
          reason="bad envelope shape"
        fi
        ;;
      ndjson)
        # Every non-empty line must be a parseable JSON object
        if ! echo "$output" | python3 -c "
import sys, json
for i, line in enumerate(sys.stdin):
    line = line.strip()
    if not line: continue
    json.loads(line)
" >/dev/null 2>&1; then
          status="FAIL"
          reason="bad ndjson"
        fi
        ;;
      raw) : ;;
    esac
  fi

  if [[ "$status" == "PASS" ]]; then
    PASS=$((PASS + 1))
    printf "  \033[32m✓\033[0m %-40s \033[90m%5dms\033[0m\n" "$name" "$elapsed_ms"
  else
    FAIL=$((FAIL + 1))
    FAILED_CHECKS+=("$name — $reason")
    printf "  \033[31m✗\033[0m %-40s \033[90m%5dms\033[0m  \033[31m%s\033[0m\n" "$name" "$elapsed_ms" "$reason"
    # First 3 lines of failed output for debugging
    echo "$output" | head -n 3 | sed 's/^/      /'
  fi
}

shumi() { $SHUMI_BIN "$@"; }

# ─── Run checks ───────────────────────────────────────────────────────────
echo "Live smoke against: $SHUMI_API_URL"
echo "Bin:                $SHUMI_BIN"
echo "Token:              ${SHUMI_TOKEN:0:14}...${SHUMI_TOKEN: -4}"
echo "Symbol:             $SMOKE_SYMBOL"
echo ""

echo "── Meta ────────────────────────────────────"
run_check "doctor"                  envelope   shumi doctor --json
run_check "version"                 envelope   shumi version --json
run_check "commands"                envelope   shumi commands --json
run_check "billing tier"            envelope   shumi billing tier --json

echo ""
echo "── Coin ────────────────────────────────────"
run_check "coin risk (single)"      envelope   shumi coin risk "$SMOKE_SYMBOL" --json
run_check "coin risk (multi)"       envelope   shumi coin risk BTC ETH SOL --json
run_check "coin sentiment"          envelope   shumi coin sentiment "$SMOKE_SYMBOL" --json
run_check "coin lookup"             envelope   shumi coin lookup "$SMOKE_SYMBOL" --json
run_check "coin historical"         envelope   shumi coin historical "$SMOKE_SYMBOL" --json
run_check "coin by-name"            envelope   shumi coin by-name Bitcoin --json

echo ""
echo "── Market ──────────────────────────────────"
run_check "market prices"           envelope   shumi market prices --symbols BTC,ETH,SOL --json
run_check "market global"           envelope   shumi market global --json
run_check "market crossing"         envelope   shumi market crossing --json
run_check "market health"           envelope   shumi market health --json
run_check "market baselines"        envelope   shumi market baselines --symbols BTC,ETH --json

echo ""
echo "── Category / Sentiment / Narratives ──────"
run_check "category list"           envelope   shumi category list --json
run_check "sentiment market"        envelope   shumi sentiment market --json
run_check "sentiment latest (top5)" envelope   shumi sentiment latest --top 5 --json
run_check "sentiment narratives"    envelope   shumi sentiment narratives --json
run_check "narratives (list)"       envelope   shumi narratives --json

echo ""
echo "── Trends / Scan ───────────────────────────"
run_check "trends (default)"        envelope   shumi trends --json --top 10
run_check "trends aligned"          envelope   shumi trends aligned --json --top 10
run_check "scan (limit 10)"         envelope   shumi scan --limit 10 --json

echo ""
echo "── Funding / Regime / Futures ──────────────"
run_check "funding momentum"        envelope   shumi funding momentum --json
run_check "funding momentum/symbol" envelope   shumi funding momentum --symbol "$SMOKE_SYMBOL" --json
run_check "funding alerts"          envelope   shumi funding alerts --json
run_check "regime active"           envelope   shumi regime active --json
run_check "futures state"           envelope   shumi futures state --json
run_check "walkforward signals"     envelope   shumi walkforward signals --json
run_check "pairs suggestions"       envelope   shumi pairs suggestions --json
run_check "pairs delta-neutral"     envelope   shumi pairs delta-neutral --json

echo ""
echo "── Tracking / Other ────────────────────────"
run_check "holders watchlist"       envelope   shumi holders watchlist --json
run_check "wallets watchlist"       envelope   shumi wallets watchlist --json
run_check "transcripts highlights"  envelope   shumi transcripts highlights --json
run_check "basket"                  envelope   shumi basket --json
run_check "signal-quality"          envelope   shumi signal-quality --asset "$SMOKE_SYMBOL" --json

echo ""
echo "── Synthesis / Resolution ──────────────────"
run_check "signal (synth)"          envelope   shumi signal "$SMOKE_SYMBOL" --json
run_check "resolve symbol"          envelope   shumi resolve "$SMOKE_SYMBOL" --json
run_check "resolve fuzzy"           envelope   shumi resolve dogwifhat --json

if [[ "$SMOKE_WATCH" == "1" ]]; then
  echo ""
  echo "── Streaming (this takes ~30s) ─────────────"
  run_check "watch funding (max=2)" ndjson    shumi watch funding --max 2 --interval 10 --json
fi

if [[ "$SMOKE_NLP" == "1" ]]; then
  echo ""
  echo "── NLP (slow path) ─────────────────────────"
  run_check "ask"                   raw        shumi ask "what is BTC's trend right now?"
fi

# ─── Report ───────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo ""
echo "────────────────────────────────────────────"
if [[ $FAIL -eq 0 ]]; then
  printf "\033[32m  ✓ All %d checks passed\033[0m\n" "$TOTAL"
  exit 0
else
  printf "\033[31m  ✗ %d of %d failed\033[0m\n" "$FAIL" "$TOTAL"
  echo ""
  echo "Failed checks:"
  for f in "${FAILED_CHECKS[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
