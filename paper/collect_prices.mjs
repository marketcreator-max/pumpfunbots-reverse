// Read-only price tape for paper trades.
// Tails paper/out/decisions.jsonl and, for each buy, polls the pump.fun
// bonding curve (PumpSwap vaults after graduation) once a second for 60 minutes.
// getAccountInfo only. No keypair, no sign, no send.
//
//   node paper/collect_prices.mjs [decisions.jsonl] [prices.csv]

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";

export const WINDOW_MS = 60 * 60 * 1000;
export const SOL_TTL_MS = 10_000;
export const CSV_HEADER = "mint,ts_ms,price_sol,price_usd,quote_reserve,base_reserve\n";

const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const PYTH_SOL_USD = new PublicKey("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG");
const SOL_MINT = WSOL.toBase58();
const JUPITER_URLS = [
  `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`,
  `https://api.jup.ag/price/v3?ids=${SOL_MINT}`,
];

export function resolveRpcUrl(env = process.env) {
  if (env.RPC_URL) return env.RPC_URL;
  if (env.HELIUS_RPC_URL) return env.HELIUS_RPC_URL;
  if (env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
  if (env.ALCHEMY_RPC_URL) return env.ALCHEMY_RPC_URL;
  if (env.ALCHEMY_URL) return env.ALCHEMY_URL;
  if (env.ALCHEMY_SOLANA_URL) return env.ALCHEMY_SOLANA_URL;
  if (env.ALCHEMY_API_KEY) return `https://solana-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
  throw new Error("RPC_URL is unset. Export RPC_URL or HELIUS_* / ALCHEMY_*. Values are not printed.");
}

export function safeText(msg, env = process.env) {
  let s = String(msg && msg.message ? msg.message : msg);
  for (const key of ["RPC_URL", "WS_URL", "HELIUS_API_KEY", "HELIUS_RPC_URL", "ALCHEMY_API_KEY", "ALCHEMY_RPC_URL", "ALCHEMY_URL", "ALCHEMY_SOLANA_URL"]) {
    const v = env[key];
    if (v && v.length >= 6) s = s.split(v).join("REDACTED");
  }
  s = s.replace(/https?:\/\/\S+/g, "RPC");
  s = s.replace(/api-key=[^&\s]+/gi, "api-key=REDACTED");
  s = s.replace(/api_key=[^&\s]+/gi, "api_key=REDACTED");
  return s.slice(0, 240);
}

export function bondingCurvePda(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP)[0];
}

export function canonicalPoolPda(mint) {
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mint.toBuffer()],
    PUMP,
  );
  const index = Buffer.alloc(2);
  index.writeUInt16LE(0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), index, authority.toBuffer(), mint.toBuffer(), WSOL.toBuffer()],
    PUMP_AMM,
  )[0];
}

export function parseBondingCurve(data) {
  const buf = Buffer.from(data);
  if (buf.length < 49) return null;
  return {
    virtualTokenReserves: buf.readBigUInt64LE(8),
    virtualSolReserves: buf.readBigUInt64LE(16),
    realTokenReserves: buf.readBigUInt64LE(24),
    realSolReserves: buf.readBigUInt64LE(32),
    complete: buf[48] === 1,
  };
}

export function parsePumpPool(data) {
  const buf = Buffer.from(data);
  if (buf.length < 203) return null;
  return {
    baseMint: new PublicKey(buf.subarray(43, 75)),
    quoteMint: new PublicKey(buf.subarray(75, 107)),
    baseVault: new PublicKey(buf.subarray(139, 171)),
    quoteVault: new PublicKey(buf.subarray(171, 203)),
  };
}

export function orientPool(parsed, mint) {
  if (parsed.baseMint.equals(mint) && parsed.quoteMint.equals(WSOL)) {
    return { tokenVault: parsed.baseVault, solVault: parsed.quoteVault };
  }
  if (parsed.quoteMint.equals(mint) && parsed.baseMint.equals(WSOL)) {
    return { tokenVault: parsed.quoteVault, solVault: parsed.baseVault };
  }
  return null;
}

export function readTokenAmount(data) {
  const buf = Buffer.from(data);
  if (buf.length < 72) return null;
  return buf.readBigUInt64LE(64);
}

export function reservesFromRaw(solRaw, tokenRaw, tokenDecimals) {
  const quote = Number(solRaw) / 1e9;
  const base = Number(tokenRaw) / 10 ** tokenDecimals;
  if (!(quote > 0) || !(base > 0) || !Number.isFinite(quote) || !Number.isFinite(base)) return null;
  return { price_sol: quote / base, quote_reserve: quote, base_reserve: base };
}

export function parseJupiterSolUsd(body) {
  const row = body && (body[SOL_MINT] || (body.data && body.data[SOL_MINT]));
  const n = Number(row && (row.usdPrice ?? row.price));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parsePythPriceAccount(data) {
  const buf = Buffer.from(data);
  if (buf.length < 240 || buf.readUInt32LE(0) !== 0xa1b2c3d4) return null;
  const expo = buf.readInt32LE(20);
  const raw = buf.readBigInt64LE(208);
  const px = Number(raw) * 10 ** expo;
  if (!Number.isFinite(px) || px < 1 || px > 100_000) return null;
  return px;
}

export function csvLine(row) {
  const cell = (n) => {
    if (n == null || !Number.isFinite(Number(n))) return "";
    const x = Number(n);
    return String(Math.round(x * 1e12) / 1e12);
  };
  return [row.mint, row.ts_ms, cell(row.price_sol), cell(row.price_usd), cell(row.quote_reserve), cell(row.base_reserve)].join(",") + "\n";
}

export function noteBuy(book, decision, now = Date.now()) {
  if (!decision || decision.event !== "buy" || !decision.mint) return false;
  const buyTs = Number(decision.ts_ms);
  if (!Number.isFinite(buyTs)) return false;
  if (book.has(decision.mint)) return false;
  const until = buyTs + WINDOW_MS;
  if (now > until) return false;
  book.set(decision.mint, { mint: decision.mint, buyTs, until, decimals: null });
  return true;
}

export function dropExpired(book, now = Date.now()) {
  for (const [mint, rec] of book) {
    if (now > rec.until) book.delete(mint);
  }
}

export function consumeLines(state, text) {
  state.buf += text;
  const out = [];
  let nl;
  while ((nl = state.buf.indexOf("\n")) >= 0) {
    const line = state.buf.slice(0, nl).trim();
    state.buf = state.buf.slice(nl + 1);
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* ignore a partial or non-json log line */
    }
  }
  return out;
}

function accountData(info) {
  if (!info) return null;
  return info.data || null;
}

async function mintDecimals(connection, mint, rec) {
  if (rec.decimals != null) return rec.decimals;
  try {
    const info = await connection.getAccountInfo(mint);
    const data = accountData(info);
    rec.decimals = data && data.length >= 45 ? data[44] : 6;
  } catch {
    rec.decimals = 6;
  }
  if (!Number.isInteger(rec.decimals) || rec.decimals < 0 || rec.decimals > 18) rec.decimals = 6;
  return rec.decimals;
}

export async function sampleMint(connection, rec) {
  const mint = new PublicKey(rec.mint);
  const decimals = await mintDecimals(connection, mint, rec);
  const curveInfo = await connection.getAccountInfo(bondingCurvePda(mint));
  const curve = curveInfo && parseBondingCurve(accountData(curveInfo));
  if (curve && !curve.complete) {
    const sample = reservesFromRaw(curve.virtualSolReserves, curve.virtualTokenReserves, decimals);
    return sample && { ...sample, venue: "curve" };
  }
  const poolInfo = await connection.getAccountInfo(canonicalPoolPda(mint));
  const pool = poolInfo && parsePumpPool(accountData(poolInfo));
  const oriented = pool && orientPool(pool, mint);
  if (!oriented) return null;
  const [tokenAcc, solAcc] = await connection.getMultipleAccountsInfo([oriented.tokenVault, oriented.solVault]);
  const tokenRaw = tokenAcc && readTokenAmount(accountData(tokenAcc));
  const solRaw = solAcc && readTokenAmount(accountData(solAcc));
  if (tokenRaw == null || solRaw == null) return null;
  const sample = reservesFromRaw(solRaw, tokenRaw, decimals);
  return sample && { ...sample, venue: "pumpswap" };
}

export async function fetchSolUsd(fetchImpl, connection) {
  for (const url of JUPITER_URLS) {
    try {
      const res = await fetchImpl(url, { method: "GET" });
      if (!res || !res.ok) continue;
      const px = parseJupiterSolUsd(await res.json());
      if (px) return px;
    } catch {
      /* try the next source */
    }
  }
  try {
    const info = await connection.getAccountInfo(PYTH_SOL_USD);
    return info ? parsePythPriceAccount(accountData(info)) : null;
  } catch {
    return null;
  }
}

export function createSolCache(fetchImpl, connection, now = Date.now) {
  let cache = { at: 0, usd: null };
  return async function solUsd() {
    const t = now();
    if (cache.usd && t - cache.at < SOL_TTL_MS) return cache.usd;
    const px = await fetchSolUsd(fetchImpl, connection);
    if (px) cache = { at: t, usd: px };
    return cache.usd;
  };
}

export async function pollOnce({ book, connection, solUsd, writeRow, now = Date.now, log = () => {} }) {
  const t = now();
  dropExpired(book, t);
  for (const rec of book.values()) {
    try {
      const sample = await sampleMint(connection, rec);
      if (!sample) continue;
      const usd = await solUsd();
      const row = {
        mint: rec.mint,
        ts_ms: t,
        price_sol: sample.price_sol,
        price_usd: usd ? sample.price_sol * usd : null,
        quote_reserve: sample.quote_reserve,
        base_reserve: sample.base_reserve,
      };
      writeRow(csvLine(row));
      log(`${rec.mint.slice(0, 8)} ${sample.venue} price_sol=${sample.price_sol}`);
    } catch (err) {
      log(`sample failed: ${safeText(err)}`);
    }
  }
}

function openCsv(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) fs.writeFileSync(file, CSV_HEADER);
  return fs.openSync(file, "a");
}

export async function runCollector({ decisionsPath, csvPath, connection, fetchImpl, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const book = new Map();
  const lines = { buf: "" };
  let offset = 0;
  const fd = openCsv(csvPath);
  const solUsd = createSolCache(fetchImpl, connection);
  let running = true;
  const stop = () => { running = false; };
  process.on("SIGINT", stop);

  function readNewDecisions() {
    if (!fs.existsSync(decisionsPath)) return;
    const size = fs.statSync(decisionsPath).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const fh = fs.openSync(decisionsPath, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fh, buf, 0, buf.length, offset);
    fs.closeSync(fh);
    offset = size;
    for (const row of consumeLines(lines, buf.toString("utf8"))) {
      if (noteBuy(book, row)) log(`tracking ${row.mint}`);
    }
  }

  log("price collector: read-only, 1s polls, 60 min per buy. RPC value is not printed.");
  while (running) {
    const t0 = Date.now();
    try {
      readNewDecisions();
      await pollOnce({
        book,
        connection,
        solUsd,
        writeRow: (line) => fs.writeSync(fd, line),
        log: (m) => log(safeText(m)),
      });
    } catch (err) {
      log(safeText(err));
    }
    const wait = Math.max(50, 1000 - (Date.now() - t0));
    await sleep(wait);
  }
  fs.closeSync(fd);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const decisionsPath = path.resolve(process.argv[2] || path.join("paper", "out", "decisions.jsonl"));
  const csvPath = path.resolve(process.argv[3] || path.join("paper", "out", "prices.csv"));
  const connection = new Connection(resolveRpcUrl(), "confirmed");
  runCollector({ decisionsPath, csvPath, connection, fetchImpl: global.fetch }).catch((err) => {
    console.error(safeText(err));
    process.exit(1);
  });
}
