import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreTape } from "../src/score.mjs";
import { configs } from "./helpers.mjs";
import { readJsonl } from "../src/util.mjs";

test("the recorded fixture scores twice to the same report and ignores the post-cutoff trade", () => {
  const events = readJsonl(new URL("../fixtures/tape.jsonl", import.meta.url));
  const cfg = { ...configs(), chain: "SOL", runId: "fixture-run" };
  const a = scoreTape(events, cfg);
  const b = scoreTape(events, cfg);
  assert.deepEqual(a.report.rows, b.report.rows);
  assert.deepEqual(a.report.json.north.confusion, b.report.json.north.confusion);
  const feature = a.features.find((row) => row.minute === 10);
  assert.equal(feature.volumeUsd, 100);
  assert.equal(feature.confidence, 72);
  assert.equal(feature.chain, "SOL");
  assert.equal(feature.chain_id, "mainnet");
  assert.match(a.report.markdown, /## Rug bots vs nurture bots/);
  const botAt = a.report.markdown.indexOf("## Rug bots vs nurture bots");
  const gateAt = a.report.markdown.indexOf("## Gate × exit");
  assert.ok(botAt >= 0 && botAt < gateAt);
  const labels = a.report.rows.map((row) => row.exit);
  for (const name of ["BOT", "H10", "T30", "TP2x+trail", "TP5x+trail", "5m", "15m"]) {
    assert.ok(labels.includes(name), name);
  }
  assert.equal(a.tokens[0].outcome, "DUD");
  assert.ok(a.wallets.some((row) => row.wallet === "BuyerA" && row.class === "REAL"));
  assert.equal(readFileSync(new URL("../fixtures/tape.jsonl", import.meta.url), "utf8").includes("api-key="), false);
});
