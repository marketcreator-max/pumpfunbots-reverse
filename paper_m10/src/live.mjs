import { createWriteStream } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";
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
import { scoreTape } from "./score.mjs";
import { readJsonl } from "./util.mjs";
import { writeResult, writeManifest } from "./output.mjs";
import { combineReports } from "./report.mjs";

function openTape(path) {
  const stream = createWriteStream(path, { flags: "a" });
  let seq = 0;
  return {
    write(obj) {
      stream.write(`${stringify({ ...obj, seq: seq++ })}\n`);
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
  healthMs = 300_000,
  solPublic = false,
  hoodPublic = false,
  onReady,
}) {
  await mkdir(outDir, { recursive: true });
  const stoppers = [];
  const results = [];
  const started = Date.now();
  const stopAt = started + hours * 3600_000;
  let stopped = false;
  const healthTimer = setInterval(() => {
    for (const chain of chains) logger.info(`health chain=${chain} uptime_s=${Math.round((Date.now() - started) / 1000)}`);
  }, healthMs);

  const tasks = chains.map(async (chain) => {
    const dir = join(outDir, chain);
    await mkdir(dir, { recursive: true });
    const identity = identityFor(chain, runId);
    const tape = openTape(join(dir, "tape.jsonl"));
    tape.write({ type: "meta", ...identity, startedAt: new Date().toISOString() });
    try {
      const handle = chain === "SOL"
        ? await runSol({ dir, identity, tape, configs, logger, keepAll, solPublic, stopAt })
        : await runHood({ dir, identity, tape, configs, logger, keepAll, hoodPublic, stopAt });
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
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(outDir, "report.md"), combineReports(reports));
  await writeFile(join(outDir, "report.json"), JSON.stringify(reports.map((report) => report.json), (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const manifestCount = await writeManifest(outDir);
  logger.info(`manifest files=${manifestCount} run_id=${runId}`);
  return { runId, results };
}

async function runSol({ dir, identity, tape, configs, logger, keepAll, solPublic, stopAt }) {
  const publicFeeds = [
    { name: "public-mainnet", http: "https://api.mainnet-beta.solana.com", ws: "wss://api.mainnet-beta.solana.com" },
    { name: "publicnode", http: "https://solana-rpc.publicnode.com", ws: "wss://solana-rpc.publicnode.com" },
  ];
  const endpoints = solPublic ? publicFeeds[0] : resolveSolEndpoints();
  logger.info(`sol feed source=${solPublic ? "public" : endpoints.name}`);
  const price = createPriceFeed({ logger });
  let latest = await price.solUsd();
  const priceTimer = setInterval(() => {
    price.solUsd().then((row) => { latest = row; }).catch(() => {});
  }, 10_000);
  const index = new WalletIndex();
  const pools = new Map();
  const pending = [];
  const tracked = new Map();
  const lags = [];
  const stats = { creates: 0, trades: 0, dropped: 0, decisions: 0, reconnects: 0, ws: "init" };
  const timers = [];
  let stopped = false;

  const health = setInterval(() => {
    const sorted = [...lags].sort((a, b) => a - b);
    logger.info(`health chain=SOL ws=${stats.ws} creates=${stats.creates} trades=${stats.trades} tracked=${tracked.size} dropped=${stats.dropped} decisions=${stats.decisions} lagP50=${percentile(sorted, 0.5) ?? "na"} lagP95=${percentile(sorted, 0.95) ?? "na"}`);
    appendFile(join(dir, "health.log"), `${new Date().toISOString()} INFO sol creates=${stats.creates} trades=${stats.trades} tracked=${tracked.size}\n`).catch(() => {});
  }, 300_000);

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
      at(600_000, () => decide(event.mint));
    } else if (event.type === "trade") {
      stats.trades++;
      const state = tracked.get(event.mint);
      if (!state) return;
      state.trades.push(event);
      index.add(event.signer, event.mint, event.recvTs);
    }
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
      if (slot != null) {
        solRpc(endpoints.http, "getBlockTime", [slot]).then((blockTime) => {
          if (blockTime == null) return;
          tape.write({ type: "slot", ...identity, slot, blockTime });
          const lag = recvTs - blockTime * 1000;
          lags.push(lag);
          if (lags.length > 5000) lags.shift();
        }).catch(() => {});
      }
    },
  });

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
      for (const id of timers) clearTimeout(id);
      tape.end().then(() => finish());
    },
  };
}

async function runHood({ dir, identity, tape, configs, logger, hoodPublic, stopAt }) {
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
  const price = createPriceFeed({ logger });
  const timers = [];
  const poll = startHoodPoll({
    client,
    config,
    identity,
    price,
    logger,
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
      for (const id of timers) clearTimeout(id);
      tape.end().then(() => finish());
    },
  };
}
