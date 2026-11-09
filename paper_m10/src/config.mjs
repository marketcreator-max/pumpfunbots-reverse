import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sha256Json } from "./util.mjs";
import { validateExits } from "./exits.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function paperRoot() {
  return ROOT;
}

export function normalizeFees(raw) {
  const sol = raw.SOL ?? {};
  const hood = raw.HOOD ?? {};
  return {
    version: raw.version,
    notionalUsd: raw.notionalUsd ?? 100,
    entryDelayMs: raw.entryDelayMs ?? [2000, 3000],
    pumpFeeBps: sol.pumpFeeBps ?? raw.pumpFeeBps ?? 100,
    pumpSwapFeeBps: sol.pumpSwapFeeBps ?? raw.pumpSwapFeeBps ?? 25,
    networkFeeLamports: sol.networkFeeLamports ?? raw.networkFeeLamports ?? 5000,
    hoodV2FeeBps: hood.defaultV2FeeBps ?? 30,
    hoodGasUnits: hood.gasUnits ?? 150_000,
  };
}

export function loadConfigs(overrides = {}) {
  const gates = readJson(overrides.gates ?? join(ROOT, "config", "gates.json"));
  const exits = validateExits(readJson(overrides.exits ?? join(ROOT, "config", "exits.json")));
  const fees = normalizeFees(readJson(overrides.fees ?? join(ROOT, "config", "fees.json")));
  const classify = readJson(overrides.classify ?? join(ROOT, "config", "classify.json"));
  const hood = readJson(overrides.hood ?? join(ROOT, "config", "hood_sources.json"));
  return {
    gates,
    exits,
    fees,
    classify,
    hood,
    gatesHash: sha256Json(gates),
    exitsHash: sha256Json(exits),
  };
}
