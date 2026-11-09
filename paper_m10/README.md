# paper_m10

Paper-only research for the minute-10 gate. It reads public chain data and scores exits. It does not build, sign, or send transactions, and it does not hold keys.

`SOL` is Solana mainnet (`chain_id` `mainnet`). `HOOD` is Robinhood Chain (`chain_id` `4663`, `eth_chainId` `0x1237`). Every tape row, decision, wallet row, and report carries `chain`, `chain_id`, `strategy_version`, and `run_id`. A record with no chain is rejected.

## Run

```bash
cd paper_m10
./run.sh --hours 3 --out out/run1 --chains SOL
./run.sh --hours 3 --out out/run1 --chains SOL,HOOD
./run.sh --hours 3 --out out/run1 --chains SOL --foreground
./run.sh --minutes 10 --out out/soak --chains SOL,HOOD --foreground
node --test test/*.test.mjs
```

`run.sh` is a supervisor. It detaches with `setsid` unless `--foreground` is set. It restarts the engine if the process dies or the heartbeat file is older than 60 seconds, appending to the same tape and keeping `run_id`. At the wall-clock deadline a separate process scores the tapes and the engine is stopped. `--minutes 10` is the soak.

SOL uses `RPC_URL` / `WS_URL`, or `HELIUS_API_KEY`, or the public mainnet endpoint, then `wss://solana-rpc.publicnode.com` if that socket drops. Twenty seconds of websocket silence forces a reconnect. SOL/USD is the Coinbase spot, with Jupiter v2 as the fallback, cached for 10 seconds. Those URLs are never logged. `api-key=` is stripped from errors.

HOOD polls `eth_getLogs` every 3 seconds, at most 200 blocks behind the head. There is no public websocket. `HOOD_RPC_URL` is first, then Alchemy `robinhood-mainnet.g.alchemy.com` when `ALCHEMY_API_KEY` is set, then:

- `https://rpc.mainnet.chain.robinhood.com`
- `https://robinhood-rpc.publicnode.com`
- `https://robinhood.drpc.org`

HTTP 429s and archive errors back off with jitter. The process stops the HOOD side if `eth_chainId` is not `0x1237`.

New HOOD pools come from the Uniswap V3 factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` (`PoolCreated`). Swaps are then read from those pools (Uniswap V2, V3, Pancake V3, and the V4 topic). Minute 10 is the pool's block time plus 10 minutes.

Quotes are the HOOD addresses for WETH, aeWETH, USDC, USDG, and USDT. Stables are priced at $1. WETH and aeWETH use ETH/USD from the Coinbase spot price, with DexScreener as the fallback, cached for 10 seconds. A fill pays the pool fee tier plus `gasPrice * 150000` gas.

## Replay

```bash
node src/cli.mjs replay --tape out/run1/SOL/tape.jsonl --out out/replay --chain SOL
node src/cli.mjs replay --tape /root/botwatch/m10_server/run3/SOL/tape.jsonl --out out/spk-replay --chain SOL
```

`--gates` and `--exits` point at replacement JSON. The same tape and configs score to the same report. SOL mints that fail every gate are dropped at minute 10, so a looser gate cannot see their later path. `--keep-all` keeps every mint for the full hour.

## What is scored

Gates `G0`, `G3`, `G3F`, `G3N`, and SpikeCalls `SPK1`–`SPK3` are in `config/gates.json`. `SPK4` (the paid Claude score) is not implemented. `SPK1` is tape-only and runs on SOL and HOOD from minute 10 through hour 6, entering once. `SPK2` adds SOL mint, freeze, and real-holder checks and is N/A on HOOD. `SPK3` adds a keyless DexScreener social lookup and abstains if that lookup is missing or fails. Replay never calls RPC or DexScreener; those checks abstain unless the tape already has them.

SpikeCalls exits are `SPK -35% stop`, `SPK half at 2x`, `SPK volume decay` (last-15-minute tape proxy for the 6h/24h pace), and `SPK 24h hold`. The 24-hour hold is marked at the last price and flagged `INCOMPLETE` when the tape ends first.

Gates `G0`, `G3`, `G3F`, and `G3N` stay the minute-10 gates. Exits are in `config/exits.json` and include the 20 research exits plus the house set: BOT (1.5x / 0.7x / 300s), H10, T30, TP2x+trail, TP5x+trail, 5m, and 15m. Each one is filled at 2 seconds and at 3 seconds.

On HOOD, dev holding and same-slot bundle are `N/A`. They are not filled in with zeros, so `G3F` and `G3N` fail closed.

The report for each chain opens with **Rug bots vs nurture bots**: entry, peak, and dump mixes, coverage, a confusion table, recurring wallets, and three pre-registered testable rules. `wallets.csv` is one row per wallet per token at the minute-10 cutoff. `outcomes.jsonl` is the later RUNNER / RUG / DUD label and is not written into the frozen decision.

## Tests and smoke

```bash
node --test test/*.test.mjs
node src/cli.mjs smoke --seconds 90 --out out/smoke
```

The smoke test uses public RPCs only, even if a keyed URL is set in the environment.
