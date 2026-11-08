# Paper run (graduation sniper)

Offline preload plus a one-hour dry run. Bot files are not modified. The preload throws before any signature or `sendTransaction`, and `lib/config.mjs` does not read a `.env` file (`existsSync` on `.env` is forced false). `RPC_URL` / the derived websocket come only from variables already exported in the shell. The script never prints those values.

`lib/config.mjs` reads `RPC_URL` and `HELIUS_API_KEY`. `WS_URL` is not read; it is `RPC_URL` with `https` swapped to `wss`. `HELIUS_API_KEY` is unused by the bot. If `RPC_URL` is unset, `paper/run.sh` copies `WS_URL`, `HELIUS_RPC_URL`, `HELIUS_API_KEY`, `ALCHEMY_RPC_URL`, `ALCHEMY_URL`, `ALCHEMY_SOLANA_URL`, or `ALCHEMY_API_KEY` into `RPC_URL`.

## 1. Prove the preload offline

```bash
node paper/test-block.cjs
```

Expected last line: `PASS block-send`.

Each of these throws `BLOCKED_SEND` and writes a JSON line `{"event":"BLOCKED_SEND","ts":...}`:

- `VersionedTransaction.prototype.sign`
- `Transaction.prototype.sign`
- `Connection.prototype.sendRawTransaction`
- `Connection.prototype.sendEncodedTransaction`
- `Connection.prototype.sendTransaction`
- HTTP POST to `*.block-engine.jito.wtf` and `bundles.jito.wtf` (`fetch`, `http.request`, `https.request`)

No RPC call is made.

## 2. One-hour paper run

Export the endpoint in the shell first. Do not put it in `.env`.

```bash
export RPC_URL='https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'
# or: export HELIUS_API_KEY='YOUR_KEY'
# or: export ALCHEMY_API_KEY='YOUR_KEY'
bash paper/run.sh
```

`paper/run.sh` sets `TIP_SOL=0`, passes `--dry-run`, sets `NODE_OPTIONS=--require .../paper/block-send.cjs`, and stops the process after 3600 seconds (`timeout --signal=INT`). A zero-funds key file must already exist at `keys/default.json` because the bot loads it before the dry-run branch. The preload still refuses to sign that key.

Outputs:

- `paper/out/run-<UTC stamp>.log` — bot stdout, passed through `paper/redact.py` so exported URL values and `api-key=` query strings are removed
- `paper/out/decisions.jsonl` — one JSON object per graduation signal, buy, sell, and graduated hold: `mint`, `ts_ms`, `event`, `price_sol`, `mc` (null; the bot does not log market cap)

## 3. Collect prices

In a second terminal, while the paper run is writing decisions. This process only calls `getAccountInfo` and a public SOL/USD price GET. It does not load a key or sign.

```bash
node paper/collect_prices.mjs
```

For each `buy` in `paper/out/decisions.jsonl` it polls the pump.fun bonding curve once a second for 60 minutes (the PumpSwap canonical pool after the curve is complete). SOL/USD comes from the Jupiter price API, cached 10 seconds, and falls back to the Pyth SOL/USD account on the same RPC. `RPC_URL` or `HELIUS_*` / `ALCHEMY_*` must already be exported. The URL and key are not printed.

`paper/out/prices.csv` columns: `mint,ts_ms,price_sol,price_usd,quote_reserve,base_reserve`. Reserves are SOL and tokens (virtual reserves on the curve, vault balances on PumpSwap).

## 4. Score

```bash
python3 paper/score.py paper/out/decisions.jsonl paper/out/prices.csv \
  -o paper/out/score.md \
  --json paper/out/score.json
```

Rules:

- $100 notional per buy decision
- fill at the print nearest to decision+2s, falling back to the nearest print within 3s; otherwise the trade is unfilled
- the `pnl_usd_+3s` column repeats the score with decision+3s
- 0.5% fee each side
- when `price_sol` and reserves are present, $100 is converted to SOL and the constant-product impact is taken from those reserves; a CSV with no `price_sol` still treats `quote_reserve` as USD
- bot exit versus `T30` (30% trail from peak), `H10` (hard stop −10%, else 15 min), `TP2x_trail`, `TP5x_trail` (take-profit or the same 30% trail, whichever first), `t5m`, `t15m`
- a rug is any print at or below 0.2× entry inside 15 minutes
- a 2× / 5× runner is any mint whose max print in that window reaches 2× or 5×; the runners table lists all of them
