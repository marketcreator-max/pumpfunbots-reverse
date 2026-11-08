"use strict";

// --require preload. Patches the shared @solana/web3.js CJS instance
// (package has no exports map; main is lib/index.cjs.js) so a paper run
// cannot sign or broadcast. Also refuses POSTs to Jito block-engine / bundle
// hosts, and makes lib/config.mjs skip any .env file (existsSync -> false).

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const MARK = Symbol.for("paper.blockSend");

function logBlocked(method) {
  const line = JSON.stringify({
    event: "BLOCKED_SEND",
    ts: new Date().toISOString(),
    ts_ms: Date.now(),
    method,
  });
  process.stdout.write(line + "\n");
}

function block(method) {
  logBlocked(method);
  throw new Error("BLOCKED_SEND");
}

function isDotEnv(p) {
  if (typeof p !== "string" && !(p instanceof URL)) return false;
  return path.basename(String(p)) === ".env";
}

if (!fs.existsSync[MARK]) {
  const origExists = fs.existsSync;
  function existsSync(p) {
    if (isDotEnv(p)) return false;
    return origExists.apply(this, arguments);
  }
  existsSync[MARK] = true;
  fs.existsSync = existsSync;
}

if (!fs.readFileSync[MARK]) {
  const origRead = fs.readFileSync;
  function readFileSync(p) {
    if (isDotEnv(p)) {
      logBlocked("fs.readFileSync .env");
      throw new Error("BLOCKED_ENV_READ");
    }
    return origRead.apply(this, arguments);
  }
  readFileSync[MARK] = true;
  fs.readFileSync = readFileSync;
}

function isJitoPost(method, href) {
  if (String(method || "GET").toUpperCase() !== "POST") return false;
  let host = "";
  try {
    host = new URL(String(href)).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "bundles.jito.wtf" || host.endsWith(".bundles.jito.wtf")) return true;
  if (host.includes("block-engine.jito")) return true;
  return false;
}

function requestTarget(args) {
  const a0 = args[0];
  let method = "GET";
  let href = "";
  if (typeof a0 === "string" || a0 instanceof URL) {
    href = String(a0);
    const opt = args[1];
    if (opt && typeof opt === "object") method = opt.method || method;
  } else if (a0 && typeof a0 === "object") {
    method = a0.method || "GET";
    const host = a0.hostname || a0.host || "";
    const proto = a0.protocol || "https:";
    const pth = a0.path || "/";
    href = proto + "//" + host + pth;
  }
  return { method, href };
}

function wrapRequest(orig, label) {
  if (!orig || orig[MARK]) return orig;
  function wrapped() {
    const { method, href } = requestTarget(arguments);
    if (isJitoPost(method, href)) block(label);
    return orig.apply(this, arguments);
  }
  wrapped[MARK] = true;
  return wrapped;
}

http.request = wrapRequest(http.request, "http.request jito");
https.request = wrapRequest(https.request, "https.request jito");

if (typeof global.fetch === "function" && !global.fetch[MARK]) {
  const origFetch = global.fetch;
  function fetchWrapped(input, init) {
    let href = "";
    let method = "GET";
    if (typeof input === "string" || input instanceof URL) href = String(input);
    else if (input && typeof input === "object") {
      href = input.url || "";
      method = input.method || method;
    }
    if (init && init.method) method = init.method;
    if (isJitoPost(method, href)) block("fetch jito");
    return origFetch.apply(this, arguments);
  }
  fetchWrapped[MARK] = true;
  global.fetch = fetchWrapped;
}

const web3 = require("@solana/web3.js");

function patch(proto, name, label) {
  if (!proto || typeof proto[name] !== "function" || proto[name][MARK]) return;
  function wrapped() {
    block(label);
  }
  wrapped[MARK] = true;
  proto[name] = wrapped;
}

patch(web3.VersionedTransaction.prototype, "sign", "VersionedTransaction.sign");
patch(web3.Transaction.prototype, "sign", "Transaction.sign");
patch(web3.Connection.prototype, "sendRawTransaction", "Connection.sendRawTransaction");
patch(web3.Connection.prototype, "sendEncodedTransaction", "Connection.sendEncodedTransaction");
patch(web3.Connection.prototype, "sendTransaction", "Connection.sendTransaction");
