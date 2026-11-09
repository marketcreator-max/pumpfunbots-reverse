import { createHash } from "node:crypto";
import { identityFor } from "./chain.mjs";

export function sampleBucket(runId, mint, mod) {
  const buf = createHash("sha256").update(`${runId}:${mint}`).digest();
  return buf.readUInt32BE(0) % mod;
}

function compare(value, rule) {
  if (value == null || Number.isNaN(value)) return false;
  if (rule.gte != null && !(value >= rule.gte)) return false;
  if (rule.gt != null && !(value > rule.gt)) return false;
  if (rule.lte != null && !(value <= rule.lte)) return false;
  if (rule.lt != null && !(value < rule.lt)) return false;
  if (rule.eq != null && !(value === rule.eq)) return false;
  return true;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function profileOf(feature) {
  const nurture = feature.nurtureShareLast60;
  const blatant = feature.blatantShareLast60;
  const real = feature.uniqueRealBuyers ?? 0;
  if (nurture == null || blatant == null) return "unknown";
  if (blatant >= 70 || (feature.bundlePct != null && feature.bundlePct >= 20)) return "rug-profile";
  if (nurture >= 50 && blatant < 50) {
    if (real >= 40) return "organic";
    if (real < 15 && nurture >= 70) return "bot-carried";
    return "nurture";
  }
  if (blatant >= 50 && blatant < 70) return "mixed";
  return "other";
}

export function evaluateGates(feature, cfg) {
  const identity = identityFor(cfg.chain, cfg.runId);
  const decisions = [];
  for (const gate of cfg.gates.gates) {
    let pass = false;
    let reason = "";
    if ((feature.tradeCount ?? 0) < 1) {
      reason = "no trades";
    } else if (gate.sample) {
      const bucket = sampleBucket(cfg.runId, feature.mint, gate.sample.mod);
      pass = bucket === (gate.sample.keep ?? 0);
      reason = pass ? "control sample" : "not in control sample";
    } else {
      const fails = [];
      for (const rule of gate.all ?? []) {
        if (feature.naFeatures?.includes(rule.feat)) {
          fails.push(`${rule.feat}=N/A`);
          continue;
        }
        if (!compare(feature[rule.feat], rule)) fails.push(`${rule.feat}=${feature[rule.feat] ?? "null"}`);
      }
      pass = fails.length === 0;
      reason = pass ? "pass" : fails.join("; ");
    }
    const record = {
      type: "decision",
      frozen: true,
      ...identity,
      confVersion: feature.confidenceVersion,
      gateVersion: cfg.gates.version,
      gateId: gate.id,
      mint: feature.mint,
      name: feature.name,
      symbol: feature.symbol,
      pass,
      confidence: feature.confidence,
      reason,
      profile: profileOf(feature),
      features: structuredClone(feature),
      configHash: cfg.gatesHash,
      decidedAtRecvTs: feature.cutoffRecvTs,
    };
    decisions.push(deepFreeze(record));
  }
  return decisions;
}
