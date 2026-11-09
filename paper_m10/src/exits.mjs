import { labelBook, noteTrade, createBook, windowMix } from "./classify.mjs";
import { constantProductBuy, constantProductSell, spotUsdPerToken } from "./fill.mjs";

const KINDS = new Set([
  "time", "multiple", "stop", "mcMultiple", "mcUsd", "nurtureFlip", "blatantSurge",
  "realBuyerDry", "liquidityPull", "bigSeller", "trail", "any", "all", "combo", "nurtureDominant",
]);

function walkKinds(when, visit) {
  if (!when || typeof when !== "object") return;
  visit(when);
  if (when.kind === "any" || when.kind === "all") for (const item of when.of ?? []) walkKinds(item, visit);
  if (when.kind === "trail" && when.arm) walkKinds(when.arm, visit);
  if (when.kind === "combo" && when.extendIf) walkKinds(when.extendIf, visit);
}

export function validateExits(config) {
  if (!config?.exits?.length) throw new Error("exits config has no exits");
  for (const exit of config.exits) {
    if (!exit.id || !exit.label) throw new Error("exit missing id or label");
    for (const rule of exit.rules ?? []) {
      walkKinds(rule.when, (when) => {
        if (!KINDS.has(when.kind)) throw new Error(`exit ${exit.id} has unknown trigger ${when.kind}`);
      });
    }
  }
  return config;
}

function midOf(tr, chain) {
  if (chain === "HOOD") return tr.priceUsd ?? null;
  return spotUsdPerToken(tr.virtualSol, tr.virtualToken, tr.solUsd);
}

function mcOf(tr, chain, supply, decimals) {
  const mid = midOf(tr, chain);
  if (mid == null || supply == null) return null;
  const human = Number(supply) / 10 ** decimals;
  return mid * human;
}

function whenTrue(when, s) {
  switch (when.kind) {
    case "time":
      return s.elapsedMs >= when.sec * 1000;
    case "multiple":
      return s.midMultiple >= when.gte;
    case "stop":
      return s.midMultiple <= when.multipleLte;
    case "mcMultiple":
      return s.entryMcUsd > 0 && s.mcUsd != null && s.mcUsd >= s.entryMcUsd * when.gte;
    case "mcUsd":
      return s.mcUsd != null && s.mcUsd >= when.gte;
    case "nurtureFlip":
      return s.nurtureNet15 != null && s.nurtureNet15 < when.belowUsd;
    case "blatantSurge":
      return s.blatantShare15 != null && s.blatantShare15 > when.above;
    case "nurtureDominant":
      return s.nurtureShare60 != null && s.blatantShare60 != null && s.nurtureShare60 >= (when.nurtureGte ?? 50) && s.blatantShare60 < (when.blatantLt ?? 50);
    case "realBuyerDry":
      return s.elapsedMs >= (when.afterMs ?? 0)
        && s.msSinceNewReal >= when.windowMs
        && (when.requireMultipleGt == null || s.midMultiple > when.requireMultipleGt);
    case "liquidityPull":
      return s.liqPull;
    case "bigSeller":
      return s.bigSell;
    case "trail":
      return false;
    case "any":
      return (when.of ?? []).some((item) => whenTrue(item, s));
    case "all":
      return (when.of ?? []).every((item) => whenTrue(item, s));
    default:
      return false;
  }
}

function armTrail(when, s, arms) {
  if (!when) return;
  if (when.kind === "trail") {
    const arm = when.arm ?? { kind: "time", sec: 0 };
    if (!arms.armed && whenTrue(arm, s)) {
      arms.armed = true;
      arms.peak = s.midMultiple;
    }
    if (arms.armed && s.midMultiple > arms.peak) arms.peak = s.midMultiple;
    return;
  }
  if (when.kind === "any" || when.kind === "all") for (const item of when.of ?? []) armTrail(item, s, arms);
}

function trailReady(when, arms) {
  if (!when) return false;
  if (when.kind === "trail") {
    return Boolean(arms.armed) && arms.peak > 0 && (1 - (arms.current / arms.peak)) >= when.pct;
  }
  if (when.kind === "any") return (when.of ?? []).some((item) => item.kind === "trail" ? trailReady(item, arms) : whenTrue(item, arms.snap));
  if (when.kind === "all") return (when.of ?? []).every((item) => item.kind === "trail" ? trailReady(item, arms) : whenTrue(item, arms.snap));
  return whenTrue(when, arms.snap);
}

function sellUsd(tr, tokenIn, feeBps, chain) {
  if (tokenIn <= 0n) return 0;
  if (tr.virtualSol > 0n && tr.virtualToken > 0n && (chain === "SOL" || tr.curve === "v2")) {
    const fill = constantProductSell({
      virtualSol: tr.virtualSol,
      virtualToken: tr.virtualToken,
      tokenIn,
      feeBps,
    });
    if (!fill) return 0;
    if (chain === "HOOD") {
      const decimals = tr.quoteDecimals ?? 18;
      return Number(fill.solOut) / 10 ** decimals * (tr.quoteUsd ?? 0);
    }
    return Number(fill.solOut) / 1e9 * (tr.solUsd ?? 0);
  }
  if (chain === "HOOD" && tr.priceUsd != null) {
    const decimals = tr.tokenDecimals ?? 18;
    const human = Number(tokenIn) / 10 ** decimals;
    return human * tr.priceUsd * (1 - feeBps / 10_000);
  }
  return 0;
}

export function openEntry({ trades, decisionRecvTs, delayMs, fees, chain, supplyRaw, decimals }) {
  const target = decisionRecvTs + delayMs;
  const tr = trades.find((row) => row.recvTs >= target && midOf(row, chain) != null && (chain === "HOOD" ? row.quoteUsd != null || row.priceUsd != null : row.solUsd != null && row.virtualSol > 0n && row.virtualToken > 0n));
  if (!tr) return null;
  const feeBps = chain === "HOOD"
    ? (tr.feeBps ?? fees.hoodV2FeeBps)
    : (tr.venue === "pumpswap" ? fees.pumpSwapFeeBps : fees.pumpFeeBps);
  let tokensOut = null;
  let impact = "constant-product";
  if (chain === "SOL" || tr.curve === "v2") {
    const quoteUsd = chain === "HOOD" ? tr.quoteUsd : tr.solUsd;
    const quoteDecimals = chain === "HOOD" ? (tr.quoteDecimals ?? 18) : 9;
    const quoteRaw = BigInt(Math.round(fees.notionalUsd / quoteUsd * 10 ** quoteDecimals));
    const fill = constantProductBuy({
      virtualSol: tr.virtualSol,
      virtualToken: tr.virtualToken,
      solLamports: quoteRaw,
      feeBps,
    });
    if (!fill) return null;
    tokensOut = fill.tokensOut;
  } else if (tr.priceUsd) {
    impact = "v3-mid";
    const netUsd = fees.notionalUsd * (1 - feeBps / 10_000);
    const human = netUsd / tr.priceUsd;
    tokensOut = BigInt(Math.max(1, Math.round(human * 10 ** decimals)));
  }
  if (tokensOut == null || tokensOut <= 0n) return null;
  const human = Number(tokensOut) / 10 ** decimals;
  const effectiveUsdPerToken = fees.notionalUsd / human;
  const spot = midOf(tr, chain);
  const mcUsd = mcOf(tr, chain, supplyRaw, decimals);
  return {
    trade: tr,
    recvTs: tr.recvTs,
    tokensOut,
    feeBps,
    impact,
    effectiveUsdPerToken,
    spotUsd: spot,
    mcUsd,
    notionalUsd: fees.notionalUsd,
  };
}

function networkUsd(tr, fees, chain) {
  if (chain === "HOOD") {
    if (tr.gasPriceWei == null || tr.ethUsd == null) return 0;
    return Number(BigInt(tr.gasPriceWei) * BigInt(fees.hoodGasUnits)) / 1e18 * tr.ethUsd;
  }
  return Number(fees.networkFeeLamports) / 1e9 * (tr.solUsd ?? 0);
}

export function simulateExit({ spec, trades, create, entry, horizonRecvTs, chain, walletIndex, thresholds, supplyRaw, decimals, fees, windowComplete = true }) {
  const book = createBook({ chain, create, thresholds, walletIndex });
  const rules = (spec.rules ?? []).map((rule) => ({ ...rule, done: false, checked: false, extend: false, arms: { armed: false, peak: 0, current: 0, snap: null } }));
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  let remaining = entry.tokensOut;
  const original = entry.tokensOut;
  let proceeds = 0;
  let sells = 0;
  let network = networkUsd(entry.trade, fees, chain);
  let peakMid = entry.spotUsd ?? entry.effectiveUsdPerToken;
  const reserves = [];
  const seenReal = new Set();
  let lastNewReal = create.recvTs;
  let closeRecv = entry.recvTs;
  let reason = "open";
  const slices = [];

  function stateAt(tr, elapsedMs) {
    const mid = midOf(tr, chain) ?? peakMid;
    if (mid > peakMid) peakMid = mid;
    const labels = labelBook(book);
    const mix15 = windowMix(trades, labels, tr.recvTs - 15_000, tr.recvTs);
    const mix60 = windowMix(trades, labels, tr.recvTs - 60_000, tr.recvTs);
    const usd = tr.usd != null ? tr.usd : (tr.solUsd != null && tr.solLamports != null ? Number(tr.solLamports) / 1e9 * tr.solUsd : 0);
    const bigSell = tr.side === "sell" && (
      (supplyRaw && Number(tr.tokenRaw ?? 0n) / Number(supplyRaw) >= 0.03) || usd >= 1000
    );
    let liqPull = false;
    if (tr.virtualSol != null) {
      reserves.push({ recvTs: tr.recvTs, virtualSol: tr.virtualSol });
      const floor = tr.recvTs - 10_000;
      let max = 0n;
      for (const sample of reserves) {
        if (sample.recvTs >= floor && sample.virtualSol > max) max = sample.virtualSol;
      }
      liqPull = max > 0n && tr.virtualSol < max && tr.virtualSol * 100n <= max * 75n;
    }
    const mcUsd = mcOf(tr, chain, supplyRaw, decimals);
    return {
      elapsedMs,
      midMultiple: entry.effectiveUsdPerToken > 0 ? mid / entry.effectiveUsdPerToken : 0,
      mcUsd,
      entryMcUsd: entry.mcUsd ?? 0,
      nurtureNet15: mix15.botSwaps ? mix15.nurtureNetUsd : null,
      blatantShare15: mix15.blatantShare,
      nurtureShare60: mix60.nurtureShare,
      blatantShare60: mix60.blatantShare,
      msSinceNewReal: tr.recvTs - lastNewReal,
      liqPull,
      bigSell,
    };
  }

  function sell(pct, why, tr, ofRemaining) {
    if (remaining <= 0n) return;
    const target = ofRemaining ? remaining * BigInt(pct) / 100n : original * BigInt(pct) / 100n;
    const qty = target > remaining ? remaining : target;
    if (qty <= 0n) return;
    const usd = sellUsd(tr, qty, entry.feeBps, chain);
    proceeds += usd;
    remaining -= qty;
    sells++;
    network += networkUsd(tr, fees, chain);
    closeRecv = tr.recvTs;
    reason = why;
    slices.push({ recvTs: tr.recvTs, qty: qty.toString(), usd, why });
  }

  function fireRules(tr, s) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const rule of rules) {
        if (rule.done) continue;
        if (rule.after && !byId.get(rule.after)?.done) continue;
        armTrail(rule.when, s, rule.arms);
        rule.arms.current = s.midMultiple;
        rule.arms.snap = s;
        if (rule.when?.kind === "combo") {
          if (!rule.checked && s.elapsedMs >= rule.when.checkSec * 1000) {
            rule.checked = true;
            rule.extend = whenTrue(rule.when.extendIf, s);
            if (!rule.extend) {
              sell(rule.when.elseSellPct ?? 100, rule.id, tr, false);
              rule.done = true;
              moved = true;
            }
          } else if (rule.checked && rule.extend && s.elapsedMs >= rule.when.extendSec * 1000) {
            sell(100, rule.id, tr, true);
            rule.done = true;
            moved = true;
          }
          continue;
        }
        const hit = rule.when?.kind === "trail" || rule.when?.kind === "any" || rule.when?.kind === "all"
          ? trailReady(rule.when, rule.arms)
          : whenTrue(rule.when, s);
        if (!hit) continue;
        const ofRemaining = rule.sellPctOfRemaining != null;
        const pct = ofRemaining ? rule.sellPctOfRemaining : rule.sellPctOfOriginal;
        sell(pct ?? 100, rule.id, tr, ofRemaining);
        rule.done = true;
        moved = true;
      }
    }
  }

  let last = null;
  for (const tr of trades) {
    if (tr.recvTs > horizonRecvTs) break;
    noteTrade(book, tr);
    if (tr.side === "buy" && tr.signer) {
      const label = labelBook(book).get(tr.signer);
      if (label?.class === "REAL" && !seenReal.has(tr.signer)) {
        seenReal.add(tr.signer);
        lastNewReal = tr.recvTs;
      }
    }
    if (tr.recvTs < entry.recvTs) continue;
    const mid = midOf(tr, chain);
    if (mid != null && mid > peakMid) peakMid = mid;
    if (tr.recvTs === entry.recvTs) {
      last = tr;
      continue;
    }
    last = tr;
    const s = stateAt(tr, tr.recvTs - entry.recvTs);
    fireRules(tr, s);
  }
  let incomplete = false;
  if (remaining > 0n && !windowComplete) {
    const mid = last ? midOf(last, chain) : entry.spotUsd;
    if (mid == null) {
      return {
        pnlUsd: null,
        exitMultiple: null,
        peakMultiple: entry.effectiveUsdPerToken > 0 && peakMid != null ? peakMid / entry.effectiveUsdPerToken : null,
        kept2x: false,
        stale: false,
        incomplete: true,
        reason: "incomplete",
        slices,
        sells,
        proceedsUsd: null,
      };
    }
    const human = Number(remaining) / 10 ** decimals;
    proceeds += human * mid;
    incomplete = true;
    reason = "mark";
    remaining = 0n;
  } else if (remaining > 0n && last) {
    sell(100, "horizon", last, true);
  }
  const stale = reason === "horizon" && horizonRecvTs - closeRecv > 5000;
  const exitMultiple = entry.notionalUsd > 0 ? proceeds / entry.notionalUsd : null;
  const pnlUsd = proceeds - entry.notionalUsd - network;
  const peakMultiple = entry.effectiveUsdPerToken > 0 && peakMid != null ? peakMid / entry.effectiveUsdPerToken : 0;
  return {
    pnlUsd,
    exitMultiple,
    peakMultiple,
    kept2x: exitMultiple != null && exitMultiple >= 2,
    stale,
    incomplete,
    reason,
    slices,
    sells,
    proceedsUsd: proceeds,
  };
}

export function pathStats({ trades, entry, horizonRecvTs, chain, entryReserve }) {
  let peak = entry.spotUsd ?? 0;
  let rugged = false;
  let troughAfter = null;
  let peakTrade = null;
  let troughTrade = null;
  for (const tr of trades) {
    if (tr.recvTs < entry.recvTs || tr.recvTs > horizonRecvTs) continue;
    const mid = midOf(tr, chain);
    if (mid != null && mid >= peak) {
      peak = mid;
      peakTrade = tr;
      troughAfter = mid;
      troughTrade = tr;
    } else if (peakTrade && mid != null && (troughAfter == null || mid < troughAfter)) {
      troughAfter = mid;
      troughTrade = tr;
    }
    if (peak > 0 && mid != null && (peak - mid) / peak >= 0.8) rugged = true;
    if (chain === "SOL" && entryReserve > 0n && tr.virtualSol != null) {
      if (tr.virtualSol * 100n < entryReserve || (entryReserve > 50_000_000n && tr.virtualSol < 50_000_000n)) rugged = true;
    }
    if (chain === "HOOD" && tr.drained) rugged = true;
  }
  const peakMultiple = entry.effectiveUsdPerToken > 0 ? peak / entry.effectiveUsdPerToken : 0;
  let outcome = "INCOMPLETE";
  return {
    peakMultiple,
    rugged,
    reached2x: peakMultiple >= 2,
    reached5x: peakMultiple >= 5,
    peakTrade,
    troughTrade,
    outcome,
  };
}
