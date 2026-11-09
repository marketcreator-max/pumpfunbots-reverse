#!/usr/bin/env bash
# Paper-only launcher. It never loads a key and never sends a transaction.
set -euo pipefail
cd "$(dirname "$0")"

HOURS=""
OUT=""
CHAINS="SOL"
FOREGROUND=0
MODE="live"
EXTRA=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --chains) CHAINS="$2"; shift 2 ;;
    --foreground) FOREGROUND=1; shift ;;
    --keep-all) EXTRA+=("--keep-all"); shift ;;
    --replay) MODE="replay"; shift ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

if [[ "$MODE" == "replay" ]]; then
  exec node src/cli.mjs replay --chains "$CHAINS" "${EXTRA[@]}"
fi

if [[ -z "$HOURS" || -z "$OUT" ]]; then
  echo "usage: ./run.sh --hours 3 --out DIR [--chains SOL,HOOD] [--foreground] [--keep-all]" >&2
  exit 2
fi

mkdir -p "$OUT"
export PAPER_M10_CHAINS="$CHAINS"

if [[ "$FOREGROUND" == "1" ]]; then
  exec node src/cli.mjs live --hours "$HOURS" --out "$OUT" --chains "$CHAINS" "${EXTRA[@]}"
fi

if [[ -f "$OUT/engine.pid" ]] && kill -0 "$(cat "$OUT/engine.pid")" 2>/dev/null; then
  echo "already running pid $(cat "$OUT/engine.pid")" >&2
  exit 1
fi

setsid nohup node src/cli.mjs live --hours "$HOURS" --out "$OUT" --chains "$CHAINS" "${EXTRA[@]}" >> "$OUT/engine.log" 2>&1 < /dev/null &
echo $! > "$OUT/engine.pid"
echo "started pid $(cat "$OUT/engine.pid") log $OUT/engine.log chains $CHAINS"
