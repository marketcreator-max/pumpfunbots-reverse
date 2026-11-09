import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function stringify(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

export function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256Json(value) {
  return sha256Text(stringify(value));
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readJsonl(path) {
  const text = readFileSync(path, "utf8");
  const rows = [];
  for (const line of text.split("\n")) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

const BIG_FIELDS = new Set([
  "solLamports", "tokenRaw", "virtualSol", "virtualToken", "realSol", "realToken",
  "totalSupply", "quoteRaw", "gasPriceWei", "reserve0", "reserve1",
]);

export function hydrate(event) {
  const out = { ...event };
  for (const key of BIG_FIELDS) {
    if (out[key] != null && out[key] !== "") out[key] = BigInt(out[key]);
  }
  if (out.type === "trade") {
    if (out.quoteIsSol == null && out.chain !== "HOOD") out.quoteIsSol = true;
    if (out.venue == null) out.venue = out.chain === "HOOD" ? "hood" : "pump";
  }
  return out;
}

export function usdFromRaw(raw, decimals, quoteUsd) {
  if (raw == null || quoteUsd == null) return 0;
  return Number(raw) / 10 ** decimals * quoteUsd;
}

export function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export function csvCell(value) {
  if (value == null) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows, columns) {
  const head = columns.join(",");
  const body = rows.map((row) => columns.map((key) => csvCell(row[key])).join(","));
  return [head, ...body].join("\n") + "\n";
}

export function roundUsd(value) {
  if (value == null || Number.isNaN(value)) return null;
  return Math.round(value * 10000) / 10000;
}

export function backoffMs(attempt, rand = Math.random) {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base + Math.floor(rand() * 250);
}
