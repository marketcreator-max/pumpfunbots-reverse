import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../src/redact.mjs";

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "idl" || name === "node_modules" || name === "out" || name === "safety.test.mjs") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.(mjs|json|sh|md|js)$/.test(name)) out.push(path);
  }
  return out;
}

test("the paper package has no signing or sending surface", () => {
  const banned = /\bKeypair\b|\bsendTransaction\b|\bsendRawTransaction\b|\bsendEncodedTransaction\b|\bprivateKey\b|\bsecretKey\b|\bjito\b|\bmnemonic\b|signTransaction|eth_sendRawTransaction|eth_sendTransaction/i;
  const root = new URL("..", import.meta.url).pathname;
  const hits = [];
  for (const path of files(root)) {
    const text = readFileSync(path, "utf8");
    if (banned.test(text)) hits.push(path);
  }
  assert.deepEqual(hits, []);
});

test("api-key query values are redacted", () => {
  const line = "failed https://rpc.example/v2/?api-key=supersecret&x=1";
  assert.equal(redact(line).includes("supersecret"), false);
  assert.match(redact(line), /api-key=REDACTED/);
});
