# paper_m10

Paper-only research for the minute-10 gate. It reads public chain data and scores exits. It does not build, sign, or send transactions, and it does not hold keys.

`SOL` is Solana mainnet (`chain_id` `mainnet`). `HOOD` is Robinhood Chain (`chain_id` `4663`, `eth_chainId` `0x1237`). Every tape row, decision, wallet row, and report carries `chain`, `chain_id`, `strategy_version`, and `run_id`. A record with no chain is rejected.

## Run

```bash
cd paper_m10
./run.sh --hours 3 --out out/run1 --chains SOL
./run.sh --hours 3 --out out/run1 --chains SOL,HOOD
./run.sh --hours 3 --out out/run1 --chains SOL --foreground
node --test test/*.test.mjs
```

`run.sh` detaches with `setsid` unless `--foreground` is set. SOL uses `RPC_URL` / `WS_URL`, or `HELIUS_API_KEY`, or the public mainnet endpoint, then `wss://solana-rpc.publicnode.com` if that socket drops. Those values are never logged. `api-key=` is stripped from errors. SOL/USD tries Pyth, then Coinbase `SOL-USD`, then Jupiter, and caches the result for 10 seconds.

HOOD polls `eth_getLogs` about every 1.5 seconds. There is no public websocket. Endpoints, in order, come from `config/hood_sources.json`:

- `https://rpc.mainnet.chain.robinhood.com`
- `https://robinhood-rpc.publicnode.com`
- `https://robinhood.drpc.org`

`HOOD_RPC_URL` replaces that list. The process stops the HOOD side if `eth_chainId` is not `0x1237`.

New HOOD pools come from the Uniswap V3 factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` (`PoolCreated`). Swaps are then read from those pools (Uniswap V2, V3, Pancake V3, and the V4 topic). Minute 10 is the pool's block time plus 10 minutes.

Quotes are the HOOD addresses for WETH, aeWETH, USDC, USDG, and USDT. Stables are priced at $1. WETH and aeWETH use ETH/USD from the Coinbase spot price, with DexScreener as the fallback, cached for 10 seconds. A fill pays the pool fee tier plus `gasPrice * 150000` gas.

## Replay

```bash
node src/cli.mjs replay --tape out/run1/SOL/tape.jsonl --out out/replay --chain SOL
```

`--gates` and `--exits` point at replacement JSON. The same tape and configs score to the same report. SOL mints that fail every gate are dropped at minute 10, so a looser gate cannot see their later path. `--keep-all` keeps every mint for the full hour.

## What is scored

Gates `G0`, `G3`, `G3F`, and `G3N` are in `config/gates.json`. Exits are in `config/exits.json` and include the 20 research exits plus the house set: BOT (1.5x / 0.7x / 300s), H10, T30, TP2x+trail, TP5x+trail, 5m, and 15m. Each one is filled at 2 seconds and at 3 seconds.

On HOOD, dev holding and same-slot bundle are `N/A`. They are not filled in with zeros, so `G3F` and `G3N` fail closed.

The report for each chain opens with **Rug bots vs nurture bots**: entry, peak, and dump mixes, coverage, a confusion table, recurring wallets, and three pre-registered testable rules. `wallets.csv` is one row per wallet per token at the minute-10 cutoff. `outcomes.jsonl` is the later RUNNER / RUG / DUD label and is not written into the frozen decision.

## Tests and smoke

```bash
node --test test/*.test.mjs
node src/cli.mjs smoke --seconds 90 --out out/smoke
```

The smoke test uses public RPCs only, even if a keyed URL is set in the environment.
