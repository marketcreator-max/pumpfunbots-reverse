import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreTape } from "../src/score.mjs";
import { configs, identity, solCreate, solTrade, watch, T0 } from "./helpers.mjs";

function run(events, chain = "SOL") {
  return scoreTape(events, { ...configs(), chain, runId: "test-run" });
}

test("minute-10 features ignore trades that arrive after the cutoff", () => {
  const early = solTrade({
    recvTs: T0 + 599_000,
    solUsdAt: T0 + 599_000,
    solLamports: 1_000_000_000n,
    signature: "early",
  });
  const late = solTrade({
    recvTs: T0 + 600_001,
    solUsdAt: T0 + 600_001,
    solLamports: 50_000_000_000n,
    signer: "Late",
    signature: "late",
  });
  const base = [solCreate(), early, watch("MintA", T0 + 600_000)];
  const withLate = [...base, late];
  const a = run(base);
  const b = run(withLate);
  const fa = a.features.find((row) => row.minute === 10);
  const fb = b.features.find((row) => row.minute === 10);
  assert.equal(fa.volumeUsd, 100);
  assert.equal(fb.volumeUsd, fa.volumeUsd);
  assert.equal(fb.tradeCount, fa.tradeCount);
  assert.ok(!JSON.stringify(fb).includes("Late"));
});

test("a sell after 60s does not change the 0-60s bot mix", () => {
  const events = [
    solCreate(),
    solTrade({ recvTs: T0 + 1_000, slot: 10, signer: "Snap", solLamports: 2_000_000_000n, tokenRaw: 10_000_000_000_000n, signature: "b1" }),
    solTrade({ recvTs: T0 + 50_000, slot: 12, signer: "Snap", solLamports: 2_000_000_000n, tokenRaw: 10_000_000_000_000n, signature: "b2" }),
    solTrade({ recvTs: T0 + 70_000, slot: 13, signer: "Snap", side: "sell", solLamports: 2_000_000_000n, tokenRaw: 10_000_000_000_000n, signature: "s1" }),
    watch("MintA", T0 + 600_000),
  ];
  const result = run(events);
  const timeline = result.timelines[0];
  assert.equal(timeline.windows["0-60s"].blatantShare, 0);
  assert.equal(timeline.windows["0-60s"].nurtureShare, 100);
  const minute10 = result.features.find((row) => row.minute === 10);
  assert.ok(minute10.blatantShare0_10 > 0);
});

test("G3 passes on mc and volume, and a later mint does not leak into the first decision", () => {
  const supply = 1_000_000_000_000_000n;
  const reserves = { virtualSol: 400_000_000_000n, virtualToken: supply, realToken: supply / 2n };
  const events = [
    solCreate({ totalSupply: supply, ...reserves }),
    solTrade({ recvTs: T0 + 500, slot: 10, signer: "Dev", tokenRaw: 50_000_000_000_000n, solLamports: 1_000_000_000n, signature: "dev", ...reserves }),
    solTrade({ recvTs: T0 + 120_000, slot: 20, signer: "B1", tokenRaw: 40_000_000_000_000n, solLamports: 40_000_000_000n, signature: "b1", ...reserves }),
    solTrade({ recvTs: T0 + 120_000, slot: 20, signer: "B2", tokenRaw: 40_000_000_000_000n, solLamports: 40_000_000_000n, signature: "b2", ...reserves }),
    solTrade({ recvTs: T0 + 120_000, slot: 20, signer: "B3", tokenRaw: 40_000_000_000_000n, solLamports: 50_000_000_000n, signature: "b3", ...reserves }),
    solTrade({ recvTs: T0 + 599_000, slot: 30, signer: "Dev", tokenRaw: 1_000_000_000n, solLamports: 1_000_000_000n, solUsdAt: T0 + 599_000, signature: "dev2", ...reserves }),
    watch("MintA", T0 + 600_000),
    solCreate({ mint: "MintB", name: "Beta", recvTs: T0 + 9_000_000, slot: 90 }),
    solTrade({ mint: "MintB", recvTs: T0 + 9_000_500, slot: 90, signer: "Buyer", signature: "other" }),
    watch("MintB", T0 + 9_600_000),
  ];
  const result = run(events);
  const feature = result.features.find((row) => row.mint === "MintA" && row.minute === 10);
  assert.equal(feature.mcUsd, 40000);
  assert.ok(feature.volumeUsd >= 13000);
  assert.ok(feature.devHoldPct < 10);
  assert.ok(feature.bundlePct < 20);
  assert.ok(feature.top10Pct < 30);
  const gates = Object.fromEntries(result.decisions.filter((row) => row.mint === "MintA").map((row) => [row.gateId, row.pass]));
  assert.equal(gates.G3, true);
  assert.equal(gates.G3F, true);
  const first = result.features.find((row) => row.mint === "MintA" && row.minute === 10);
  assert.equal(first.recurringWallets.length, 0);
  assert.equal(result.decisions.every((row) => row.chain === "SOL" && row.chain_id === "mainnet" && row.strategy_version === "paper-m10-v1" && row.run_id === "test-run"), true);
  assert.equal("outcome" in result.decisions[0], false);
  assert.throws(() => { result.decisions[0].pass = false; }, TypeError);
});

test("HOOD marks dev and bundle N/A and does not invent zeros", () => {
  const id = identity("HOOD");
  const events = [
    { ...id, type: "create", mint: "0xabc", name: "Hood", symbol: "HD", creator: null, recvTs: T0, blockNumber: 5, slot: null, totalSupply: 1_000_000_000_000_000_000n, tokenDecimals: 18 },
    { ...id, type: "trade", mint: "0xabc", recvTs: T0 + 599_000, blockNumber: 9, slot: null, signer: "0x1", side: "buy", usd: 20_000, priceUsd: 0.00004, quoteUsd: 1, tokenRaw: 10n ** 18n, tokenDecimals: 18, solUsdAt: T0 + 599_000, priceAt: T0 + 599_000, blockTime: 1 },
    { ...id, type: "watch", mint: "0xabc", recvTs: T0 + 600_000 },
  ];
  const result = run(events, "HOOD");
  const feature = result.features.find((row) => row.minute === 10);
  assert.equal(feature.devHoldPct, null);
  assert.equal(feature.bundlePct, null);
  assert.ok(feature.naFeatures.includes("devHoldPct"));
  assert.equal(feature.chain, "HOOD");
  assert.equal(feature.chain_id, "4663");
  const g3f = result.decisions.find((row) => row.gateId === "G3F");
  assert.equal(g3f.pass, false);
  assert.match(g3f.reason, /devHoldPct=N\/A/);
  assert.match(g3f.reason, /bundlePct=N\/A/);
});

test("missing chain identity is refused", () => {
  assert.throws(() => scoreTape([{ type: "create", mint: "X", recvTs: 1 }], { ...configs(), chain: "SOL", runId: "test-run" }), /missing chain identity/);
});
