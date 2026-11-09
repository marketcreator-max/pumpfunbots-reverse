import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfigs } from "./config.mjs";
import { createLogger } from "./redact.mjs";
import { readJsonl } from "./util.mjs";
import { scoreTape } from "./score.mjs";
import { writeResult, writeManifest } from "./output.mjs";
import { runLive } from "./live.mjs";
import { parseHoodConfig, createHoodClient, assertHoodChain } from "./hood.mjs";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function chainList(value) {
  const chains = String(value ?? "SOL").split(",").map((item) => item.trim()).filter(Boolean);
  for (const chain of chains) {
    if (chain !== "SOL" && chain !== "HOOD") {
      throw new Error(`Unknown chain ${chain}. Pass SOL, HOOD, or SOL,HOOD. Refusing to infer.`);
    }
  }
  if (!chains.length) throw new Error("Pass --chains SOL, HOOD, or SOL,HOOD.");
  return chains;
}

async function replay(flags) {
  if (!flags.tape || !flags.out || !flags.chain) {
    throw new Error("replay requires --tape, --out, and --chain (SOL or HOOD).");
  }
  const chain = chainList(flags.chain)[0];
  const configs = loadConfigs({ gates: flags.gates, exits: flags.exits, fees: flags.fees });
  const events = readJsonl(flags.tape);
  const meta = events.find((event) => event.type === "meta");
  const runId = flags["run-id"] || meta?.run_id;
  if (!runId) throw new Error("replay requires --run-id or a meta row with run_id");
  const result = scoreTape(events, { ...configs, chain, runId });
  await writeResult(flags.out, result);
  await writeManifest(flags.out);
  console.log(`replay ${chain} entries=${result.scored.filter((row) => row.filled).length} wrote ${flags.out}`);
}

async function smoke(flags) {
  const seconds = Math.min(180, Number(flags.seconds ?? 90));
  const out = flags.out ?? "out/smoke";
  await mkdir(out, { recursive: true });
  const logger = createLogger();
  const configs = loadConfigs();
  const report = { seconds, sol: null, hood: null };
  const solRun = runLive({
    outDir: join(out, "sol-run"),
    hours: seconds / 3600,
    chains: ["SOL"],
    configs,
    logger,
    solPublic: true,
    healthMs: 20_000,
  }).then((result) => {
    report.sol = { ok: true, runId: result.runId };
  }).catch((error) => {
    report.sol = { ok: false, error: error.message };
  });

  try {
    const hood = parseHoodConfig(configs.hood);
    const client = createHoodClient(hood.urls, { logger });
    const chainId = await assertHoodChain(client);
    const head = await client.call("eth_blockNumber", []);
    const headN = Number(BigInt(head));
    const from = "0x" + Math.max(0, headN - 20).toString(16);
    const logs = await client.call("eth_getLogs", [{
      fromBlock: from,
      toBlock: head,
      address: hood.factory,
      topics: [hood.poolCreatedTopic],
    }]);
    report.hood = { ok: true, chainId, head, poolCreatedLogs: Array.isArray(logs) ? logs.length : 0, factory: hood.factory };
  } catch (error) {
    report.hood = { ok: false, error: error.message };
  }
  await solRun;
  await writeFile(join(out, "smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  logger.info(`smoke wrote ${out}/smoke.json`);
  if (!report.hood?.ok && !report.sol?.ok) process.exitCode = 1;
}

async function main() {
  const flags = args(process.argv.slice(2));
  const command = flags._[0] ?? "live";
  if (command === "replay") {
    await replay(flags);
    return;
  }
  if (command === "smoke") {
    await smoke(flags);
    return;
  }
  if (command !== "live") throw new Error(`Unknown command ${command}`);
  if (!flags.hours || !flags.out) throw new Error("live requires --hours and --out");
  const chains = chainList(flags.chains);
  const configs = loadConfigs({ gates: flags.gates, exits: flags.exits, fees: flags.fees });
  const logger = createLogger();
  await runLive({
    outDir: flags.out,
    hours: Number(flags.hours),
    chains,
    configs,
    logger,
    keepAll: Boolean(flags["keep-all"]),
    runId: flags["run-id"],
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

export { args, chainList };
