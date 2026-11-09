import { classOf, subtypeOf } from "./classify.mjs";
import { roundUsd } from "./util.mjs";

// Pre-registered from the Nov 8 note. Not fitted on a run's results.
export const TESTABLE_RULES = Object.freeze([
  {
    id: "R1",
    status: "TESTABLE",
    text: "Skip when blatant share of bot swaps in the last 60s before minute 10 is >= 70.",
  },
  {
    id: "R2",
    status: "TESTABLE",
    text: "Enter when nurturing share in that same 60s is >= 50, blatant share is < 50, and unique real buyers in the first 10 minutes are >= 40. Exit on a nurture flip (15s nurturing net flow < -$200).",
  },
  {
    id: "R3",
    status: "TESTABLE",
    text: "Skip when a wallet in the first 10 minutes already has 2 or more earlier rugs and no earlier runner in this run.",
  },
]);

export function predictOutcome(feature) {
  const blatant = feature.blatantShareLast60;
  const nurture = feature.nurtureShareLast60;
  if (feature.botSwapsLast60 == null || feature.botSwapsLast60 < 1 || blatant == null || nurture == null) return "UNKNOWN";
  if (blatant >= 70 || nurture < 20) return "RUG";
  if (nurture >= 50 && blatant < 50) return "RUNNER";
  return "UNKNOWN";
}

export function primaryOutcome({ observed, reached2x, rugged }) {
  if (!observed) return "INCOMPLETE";
  if (reached2x) return "RUNNER";
  if (rugged) return "RUG";
  return "DUD";
}

export function confusion(rows) {
  const predictedKeys = ["RUNNER", "RUG", "UNKNOWN"];
  const actualKeys = ["RUNNER", "RUG", "DUD"];
  const table = {};
  for (const predicted of predictedKeys) {
    table[predicted] = { RUNNER: 0, RUG: 0, DUD: 0, total: 0 };
  }
  for (const row of rows) {
    if (!predictedKeys.includes(row.predicted) || !actualKeys.includes(row.actual)) continue;
    table[row.predicted][row.actual] += 1;
    table[row.predicted].total += 1;
  }
  return table;
}

export function mean(rows, key) {
  const values = rows.map((row) => row[key]).filter((value) => value != null && !Number.isNaN(value));
  if (!values.length) return null;
  return roundUsd(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function mixBuckets(tokens) {
  const groups = [
    ["runners2x", (row) => row.reached2x],
    ["runners5x", (row) => row.reached5x],
    ["rugs", (row) => row.rugged],
    ["duds", (row) => row.outcome === "DUD"],
  ];
  const out = {};
  for (const [name, pred] of groups) {
    const rows = tokens.filter((row) => row.observed && pred(row));
    out[name] = {
      tokens: rows.length,
      blatantShare: mean(rows, "entryBlatant"),
      nurtureShare: mean(rows, "entryNurture"),
      botNetUsd: mean(rows, "entryBotNet"),
      nurtureNetUsd: mean(rows, "entryNurtureNet"),
      realBuyers: mean(rows, "entryReal"),
      peakBlatant: mean(rows, "peakBlatant"),
      peakNurture: mean(rows, "peakNurture"),
      peakBotNet: mean(rows, "peakBotNet"),
      peakNurtureNet: mean(rows, "peakNurtureNet"),
      peakReal: mean(rows, "peakReal"),
      dumpBlatant: mean(rows, "dumpBlatant"),
      dumpNurture: mean(rows, "dumpNurture"),
      dumpBotNet: mean(rows, "dumpBotNet"),
      dumpNurtureNet: mean(rows, "dumpNurtureNet"),
      dumpReal: mean(rows, "dumpReal"),
    };
  }
  return out;
}

export function walletRows(labels, { identity, mint, name, cutoff }) {
  const rows = [];
  for (const label of labels.values()) {
    const holdSec = label.firstBuyTs == null ? null : ((label.lastSellTs ?? cutoff) - label.firstBuyTs) / 1000;
    rows.push({
      ...identity,
      mint,
      token_name: name,
      wallet: label.wallet,
      class: label.class ?? classOf(label),
      subtype: label.subtype ?? subtypeOf(label),
      buy_usd: roundUsd(label.buyUsd),
      sell_usd: roundUsd(label.sellUsd),
      net_flow_usd: roundUsd(label.netUsd),
      hold_sec: holdSec == null ? null : roundUsd(holdSec),
      asof: "entry",
    });
  }
  rows.sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  return rows;
}

export function recurringEvaluation(mintRows) {
  const history = new Map();
  const calls = [];
  const ordered = [...mintRows].sort((a, b) => a.t0 - b.t0 || (a.mint < b.mint ? -1 : 1));
  for (const row of ordered) {
    for (const wallet of row.wallets) {
      const prior = (history.get(wallet) ?? []).filter((item) => item.outcome !== "INCOMPLETE");
      if (prior.length >= 2 && row.outcome !== "INCOMPLETE") {
        const priorRugs = prior.filter((item) => item.outcome === "RUG").length;
        const priorRunners = prior.filter((item) => item.outcome === "RUNNER").length;
        calls.push({
          wallet,
          mint: row.mint,
          token_name: row.name,
          prior: prior.length,
          priorRugs,
          priorRunners,
          flaggedRug: priorRugs >= 2 && priorRunners === 0,
          actual: row.outcome,
        });
      }
    }
    for (const wallet of row.wallets) {
      const list = history.get(wallet) ?? [];
      list.push({ mint: row.mint, outcome: row.outcome, t0: row.t0 });
      history.set(wallet, list);
    }
  }
  const byWallet = new Map();
  for (const [wallet, list] of history) {
    const done = list.filter((item) => item.outcome !== "INCOMPLETE");
    if (done.length < 2) continue;
    byWallet.set(wallet, {
      wallet,
      mints: done.length,
      runners: done.filter((item) => item.outcome === "RUNNER").length,
      rugs: done.filter((item) => item.outcome === "RUG").length,
      duds: done.filter((item) => item.outcome === "DUD").length,
    });
  }
  return {
    wallets: [...byWallet.values()].sort((a, b) => b.rugs - a.rugs || b.mints - a.mints || (a.wallet < b.wallet ? -1 : 1)),
    calls,
  };
}

export function coverageOf(tokens) {
  const withSwaps = tokens.filter((row) => (row.swaps ?? 0) > 0);
  const signed = withSwaps.reduce((sum, row) => sum + (row.signedSwaps ?? 0), 0);
  const swaps = withSwaps.reduce((sum, row) => sum + (row.swaps ?? 0), 0);
  const predicted = tokens.filter((row) => row.observed && row.predicted && row.predicted !== "UNKNOWN");
  const observed = tokens.filter((row) => row.observed);
  return {
    signerPct: swaps ? roundUsd((signed / swaps) * 100) : null,
    predictorPct: observed.length ? roundUsd((predicted.length / observed.length) * 100) : null,
    observed: observed.length,
    incomplete: tokens.filter((row) => !row.observed).length,
  };
}
