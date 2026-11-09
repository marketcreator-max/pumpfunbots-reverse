// Port of SpikeCalls/ai-trading-desk @ c0f226a scanner, chain check, and exits.
// Logic only. This file does not import or run that repository.

import { marketCapUsd } from "./fill.mjs";

export const SPIKE_SOURCE = "SpikeCalls/ai-trading-desk@c0f226a";

export const SPIKE = Object.freeze({
  minAgeMin: 10,
  maxAgeMin: 6 * 60,
  minLiquidityUsd: 8_000,
  minVolumeH1Usd: 15_000,
  minMcapUsd: 25_000,
  maxMcapUsd: 5_000_000,
  minTradesH1: 120,
  minSellRatio: 0.15,
  maxTopWallet: 0.05,
  maxTop10: 0.25,
  stopPct: 0.35,
  takeHalfAt: 2,
  volumeDecayRatio: 0.2,
  volumeDecayMinMinutes: 30,
  maxHoldHours: 24,
  // SpikeCalls refused a new entry when 3 positions were already open.
  // That rule is not used. Null means every pass is entered.
  maxConcurrentPositions: null,
});

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export function tradeUsd(tr) {
  if (tr.usd != null) return tr.usd;
  if (tr.quoteIsSol === false || tr.solUsd == null || tr.solLamports == null) return 0;
  return Number(tr.solLamports) / 1e9 * tr.solUsd;
}

export function liquidityUsd(tr, chain) {
  if (tr.liquidityUsd != null) return tr.liquidityUsd;
  if (chain === "HOOD") {
    if (tr.quoteUsd == null || tr.virtualSol == null) return null;
    const quote = Number(tr.virtualSol) / 10 ** (tr.quoteDecimals ?? 18) * tr.quoteUsd;
    return quote > 0 ? quote * 2 : null;
  }
  if (tr.solUsd == null) return null;
  if (tr.realSol != null && tr.realSol > 0n) return Number(tr.realSol) / 1e9 * tr.solUsd;
  if (tr.virtualSol != null) {
    const est = Math.max(0, Number(tr.virtualSol) / 1e9 - 30);
    return est > 0 ? est * tr.solUsd : null;
  }
  return null;
}

export function mcapAt(tr, chain, supply, decimals) {
  if (tr.mcUsd != null) return tr.mcUsd;
  if (tr.priceUsd != null && supply != null) return tr.priceUsd * (Number(supply) / 10 ** decimals);
  if (chain !== "HOOD" && tr.virtualSol != null && tr.virtualToken != null && tr.solUsd != null && supply != null) {
    return marketCapUsd(tr.virtualSol, tr.virtualToken, supply, tr.solUsd);
  }
  return null;
}

// Same order as scanner.free_kill. A missing number abstains. It does not pass.
export function spk1Reason(metrics) {
  if (metrics.ageMinutes == null || !(SPIKE.minAgeMin <= metrics.ageMinutes && metrics.ageMinutes <= SPIKE.maxAgeMin)) {
    return "age";
  }
  if (metrics.liquidityUsd == null) return "abstain:liquidity";
  if (metrics.liquidityUsd < SPIKE.minLiquidityUsd) return "liquidity";
  if (metrics.volumeH1Usd == null) return "abstain:volume";
  if (metrics.volumeH1Usd < SPIKE.minVolumeH1Usd) return "volume";
  if (metrics.mcUsd == null) return "abstain:mcap";
  if (!(SPIKE.minMcapUsd <= metrics.mcUsd && metrics.mcUsd <= SPIKE.maxMcapUsd)) return "mcap";
  if ((metrics.tradesH1 ?? 0) < SPIKE.minTradesH1) return "trades";
  if (metrics.buysH1 && metrics.sellRatio < SPIKE.minSellRatio) return "no_sells";
  return null;
}

export function spk2Reason(metrics, facts, chain) {
  const base = spk1Reason(metrics);
  if (base) return base;
  if (chain !== "SOL") return "N/A:authority";
  if (!facts || facts.abstain) return "abstain:authority";
  if (facts.mintAuthority) return "mint_authority";
  if (facts.freezeAuthority) return "freeze_authority";
  if (facts.topWalletPct == null || facts.top10Pct == null) return "abstain:holders";
  if (facts.topWalletPct > SPIKE.maxTopWallet) return "top_wallet";
  if (facts.top10Pct > SPIKE.maxTop10) return "top_10";
  return null;
}

// HOOD has no SPL mint or freeze authority. SPK3 there is the tape gate plus socials.
export function spk3Reason(metrics, facts, socials, chain) {
  const base = chain === "SOL" ? spk2Reason(metrics, facts, chain) : spk1Reason(metrics);
  if (base) return base;
  if (!socials || socials.abstain) return "abstain:socials";
  if (!socials.x && !socials.telegram) return "socials";
  return null;
}

function latestAt(rows, recvTs) {
  let found = null;
  for (const row of rows ?? []) {
    if (row.recvTs <= recvTs) found = row;
    else break;
  }
  return found;
}

export function firstSpikePasses({ trades, create, facts, socials, chain, supply, decimals }) {
  const t0 = create.recvTs;
  const start = t0 + SPIKE.minAgeMin * 60_000;
  const end = t0 + SPIKE.maxAgeMin * 60_000;
  const window = [];
  let volume = 0;
  let buys = 0;
  let sells = 0;
  const found = {};
  const reasons = {};
  for (const tr of trades) {
    if (tr.recvTs > end) break;
    const usd = tradeUsd(tr);
    window.push({ recvTs: tr.recvTs, usd, side: tr.side });
    volume += usd;
    if (tr.side === "sell") sells += 1;
    else if (tr.side === "buy") buys += 1;
    const cut = tr.recvTs - 3_600_000;
    while (window.length && window[0].recvTs < cut) {
      const old = window.shift();
      volume -= old.usd;
      if (old.side === "sell") sells -= 1;
      else if (old.side === "buy") buys -= 1;
    }
    if (tr.recvTs < start) continue;
    const metrics = {
      ageMinutes: (tr.recvTs - t0) / 60_000,
      liquidityUsd: liquidityUsd(tr, chain),
      volumeH1Usd: volume,
      mcUsd: mcapAt(tr, chain, supply, decimals),
      tradesH1: buys + sells,
      buysH1: buys,
      sellsH1: sells,
      sellRatio: buys > 0 ? sells / buys : null,
      cutoffRecvTs: tr.recvTs,
    };
    const fact = latestAt(facts, tr.recvTs);
    const social = latestAt(socials, tr.recvTs);
    reasons.SPK1 = spk1Reason(metrics);
    reasons.SPK2 = spk2Reason(metrics, fact, chain);
    reasons.SPK3 = spk3Reason(metrics, fact, social, chain);
    if (!found.SPK1 && !reasons.SPK1) found.SPK1 = { recvTs: tr.recvTs, metrics };
    if (!found.SPK2 && !reasons.SPK2) found.SPK2 = { recvTs: tr.recvTs, metrics };
    if (!found.SPK3 && !reasons.SPK3) found.SPK3 = { recvTs: tr.recvTs, metrics };
    if (found.SPK1 && found.SPK2 && found.SPK3) break;
  }
  return { passes: found, reasons };
}

export function spikeConfidence(metrics) {
  let score = 100;
  if (metrics.liquidityUsd == null) score -= 25;
  if (metrics.mcUsd == null) score -= 25;
  if (metrics.volumeH1Usd == null) score -= 15;
  if ((metrics.tradesH1 ?? 0) < SPIKE.minTradesH1) score -= 10;
  return Math.max(0, Math.min(100, score));
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

export function spikeDecisions({ identity, create, passes, reasons = {}, configHash }) {
  const scope = {
    SPK1: ["SOL", "HOOD"],
    SPK2: ["SOL"],
    SPK3: ["SOL", "HOOD"],
  };
  const out = [];
  for (const gateId of ["SPK1", "SPK2", "SPK3"]) {
    const hit = passes[gateId];
    const applicable = scope[gateId].includes(identity.chain);
    let pass = false;
    let reason = reasons[gateId] || "no pass in the 10 minute to 6 hour window";
    let metrics = null;
    let decidedAt = create.recvTs + SPIKE.maxAgeMin * 60_000;
    if (!applicable) reason = "N/A:authority";
    if (hit) {
      pass = true;
      reason = "pass";
      metrics = hit.metrics;
      decidedAt = hit.recvTs;
    }
    out.push(freeze({
      type: "decision",
      frozen: true,
      ...identity,
      confVersion: "spk-conf-v1",
      gateVersion: "gates-v2",
      gateId,
      gateMode: "spike",
      scope: scope[gateId],
      source: SPIKE_SOURCE,
      mint: create.mint,
      name: create.name ?? "",
      symbol: create.symbol ?? "",
      pass,
      confidence: metrics ? spikeConfidence(metrics) : 0,
      reason,
      profile: "spike",
      features: metrics,
      configHash,
      decidedAtRecvTs: decidedAt,
    }));
  }
  return out;
}

export function volumeDecayRatio(trades, now) {
  let recent = 0;
  let base = 0;
  const recentCut = now - 15 * 60_000;
  const baseCut = now - 60 * 60_000;
  for (const tr of trades) {
    if (tr.recvTs > now) break;
    if (tr.recvTs < baseCut) continue;
    const usd = tradeUsd(tr);
    base += usd;
    if (tr.recvTs >= recentCut) recent += usd;
  }
  if (base <= 0) return null;
  return recent / (base / 4);
}

async function rpcCall(rpcUrl, method, params, fetchImpl) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 429) throw new Error("sol rpc 429");
  const body = await response.json();
  if (body.error) throw new Error("sol rpc error");
  return body.result;
}

// Read-only SPL facts. A failure abstains. Nothing here is logged with the RPC URL.
export async function readSolFacts(mint, { rpcUrl, fetchImpl = globalThis.fetch }) {
  try {
    const info = await rpcCall(rpcUrl, "getAccountInfo", [mint, { encoding: "jsonParsed" }], fetchImpl);
    const parsed = info?.value?.data?.parsed?.info;
    if (!parsed) return { abstain: true };
    const decimals = Number(parsed.decimals);
    const supplyRaw = Number(parsed.supply);
    const supply = supplyRaw / 10 ** decimals;
    const largestBody = await rpcCall(rpcUrl, "getTokenLargestAccounts", [mint], fetchImpl);
    const largest = (largestBody?.value ?? []).slice(0, 20);
    const tokenAccts = largest.map((row) => row.address);
    const accts = tokenAccts.length
      ? await rpcCall(rpcUrl, "getMultipleAccounts", [tokenAccts, { encoding: "jsonParsed" }], fetchImpl)
      : { value: [] };
    const owners = (accts?.value ?? []).map((account) => account?.data?.parsed?.info?.owner ?? null);
    const uniq = [...new Set(owners.filter(Boolean))];
    const ownerAccts = uniq.length
      ? await rpcCall(rpcUrl, "getMultipleAccounts", [uniq, { encoding: "base64" }], fetchImpl)
      : { value: [] };
    const programOf = {};
    uniq.forEach((owner, i) => { programOf[owner] = ownerAccts?.value?.[i]?.owner ?? null; });
    const wallets = new Map();
    for (let i = 0; i < largest.length; i++) {
      const amount = Number(largest[i].uiAmount ?? 0);
      const owner = owners[i];
      const program = owner ? programOf[owner] : null;
      if (owner && program && program !== SYSTEM_PROGRAM) continue;
      const key = owner || largest[i].address;
      wallets.set(key, (wallets.get(key) ?? 0) + amount);
    }
    const ranked = [...wallets.values()].sort((a, b) => b - a);
    const share = (rows) => (supply > 0 ? rows.reduce((sum, value) => sum + value, 0) / supply : null);
    return {
      abstain: false,
      mintAuthority: parsed.mintAuthority ?? null,
      freezeAuthority: parsed.freezeAuthority ?? null,
      topWalletPct: share(ranked.slice(0, 1)),
      top10Pct: share(ranked.slice(0, 10)),
    };
  } catch {
    return { abstain: true };
  }
}

export function createSocials({ fetchImpl = globalThis.fetch, minGapMs = 1500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const cache = new Map();
  let nextAt = 0;
  let chain = Promise.resolve();
  async function lookup(mint) {
    if (cache.has(mint)) return cache.get(mint);
    const run = chain.then(async () => {
      const wait = Math.max(0, nextAt - Date.now());
      if (wait) await sleep(wait);
      nextAt = Date.now() + minGapMs;
      try {
        const response = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error(`dex ${response.status}`);
        const body = await response.json();
        const pairs = body.pairs ?? [];
        const info = pairs.find((pair) => pair.info)?.info ?? {};
        const links = {};
        for (const link of info.socials ?? []) links[link.type] = link.url;
        const sites = info.websites ?? [];
        const result = { abstain: false, x: links.twitter ?? null, telegram: links.telegram ?? null, website: sites[0]?.url ?? null };
        cache.set(mint, result);
        return result;
      } catch {
        const result = { abstain: true, x: null, telegram: null, website: null };
        cache.set(mint, result);
        return result;
      }
    });
    chain = run.then(() => {}, () => {});
    return run;
  }
  return { lookup, cache };
}
