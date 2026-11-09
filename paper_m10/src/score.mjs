import { SUPPLY_RAW } from "./constants.mjs";
import { assertIdentity, identityFor } from "./chain.mjs";
import { WalletIndex, windowMix, labelBook, playUntil } from "./classify.mjs";
import { computeFeatures, sliceMix } from "./features.mjs";
import { evaluateGates } from "./gates.mjs";
import { openEntry, pathStats, simulateExit } from "./exits.mjs";
import { spotUsdPerToken } from "./fill.mjs";
import { hydrate, roundUsd } from "./util.mjs";
import {
  TESTABLE_RULES,
  predictOutcome,
  primaryOutcome,
  confusion,
  mixBuckets,
  walletRows,
  recurringEvaluation,
  coverageOf,
} from "./outcome.mjs";
import { buildReport } from "./report.mjs";
import { assessRun, sumGaps } from "./watchdog.mjs";

function midOf(tr, chain) {
  if (chain === "HOOD") return tr.priceUsd ?? null;
  return spotUsdPerToken(tr.virtualSol, tr.virtualToken, tr.solUsd);
}

function reached(mint, ms) {
  const cut = mint.create.recvTs + ms;
  if (mint.watches.some((ts) => ts >= cut)) return true;
  return mint.trades.some((tr) => tr.recvTs >= cut);
}

function decimalsOf(chain, create) {
  if (chain === "HOOD") return create.tokenDecimals ?? 18;
  return 6;
}

function supplyOf(chain, create) {
  if (create.totalSupply && create.totalSupply !== 0n) return create.totalSupply;
  return chain === "SOL" ? SUPPLY_RAW : null;
}

export function scoreTape(rawEvents, cfg) {
  if (!cfg?.chain || !cfg?.runId) throw new Error("scoreTape requires an explicit chain and runId");
  const identity = identityFor(cfg.chain, cfg.runId);
  const events = rawEvents.map(hydrate).sort((a, b) => (a.recvTs ?? 0) - (b.recvTs ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
  for (const event of events) {
    if (event.type === "meta") {
      if (event.chain) assertIdentity(event, identity);
      continue;
    }
    if (!event.chain || event.chain_id == null) {
      throw new Error(`event ${event.type ?? "unknown"} is missing chain identity. Refusing to infer a chain.`);
    }
    assertIdentity(event, identity);
  }
  const index = new WalletIndex();
  const mints = new Map();
  for (const event of events) {
    if (event.type === "create") {
      if (!mints.has(event.mint)) mints.set(event.mint, { create: event, trades: [], watches: [] });
      else if (!mints.get(event.mint).create.name && event.name) mints.get(event.mint).create = { ...mints.get(event.mint).create, ...event };
    } else if (event.type === "trade" && event.mint) {
      const mint = mints.get(event.mint);
      if (!mint) continue;
      mint.trades.push(event);
      index.add(event.signer, event.mint, event.recvTs);
    } else if (event.type === "watch") {
      mints.get(event.mint)?.watches.push(event.recvTs);
    }
  }

  const features = [];
  const decisions = [];
  const scored = [];
  const wallets = [];
  const timelines = [];
  const tokenRows = [];
  const trackMs = cfg.trackAfterDecisionMs ?? 3_600_000;
  const minutes = [5, 10, 15];

  for (const mint of [...mints.keys()].sort()) {
    const state = mints.get(mint);
    const t0 = state.create.recvTs;
    const decimals = decimalsOf(cfg.chain, state.create);
    const supply = supplyOf(cfg.chain, state.create);
    let minute10 = null;
    let labels10 = null;
    for (const minute of minutes) {
      const ms = minute * 60_000;
      if (!reached(state, ms)) continue;
      const computed = computeFeatures({
        chain: cfg.chain,
        create: state.create,
        trades: state.trades,
        cutoff: t0 + ms,
        minute,
        walletIndex: index,
        thresholds: cfg.classify,
      });
      const feature = { ...identity, ...computed.feature };
      features.push(feature);
      if (minute === 10) {
        minute10 = feature;
        labels10 = computed.labels;
      }
    }
    if (!minute10) continue;
    const decs = evaluateGates(minute10, { ...cfg, chain: cfg.chain, runId: cfg.runId });
    decisions.push(...decs);
    wallets.push(...walletRows(labels10, { identity, mint, name: minute10.name, cutoff: minute10.cutoffRecvTs }));

    const timeline = { ...identity, type: "timeline", mint, name: minute10.name, symbol: minute10.symbol, windows: {} };
    const slices = [
      ["0-60s", t0, t0 + 60_000],
      ["1-5m", t0 + 60_000, t0 + 300_000],
      ["5-10m", t0 + 300_000, t0 + 600_000],
    ];
    for (const [label, start, end] of slices) {
      if (!reached(state, end - t0)) continue;
      const mix = sliceMix({
        chain: cfg.chain,
        create: state.create,
        trades: state.trades,
        walletIndex: index,
        thresholds: cfg.classify,
        t0: start,
        t1: end,
      });
      timeline.windows[label] = mix;
    }

    const horizon = minute10.cutoffRecvTs + trackMs;
    const observed = reached(state, horizon - t0);
    let ref = null;
    let refReserve = 0n;
    for (const tr of state.trades) {
      if (tr.recvTs > minute10.cutoffRecvTs) break;
      const mid = midOf(tr, cfg.chain);
      if (mid != null) {
        ref = mid;
        refReserve = tr.virtualSol ?? 0n;
      }
    }
    let peak = ref;
    let peakTrade = null;
    let trough = null;
    let troughTrade = null;
    let rugged = false;
    if (observed && ref != null) {
      for (const tr of state.trades) {
        if (tr.recvTs <= minute10.cutoffRecvTs || tr.recvTs > horizon) continue;
        const mid = midOf(tr, cfg.chain);
        if (mid != null && mid >= peak) {
          peak = mid;
          peakTrade = tr;
          trough = mid;
          troughTrade = tr;
        } else if (peakTrade && mid != null && (trough == null || mid < trough)) {
          trough = mid;
          troughTrade = tr;
        }
        if (peak > 0 && mid != null && (peak - mid) / peak >= 0.8) rugged = true;
        if (cfg.chain === "SOL" && refReserve > 0n && tr.virtualSol != null) {
          if (tr.virtualSol * 100n < refReserve || (refReserve > 50_000_000n && tr.virtualSol < 50_000_000n)) rugged = true;
        }
      }
    }
    const peakMultiple = ref ? peak / ref : 0;
    const reached2x = observed && peakMultiple >= 2;
    const reached5x = observed && peakMultiple >= 5;
    const outcome = primaryOutcome({ observed, reached2x, rugged: observed && rugged });
    let peakMix = null;
    let dumpMix = null;
    if (peakTrade) {
      peakMix = windowMix(
        state.trades,
        labelBook(playUntil(state.trades, state.create, cfg.chain, cfg.classify, index, peakTrade.recvTs)),
        peakTrade.recvTs - 60_000,
        peakTrade.recvTs,
      );
      timeline.windows.peak = peakMix;
    }
    if (troughTrade && peakTrade && troughTrade.recvTs > peakTrade.recvTs) {
      dumpMix = windowMix(
        state.trades,
        labelBook(playUntil(state.trades, state.create, cfg.chain, cfg.classify, index, troughTrade.recvTs)),
        peakTrade.recvTs,
        troughTrade.recvTs,
      );
      timeline.windows.dump = dumpMix;
    }
    timeline.outcome = outcome;
    timelines.push(timeline);

    const token = {
      ...identity,
      mint,
      name: minute10.name,
      symbol: minute10.symbol,
      t0,
      observed,
      outcome,
      reached2x,
      reached5x,
      rugged: observed && rugged,
      peakMultiple: roundUsd(peakMultiple),
      predicted: predictOutcome(minute10),
      swaps: minute10.swaps,
      signedSwaps: minute10.signedSwaps,
      entryBlatant: minute10.blatantShare0_10,
      entryNurture: minute10.nurtureShare0_10,
      entryBotNet: minute10.botNetUsd0_10,
      entryNurtureNet: minute10.nurtureNetUsd0_10,
      entryReal: minute10.uniqueRealBuyers,
      entryBlatant60: minute10.blatantShareLast60,
      entryNurture60: minute10.nurtureShareLast60,
      peakBlatant: peakMix?.blatantShare ?? null,
      peakNurture: peakMix?.nurtureShare ?? null,
      peakBotNet: peakMix ? roundUsd(peakMix.botNetUsd) : null,
      peakNurtureNet: peakMix ? roundUsd(peakMix.nurtureNetUsd) : null,
      peakReal: peakMix?.uniqueRealBuyers ?? null,
      dumpBlatant: dumpMix?.blatantShare ?? null,
      dumpNurture: dumpMix?.nurtureShare ?? null,
      dumpBotNet: dumpMix ? roundUsd(dumpMix.botNetUsd) : null,
      dumpNurtureNet: dumpMix ? roundUsd(dumpMix.nurtureNetUsd) : null,
      dumpReal: dumpMix?.uniqueRealBuyers ?? null,
      wallets: [...labels10.keys()],
      gatePass: decs.filter((row) => row.pass).map((row) => row.gateId),
    };
    tokenRows.push(token);

    for (const decision of decs.filter((row) => row.pass)) {
      for (const delay of cfg.fees.entryDelayMs) {
        const entry = openEntry({
          trades: state.trades,
          decisionRecvTs: minute10.cutoffRecvTs,
          delayMs: delay,
          fees: cfg.fees,
          chain: cfg.chain,
          supplyRaw: supply,
          decimals,
        });
        if (!entry) {
          scored.push({ ...identity, gateId: decision.gateId, delayMs: delay, mint, name: minute10.name, symbol: minute10.symbol, filled: false });
          continue;
        }
        const stats = pathStats({
          trades: state.trades,
          entry,
          horizonRecvTs: horizon,
          chain: cfg.chain,
          entryReserve: entry.trade.virtualSol ?? 0n,
        });
        for (const exit of cfg.exits.exits) {
          const sim = simulateExit({
            spec: exit,
            trades: state.trades,
            create: state.create,
            entry,
            horizonRecvTs: horizon,
            chain: cfg.chain,
            walletIndex: index,
            thresholds: cfg.classify,
            supplyRaw: supply ?? 0n,
            decimals,
            fees: cfg.fees,
            windowComplete: observed,
          });
          scored.push({
            ...identity,
            gateId: decision.gateId,
            exitId: exit.id,
            exitLabel: exit.label,
            house: Boolean(exit.house),
            research: Boolean(exit.research),
            delayMs: delay,
            mint,
            name: minute10.name,
            symbol: minute10.symbol,
            filled: true,
            incomplete: Boolean(sim.incomplete),
            pnlUsd: roundUsd(sim.pnlUsd),
            exitMultiple: roundUsd(sim.exitMultiple),
            peakMultiple: roundUsd(stats.peakMultiple),
            kept2x: sim.exitMultiple >= 2,
            reached2x: stats.reached2x,
            reached5x: stats.reached5x,
            rugged: stats.rugged,
            stale: sim.stale,
            reason: sim.reason,
          });
        }
      }
    }
  }

  const operators = slotOperators(mints, tokenRows, identity, cfg.chain, cfg.classify.bundleMinBuys ?? 3);
  const recurring = recurringEvaluation(tokenRows);
  const observedTokens = tokenRows.filter((row) => row.observed);
  const gapInfo = sumGaps([
    ...events.filter((event) => event.type === "gap"),
    ...(cfg.extraGaps ?? []),
  ]);
  let firstTs = null;
  let lastTs = null;
  for (const event of events) {
    if (typeof event.recvTs !== "number") continue;
    if (firstTs == null || event.recvTs < firstTs) firstTs = event.recvTs;
    if (lastTs == null || event.recvTs > lastTs) lastTs = event.recvTs;
  }
  const durationMs = cfg.durationMs ?? (firstTs != null && lastTs != null ? lastTs - firstTs : 0);
  const validity = assessRun({
    decided: tokenRows.length,
    incomplete: tokenRows.filter((row) => !row.observed).length,
    gapMs: gapInfo.total,
    durationMs,
  });
  const north = {
    rules: TESTABLE_RULES,
    coverage: coverageOf(tokenRows),
    buckets: mixBuckets(observedTokens),
    confusion: confusion(observedTokens.map((row) => ({ predicted: row.predicted, actual: row.outcome }))),
    confusionG0: confusion(observedTokens.filter((row) => row.gatePass.includes("G0")).map((row) => ({ predicted: row.predicted, actual: row.outcome }))),
    recurring,
    runners: observedTokens.filter((row) => row.reached2x).sort((a, b) => b.peakMultiple - a.peakMultiple),
    validity,
    gaps: gapInfo.rows,
  };
  const report = buildReport({ identity, features, decisions, scored, exits: cfg.exits, gates: cfg.gates, north, tokens: tokenRows });
  return { identity, features, decisions, scored, wallets, timelines, operators, tokens: tokenRows, north, report };
}

function slotOperators(mints, tokenRows, identity, chain, minBuys) {
  if (chain !== "SOL") return [];
  const outcome = new Map(tokenRows.map((row) => [row.mint, row.outcome]));
  const rows = [];
  for (const [mint, state] of mints) {
    const cutoff = state.create.recvTs + 600_000;
    const slots = new Map();
    for (const tr of state.trades) {
      if (tr.recvTs > cutoff || tr.side !== "buy" || tr.slot == null || !tr.signer) continue;
      let group = slots.get(tr.slot);
      if (!group) {
        group = new Set();
        slots.set(tr.slot, group);
      }
      group.add(tr.signer);
    }
    for (const [slot, signers] of slots) {
      if (signers.size < minBuys) continue;
      rows.push({
        ...identity,
        operator_id: `slot:${mint}:${slot}`,
        kind: "same-slot",
        funder: "",
        mint,
        token_name: state.create.name ?? "",
        wallets: [...signers].sort().join(" "),
        wallet_count: signers.size,
        outcome: outcome.get(mint) ?? "INCOMPLETE",
      });
    }
  }
  rows.sort((a, b) => (a.operator_id < b.operator_id ? -1 : 1));
  return rows;
}
