#!/usr/bin/env bash
# Paper-only supervisor. It starts the engine, restarts it on crash or stall,
# and scores from a separate process when the wall-clock deadline hits.
set -euo pipefail
cd "$(dirname "$0")"

HOURS=""
MINUTES=""
OUT=""
CHAINS="SOL"
FOREGROUND=0
EXTRA=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --minutes) MINUTES="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --chains) CHAINS="$2"; shift 2 ;;
    --foreground) FOREGROUND=1; shift ;;
    --keep-all) EXTRA+=("--keep-all"); shift ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

if [[ -z "$OUT" || ( -z "$HOURS" && -z "$MINUTES" ) ]]; then
  echo "usage: ./run.sh --hours 3 --out DIR [--chains SOL,HOOD] [--minutes 10] [--foreground] [--keep-all]" >&2
  exit 2
fi

mkdir -p "$OUT"
ARGS=(supervise --out "$OUT" --chains "$CHAINS")
if [[ -n "$HOURS" ]]; then ARGS+=(--hours "$HOURS"); fi
if [[ -n "$MINUTES" ]]; then ARGS+=(--minutes "$MINUTES"); fi
ARGS+=("${EXTRA[@]}")

if [[ "$FOREGROUND" == "1" ]]; then
  exec node src/cli.mjs "${ARGS[@]}"
fi

if [[ -f "$OUT/engine.pid" ]] && kill -0 "$(cat "$OUT/engine.pid")" 2>/dev/null; then
  echo "already running pid $(cat "$OUT/engine.pid")" >&2
  exit 1
fi

setsid nohup node src/cli.mjs "${ARGS[@]}" >> "$OUT/engine.log" 2>&1 < /dev/null &
echo $! > "$OUT/engine.pid"
echo "started supervisor pid $(cat "$OUT/engine.pid") log $OUT/engine.log chains $CHAINS"
