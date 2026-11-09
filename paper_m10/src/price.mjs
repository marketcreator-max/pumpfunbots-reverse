import { PYTH_SOL_USD_ID } from "./constants.mjs";
import { redact } from "./redact.mjs";

const CACHE_MS = 10_000;
const COINBASE_ETH = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
const DEX_ETH = "https://api.dexscreener.com/latest/dex/tokens/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

async function readJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`price http ${response.status}`);
  return response.json();
}

export function createPriceFeed({ fetchImpl = globalThis.fetch, now = () => Date.now(), logger } = {}) {
  const log = logger ?? { warn() {} };
  let sol = null;
  let eth = null;
  let lifetime = new AbortController();
  const signal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(8000)]);

  async function solUsd() {
    if (sol && now() - sol.at < CACHE_MS) return { ...sol, stale: false };
    try {
      const body = await readJson(fetchImpl, `https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x${PYTH_SOL_USD_ID}`, signal());
      const price = body.parsed?.[0]?.price;
      const usd = price ? Number(price.price) * 10 ** Number(price.expo) : NaN;
      if (usd > 0) {
        sol = { usd, at: now(), source: "pyth" };
        return { ...sol, stale: false };
      }
    } catch (error) {
      log.warn(`sol price pyth failed: ${redact(error.message)}`);
    }
    try {
      const body = await readJson(fetchImpl, "https://api.coinbase.com/v2/prices/SOL-USD/spot", signal());
      const usd = Number(body.data?.amount);
      if (usd > 0) {
        sol = { usd, at: now(), source: "coinbase" };
        return { ...sol, stale: false };
      }
    } catch (error) {
      log.warn(`sol price coinbase failed: ${redact(error.message)}`);
    }
    try {
      const body = await readJson(fetchImpl, "https://lite-api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112", signal());
      const row = body.data?.So11111111111111111111111111111111111111112;
      const usd = Number(row?.price);
      if (usd > 0) {
        sol = { usd, at: now(), source: "jupiter" };
        return { ...sol, stale: false };
      }
    } catch (error) {
      log.warn(`sol price jupiter failed: ${redact(error.message)}`);
    }
    if (sol) return { ...sol, stale: true };
    return { usd: null, at: 0, source: null, stale: true };
  }

  async function ethUsd() {
    if (eth && now() - eth.at < CACHE_MS) return { ...eth, stale: false };
    try {
      const body = await readJson(fetchImpl, COINBASE_ETH, signal());
      const usd = Number(body.data?.amount);
      if (usd > 0) {
        eth = { usd, at: now(), source: "coinbase" };
        return { ...eth, stale: false };
      }
    } catch (error) {
      log.warn(`eth price coinbase failed: ${redact(error.message)}`);
    }
    try {
      const body = await readJson(fetchImpl, DEX_ETH, signal());
      const pairs = body.pairs ?? [];
      const hit = pairs.find((pair) => Number(pair.priceUsd) > 0 && /USDC|USDT|DAI|USDG/i.test(`${pair.quoteToken?.symbol ?? ""}`));
      const usd = Number((hit ?? pairs.find((pair) => Number(pair.priceUsd) > 0))?.priceUsd);
      if (usd > 0) {
        eth = { usd, at: now(), source: "dexscreener" };
        return { ...eth, stale: false };
      }
    } catch (error) {
      log.warn(`eth price dexscreener failed: ${redact(error.message)}`);
    }
    if (eth) return { ...eth, stale: true };
    return { usd: null, at: 0, source: null, stale: true };
  }

  return {
    solUsd,
    ethUsd,
    stop() {
      lifetime.abort();
      lifetime = new AbortController();
    },
  };
}
