import { test } from "node:test";
import assert from "node:assert/strict";
import { openEntry, simulateExit } from "../src/exits.mjs";
import { WalletIndex } from "../src/classify.mjs";
import { configs, solCreate, solTrade, T0 } from "./helpers.mjs";

const fees = configs().fees;
const thresholds = configs().classify;

function book() {
  return { walletIndex: new WalletIndex(), create: solCreate() };
}

test("H10 and the 3s fill use later prints than the 2s fill", () => {
  const decision = T0 + 600_000;
  const reserves = { virtualSol: 40_000_000_000n, virtualToken: 1_000_000_000_000_000n };
  const trades = [
    solTrade({ recvTs: decision + 2_000, signature: "fill2", ...reserves }),
    solTrade({ recvTs: decision + 3_500, signature: "fill3", ...reserves }),
    solTrade({ recvTs: decision + 12_000, signature: "h10", virtualSol: 80_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
  ];
  const entry2 = openEntry({ trades, decisionRecvTs: decision, delayMs: 2000, fees, chain: "SOL", supplyRaw: 10n ** 15n, decimals: 6 });
  const entry3 = openEntry({ trades, decisionRecvTs: decision, delayMs: 3000, fees, chain: "SOL", supplyRaw: 10n ** 15n, decimals: 6 });
  assert.equal(entry2.trade.signature, "fill2");
  assert.equal(entry3.trade.signature, "fill3");
  const h10 = configs().exits.exits.find((exit) => exit.id === "H10");
  const sim = simulateExit({
    spec: h10,
    trades,
    create: book().create,
    entry: entry2,
    horizonRecvTs: decision + 3_600_000,
    chain: "SOL",
    walletIndex: new WalletIndex(),
    thresholds,
    supplyRaw: 10n ** 15n,
    decimals: 6,
    fees,
  });
  assert.equal(sim.slices[0].why, "t");
  assert.equal(sim.slices[0].recvTs, decision + 12_000);
});

test("BOT sells on the 1.5x print before the 300s timeout", () => {
  const decision = T0 + 600_000;
  const trades = [
    solTrade({ recvTs: decision + 2_000, signature: "fill", virtualSol: 40_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
    solTrade({ recvTs: decision + 20_000, signature: "pump", virtualSol: 400_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
    solTrade({ recvTs: decision + 400_000, signature: "late", virtualSol: 400_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
  ];
  const entry = openEntry({ trades, decisionRecvTs: decision, delayMs: 2000, fees, chain: "SOL", supplyRaw: 10n ** 15n, decimals: 6 });
  const bot = configs().exits.exits.find((exit) => exit.id === "BOT");
  const sim = simulateExit({
    spec: bot,
    trades,
    create: solCreate(),
    entry,
    horizonRecvTs: decision + 3_600_000,
    chain: "SOL",
    walletIndex: new WalletIndex(),
    thresholds,
    supplyRaw: 10n ** 15n,
    decimals: 6,
    fees,
  });
  assert.equal(sim.slices[0].recvTs, decision + 20_000);
  assert.ok(sim.exitMultiple > 1);
});

test("a new time exit can be added from config without editing the simulator", () => {
  const decision = T0 + 600_000;
  const trades = [
    solTrade({ recvTs: decision + 2_000, signature: "fill", virtualSol: 40_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
    solTrade({ recvTs: decision + 9_000, signature: "t7", virtualSol: 40_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
  ];
  const entry = openEntry({ trades, decisionRecvTs: decision, delayMs: 2000, fees, chain: "SOL", supplyRaw: 10n ** 15n, decimals: 6 });
  const spec = { id: "T7", label: "T7", rules: [{ id: "t", sellPctOfOriginal: 100, when: { kind: "time", sec: 7 } }] };
  const sim = simulateExit({
    spec,
    trades,
    create: solCreate(),
    entry,
    horizonRecvTs: decision + 3_600_000,
    chain: "SOL",
    walletIndex: new WalletIndex(),
    thresholds,
    supplyRaw: 10n ** 15n,
    decimals: 6,
    fees,
  });
  assert.equal(sim.slices[0].recvTs, decision + 9_000);
});
