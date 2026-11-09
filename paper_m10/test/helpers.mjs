import { loadConfigs } from "../src/config.mjs";

export const T0 = 1_700_000_000_000;
export const RUN = "test-run";

export function identity(chain = "SOL", runId = RUN) {
  return {
    chain,
    chain_id: chain === "SOL" ? "mainnet" : "4663",
    strategy_version: "paper-m10-v1",
    run_id: runId,
  };
}

export function configs() {
  return loadConfigs();
}

export function solCreate(extra = {}) {
  return {
    ...identity(),
    type: "create",
    mint: "MintA",
    name: "Alpha",
    symbol: "ALP",
    creator: "Dev",
    user: "Dev",
    recvTs: T0,
    slot: 10,
    blockNumber: null,
    blockTime: 1_700_000_000,
    virtualSol: 30_000_000_000n,
    virtualToken: 1_000_000_000_000_000n,
    realToken: 800_000_000_000_000n,
    totalSupply: 1_000_000_000_000_000n,
    solUsd: 100,
    ...extra,
  };
}

export function solTrade(extra = {}) {
  return {
    ...identity(),
    type: "trade",
    mint: "MintA",
    recvTs: T0 + 30_000,
    slot: 11,
    blockNumber: null,
    blockTime: 1_700_000_030,
    signer: "Buyer",
    funder: null,
    side: "buy",
    solLamports: 1_000_000_000n,
    tokenRaw: 1_000_000_000_000n,
    virtualSol: 31_000_000_000n,
    virtualToken: 990_000_000_000_000n,
    realSol: 1_000_000_000n,
    realToken: 790_000_000_000_000n,
    venue: "pump",
    quoteIsSol: true,
    solUsd: 100,
    solUsdAt: T0 + 30_000,
    signature: "sig",
    ...extra,
  };
}

export function watch(mint, recvTs, chain = "SOL") {
  return { ...identity(chain), type: "watch", mint, recvTs };
}
