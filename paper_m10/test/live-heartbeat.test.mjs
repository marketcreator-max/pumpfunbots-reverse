import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadConfigs } from "../src/config.mjs";
import { runLive } from "../src/live.mjs";

function fakeSocket() {
  const events = new EventEmitter();
  const socket = {
    readyState: 1,
    ping() {
      setTimeout(() => events.emit("pong"), 5);
    },
    send() {},
    close() {
      socket.readyState = 3;
      events.emit("close");
    },
    addEventListener(name, fn) {
      events.on(name, fn);
    },
    on(name, fn) {
      events.on(name, fn);
    },
  };
  setTimeout(() => events.emit("open"), 5);
  return socket;
}

test("live engine survives at least two heartbeat intervals", async () => {
  const interval = 400;
  const dir = mkdtempSync(join(tmpdir(), "paper-m10-hb-"));
  const errors = [];
  let beats = 0;
  const logger = {
    info(message) {
      if (String(message).startsWith("loop-lag")) beats += 1;
    },
    warn() {},
    error(message) {
      errors.push(String(message));
    },
  };
  await runLive({
    outDir: dir,
    hours: (interval * 2 + 350) / 3_600_000,
    chains: ["SOL"],
    configs: loadConfigs(),
    logger,
    runId: "hb-test",
    scoreAtEnd: false,
    healthMs: interval,
    createSolSocket: () => fakeSocket(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { amount: "80" } }),
    }),
  });
  assert.equal(errors.filter((message) => /before initialization|Cannot access/.test(message)).length, 0);
  assert.ok(beats >= 3, `expected the immediate beat plus two intervals, got ${beats}`);
  const heartbeat = JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8"));
  assert.equal(heartbeat.runId, "hb-test");
  assert.equal(typeof heartbeat.t, "number");
  assert.ok(heartbeat.t > 0);
});
