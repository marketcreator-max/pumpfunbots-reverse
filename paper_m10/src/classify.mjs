// Causal wallet labels. noteTrade only looks at the trade it is given, so a
// caller that stops at a cutoff cannot leak later prints into the label.

export class WalletIndex {
  constructor() {
    this.mints = new Map();
  }

  add(wallet, mint, recvTs) {
    if (!wallet || !mint) return;
    let byMint = this.mints.get(wallet);
    if (!byMint) {
      byMint = new Map();
      this.mints.set(wallet, byMint);
    }
    const prev = byMint.get(mint);
    if (prev == null || recvTs < prev) byMint.set(mint, recvTs);
  }

  countAt(wallet, cutoff) {
    const byMint = this.mints.get(wallet);
    if (!byMint) return 0;
    let n = 0;
    for (const ts of byMint.values()) if (ts <= cutoff) n++;
    return n;
  }
}

function blankSigner(wallet) {
  return {
    wallet,
    trades: [],
    buys: [],
    sells: [],
    buyUsd: 0,
    sellUsd: 0,
    buyRaw: 0n,
    sellRaw: 0n,
    sniper: false,
    sandwich: false,
    firstBuyTs: null,
    lastSellTs: null,
  };
}

function tradeUsd(tr) {
  if (tr.usd != null) return tr.usd;
  if (tr.chain === "HOOD") return tr.usd ?? 0;
  if (tr.solUsd == null || tr.quoteIsSol === false) return 0;
  return Number(tr.solLamports) / 1e9 * tr.solUsd;
}

function soldFast(signer, windowMs, frac) {
  if (signer.buyUsd <= 0) return signer.sellUsd > 0;
  for (const buy of signer.buys) {
    let got = 0;
    for (const sell of signer.sells) {
      if (sell.recvTs >= buy.recvTs && sell.recvTs <= buy.recvTs + windowMs) got += sell.usd;
    }
    if (got + 1e-9 >= buy.usd * frac) return true;
  }
  return false;
}

function cyclesOf(signer) {
  const cycles = [];
  let lastBuy = null;
  let prev = null;
  for (const tr of signer.trades) {
    if (prev === "buy" && tr.side === "sell" && lastBuy != null) {
      cycles.push({ at: tr.recvTs, hold: tr.recvTs - lastBuy });
    }
    if (tr.side === "buy") lastBuy = tr.recvTs;
    prev = tr.side;
  }
  return cycles;
}

function burstTrips(cycles, windowMs, need) {
  for (let i = 0; i < cycles.length; i++) {
    let n = 0;
    for (let j = i; j < cycles.length; j++) {
      if (cycles[j].at - cycles[i].at <= windowMs) n++;
    }
    if (n >= need) return true;
  }
  return false;
}

export function createBook({ chain, create, thresholds, walletIndex }) {
  return {
    chain,
    create,
    thresholds,
    walletIndex,
    signers: new Map(),
    group: null,
    groupTrades: [],
  };
}

function atomicGroup(chain, tr) {
  if (chain === "HOOD") return tr.blockNumber == null ? null : `b:${tr.blockNumber}`;
  return tr.slot == null ? null : `s:${tr.slot}`;
}

export function noteTrade(book, tr) {
  const wallet = tr.signer;
  if (!wallet) return null;
  let signer = book.signers.get(wallet);
  if (!signer) {
    signer = blankSigner(wallet);
    book.signers.set(wallet, signer);
  }
  const usd = tradeUsd(tr);
  const row = { recvTs: tr.recvTs, side: tr.side, usd, raw: tr.tokenRaw ?? 0n, group: atomicGroup(book.chain, tr) };
  signer.trades.push(row);
  if (tr.side === "buy") {
    signer.buys.push(row);
    signer.buyUsd += usd;
    signer.buyRaw += tr.tokenRaw ?? 0n;
    if (signer.firstBuyTs == null) signer.firstBuyTs = tr.recvTs;
    const create = book.create;
    const same =
      book.chain === "HOOD"
        ? tr.blockNumber != null && tr.blockNumber === create.blockNumber
        : tr.slot != null && tr.slot === create.slot;
    const fast = create.recvTs != null && tr.recvTs - create.recvTs <= book.thresholds.sniperWindowMs;
    if (same || fast) signer.sniper = true;
  } else if (tr.side === "sell") {
    signer.sells.push(row);
    signer.sellUsd += usd;
    signer.sellRaw += tr.tokenRaw ?? 0n;
    signer.lastSellTs = tr.recvTs;
  }

  const group = atomicGroup(book.chain, tr);
  if (group == null || group !== book.group) {
    book.group = group;
    book.groupTrades = [];
  }
  if (group != null) {
    book.groupTrades.push({ signer: wallet, side: tr.side });
    if (tr.side === "sell") {
      const seq = book.groupTrades;
      const sellAt = seq.length - 1;
      let buyAt = -1;
      for (let i = 0; i < sellAt; i++) {
        if (seq[i].signer === wallet && seq[i].side === "buy") buyAt = i;
      }
      if (buyAt >= 0) {
        for (let j = buyAt + 1; j < sellAt; j++) {
          if (seq[j].signer !== wallet && seq[j].side === "buy") signer.sandwich = true;
        }
      }
    }
  }
  refresh(book, signer, tr.recvTs);
  return signer;
}

function refresh(book, signer, now) {
  const t = book.thresholds;
  const fast = soldFast(signer, t.flipperWindowMs, t.flipperSellFrac);
  const cycles = cyclesOf(signer);
  const avgHold = cycles.length ? cycles.reduce((sum, c) => sum + c.hold, 0) / cycles.length : Infinity;
  const flipper = fast || burstTrips(cycles, t.roundTripWindowMs, t.roundTrips) || (cycles.length >= 2 && avgHold < t.avgHoldMs);
  const sellOnly = signer.buyRaw === 0n && signer.sellRaw > 0n;
  const creator = book.create?.creator;
  const opSkim = Boolean(creator) && signer.wallet === creator && (sellOnly || signer.sellUsd > signer.buyUsd);
  const hf = book.walletIndex.countAt(signer.wallet, now) >= t.highFrequencyMints;
  const bot = signer.sniper || flipper || signer.sandwich || hf || sellOnly || opSkim;
  const blatant = signer.sandwich || opSkim || fast || sellOnly;
  const twoSided = signer.buyUsd > 0 && signer.sellUsd > 0;
  const net = signer.buyUsd - signer.sellUsd;
  const nurturing = bot && !blatant && (!fast || (twoSided && net >= t.nurtureNetFloorUsd));
  signer.flipper = flipper;
  signer.sellOnly = sellOnly;
  signer.opSkim = opSkim;
  signer.hf = hf;
  signer.bot = bot;
  signer.blatant = blatant;
  signer.nurturing = nurturing;
  signer.twoSided = twoSided;
  signer.netUsd = net;
  signer.fast = fast;
}

export function classOf(signer) {
  if (!signer) return "UNKNOWN";
  if (signer.blatant) return "BLATANT";
  if (signer.nurturing) return "NURTURING";
  if (signer.buyRaw > 0n && !signer.bot) return "REAL";
  return "UNKNOWN";
}

export function subtypeOf(signer) {
  if (!signer) return "unknown";
  if (signer.sandwich) return "sandwich";
  if (signer.opSkim) return "op-skim";
  if (signer.sellOnly) return "sell-only";
  if (signer.flipper) return "flipper";
  if (signer.sniper) return "sniper";
  if (signer.hf) return "high-frequency";
  if (signer.bot && signer.twoSided) return "mm";
  if (signer.bot) return "holder";
  if (signer.buyRaw > 0n) return "real";
  return "unknown";
}

export function labelBook(book) {
  const labels = new Map();
  for (const [wallet, signer] of book.signers) {
    labels.set(wallet, {
      wallet,
      class: classOf(signer),
      subtype: subtypeOf(signer),
      bot: signer.bot,
      blatant: signer.blatant,
      nurturing: signer.nurturing,
      buyUsd: signer.buyUsd,
      sellUsd: signer.sellUsd,
      netUsd: signer.netUsd,
      firstBuyTs: signer.firstBuyTs,
      lastSellTs: signer.lastSellTs,
      buyRaw: signer.buyRaw,
      sellRaw: signer.sellRaw,
    });
  }
  return labels;
}

export function playUntil(trades, create, chain, thresholds, walletIndex, cutoff) {
  const book = createBook({ chain, create, thresholds, walletIndex });
  for (const tr of trades) {
    if (tr.recvTs > cutoff) break;
    noteTrade(book, tr);
  }
  return book;
}

export function windowMix(trades, labels, t0, t1) {
  let botSwaps = 0;
  let blatantSwaps = 0;
  let nurtureSwaps = 0;
  let botNet = 0;
  let nurtureNet = 0;
  let blatantNet = 0;
  let swaps = 0;
  let signedSwaps = 0;
  const real = new Set();
  const buyers = new Set();
  for (const tr of trades) {
    if (tr.recvTs < t0 || tr.recvTs > t1) continue;
    swaps++;
    if (tr.signer) signedSwaps++;
    const label = tr.signer ? labels.get(tr.signer) : null;
    const usd = tradeUsd(tr);
    const signed = tr.side === "buy" ? usd : -usd;
    if (tr.side === "buy" && tr.signer) buyers.add(tr.signer);
    if (tr.side === "buy" && label && label.class === "REAL") real.add(tr.signer);
    if (!label?.bot) continue;
    botSwaps++;
    botNet += signed;
    if (label.blatant) {
      blatantSwaps++;
      blatantNet += signed;
    }
    if (label.nurturing) {
      nurtureSwaps++;
      nurtureNet += signed;
    }
  }
  return {
    swaps,
    signedSwaps,
    botSwaps,
    blatantShare: botSwaps ? (blatantSwaps / botSwaps) * 100 : null,
    nurtureShare: botSwaps ? (nurtureSwaps / botSwaps) * 100 : null,
    botNetUsd: botNet,
    nurtureNetUsd: nurtureNet,
    blatantNetUsd: blatantNet,
    uniqueRealBuyers: real.size,
    uniqueBuyers: buyers.size,
  };
}
