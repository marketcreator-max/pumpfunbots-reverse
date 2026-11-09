import { test } from "node:test";
import assert from "node:assert/strict";
import { createPriceFeed } from "../src/price.mjs";
import { hoodEndpoints, POLL_MS, BLOCK_BATCH } from "../src/hood.mjs";
import { openEntry, simulateExit } from "../src/exits.mjs";
import { WalletIndex } from "../src/classify.mjs";
import { configs, solCreate, solTrade, T0 } from "./helpers.mjs";
import { assessRun, durationMs, hoodWindow, shouldRestart, sumGaps } from "../src/watchdog.mjs";
import { redact } from "../src/redact.mjs";
import { args } from "../src/cli.mjs";

test("ten minute soak is 600000 ms and a stall is a missed heartbeat", () => {
  assert.equal(durationMs({ minutes: 10 }), 600_000);
  assert.equal(shouldRestart({ now: 100_000, startedAt: 90_000, heartbeatAt: 95_000 }), false);
  assert.equal(shouldRestart({ now: 200_000, startedAt: 0, heartbeatAt: 100_000 }), true);
  assert.equal(args(["--minutes", "10"]).minutes, "10");
});

test("a run is INVALID when outcome windows or gaps blow the budget", () => {
  assert.equal(assessRun({ decided: 10, incomplete: 6, gapMs: 0, durationMs: 1000 }).valid, false);
  assert.equal(assessRun({ decided: 10, incomplete: 5, gapMs: 0, durationMs: 1000 }).valid, true);
  assert.equal(assessRun({ decided: 4, incomplete: 0, gapMs: 200, durationMs: 1000 }).valid, false);
  assert.equal(sumGaps([{ gapStart: 0, gapEnd: 100 }, { start: 200, end: 250 }]).total, 150);
});

test("HOOD stays near the head and prefers the keyed URL without logging it", () => {
  assert.equal(POLL_MS, 3000);
  assert.ok(BLOCK_BATCH <= 200);
  const jumped = hoodWindow(1, 50_000, 200);
  assert.equal(jumped.to - jumped.from, 200);
  assert.ok(jumped.skipped > 0);
  assert.deepEqual(hoodWindow(null, 10, 200), { from: 10, to: 10, skipped: 0 });
  const previous = process.env.ALCHEMY_API_KEY;
  process.env.ALCHEMY_API_KEY = "supersecretkey12";
  try {
    const urls = hoodEndpoints({ urls: ["https://robinhood.drpc.org"] }, {
      HOOD_RPC_URL: "https://rpc.example.test/hood",
      ALCHEMY_API_KEY: "supersecretkey12",
    });
    assert.equal(urls[0], "https://rpc.example.test/hood");
    assert.match(urls[1], /robinhood-mainnet\.g\.alchemy\.com\/v2\/supersecretkey12/);
    assert.equal(redact(urls[1]).includes("supersecretkey12"), false);
    assert.equal(urls.at(-1), "https://robinhood.drpc.org");
  } finally {
    if (previous == null) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = previous;
  }
});

test("SOL price starts at Coinbase and does not call Pyth", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes("coinbase.com") && String(url).includes("SOL-USD")) {
      return { ok: true, json: async () => ({ data: { amount: "80.5" } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const feed = createPriceFeed({ fetchImpl, logger: { warn() {} } });
  const price = await feed.solUsd();
  feed.stop();
  assert.equal(price.source, "coinbase");
  assert.equal(price.usd, 80.5);
  assert.equal(urls.some((url) => url.includes("pyth")), false);
});

test("an incomplete position is marked at the last price and is not zero", () => {
  const decision = T0 + 600_000;
  const fees = configs().fees;
  const trades = [
    solTrade({ recvTs: decision + 2_000, signature: "fill", virtualSol: 40_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
    solTrade({ recvTs: decision + 20_000, signature: "up", virtualSol: 80_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
  ];
  const entry = openEntry({ trades, decisionRecvTs: decision, delayMs: 2000, fees, chain: "SOL", supplyRaw: 10n ** 15n, decimals: 6 });
  const spec = configs().exits.exits.find((exit) => exit.id === "T30");
  const sim = simulateExit({
    spec,
    trades,
    create: solCreate(),
    entry,
    horizonRecvTs: decision + 3_600_000,
    chain: "SOL",
    walletIndex: new WalletIndex(),
    thresholds: configs().classify,
    supplyRaw: 10n ** 15n,
    decimals: 6,
    fees,
    windowComplete: false,
  });
  assert.equal(sim.incomplete, true);
  assert.equal(sim.reason, "mark");
  assert.notEqual(sim.pnlUsd, 0);
  assert.notEqual(sim.pnlUsd, null);
});
