"use strict";

// Offline proof that the preload throws before any network I/O.
// Usage: node paper/test-block.cjs

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");

const lines = [];
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, enc, cb) => {
  lines.push(String(chunk));
  if (typeof enc === "function") enc();
  else if (typeof cb === "function") cb();
  return true;
};

require("./block-send.cjs");

const {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

function expectThrow(fn, label, message = "BLOCKED_SEND") {
  const before = lines.length;
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, label + " did not throw");
  assert.strictEqual(err.message, message, label + " message");
  const fresh = lines.slice(before).join("");
  assert.ok(fresh.includes('"event":"BLOCKED_SEND"'), label + " did not log BLOCKED_SEND");
  assert.ok(fresh.includes('"ts"'), label + " log missing ts");
}

function main() {
  const kp = Keypair.generate();
  const ix = SystemProgram.transfer({
    fromPubkey: kp.publicKey,
    toPubkey: kp.publicKey,
    lamports: 1,
  });
  const blockhash = "11111111111111111111111111111111";

  const vtx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message(),
  );
  expectThrow(() => vtx.sign([kp]), "VersionedTransaction.sign");

  const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(ix);
  expectThrow(() => tx.sign(kp), "Transaction.sign");

  const conn = new Connection("http://127.0.0.1:1", "confirmed");
  expectThrow(() => conn.sendRawTransaction(Buffer.from([1])), "Connection.sendRawTransaction");
  expectThrow(() => conn.sendEncodedTransaction("AQ=="), "Connection.sendEncodedTransaction");
  expectThrow(() => conn.sendTransaction(vtx), "Connection.sendTransaction");

  expectThrow(
    () => fetch("https://mainnet.block-engine.jito.wtf/api/v1/bundles", { method: "POST", body: "{}" }),
    "fetch jito POST",
  );
  expectThrow(
    () => https.request({ hostname: "amsterdam.mainnet.block-engine.jito.wtf", path: "/api/v1/bundles", method: "POST" }),
    "https.request jito POST",
  );
  expectThrow(
    () => http.request({ hostname: "bundles.jito.wtf", path: "/api/v1/bundles", method: "POST", protocol: "http:" }),
    "http.request jito POST",
  );

  const envFile = path.join(os.tmpdir(), "paper-block-" + process.pid, ".env");
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, "RPC_URL=https://evil.example/?api-key=secret\n");
  assert.strictEqual(fs.existsSync(envFile), false, ".env existsSync must be false");
  expectThrow(() => fs.readFileSync(envFile, "utf8"), "fs.readFileSync .env", "BLOCKED_ENV_READ");
  fs.rmSync(path.dirname(envFile), { recursive: true, force: true });

  origWrite("PASS block-send\n");
}

main();
