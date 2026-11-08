#!/usr/bin/env bash
# One-hour paper run of the graduation sniper.
# Does not modify bot code. Requires RPC_URL or a HELIUS_*/ALCHEMY_* var
# already exported. Values are never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p paper/out

export TIP_SOL=0

# lib/config.mjs reads RPC_URL only. WS_URL is derived there by swapping the
# scheme. HELIUS_API_KEY is loaded and unused. ALCHEMY_* is not in config, so
# copy a URL or key into RPC_URL here. Never print the values.
if [[ -z "${RPC_URL:-}" ]]; then
  if [[ -n "${WS_URL:-}" ]]; then
    RPC_URL="${WS_URL/#wss:\/\//https://}"
    RPC_URL="${RPC_URL/#ws:\/\//http://}"
  elif [[ -n "${HELIUS_RPC_URL:-}" ]]; then
    RPC_URL="$HELIUS_RPC_URL"
  elif [[ -n "${HELIUS_API_KEY:-}" ]]; then
    RPC_URL="https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}"
  elif [[ -n "${ALCHEMY_RPC_URL:-}" ]]; then
    RPC_URL="$ALCHEMY_RPC_URL"
  elif [[ -n "${ALCHEMY_URL:-}" ]]; then
    RPC_URL="$ALCHEMY_URL"
  elif [[ -n "${ALCHEMY_SOLANA_URL:-}" ]]; then
    RPC_URL="$ALCHEMY_SOLANA_URL"
  elif [[ -n "${ALCHEMY_API_KEY:-}" ]]; then
    RPC_URL="https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}"
  else
    echo "RPC_URL is unset. Export RPC_URL, WS_URL, HELIUS_RPC_URL, HELIUS_API_KEY, ALCHEMY_RPC_URL, ALCHEMY_URL, ALCHEMY_SOLANA_URL, or ALCHEMY_API_KEY." >&2
    echo "Values are not printed." >&2
    exit 2
  fi
  export RPC_URL
fi

if [[ -n "${WS_URL:-}" ]]; then
  derived="${RPC_URL/https:\/\//wss://}"
  derived="${derived/http:\/\//ws://}"
  if [[ "$derived" != "$WS_URL" ]]; then
    echo "warning: WS_URL does not match the websocket lib/config.mjs derives from RPC_URL. The bot uses the derived URL." >&2
  fi
fi

case "${NODE_OPTIONS:-}" in
  *paper/block-send.cjs*) ;;
  *) export NODE_OPTIONS="--require ${ROOT}/paper/block-send.cjs${NODE_OPTIONS:+ ${NODE_OPTIONS}}" ;;
esac

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
log="paper/out/run-${stamp}.log"
dec="paper/out/decisions.jsonl"
: >"$dec"

echo "paper run: --dry-run, TIP_SOL=0, preload on, .env blocked, timeout 3600s"
echo "RPC_URL: set (not printed). WS derived from RPC_URL by lib/config.mjs."
echo "log: ${log}"
echo "decisions: ${dec}"

set +e
timeout --signal=INT 3600 node bots/graduation-sniper/graduation.mjs --dry-run 2>&1 \
  | node paper/capture.mjs "$dec" \
  | python3 -u paper/redact.py \
  | tee "$log"
st=("${PIPESTATUS[@]}")
set -e
rc=${st[0]}
# Capture or redact failing is a real error. 124/130 from timeout are a clean stop.
for i in 1 2 3; do
  if [[ "${st[$i]:-0}" -ne 0 ]]; then
    echo "paper run pipeline failed (part ${i} status ${st[$i]}). See ${log}" >&2
    exit "${st[$i]}"
  fi
done
if [[ "$rc" -eq 124 || "$rc" -eq 130 || "$rc" -eq 0 ]]; then
  echo "paper run finished (status ${rc}). decisions: ${dec}"
  exit 0
fi
echo "paper run failed (status ${rc}). See ${log}" >&2
exit "$rc"
