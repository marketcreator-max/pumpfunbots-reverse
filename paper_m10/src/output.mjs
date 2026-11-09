import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify, toCsv } from "./util.mjs";

const WALLET_COLUMNS = [
  "chain", "chain_id", "strategy_version", "run_id", "mint", "token_name", "wallet",
  "class", "subtype", "buy_usd", "sell_usd", "net_flow_usd", "hold_sec", "asof",
];

const OPERATOR_COLUMNS = [
  "chain", "chain_id", "strategy_version", "run_id", "operator_id", "kind", "funder",
  "mint", "token_name", "wallets", "wallet_count", "outcome",
];

async function walk(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files;
}

export async function writeResult(dir, result) {
  await mkdir(dir, { recursive: true });
  const json = (value) => stringify(value);
  await writeFile(join(dir, "report.md"), result.report.markdown);
  await writeFile(join(dir, "report.json"), JSON.stringify(result.report.json, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  await writeFile(join(dir, "wallets.csv"), toCsv(result.wallets, WALLET_COLUMNS));
  await writeFile(join(dir, "operators.csv"), toCsv(result.operators, OPERATOR_COLUMNS));
  await writeFile(join(dir, "timelines.jsonl"), result.timelines.map((row) => json(row)).join("\n") + (result.timelines.length ? "\n" : ""));
  await writeFile(join(dir, "features.jsonl"), result.features.map((row) => json(row)).join("\n") + (result.features.length ? "\n" : ""));
  await writeFile(join(dir, "decisions.jsonl"), result.decisions.map((row) => json(row)).join("\n") + (result.decisions.length ? "\n" : ""));
  await writeFile(join(dir, "exits.jsonl"), result.scored.map((row) => json(row)).join("\n") + (result.scored.length ? "\n" : ""));
  await writeFile(join(dir, "outcomes.jsonl"), result.tokens.map((row) => json(row)).join("\n") + (result.tokens.length ? "\n" : ""));
}

export async function writeManifest(dir) {
  const files = (await walk(dir)).filter((file) => file !== "SHA256SUMS.txt").sort();
  const lines = [];
  for (const file of files) {
    const data = await readFile(join(dir, file));
    lines.push(`${createHash("sha256").update(data).digest("hex")}  ${file}`);
  }
  await writeFile(join(dir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
  return lines.length;
}
