import { spawn } from "node:child_process";
import { readFile, writeFile, appendFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./redact.mjs";
import { durationMs, shouldRestart } from "./watchdog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rand = Math.random().toString(16).slice(2, 10);
  return `m10-${stamp}-${rand}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function heartbeatAt(outDir) {
  try {
    const raw = JSON.parse(await readFile(join(outDir, "heartbeat.json"), "utf8"));
    return Number(raw.t) || null;
  } catch {
    return null;
  }
}

function spawnEngine({ outDir, chains, runId, hours, keepAll, logger }) {
  const args = [
    join(ROOT, "src", "cli.mjs"),
    "engine",
    "--out", outDir,
    "--chains", chains,
    "--run-id", runId,
    "--hours", String(hours),
  ];
  if (keepAll) args.push("--keep-all");
  logger.info(`engine start run_id=${runId}`);
  return spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
}

function killChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  const timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, 5_000);
  child.once("exit", () => clearTimeout(timer));
}

async function watchChild(child, { deadline, outDir, logger }) {
  const startedAt = Date.now();
  let settled = false;
  let killed = null;
  return new Promise((resolve) => {
    let timer = null;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      resolve(reason);
    };
    child.once("exit", (code) => {
      if (killed) finish(killed);
      else if (Date.now() >= deadline) finish("deadline");
      else finish(code === 0 ? "exit" : "crash");
    });
    timer = setInterval(async () => {
      if (killed) return;
      if (Date.now() >= deadline) {
        killed = "deadline";
        logger.info("deadline reached, stopping engine for scoring");
        killChild(child);
        return;
      }
      const beat = await heartbeatAt(outDir);
      if (shouldRestart({ now: Date.now(), startedAt, heartbeatAt: beat })) {
        killed = "stall";
        logger.warn("GAP supervisor stall, restarting engine");
        const end = Date.now();
        await appendFile(join(outDir, "gaps.jsonl"), `${JSON.stringify({ type: "gap", start: beat ?? startedAt, end, reason: "stall" })}\n`).catch(() => {});
        killChild(child);
      }
    }, 10_000);
  });
}

export async function supervise({ outDir, chains, hours = 0, minutes = 0, keepAll = false, runId, logger = createLogger() }) {
  if (!process.stdout.isTTY) process.stdout._handle?.setBlocking?.(true);
  const duration = durationMs({ hours, minutes });
  if (duration <= 0) throw new Error("duration must be positive");
  await mkdir(outDir, { recursive: true });
  const idPath = join(outDir, "run_id");
  if (!runId) {
    try { runId = (await readFile(idPath, "utf8")).trim(); } catch { runId = makeRunId(); }
  }
  await writeFile(idPath, `${runId}\n`);
  const startedAt = Date.now();
  const deadline = startedAt + duration;
  await writeFile(join(outDir, "started.json"), `${JSON.stringify({ runId, startedAt, durationMs: duration, chains })}\n`);
  logger.info(`supervisor run_id=${runId} duration_s=${Math.round(duration / 1000)} chains=${chains}`);

  while (Date.now() < deadline) {
    const remainingHours = Math.max(duration / 3_600_000, (deadline - Date.now()) / 3_600_000);
    const child = spawnEngine({ outDir, chains, runId, hours: remainingHours, keepAll, logger });
    const reason = await watchChild(child, { deadline, outDir, logger });
    if (reason === "deadline" || reason === "exit" && Date.now() >= deadline - 1000) break;
    if (reason === "crash" || reason === "stall") {
      const end = Date.now();
      await appendFile(join(outDir, "gaps.jsonl"), `${JSON.stringify({ type: "gap", start: end - 1000, end, reason })}\n`).catch(() => {});
      logger.warn(`GAP restart after ${reason}`);
    }
    if (Date.now() >= deadline) break;
    await sleep(2_000);
  }

  logger.info("supervisor scoring");
  const score = spawn(process.execPath, [
    join(ROOT, "src", "cli.mjs"),
    "score",
    "--out", outDir,
    "--chains", chains,
    "--run-id", runId,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  const code = await new Promise((resolve) => score.once("exit", resolve));
  try {
    const info = await stat(join(outDir, "report.md"));
    logger.info(`supervisor report bytes=${info.size} exit=${code}`);
  } catch {
    logger.error("supervisor score did not write report.md");
  }
  return { runId, code };
}
