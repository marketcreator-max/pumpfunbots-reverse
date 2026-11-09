import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreTape } from "../src/score.mjs";
import { configs, identity, solCreate, solTrade, watch, T0 } from "./helpers.mjs";
import { SPIKE, createSocials, spk1Reason } from "../src/spikecalls.mjs";
import { openEntry, simulateExit } from "../src/exits.mjs";
import { WalletIndex } from "../src/classify.mjs";

function burst() {
  const supply = 1_000_000_000_000_000n;
  const reserves = { virtualSol: 300_000_000_000n, virtualToken: supply, realSol: 100_000_000_000n, realToken: supply / 2n };
  const events = [
    solCreate({ totalSupply: supply, ...reserves }),
    watch("MintA", T0 + 600_000),
  ];
  const start = T0 + 30 * 60_000;
  for (let i = 0; i < 100; i++) {
    events.push(solTrade({
      recvTs: start + i * 1000,
      slot: 40 + i,
      signer: `B${i}`,
      side: "buy",
      solLamports: 2_000_000_000n,
      solUsd: 100,
      solUsdAt: start,
      signature: `buy-${i}`,
      ...reserves,
    }));
  }
  for (let i = 0; i < 20; i++) {
    events.push(solTrade({
      recvTs: start + 100_000 + i * 1000,
      slot: 200 + i,
      signer: `S${i}`,
      side: "sell",
      solLamports: 1_000_000_000n,
      solUsd: 100,
      solUsdAt: start,
      signature: `sell-${i}`,
      ...reserves,
    }));
  }
  return { events, reserves, supply, decisionNear: start + 100_000 };
}

test("SPK1 enters once at the first tape pass and SPK2 abstains without chain facts", () => {
  const { events, decisionNear } = burst();
  const result = scoreTape(events, { ...configs(), chain: "SOL", runId: "test-run" });
  const spk1 = result.decisions.find((row) => row.gateId === "SPK1");
  const spk2 = result.decisions.find((row) => row.gateId === "SPK2");
  const spk3 = result.decisions.find((row) => row.gateId === "SPK3");
  assert.equal(spk1.pass, true);
  assert.ok(spk1.decidedAtRecvTs >= decisionNear - 30_000);
  assert.equal(result.decisions.filter((row) => row.gateId === "SPK1" && row.pass).length, 1);
  assert.equal(spk2.pass, false);
  assert.match(spk2.reason, /abstain:authority/);
  assert.equal(spk3.pass, false);
  assert.match(spk3.reason, /abstain/);
  assert.equal(spk1.scope.includes("HOOD"), true);
  assert.deepEqual(spk2.scope, ["SOL"]);
});

test("SPK2 passes when the tape already has revoked authorities and small real holders", () => {
  const { events, reserves } = burst();
  const factAt = T0 + 29 * 60_000;
  events.push({
    ...identity(),
    type: "solFacts",
    mint: "MintA",
    recvTs: factAt,
    abstain: false,
    mintAuthority: null,
    freezeAuthority: null,
    topWalletPct: 0.04,
    top10Pct: 0.2,
  });
  events.push(solTrade({
    recvTs: T0 + 31 * 60_000,
    slot: 900,
    signer: "Late",
    side: "buy",
    solLamports: 2_000_000_000n,
    solUsd: 100,
    solUsdAt: factAt,
    signature: "after-facts",
    ...reserves,
  }));
  const result = scoreTape(events, { ...configs(), chain: "SOL", runId: "test-run" });
  const spk2 = result.decisions.find((row) => row.gateId === "SPK2");
  assert.equal(spk2.pass, true);
  assert.ok(spk2.decidedAtRecvTs >= factAt);
});

test("a low sell ratio and an open mint authority do not pass", () => {
  assert.equal(spk1Reason({
    ageMinutes: 30, liquidityUsd: 9000, volumeH1Usd: 20000, mcUsd: 40000, tradesH1: 120, buysH1: 100, sellsH1: 10, sellRatio: 0.1,
  }), "no_sells");
  const { events, reserves } = burst();
  events.push({
    ...identity(),
    type: "solFacts",
    mint: "MintA",
    recvTs: T0 + 20 * 60_000,
    abstain: false,
    mintAuthority: "StillMinting",
    freezeAuthority: null,
    topWalletPct: 0.01,
    top10Pct: 0.1,
  }, solTrade({
    recvTs: T0 + 32 * 60_000, slot: 901, signer: "Z", side: "buy", solLamports: 2_000_000_000n, solUsd: 100, solUsdAt: T0, signature: "z", ...reserves,
  }));
  const result = scoreTape(events, { ...configs(), chain: "SOL", runId: "test-run" });
  assert.equal(result.decisions.find((row) => row.gateId === "SPK2").pass, false);
  assert.match(result.decisions.find((row) => row.gateId === "SPK2").reason, /mint_authority/);
});

test("HOOD can pass SPK1 and skips the SOL authority gate", () => {
  const id = identity("HOOD");
  const supply = 1_000_000_000_000_000n;
  const events = [{ ...id, type: "create", mint: "0xabc", name: "Hood", symbol: "HD", recvTs: T0, tokenDecimals: 6, totalSupply: supply }];
  const start = T0 + 40 * 60_000;
  for (let i = 0; i < 120; i++) {
    events.push({
      ...id,
      type: "trade",
      mint: "0xabc",
      recvTs: start + i * 1000,
      blockNumber: 10 + i,
      signer: `0x${i}`,
      side: i % 6 === 0 ? "sell" : "buy",
      usd: 200,
      priceUsd: 0.00003,
      quoteUsd: 1,
      quoteDecimals: 6,
      virtualSol: 5_000_000_000n,
      tokenDecimals: 6,
      tokenRaw: 1n,
    });
  }
  const result = scoreTape(events, { ...configs(), chain: "HOOD", runId: "test-run" });
  assert.equal(result.decisions.find((row) => row.gateId === "SPK1").pass, true);
  assert.equal(result.decisions.find((row) => row.gateId === "SPK2").pass, false);
  assert.equal(result.decisions.find((row) => row.gateId === "SPK2").reason, "N/A:authority");
});

test("DexScreener socials are cached, rate-limited, and abstain on failure", async () => {
  const waits = [];
  let calls = 0;
  const socials = createSocials({
    minGapMs: 1000,
    sleep: async (ms) => { waits.push(ms); },
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes("bad")) throw new Error("down");
      return {
        ok: true,
        json: async () => ({ pairs: [{ info: { socials: [{ type: "twitter", url: "https://x.com/a" }], websites: [] } }] }),
      };
    },
  });
  const first = await socials.lookup("MintOk");
  const again = await socials.lookup("MintOk");
  const failed = await socials.lookup("bad");
  assert.equal(first.x, "https://x.com/a");
  assert.equal(first.abstain, false);
  assert.equal(again, first);
  assert.equal(calls, 2);
  assert.equal(failed.abstain, true);
  assert.ok(waits.some((ms) => ms >= 1000));
});

test("more than three overlapping passes each get a $100 entry", () => {
  assert.equal(SPIKE.maxConcurrentPositions, null);
  const events = [];
  const supply = 1_000_000_000_000_000n;
  const reserves = { virtualSol: 500_000_000_000n, virtualToken: supply, realSol: 200_000_000_000n, realToken: supply / 2n };
  for (let n = 0; n < 5; n++) {
    const mint = `Gate${n}`;
    events.push(solCreate({ mint, name: mint, symbol: mint, totalSupply: supply, ...reserves }));
    events.push(solTrade({
      mint, recvTs: T0 + 60_000, slot: 20 + n, signer: `B${n}`,
      solLamports: 200_000_000_000n, solUsd: 100, signature: `vol-${n}`, ...reserves,
    }));
    events.push(watch(mint, T0 + 600_000));
    events.push(solTrade({
      mint, recvTs: T0 + 602_500, slot: 80 + n, signer: `F${n}`,
      solLamports: 1_000_000_000n, solUsd: 100, signature: `gfill-${n}`, ...reserves,
    }));
  }
  for (let n = 0; n < 4; n++) {
    const minted = burst();
    const mint = `Spike${n}`;
    for (const event of minted.events) {
      event.mint = mint;
      if (event.name) event.name = mint;
      if (event.symbol) event.symbol = mint;
    }
    minted.events.push(solTrade({
      mint, recvTs: T0 + 35 * 60_000, slot: 960 + n, signer: "Fill",
      side: "buy", solLamports: 1_000_000_000n, solUsd: 100, solUsdAt: T0,
      signature: `sfill-${n}`, ...minted.reserves,
    }));
    events.push(...minted.events);
  }
  const result = scoreTape(events, { ...configs(), chain: "SOL", runId: "test-run" });
  const g3 = result.scored.filter((row) => row.gateId === "G3" && row.exitId === "H10" && row.delayMs === 2000 && row.filled);
  const spk = result.scored.filter((row) => row.gateId === "SPK1" && row.exitId === "H10" && row.delayMs === 2000 && row.filled);
  assert.equal(new Set(g3.map((row) => row.mint)).size, 5);
  assert.equal(new Set(spk.map((row) => row.mint)).size, 4);
  for (const row of [...g3, ...spk]) assert.equal(row.notionalUsd, 100);
});

test("volume decay uses the 1h tape proxy and the 24h hold stays incomplete", () => {
  const decision = T0 + 600_000;
  const fees = configs().fees;
  const trades = [
    solTrade({ recvTs: decision + 2_000, signature: "fill", virtualSol: 40_000_000_000n, virtualToken: 1_000_000_000_000_000n, solLamports: 5_000_000_000n }),
  ];
  for (let i = 0; i < 20; i++) {
    trades.push(solTrade({
      recvTs: decision + 60_000 + i * 1000,
      signature: `hot-${i}`,
      side: "buy",
      solLamports: 1_000_000_000n,
      virtualSol: 40_000_000_000n,
      virtualToken: 1_000_000_000_000_000n,
    }));
  }
  trades.push(solTrade({
    recvTs: decision + 40 * 60_000,
    signature: "quiet",
    side: "buy",
    solLamports: 1_000_000n,
    virtualSol: 40_000_000_000n,
    virtualToken: 1_000_000_000_000_000n,
  }));
  const entry = openEntry({ trades, decisionRecvTs: decision, delayMs: 2000, fees, chain: "SOL", supplyRaw: 10n ** 15n, decimals: 6 });
  const exits = configs().exits.exits;
  const vol = exits.find((exit) => exit.id === "SPK_VOL");
  const hold = exits.find((exit) => exit.id === "SPK_HOLD24");
  const common = {
    trades, create: solCreate(), entry, horizonRecvTs: decision + 24 * 3_600_000,
    chain: "SOL", walletIndex: new WalletIndex(), thresholds: configs().classify,
    supplyRaw: 10n ** 15n, decimals: 6, fees, windowComplete: false,
  };
  const decay = simulateExit({ ...common, spec: vol });
  const timed = simulateExit({ ...common, spec: hold });
  assert.equal(decay.reason, "decay");
  assert.equal(timed.incomplete, true);
  assert.equal(timed.reason, "mark");
  assert.notEqual(timed.pnlUsd, 0);
});
