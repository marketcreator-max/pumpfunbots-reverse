import { test } from "node:test";
import assert from "node:assert/strict";
import { constantProductBuy, constantProductSell, gasUsd } from "../src/fill.mjs";

test("pump buy takes a 1% fee before constant-product impact", () => {
  const fill = constantProductBuy({
    virtualSol: 30_000_000_000n,
    virtualToken: 1_073_000_000_000_000n,
    solLamports: 1_000_000_000n,
    feeBps: 100,
  });
  assert.equal(fill.feeLamports, 10_000_000n);
  assert.equal(fill.tokensOut, 34_277_831_558_567n);
});

test("pump sell takes the fee from the output", () => {
  const fill = constantProductSell({
    virtualSol: 30_000_000_000n,
    virtualToken: 1_073_000_000_000_000n,
    tokenIn: 34_277_831_558_567n,
    feeBps: 100,
  });
  assert.ok(fill.solOut < fill.gross);
  assert.equal(fill.feeLamports, fill.gross / 100n);
});

test("HOOD gas is gasPrice times 150k gas, priced in ETH", () => {
  const usd = gasUsd({ gasPriceWei: 1_000_000_000n, gasUnits: 150_000, ethUsd: 2000 });
  assert.equal(usd, 0.3);
});
