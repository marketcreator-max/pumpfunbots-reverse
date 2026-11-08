// Offline checks for the price collector. No RPC, no price API.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PublicKey } from "@solana/web3.js";
import {
  CSV_HEADER,
  WINDOW_MS,
  canonicalPoolPda,
  consumeLines,
  createSolCache,
  csvLine,
  noteBuy,
  parseBondingCurve,
  parseJupiterSolUsd,
  parsePumpPool,
  parsePythPriceAccount,
  pollOnce,
  readTokenAmount,
  reservesFromRaw,
  resolveRpcUrl,
  safeText,
  sampleMint,
} from "./collect_prices.mjs";

const src = fs.readFileSync(new URL("./collect_prices.mjs", import.meta.url), "utf8");
for (const banned of ["sendRawTransaction", "sendEncodedTransaction", "sendTransaction", "loadKeypair", "Keypair", ".sign("]) {
  assert.equal(src.includes(banned), false, `collector must not reference ${banned}`);
}

const missing = (() => {
  try {
    resolveRpcUrl({});
    return "";
  } catch (err) {
    return err.message;
  }
})();
assert.match(missing, /RPC_URL is unset/);
assert.equal(missing.includes("http"), false);
const secret = "supersecretvalue";
const url = resolveRpcUrl({ HELIUS_API_KEY: secret });
assert.equal(url.includes(secret), true);
assert.equal(safeText(new Error(`dial ${url} api-key=${secret}`), { HELIUS_API_KEY: secret, RPC_URL: url }).includes(secret), false);

const curve = Buffer.alloc(49);
curve.writeBigUInt64LE(1_000_000_000_000n, 8);
curve.writeBigUInt64LE(30_000_000_000n, 16);
const parsed = parseBondingCurve(curve);
const fromCurve = reservesFromRaw(parsed.virtualSolReserves, parsed.virtualTokenReserves, 6);
assert.equal(fromCurve.quote_reserve, 30);
assert.equal(fromCurve.base_reserve, 1_000_000);
assert.ok(Math.abs(fromCurve.price_sol - 0.00003) < 1e-12);
curve[48] = 1;
assert.equal(parseBondingCurve(curve).complete, true);

const jup = parseJupiterSolUsd({
  So11111111111111111111111111111111111111112: { usdPrice: 150 },
});
assert.equal(jup, 150);

const pyth = Buffer.alloc(240);
pyth.writeUInt32LE(0xa1b2c3d4, 0);
pyth.writeInt32LE(-8, 20);
pyth.writeBigInt64LE(15_000_000_000n, 208);
assert.equal(parsePythPriceAccount(pyth), 150);

const mint = PublicKey.unique();
const tokenVault = PublicKey.unique();
const solVault = PublicKey.unique();
const poolBuf = Buffer.alloc(243);
mint.toBuffer().copy(poolBuf, 43);
new PublicKey("So11111111111111111111111111111111111111112").toBuffer().copy(poolBuf, 75);
tokenVault.toBuffer().copy(poolBuf, 139);
solVault.toBuffer().copy(poolBuf, 171);
const pool = parsePumpPool(poolBuf);
assert.equal(pool.baseVault.equals(tokenVault), true);

function tokenAcc(amount) {
  const buf = Buffer.alloc(72);
  buf.writeBigUInt64LE(amount, 64);
  return buf;
}
assert.equal(readTokenAmount(tokenAcc(1_000_000n)), 1_000_000n);

const book = new Map();
const buyTs = 1_700_000_000_000;
assert.equal(noteBuy(book, { event: "signal", mint: mint.toBase58(), ts_ms: buyTs }, buyTs), false);
assert.equal(noteBuy(book, { event: "buy", mint: mint.toBase58(), ts_ms: buyTs }, buyTs), true);
assert.equal(noteBuy(book, { event: "buy", mint: mint.toBase58(), ts_ms: buyTs }, buyTs), false);
assert.equal(noteBuy(book, { event: "buy", mint: "late", ts_ms: buyTs }, buyTs + WINDOW_MS + 1), false);

const lines = consumeLines({ buf: "" }, `{"event":"buy","mint":"${mint.toBase58()}","ts_ms":${buyTs}}\nnot json\n`);
assert.equal(lines.length, 1);

const accounts = new Map();
accounts.set(mint.toBase58(), Buffer.from([0]));
const dec = Buffer.alloc(45);
dec[44] = 6;
accounts.set(mint.toBase58(), dec);
const curvePda = (await import("./collect_prices.mjs")).bondingCurvePda(mint);
accounts.set(curvePda.toBase58(), curve);
curve[48] = 1;
accounts.set(canonicalPoolPda(mint).toBase58(), poolBuf);
accounts.set(tokenVault.toBase58(), tokenAcc(1_000_000_000_000n));
accounts.set(solVault.toBase58(), tokenAcc(30_000_000_000n));

const connection = {
  async getAccountInfo(pk) {
    const data = accounts.get(pk.toBase58());
    return data ? { data } : null;
  },
  async getMultipleAccountsInfo(pks) {
    return Promise.all(pks.map((pk) => this.getAccountInfo(pk)));
  },
};

const graduated = await sampleMint(connection, { mint: mint.toBase58(), decimals: null });
assert.equal(graduated.venue, "pumpswap");
assert.equal(graduated.quote_reserve, 30);

curve[48] = 0;
const live = await sampleMint(connection, { mint: mint.toBase58(), decimals: 6 });
assert.equal(live.venue, "curve");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-prices-"));
const csvPath = path.join(dir, "prices.csv");
fs.writeFileSync(csvPath, CSV_HEADER);
const fd = fs.openSync(csvPath, "a");
let fetches = 0;
const solUsd = createSolCache(async () => {
  fetches += 1;
  return { ok: true, json: async () => ({ So11111111111111111111111111111111111111112: { usdPrice: 150 } }) };
}, connection, () => buyTs);
await pollOnce({
  book,
  connection,
  solUsd,
  now: () => buyTs + 2000,
  writeRow: (line) => fs.writeSync(fd, line),
});
await pollOnce({
  book,
  connection,
  solUsd,
  now: () => buyTs + 2500,
  writeRow: (line) => fs.writeSync(fd, line),
});
fs.closeSync(fd);
assert.equal(fetches, 1, "SOL/USD must be cached inside 10s");
const body = fs.readFileSync(csvPath, "utf8").trim().split("\n");
assert.equal(body[0], CSV_HEADER.trim());
assert.equal(body.length, 3);
assert.match(body[1], new RegExp(`^${mint.toBase58()},${buyTs + 2000},0.00003,0.0045,30,1000000$`));

const decisions = path.join(dir, "decisions.jsonl");
fs.writeFileSync(decisions, JSON.stringify({
  event: "buy", mint: mint.toBase58(), ts_ms: buyTs + 2000, price_sol: null, mc: null, reason: "pre_graduation",
}) + "\n" + JSON.stringify({
  event: "sell", mint: mint.toBase58(), ts_ms: buyTs + 30_000, reason: "tp",
}) + "\n");
const scored = spawnSync("python3", [
  "paper/score.py", decisions, csvPath, "--json", path.join(dir, "score.json"),
], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), encoding: "utf8" });
assert.equal(scored.status, 0, scored.stderr);
const report = JSON.parse(fs.readFileSync(path.join(dir, "score.json"), "utf8"));
const trade = report.trades[0];
assert.equal(trade.filled, true);
assert.equal(trade.impact, true);
assert.ok(trade.fill_price_usd > trade.spot_usd);

assert.equal(csvLine({ mint: "M", ts_ms: 1, price_sol: 0.1, price_usd: null, quote_reserve: 1, base_reserve: 2 }), "M,1,0.1,,1,2\n");

console.log("PASS collect-prices");
