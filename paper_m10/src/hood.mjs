import { identityFor } from "./chain.mjs";
import { addressFromWord, decodeUniswapV3PoolCreated, decodeUniswapV3Swap, decodeUniswapV2Swap, intFromWord, uintFromWord, v3RawPrice, words } from "./abi.mjs";
import { redact } from "./redact.mjs";
import { backoffMs } from "./util.mjs";

export const HOOD_CHAIN_ID = 4663n;
export const HOOD_CHAIN_ID_HEX = "0x1237";
export const POLL_MS = 1500;
export const BLOCK_BATCH = 20;
const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const PV3_SWAP = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
const V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const PINF_SWAP = "0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237";
const SYNC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1";

const QUOTE_SYMBOLS = new Set(["WETH", "aeWETH", "USDC", "USDG", "USDT"]);

export function chainIdMatches(hex) {
  try {
    return BigInt(hex) === HOOD_CHAIN_ID;
  } catch {
    return false;
  }
}

export function blockBatches(fromBlock, toBlock, size = BLOCK_BATCH) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += size) {
    out.push([start, Math.min(toBlock, start + size - 1)]);
  }
  return out;
}

export function parseHoodConfig(raw) {
  if (!raw || raw.chain !== "HOOD" || String(raw.chain_id) !== "4663" || String(raw.chain_id_hex).toLowerCase() !== HOOD_CHAIN_ID_HEX) {
    throw new Error("config/hood_sources.json must declare HOOD chain_id 4663 (eth_chainId 0x1237). Refusing to infer a chain.");
  }
  const quotes = [];
  const seen = new Set();
  for (const quote of raw.quote_tokens_all ?? []) {
    if (!quote?.address || /ethereum/i.test(quote.role ?? "")) continue;
    if (!QUOTE_SYMBOLS.has(quote.symbol)) continue;
    const address = quote.address.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    const eth = quote.symbol === "WETH" || quote.symbol === "aeWETH";
    quotes.push({ address, symbol: quote.symbol, decimals: quote.decimals, usd: eth ? "eth" : "stable" });
  }
  if (quotes.length < 5) {
    throw new Error("HOOD config is missing WETH, aeWETH, USDC, USDG, or USDT. Refusing to price pools without those quotes.");
  }
  const factory = (raw.factories ?? []).find((item) => item.address && (item.event_abis ?? []).some((event) => event.name === "PoolCreated"));
  if (!factory) {
    throw new Error("HOOD adapter has no Uniswap V3 factory address in config/hood_sources.json. Add the PoolCreated factory, then rerun.");
  }
  const urls = (raw.rpc_public ?? []).map((item) => item.url).filter(Boolean);
  if (!urls.length) throw new Error("HOOD config lists no public RPC URLs.");
  const swapTopics = new Set([V2_SWAP, V3_SWAP, PV3_SWAP, V4_SWAP, PINF_SWAP]);
  for (const item of raw.factories ?? []) {
    for (const event of item.event_abis ?? []) {
      if (event.topic0 && /swap/i.test(event.name ?? "")) swapTopics.add(event.topic0.toLowerCase());
    }
  }
  return {
    chainIdHex: HOOD_CHAIN_ID_HEX,
    factory: factory.address.toLowerCase(),
    poolCreatedTopic: "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118",
    swapTopics: [...swapTopics],
    quotes,
    urls,
  };
}

export function quoteOf(poolTokens, quotes) {
  const map = new Map(quotes.map((quote) => [quote.address, quote]));
  const a = map.get(poolTokens.token0.toLowerCase());
  const b = map.get(poolTokens.token1.toLowerCase());
  if (a && !b) return { quote: a, token: poolTokens.token1.toLowerCase(), tokenIsToken0: false };
  if (b && !a) return { quote: b, token: poolTokens.token0.toLowerCase(), tokenIsToken0: true };
  return null;
}

export function v3HumanPrice({ sqrtPriceX96, tokenIsToken0, tokenDecimals, quoteDecimals }) {
  const { num, den } = v3RawPrice(sqrtPriceX96);
  const diff = BigInt(tokenDecimals - quoteDecimals);
  let scaledNum = tokenIsToken0 ? num : den;
  let scaledDen = tokenIsToken0 ? den : num;
  if (diff >= 0n) scaledNum *= 10n ** diff;
  else scaledDen *= 10n ** -diff;
  if (scaledDen === 0n) return null;
  const whole = scaledNum / scaledDen;
  const frac = ((scaledNum % scaledDen) * 10n ** 15n) / scaledDen;
  return Number(whole) + Number(frac) / 1e15;
}

function hexToBig(hex) {
  return BigInt(hex);
}

function v4Amounts(log) {
  const data = words(log.data ?? "0x");
  if (data.length < 2) return null;
  return {
    sender: log.topics?.[2] ? addressFromWord(log.topics[2]) : null,
    amount0: intFromWord(data[0]),
    amount1: intFromWord(data[1]),
    sqrtPriceX96: data[2] ? uintFromWord(data[2]) : null,
  };
}

export function createHoodState() {
  return { pools: new Map(), pendingNames: new Map() };
}

// Pure log application. Minute-10 later uses pool creation block time as recvTs.
export function applyHoodLogs({ logs, state, quotes, blockTimeMs, identity, ethUsd, gasPriceWei, localRecvTs }) {
  const events = [];
  const ordered = [...logs].sort((a, b) => {
    const ba = Number(hexToBig(a.blockNumber ?? "0x0"));
    const bb = Number(hexToBig(b.blockNumber ?? "0x0"));
    if (ba !== bb) return ba - bb;
    return Number(hexToBig(a.logIndex ?? "0x0")) - Number(hexToBig(b.logIndex ?? "0x0"));
  });
  for (const log of ordered) {
    const topic = (log.topics?.[0] ?? "").toLowerCase();
    const blockNumber = Number(hexToBig(log.blockNumber ?? "0x0"));
    const recvTs = blockTimeMs.get(blockNumber) ?? localRecvTs;
    const common = {
      ...identity,
      blockNumber,
      slot: null,
      blockTime: blockTimeMs.has(blockNumber) ? Math.floor(blockTimeMs.get(blockNumber) / 1000) : null,
      recvTs,
      localRecvTs,
      signature: log.transactionHash ?? null,
      ethUsd: ethUsd ?? null,
      gasPriceWei: gasPriceWei ?? null,
      priceAt: localRecvTs,
    };
    if (topic === "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118") {
      const created = decodeUniswapV3PoolCreated(log);
      const side = quoteOf(created, quotes);
      if (!side) continue;
      const pool = created.pool.toLowerCase();
      const info = {
        pool,
        token: side.token,
        quote: side.quote,
        tokenIsToken0: side.tokenIsToken0,
        token0: created.token0.toLowerCase(),
        token1: created.token1.toLowerCase(),
        feeBps: Math.round(created.fee / 100),
        feeTier: created.fee,
        createdRecvTs: recvTs,
        tokenDecimals: 18,
        curve: "v3",
      };
      state.pools.set(pool, info);
      events.push({
        ...common,
        type: "create",
        mint: side.token,
        name: side.token,
        symbol: side.token.slice(0, 8),
        creator: null,
        user: null,
        pool,
        quoteMint: side.quote.address,
        quoteSymbol: side.quote.symbol,
        feeBps: info.feeBps,
        tokenDecimals: 18,
        quoteDecimals: side.quote.decimals,
        totalSupply: null,
        virtualSol: 0n,
        virtualToken: 0n,
      });
      continue;
    }
    const pool = state.pools.get((log.address ?? "").toLowerCase());
    if (!pool) continue;
    if (topic === SYNC) {
      const data = words(log.data ?? "0x");
      pool.reserve0 = uintFromWord(data[0] ?? "0x0");
      pool.reserve1 = uintFromWord(data[1] ?? "0x0");
      continue;
    }
    let side = null;
    let sqrtPrice = null;
    let curve = pool.curve;
    if (topic === V2_SWAP) {
      const swap = decodeUniswapV2Swap(log);
      const tokenIn = pool.tokenIsToken0 ? swap.amount0In : swap.amount1In;
      const tokenOut = pool.tokenIsToken0 ? swap.amount0Out : swap.amount1Out;
      const quoteIn = pool.tokenIsToken0 ? swap.amount1In : swap.amount0In;
      const quoteOut = pool.tokenIsToken0 ? swap.amount1Out : swap.amount0Out;
      const buy = tokenOut > 0n;
      side = { signer: swap.to, side: buy ? "buy" : "sell", tokenRaw: buy ? tokenOut : tokenIn, quoteRaw: buy ? quoteIn : quoteOut };
      curve = "v2";
    } else if (topic === V3_SWAP || topic === PV3_SWAP) {
      const swap = decodeUniswapV3Swap(log);
      const tokenDelta = pool.tokenIsToken0 ? swap.amount0 : swap.amount1;
      const quoteDelta = pool.tokenIsToken0 ? swap.amount1 : swap.amount0;
      const buy = tokenDelta < 0n;
      side = {
        signer: swap.recipient,
        side: buy ? "buy" : "sell",
        tokenRaw: tokenDelta < 0n ? -tokenDelta : tokenDelta,
        quoteRaw: quoteDelta < 0n ? -quoteDelta : quoteDelta,
      };
      sqrtPrice = swap.sqrtPriceX96;
      curve = "v3";
    } else if (topic === V4_SWAP || topic === PINF_SWAP) {
      const swap = v4Amounts(log);
      if (!swap) continue;
      const tokenDelta = pool.tokenIsToken0 ? swap.amount0 : swap.amount1;
      const quoteDelta = pool.tokenIsToken0 ? swap.amount1 : swap.amount0;
      const buy = tokenDelta < 0n;
      side = {
        signer: swap.sender,
        side: buy ? "buy" : "sell",
        tokenRaw: tokenDelta < 0n ? -tokenDelta : tokenDelta,
        quoteRaw: quoteDelta < 0n ? -quoteDelta : quoteDelta,
      };
      sqrtPrice = swap.sqrtPriceX96;
      curve = "v4";
    } else {
      continue;
    }
    const quoteUsd = pool.quote.usd === "stable" ? 1 : ethUsd ?? null;
    const human = sqrtPrice != null
      ? v3HumanPrice({
        sqrtPriceX96: sqrtPrice,
        tokenIsToken0: pool.tokenIsToken0,
        tokenDecimals: pool.tokenDecimals,
        quoteDecimals: pool.quote.decimals,
      })
      : null;
    const priceUsd = human != null && quoteUsd != null ? human * quoteUsd : null;
    const usd = quoteUsd == null ? null : Number(side.quoteRaw) / 10 ** pool.quote.decimals * quoteUsd;
    const quoteReserve = pool.tokenIsToken0 ? pool.reserve1 : pool.reserve0;
    const tokenReserve = pool.tokenIsToken0 ? pool.reserve0 : pool.reserve1;
    events.push({
      ...common,
      type: "trade",
      venue: "hood",
      curve,
      mint: pool.token,
      pool: pool.pool,
      signer: side.signer,
      funder: null,
      side: side.side,
      tokenRaw: side.tokenRaw,
      quoteRaw: side.quoteRaw,
      usd,
      quoteUsd,
      quoteIsSol: false,
      priceUsd,
      quoteDecimals: pool.quote.decimals,
      tokenDecimals: pool.tokenDecimals,
      feeBps: pool.feeBps,
      virtualSol: curve === "v2" && quoteReserve != null ? quoteReserve : 0n,
      virtualToken: curve === "v2" && tokenReserve != null ? tokenReserve : 0n,
      solUsd: null,
    });
  }
  return events;
}

export async function hoodRpc(url, method, params, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json();
  if (body.error) throw new Error(redact(JSON.stringify(body.error)));
  return body.result;
}

export function createHoodClient(urls, { fetchImpl = globalThis.fetch, logger } = {}) {
  let index = 0;
  async function call(method, params) {
    let last = null;
    for (let attempt = 0; attempt < urls.length; attempt++) {
      const url = urls[(index + attempt) % urls.length];
      try {
        const result = await hoodRpc(url, method, params, fetchImpl);
        index = (index + attempt) % urls.length;
        return result;
      } catch (error) {
        last = error;
        logger?.warn(`hood ${method} failed on endpoint ${attempt + 1}/${urls.length}: ${redact(error.message)}`);
      }
    }
    throw last ?? new Error(`hood ${method} failed`);
  }
  return { call };
}

export function hoodEndpoints(config, env = process.env) {
  if (env.HOOD_RPC_URL) return [env.HOOD_RPC_URL];
  return config.urls;
}

export async function assertHoodChain(client) {
  const hex = await client.call("eth_chainId", []);
  if (!chainIdMatches(hex)) {
    throw new Error(`HOOD rpc eth_chainId ${hex} is not 0x1237 (4663). Refusing to ingest.`);
  }
  return hex;
}

export async function pollHoodOnce({ client, config, state, fromBlock, toBlock, identity, ethUsd, gasPriceWei, localRecvTs, logger }) {
  const events = [];
  const blockTimeMs = new Map();
  const batches = blockBatches(fromBlock, toBlock);
  for (const [start, end] of batches) {
    const fromHex = "0x" + start.toString(16);
    const toHex = "0x" + end.toString(16);
    const created = await client.call("eth_getLogs", [{
      fromBlock: fromHex,
      toBlock: toHex,
      address: config.factory,
      topics: [config.poolCreatedTopic],
    }]);
    const pools = [...state.pools.keys()];
    let swaps = [];
    if (pools.length) {
      for (let i = 0; i < pools.length; i += 25) {
        const slice = pools.slice(i, i + 25);
        const logs = await client.call("eth_getLogs", [{
          fromBlock: fromHex,
          toBlock: toHex,
          address: slice,
          topics: [config.swapTopics],
        }]);
        swaps = swaps.concat(logs ?? []);
      }
    }
    const logs = [...(created ?? []), ...swaps];
    const blocks = [...new Set(logs.map((log) => log.blockNumber).filter(Boolean))];
    for (const block of blocks) {
      if (blockTimeMs.has(Number(BigInt(block)))) continue;
      try {
        const header = await client.call("eth_getBlockByNumber", [block, false]);
        if (header?.timestamp) blockTimeMs.set(Number(BigInt(block)), Number(BigInt(header.timestamp)) * 1000);
      } catch (error) {
        logger?.warn(`hood block time failed: ${redact(error.message)}`);
      }
    }
    events.push(...applyHoodLogs({ logs, state, quotes: config.quotes, blockTimeMs, identity, ethUsd, gasPriceWei, localRecvTs }));
  }
  await enrichCreates(client, events, state);
  return events;
}

async function enrichCreates(client, events, state) {
  for (const event of events) {
    if (event.type !== "create") continue;
    const pool = state.pools.get(event.pool);
    try {
      const supply = await client.call("eth_call", [{ to: event.mint, data: "0x18160ddd" }, "latest"]);
      if (supply && supply !== "0x") {
        event.totalSupply = BigInt(supply);
        if (pool) pool.totalSupply = event.totalSupply;
      }
    } catch {
      // Supply stays unknown. Market cap is then N/A, not zero.
    }
    try {
      const decoded = await client.call("eth_call", [{ to: event.mint, data: "0x313ce567" }, "latest"]);
      if (decoded && decoded !== "0x") {
        const decimals = Number(BigInt(decoded));
        if (decimals >= 0 && decimals <= 36) {
          event.tokenDecimals = decimals;
          if (pool) pool.tokenDecimals = decimals;
        }
      }
    } catch {
      // Default 18 stands.
    }
  }
}

export function startHoodPoll({ client, config, identity, price, onEvents, logger, intervalMs = POLL_MS }) {
  const state = createHoodState();
  let stopped = false;
  let timer = null;
  let cursor = null;
  const loop = async () => {
    if (stopped) return;
    try {
      const headHex = await client.call("eth_blockNumber", []);
      const head = Number(BigInt(headHex));
      if (cursor == null) cursor = Math.max(0, head - BLOCK_BATCH);
      if (head >= cursor) {
        let gasPriceWei = null;
        try {
          gasPriceWei = BigInt(await client.call("eth_gasPrice", [])).toString();
        } catch (error) {
          logger?.warn(`hood gasPrice failed: ${redact(error.message)}`);
        }
        const eth = await price.ethUsd();
        const events = await pollHoodOnce({
          client,
          config,
          state,
          fromBlock: cursor,
          toBlock: head,
          identity,
          ethUsd: eth.usd,
          gasPriceWei,
          localRecvTs: Date.now(),
          logger,
        });
        cursor = head + 1;
        if (events.length) await onEvents(events);
      }
    } catch (error) {
      logger?.warn(`hood poll failed: ${redact(error.message)}`);
    }
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };
  timer = setTimeout(loop, 0);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export { backoffMs };
