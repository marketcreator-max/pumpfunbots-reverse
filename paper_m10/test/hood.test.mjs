import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfigs } from "../src/config.mjs";
import { applyHoodLogs, blockBatches, chainIdMatches, createHoodState, parseHoodConfig, v3HumanPrice } from "../src/hood.mjs";
import { eventTopic } from "../src/abi.mjs";
import { identity } from "./helpers.mjs";

const USDC = "0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8";
const TOKEN = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";

function word(value) {
  const hex = typeof value === "bigint" ? value.toString(16) : String(value).toLowerCase().replace(/^0x/, "");
  return "0x" + hex.padStart(64, "0");
}

test("default HOOD config is Robinhood 4663 with the known factory and five quotes", () => {
  const parsed = parseHoodConfig(loadConfigs().hood);
  assert.equal(parsed.chainIdHex, "0x1237");
  assert.equal(parsed.factory, "0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
  assert.deepEqual(parsed.quotes.map((quote) => quote.symbol).sort(), ["USDC", "USDG", "USDT", "WETH", "aeWETH"]);
  assert.equal(parsed.urls[0], "https://rpc.mainnet.chain.robinhood.com");
  assert.equal(parsed.urls[1], "https://robinhood-rpc.publicnode.com");
  assert.equal(parsed.urls[2], "https://robinhood.drpc.org");
  assert.equal(chainIdMatches("0x1237"), true);
  assert.equal(chainIdMatches("0x123f"), false);
  assert.deepEqual(blockBatches(10, 45, 20), [[10, 29], [30, 45]]);
});

test("an empty factory list fails closed", () => {
  const raw = structuredClone(loadConfigs().hood);
  raw.factories = [];
  assert.throws(() => parseHoodConfig(raw), /no Uniswap V3 factory/);
});

test("PoolCreated then a V3 swap becomes a tape row priced from the quote", () => {
  const topic = eventTopic("PoolCreated(address,address,uint24,int24,address)");
  const swapTopic = eventTopic("Swap(address,address,int256,int256,uint160,uint128,int24)");
  const sqrt = (1n << 96n) / 1_000_000n;
  const logs = [
    {
      address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
      blockNumber: "0x10",
      logIndex: "0x1",
      transactionHash: "0xaa",
      topics: [topic, word(TOKEN), word(USDC), word("0xbb8")],
      data: word("0x3c") + word(POOL).slice(2),
    },
    {
      address: POOL,
      blockNumber: "0x11",
      logIndex: "0x2",
      transactionHash: "0xbb",
      topics: [swapTopic, word("0x3333333333333333333333333333333333333333"), word("0x4444444444444444444444444444444444444444")],
      data: [
        word((1n << 256n) - 10n ** 18n),
        word(10n ** 6n),
        word(sqrt),
        word("0x1"),
        word("0x1"),
      ].map((item) => item.slice(2)).join("").replace(/^/, "0x"),
    },
  ];
  const state = createHoodState();
  const quotes = parseHoodConfig(loadConfigs().hood).quotes;
  const events = applyHoodLogs({
    logs,
    state,
    quotes,
    blockTimeMs: new Map([[16, 1_700_000_000_000], [17, 1_700_000_010_000]]),
    identity: identity("HOOD"),
    ethUsd: 2000,
    gasPriceWei: "1000000000",
    localRecvTs: 1_700_000_010_500,
  });
  const create = events.find((event) => event.type === "create");
  const trade = events.find((event) => event.type === "trade");
  assert.equal(create.mint, TOKEN);
  assert.equal(create.recvTs, 1_700_000_000_000);
  assert.equal(create.chain_id, "4663");
  assert.equal(trade.side, "buy");
  assert.equal(trade.signer, "0x4444444444444444444444444444444444444444");
  assert.ok(Math.abs(trade.priceUsd - 1) < 0.01);
  assert.ok(Math.abs(trade.usd - 1) < 0.01);
  const human = v3HumanPrice({ sqrtPriceX96: sqrt, tokenIsToken0: true, tokenDecimals: 18, quoteDecimals: 6 });
  assert.ok(Math.abs(human - 1) < 0.01);
});
