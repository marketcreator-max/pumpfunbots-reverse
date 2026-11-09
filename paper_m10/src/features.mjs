import { SUPPLY_RAW } from "./constants.mjs";
import { labelBook, playUntil, windowMix } from "./classify.mjs";
import { marketCapUsd } from "./fill.mjs";
import { clamp, roundUsd } from "./util.mjs";

// Frozen at conf-v1. Bump the version if a weight changes.
export const CONF_V1 = Object.freeze({
  version: "conf-v1",
  base: 100,
  noTrades: 40,
  fewTrades: 15,
  fewTradesBelow: 5,
  noPrice: 25,
  noCreate: 20,
  lowBlockTime: 10,
  blockTimeFloor: 0.5,
  negativeBalances: 10,
  thinBots: 8,
  thinBotsBelow: 5,
  noFunder: 5,
});

export function confidenceOf(feature) {
  const c = CONF_V1;
  let score = c.base;
  if (feature.tradeCount < 1) score -= c.noTrades;
  else if (feature.tradeCount < c.fewTradesBelow) score -= c.fewTrades;
  if (feature.priceRefUsd == null) score -= c.noPrice;
  else if (feature.priceStale) score -= c.noPrice;
  if (!feature.haveCreate) score -= c.noCreate;
  if ((feature.blockTimeCoverage ?? 0) < c.blockTimeFloor) score -= c.lowBlockTime;
  if ((feature.negativeBalances ?? 0) > 0) score -= c.negativeBalances;
  if ((feature.botSwapsLast60 ?? 0) < c.thinBotsBelow) score -= c.thinBots;
  if (!feature.funderData) score -= c.noFunder;
  return clamp(score, 0, 100);
}

function notion(tr) {
  if (tr.usd != null) return tr.usd;
  if (tr.quoteIsSol === false) return 0;
  if (tr.solUsd == null || tr.solLamports == null) return 0;
  return Number(tr.solLamports) / 1e9 * tr.solUsd;
}

function seriesPrice(tr) {
  if (tr.priceUsd != null) return tr.priceUsd;
  if (tr.virtualToken && tr.virtualSol && tr.virtualToken !== 0n) {
    return Number(tr.virtualSol) / Number(tr.virtualToken);
  }
  return null;
}

function drawdown(trades) {
  let peak = null;
  let firstHigh = null;
  let maxDd = 0;
  for (const tr of trades) {
    const price = seriesPrice(tr);
    if (price == null) continue;
    if (peak == null || price > peak) peak = price;
    if (firstHigh == null && peak != null && price < peak * 0.99) firstHigh = peak;
    if (firstHigh != null && firstHigh > 0) {
      const dd = (firstHigh - price) / firstHigh;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return { maxDrawdownPct: maxDd * 100, firstHigh: firstHigh ?? peak };
}

function balancesOf(trades) {
  const bal = new Map();
  let negative = 0;
  for (const tr of trades) {
    if (!tr.signer || tr.tokenRaw == null) continue;
    const prev = bal.get(tr.signer) ?? 0n;
    const next = tr.side === "buy" ? prev + tr.tokenRaw : prev - tr.tokenRaw;
    if (next < 0n) negative++;
    bal.set(tr.signer, next);
  }
  return { bal, negative };
}

function top10Pct(bal, supply) {
  if (!supply || supply === 0n) return null;
  const positive = [...bal.values()].filter((v) => v > 0n).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  let sum = 0n;
  for (const v of positive.slice(0, 10)) sum += v;
  return Number(sum) / Number(supply) * 100;
}

function bundlePct(trades, supply, minBuys) {
  if (!supply || supply === 0n) return { bundlePct: null, bundleSlot: null };
  const slots = new Map();
  const funders = new Map();
  let funderData = false;
  for (const tr of trades) {
    if (tr.side !== "buy" || tr.tokenRaw == null) continue;
    if (tr.slot != null) {
      let group = slots.get(tr.slot);
      if (!group) {
        group = { raw: 0n, signers: new Set() };
        slots.set(tr.slot, group);
      }
      group.raw += tr.tokenRaw;
      if (tr.signer) group.signers.add(tr.signer);
    }
    if (tr.funder) {
      funderData = true;
      let group = funders.get(tr.funder);
      if (!group) {
        group = { raw: 0n, signers: new Set() };
        funders.set(tr.funder, group);
      }
      group.raw += tr.tokenRaw;
      if (tr.signer) group.signers.add(tr.signer);
    }
  }
  let best = 0n;
  let bestSlot = null;
  for (const [slot, group] of slots) {
    if (group.signers.size >= minBuys && group.raw > best) {
      best = group.raw;
      bestSlot = slot;
    }
  }
  for (const group of funders.values()) {
    if (group.signers.size >= minBuys && group.raw > best) best = group.raw;
  }
  return { bundlePct: Number(best) / Number(supply) * 100, bundleSlot: bestSlot, funderData };
}

export function computeFeatures({ chain, create, trades, cutoff, minute, walletIndex, thresholds }) {
  const windowTrades = trades
    .filter((tr) => tr.recvTs <= cutoff)
    .sort((a, b) => a.recvTs - b.recvTs || (a.seq ?? 0) - (b.seq ?? 0));
  const book = playUntil(windowTrades, create, chain, thresholds, walletIndex, cutoff);
  const labels = labelBook(book);
  const full = windowMix(windowTrades, labels, create.recvTs, cutoff);
  const last60 = windowMix(windowTrades, labels, cutoff - 60_000, cutoff);
  const supply = create.totalSupply && create.totalSupply !== 0n ? create.totalSupply : (chain === "SOL" ? SUPPLY_RAW : null);
  const lastPx = [...windowTrades].reverse().find((tr) => seriesPrice(tr) != null);
  const priceRef = lastPx?.solUsd ?? lastPx?.quoteUsd ?? null;
  const priceAt = lastPx?.solUsdAt ?? lastPx?.priceAt ?? null;
  let mcUsd = null;
  let mcUsdCirc = null;
  if (chain === "HOOD" || lastPx?.priceUsd != null) {
    if (lastPx?.priceUsd != null && supply != null) {
      const decimals = chain === "HOOD" ? (create.tokenDecimals ?? lastPx.tokenDecimals ?? 18) : 6;
      mcUsd = lastPx.priceUsd * (Number(supply) / 10 ** decimals);
    }
  } else if (lastPx && priceRef != null && supply != null) {
    mcUsd = marketCapUsd(lastPx.virtualSol, lastPx.virtualToken, supply, lastPx.solUsd ?? priceRef);
    const realLeft = lastPx.realToken ?? create.realToken ?? 0n;
    const circ = realLeft > 0n && realLeft < supply ? supply - realLeft : supply;
    mcUsdCirc = marketCapUsd(lastPx.virtualSol, lastPx.virtualToken, circ, lastPx.solUsd ?? priceRef);
  }
  let volumeUsd = 0;
  let buyVolumeUsd = 0;
  let timed = 0;
  for (const tr of windowTrades) {
    const usd = notion(tr);
    volumeUsd += usd;
    if (tr.side === "buy") buyVolumeUsd += usd;
    if (tr.blockTime != null) timed++;
  }
  const { bal, negative } = balancesOf(windowTrades);
  const dd = drawdown(windowTrades);
  const solOnly = chain === "SOL";
  const bundle = solOnly ? bundlePct(windowTrades, supply, thresholds.bundleMinBuys) : { bundlePct: null, bundleSlot: null, funderData: false };
  let devHoldPct = null;
  if (solOnly && create.creator && supply) {
    const raw = bal.get(create.creator) ?? 0n;
    devHoldPct = raw > 0n ? Number(raw) / Number(supply) * 100 : 0;
  }
  const recurring = [];
  for (const wallet of book.signers.keys()) {
    const mints = walletIndex.countAt(wallet, cutoff);
    if (mints >= 2) recurring.push({ wallet, mints });
  }
  recurring.sort((a, b) => b.mints - a.mints || (a.wallet < b.wallet ? -1 : 1));
  const naFeatures = solOnly ? [] : ["devHoldPct", "bundlePct", "bondingCurve"];
  const feature = {
    chain,
    minute,
    mint: create.mint,
    name: create.name ?? "",
    symbol: create.symbol ?? "",
    creator: create.creator ?? null,
    cutoffRecvTs: cutoff,
    haveCreate: true,
    tradeCount: windowTrades.length,
    mcUsd: mcUsd == null ? null : roundUsd(mcUsd),
    mcUsdCirc: mcUsdCirc == null ? null : roundUsd(mcUsdCirc),
    volumeUsd: roundUsd(volumeUsd),
    buyVolumeUsd: roundUsd(buyVolumeUsd),
    uniqueRealBuyers: full.uniqueRealBuyers,
    uniqueBuyers: full.uniqueBuyers,
    devHoldPct: devHoldPct == null ? null : roundUsd(devHoldPct),
    bundlePct: bundle.bundlePct == null ? null : roundUsd(bundle.bundlePct),
    bundleSlot: bundle.bundleSlot,
    top10Pct: supply ? roundUsd(top10Pct(bal, supply)) : null,
    maxDrawdownPct: roundUsd(dd.maxDrawdownPct),
    priceRefUsd: priceRef,
    priceStale: priceAt != null && cutoff - priceAt > 30_000,
    blockTimeCoverage: windowTrades.length ? timed / windowTrades.length : 0,
    negativeBalances: negative,
    funderData: Boolean(bundle.funderData),
    botSwaps0_10: full.botSwaps,
    botSwapsLast60: last60.botSwaps,
    blatantShare0_10: full.blatantShare == null ? null : roundUsd(full.blatantShare),
    nurtureShare0_10: full.nurtureShare == null ? null : roundUsd(full.nurtureShare),
    blatantShareLast60: last60.blatantShare == null ? null : roundUsd(last60.blatantShare),
    nurtureShareLast60: last60.nurtureShare == null ? null : roundUsd(last60.nurtureShare),
    botNetUsd0_10: roundUsd(full.botNetUsd),
    nurtureNetUsd0_10: roundUsd(full.nurtureNetUsd),
    blatantNetUsd0_10: roundUsd(full.blatantNetUsd),
    nurtureNetUsdLast60: roundUsd(last60.nurtureNetUsd),
    blatantNetUsdLast60: roundUsd(last60.blatantNetUsd),
    swaps: full.swaps,
    signedSwaps: full.signedSwaps,
    naFeatures,
    sandwichScope: chain === "HOOD" ? "block" : "slot",
    recurringWallets: recurring.slice(0, 20),
    labels: {
      blatant: [...labels.values()].filter((l) => l.class === "BLATANT").length,
      nurturing: [...labels.values()].filter((l) => l.class === "NURTURING").length,
      real: [...labels.values()].filter((l) => l.class === "REAL").length,
    },
  };
  feature.confidence = confidenceOf(feature);
  feature.confidenceVersion = CONF_V1.version;
  return { feature, labels, book };
}

export function sliceMix({ chain, create, trades, walletIndex, thresholds, t0, t1 }) {
  const ordered = [...trades].sort((a, b) => a.recvTs - b.recvTs || (a.seq ?? 0) - (b.seq ?? 0));
  const book = playUntil(ordered, create, chain, thresholds, walletIndex, t1);
  const labels = labelBook(book);
  return windowMix(ordered, labels, t0, t1);
}
