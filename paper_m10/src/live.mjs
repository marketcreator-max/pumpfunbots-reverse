import { createWriteStream, statSync } from "node:fs";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM } from "./constants.mjs";
import { identityFor } from "./chain.mjs";
import { WalletIndex } from "./classify.mjs";
import { eventsFromLogs } from "./decode.mjs";
import { computeFeatures } from "./features.mjs";
import { evaluateGates } from "./gates.mjs";
import { parseHoodConfig, createHoodClient, assertHoodChain, startHoodPoll, hoodEndpoints } from "./hood.mjs";
import { createPriceFeed } from "./price.mjs";
import { resolveSolEndpoints, solRpc, subscribeSolLogs } from "./rpc.mjs";
import { stringify, percentile } from "./util.mjs";
import { GAP_MS, HEARTBEAT_MS, gapDue } from "./watchdog.mjs";

const MAX_TRADES = 2500;
const KEEP_HEAD = 400;
const MAX_TRACKED = 800;
const MAX_WALLETS = 200_000;
const MAX_TAPE_QUEUE = 5000;

function lineBuffer() {
  if (!process.stdout.isTTY) process.stdout._handle?.setBlocking?.(true);
  if (!process.stderr.isTTY) process.stderr._handle?.setBlocking?.(true);
}
import { scoreTape } from "./score.mjs";
import { readJsonl } from "./util.mjs";
import { writeResult, writeManifest } from "./output.mjs";
import { combineReports } from "./report.mjs";

function openTape(path, onRow) {
  const stream = createWriteStream(path, { flags: "a", highWaterMark: 256 * 1024 });
  let seq = Date.now();
  const queue = [];
  let blocked = false;
  let skipped = 0;
  const drain = () => {
    while (queue.length && !blocked) {
      const line = queue.shift();
      blocked = !stream.write(line);
      if (blocked) {
        stream.once("drain", () => {
          blocked = false;
          drain();
        });
      }
    }
  };
  return {
    skipped: () => skipped,
    write(obj) {
      if (queue.length >= MAX_TAPE_QUEUE) {
        skipped++;
        return false;
      }
      queue.push(`${stringify({ ...obj, seq: seq++ })}\n`);
      onRow?.(obj);
      drain();
      return true;
    },
    flush() {
      return new Promise((resolve) => stream.write("", resolve));
    },
    end() {
      return new Promise((resolve) => stream.end(resolve));
    },
  };
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rand = Math.random().toString(16).slice(2, 10);
  return `m10-${stamp}-${rand}`;
}

export async function runLive({
  outDir,
  hours,
  chains,
  configs,
  runId = makeRunId(),
  logger,
  keepAll = false,
  healthMs = HEARTBEAT_MS,
  fetchImpl,
  createSolSocket,
  solPublic = false,
  hoodPublic = false,
  scoreAtEnd = false,
  onReady,
}) {
  lineBuffer();
  await mkdir(outDir, { recursive: true });
  const pulse = { lastTapeAt: null, gaps: 0, loopLagMs: 0, sol: {}, hood: {} };
  const stoppers = [];
  const results = [];
  const started = Date.now();
  const stopAt = started + hours * 3600_000;
  let stopped = false;
  let lagMark = Date.now();
  const beat = () => {
    const now = Date.now();
    pulse.loopLagMs = Math.max(0, now - lagMark - HEARTBEAT_MS);
    lagMark = now;
    logger.info(`loop-lag ms=${pulse.loopLagMs}`);
    const sol = pulse.sol;
    const hood = pulse.hood;
    logger.info(`health chain=SOL ws=${sol.ws ?? "na"} creates=${sol.creates ?? 0} trades=${sol.trades ?? 0} tracked=${sol.tracked ?? 0} dropped=${sol.dropped ?? 0} gaps=${sol.gaps ?? 0} skipped=${sol.skipped ?? 0} lagP95=${sol.lagP95 ?? "na"}`);
    logger.info(`health chain=HOOD polls=${hood.polls ?? 0} events=${hood.events ?? 0} errors=${hood.errors ?? 0} rateLimits=${hood.rateLimits ?? 0} head=${hood.head ?? "na"} skippedBlocks=${hood.skippedBlocks ?? 0}`);
    writeFile(join(outDir, "heartbeat.json"), `${JSON.stringify({ t: now, runId, loopLagMs: pulse.loopLagMs, lastTapeAt: pulse.lastTapeAt, sol, hood })}\n`).catch(() => {});
  };
  beat();
  const healthTimer = setInterval(beat, Math.min(healthMs, HEARTBEAT_MS));

  const tasks = chains.map(async (chain) => {
    const dir = join(outDir, chain);
    await mkdir(dir, { recursive: true });
    const identity = identityFor(chain, runId);
    const tapePath = join(dir, "tape.jsonl");
    let existing = false;
    try { existing = statSync(tapePath).size > 0; } catch { /* new tape */ }
    const tape = openTape(tapePath, (obj) => {
      if (obj?.type === "gap") return;
      pulse.lastTapeAt = Date.now();
    });
    if (!existing) tape.write({ type: "meta", ...identity, startedAt: new Date().toISOString() });
    else tape.write({ type: "resume", ...identity, at: Date.now() });
    try {
      const handle = chain === "SOL"
        ? await runSol({ dir, identity, tape, configs, logger, keepAll, solPublic, stopAt, pulse, fetchImpl, createSolSocket })
        : await runHood({ dir, identity, tape, configs, logger, keepAll, hoodPublic, stopAt, pulse, fetchImpl });
      stoppers.push(handle.stop);
      await handle.done;
    } catch (error) {
      logger.error(`${chain} failed: ${error.message}`);
    }
  });

  onReady?.({ runId, outDir });
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(healthTimer);
    for (const stop of stoppers) stop();
  };
  const timer = setTimeout(shutdown, Math.max(0, stopAt - Date.now()));
  process.on("SIGHUP", () => {});
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await Promise.all(tasks);
  clearTimeout(timer);
  await shutdown();
  if (!scoreAtEnd) return { runId, results };

  const reports = [];
  for (const chain of chains) {
    const dir = join(outDir, chain);
    await appendFile(join(dir, "health.log"), `${new Date().toISOString()} INFO scoring ${chain}\n`);
    const events = readJsonl(join(dir, "tape.jsonl"));
    const result = scoreTape(events, { ...configs, chain, runId });
    await writeResult(dir, result);
    reports.push(result.report);
    results.push(result);
  }
  await writeFile(join(outDir, "report.md"), combineReports(reports));
  await writeFile(join(outDir, "report.json"), JSON.stringify(reports.map((report) => report.json), (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const manifestCount = await writeManifest(outDir);
  logger.info(`manifest files=${manifestCount} run_id=${runId}`);
  return { runId, results };
}

async function runSol({ dir, identity, tape, configs, logger, keepAll, solPublic, pulse, fetchImpl, createSolSocket }) {
  const publicFeeds = [
    { name: "public-mainnet", http: "https://api.mainnet-beta.solana.com", ws: "wss://api.mainnet-beta.solana.com" },
    { name: "publicnode", http: "https://solana-rpc.publicnode.com", ws: "wss://solana-rpc.publicnode.com" },
  ];
  const endpoints = solPublic ? publicFeeds[0] : resolveSolEndpoints();
  logger.info(`sol feed source=${solPublic ? "public" : endpoints.name}`);
  const price = createPriceFeed({ logger, fetchImpl });
  let latest = await price.solUsd();
  const priceTimer = setInterval(() => {
    price.solUsd().then((row) => { latest = row; }).catch(() => {});
  }, 10_000);
  const index = new WalletIndex();
  const pools = new Map();
  const pending = [];
  const tracked = new Map();
  const lags = [];
  const stats = { creates: 0, trades: 0, dropped: 0, decisions: 0, reconnects: 0, ws: "init", gaps: 0, skipped: 0 };
  const timers = [];
  let stopped = false;
  let gapOpen = null;
  pulse.sol = stats;
  const slotQueue = [];
  const seenSlots = new Set();
  let slotInflight = 0;

  function publishSol() {
    const sorted = [...lags].sort((a, b) => a - b);
    stats.tracked = tracked.size;
    stats.skipped = tape.skipped();
    stats.lagP50 = percentile(sorted, 0.5);
    stats.lagP95 = percentile(sorted, 0.95);
    appendFile(join(dir, "health.log"), `${new Date().toISOString()} INFO chain=SOL ws=${stats.ws} creates=${stats.creates} trades=${stats.trades} tracked=${stats.tracked} dropped=${stats.dropped} gaps=${stats.gaps} skipped=${stats.skipped} lagP95=${stats.lagP95 ?? "na"}\n`).catch(() => {});
  }

  const health = setInterval(publishSol, HEARTBEAT_MS);

  function wantBlockTime(slot, recvTs) {
    if (slot == null || seenSlots.has(slot)) return;
    seenSlots.add(slot);
    if (seenSlots.size > 20_000) seenSlots.clear();
    slotQueue.push({ slot, recvTs });
    if (slotQueue.length > 100) slotQueue.splice(0, slotQueue.length - 100);
    pumpSlots();
  }

  function pumpSlots() {
    while (slotInflight < 2 && slotQueue.length) {
      const job = slotQueue.shift();
      slotInflight++;
      solRpc(endpoints.http, "getBlockTime", [job.slot]).then((blockTime) => {
        if (blockTime == null) return;
        tape.write({ type: "slot", ...identity, slot: job.slot, blockTime });
        lags.push(job.recvTs - blockTime * 1000);
        if (lags.length > 2000) lags.splice(0, lags.length - 2000);
      }).catch(() => {}).finally(() => {
        slotInflight--;
        pumpSlots();
      });
    }
  }

  function remember(event) {
    if (event.type === "pool" || event.type === "migrate") {
      if (event.pool && event.mint) pools.set(event.pool, event.mint);
      tape.write(event);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].pool === event.pool) {
          const trade = pending.splice(i, 1)[0];
          trade.mint = event.mint;
          remember(trade);
        }
      }
      return;
    }
    if (event.type === "trade" && !event.mint && event.pool) {
      const mint = pools.get(event.pool);
      if (mint) event.mint = mint;
      else {
        pending.push(event);
        if (pending.length > 500) pending.shift();
        return;
      }
    }
    if (event.type === "trade" && event.mint && !tracked.has(event.mint)) return;
    if (event.blockTime != null) {
      const lag = event.recvTs - event.blockTime * 1000;
      lags.push(lag);
      if (lags.length > 5000) lags.shift();
    }
    tape.write(event);
    if (event.type === "create") {
      stats.creates++;
      const state = { create: event, trades: [], timers: [] };
      tracked.set(event.mint, state);
      const at = (ms, fn) => {
        const id = setTimeout(fn, Math.max(0, event.recvTs + ms - Date.now()));
        state.timers.push(id);
        timers.push(id);
      };
      at(300_000, () => tape.write({ type: "watch", ...identity, mint: event.mint, recvTs: event.recvTs + 300_000 }));
      at(600_000, () => scheduleDecide(event.mint));
      if (tracked.size > MAX_TRACKED) {
        const oldest = tracked.keys().next().value;
        const victim = tracked.get(oldest);
        if (victim && oldest !== event.mint) {
          for (const id of victim.timers) clearTimeout(id);
          tracked.delete(oldest);
          stats.dropped++;
        }
      }
    } else if (event.type === "trade") {
      stats.trades++;
      const state = tracked.get(event.mint);
      if (!state) return;
      state.trades.push(event);
      if (state.trades.length > MAX_TRADES) {
        state.trades = state.trades.slice(0, KEEP_HEAD).concat(state.trades.slice(state.trades.length - (MAX_TRADES - KEEP_HEAD)));
        state.trimmed = true;
      }
      if (index.mints.size < MAX_WALLETS) index.add(event.signer, event.mint, event.recvTs);
    }
  }

  const decideQueue = [];
  let deciding = false;
  function scheduleDecide(mint) {
    decideQueue.push(mint);
    if (!deciding) {
      deciding = true;
      setImmediate(drainDecisions);
    }
  }
  function drainDecisions() {
    const mint = decideQueue.shift();
    if (!mint || stopped) {
      deciding = false;
      return;
    }
    try { decide(mint); } catch (error) { logger.error(`decide failed: ${error.message}`); }
    setImmediate(drainDecisions);
  }

  function decide(mint) {
    const state = tracked.get(mint);
    if (!state || stopped) return;
    const cutoff = state.create.recvTs + 600_000;
    tape.write({ type: "watch", ...identity, mint, recvTs: cutoff });
    const computed = computeFeatures({
      chain: "SOL",
      create: state.create,
      trades: state.trades,
      cutoff,
      minute: 10,
      walletIndex: index,
      thresholds: configs.classify,
    });
    const decisions = evaluateGates({ ...identity, ...computed.feature }, { ...configs, chain: "SOL", runId: identity.run_id });
    for (const decision of decisions) {
      appendFile(join(dir, "decisions.live.jsonl"), `${stringify(decision)}\n`).catch(() => {});
      stats.decisions++;
    }
    const keep = keepAll || decisions.some((row) => row.pass);
    if (!keep) {
      stats.dropped++;
      for (const id of state.timers) clearTimeout(id);
      tracked.delete(mint);
      return;
    }
    const watch = (ms) => tape.write({ type: "watch", ...identity, mint, recvTs: state.create.recvTs + ms });
    const later = (ms) => {
      const id = setTimeout(() => watch(ms), Math.max(0, state.create.recvTs + ms - Date.now()));
      timers.push(id);
    };
    later(900_000);
    later(4_200_000);
  }

  const feed = subscribeSolLogs({
    wsUrl: endpoints.ws,
    wsUrls: solPublic ? publicFeeds.map((item) => item.ws) : [endpoints.ws],
    createSocket: createSolSocket,
    mentions: [PUMP_PROGRAM, PUMP_AMM_PROGRAM],
    logger,
    onStatus: ({ state }) => {
      stats.ws = state;
      if (state === "closed") stats.reconnects++;
    },
    onLogs: (params) => {
      const value = params?.result?.value;
      if (!value || value.err) return;
      const slot = params.result.context?.slot ?? null;
      const recvTs = Date.now();
      const decoded = eventsFromLogs({
        logs: value.logs,
        slot,
        signature: value.signature,
        recvTs,
        blockTime: null,
        solUsd: latest?.usd ?? null,
        solUsdAt: latest?.at ?? null,
        runId: identity.run_id,
      });
      const ordered = [
        ...decoded.filter((event) => event.type === "create" || event.type === "pool" || event.type === "migrate"),
        ...decoded.filter((event) => event.type === "trade"),
      ];
      for (const event of ordered) remember(event);
      wantBlockTime(slot, recvTs);
    },
  });

  const gapTimer = setInterval(() => {
    const now = Date.now();
    if (gapOpen != null && pulse.lastTapeAt != null && pulse.lastTapeAt > gapOpen) {
      tape.write({ type: "gap", ...identity, gapStart: gapOpen, gapEnd: pulse.lastTapeAt, reason: "silence", recvTs: pulse.lastTapeAt });
      logger.warn(`GAP sol closed ${pulse.lastTapeAt - gapOpen}ms`);
      gapOpen = null;
      return;
    }
    if (!gapDue(pulse.lastTapeAt, now, GAP_MS) || gapOpen != null) return;
    gapOpen = pulse.lastTapeAt;
    stats.gaps++;
    pulse.gaps++;
    logger.warn(`GAP sol no tape row for ${GAP_MS}ms, reconnecting`);
    feed.forceReconnect();
  }, 5_000);

  let finish = () => {};
  const done = new Promise((resolve) => { finish = resolve; });

  return {
    done,
    stop() {
      if (stopped) return;
      stopped = true;
      feed.stop();
      price.stop();
      clearInterval(priceTimer);
      clearInterval(health);
      clearInterval(gapTimer);
      for (const id of timers) clearTimeout(id);
      tape.end().then(() => finish());
    },
  };
}

async function runHood({ dir, identity, tape, configs, logger, hoodPublic, pulse, fetchImpl }) {
  let config;
  try {
    config = parseHoodConfig(configs.hood);
  } catch (error) {
    logger.error(error.message);
    await appendFile(join(dir, "ERROR.txt"), `${error.message}\n`);
    tape.write({ type: "error", ...identity, message: error.message });
    await tape.end();
    throw error;
  }
  const urls = hoodPublic ? config.urls : hoodEndpoints(config);
  logger.info(`hood endpoints=${urls.length} factory=${config.factory}`);
  const client = createHoodClient(urls, { logger });
  try {
    const chainId = await assertHoodChain(client);
    logger.info(`hood eth_chainId=${chainId}`);
  } catch (error) {
    logger.error(error.message);
    await appendFile(join(dir, "ERROR.txt"), `${error.message}\n`);
    tape.write({ type: "error", ...identity, message: error.message });
    await tape.end();
    throw error;
  }
  const price = createPriceFeed({ logger, fetchImpl });
  const timers = [];
  const hoodStats = { polls: 0, errors: 0, rateLimits: 0, events: 0, skippedBlocks: 0, head: null };
  pulse.hood = hoodStats;
  const poll = startHoodPoll({
    client,
    config,
    identity,
    price,
    logger,
    stats: hoodStats,
    onEvents: async (events) => {
      for (const event of events) {
        tape.write(event);
        if (event.type !== "create") continue;
        // Minute 10 is the pool's block time plus 10 minutes, not the poll delay.
        for (const ms of [300_000, 600_000, 900_000, 4_200_000]) {
          const id = setTimeout(() => {
            tape.write({ type: "watch", ...identity, mint: event.mint, recvTs: event.recvTs + ms });
          }, Math.max(0, event.recvTs + ms - Date.now()));
          timers.push(id);
        }
      }
    },
  });
  let finish = () => {};
  const done = new Promise((resolve) => { finish = resolve; });
  return {
    done,
    stop() {
      poll.stop();
      price.stop();
      for (const id of timers) clearTimeout(id);
      tape.end().then(() => finish());
    },
  };
}
