// Parse graduation-sniper stdout into paper/out/decisions.jsonl.
// Does not change the bot. Re-emits every line to stdout.
import fs from "node:fs";
import path from "node:path";

const outPath = process.argv[2] || path.join("paper", "out", "decisions.jsonl");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const fd = fs.openSync(outPath, "a");

const prefixToMint = new Map();
let pending = null;

function emit(obj) {
  fs.writeSync(fd, JSON.stringify(obj) + "\n");
}

function remember(mint) {
  if (mint && mint.length >= 12) prefixToMint.set(mint.slice(0, 12), mint);
}

function resolveMint(prefix) {
  return prefixToMint.get(prefix) || prefix;
}

function handle(line) {
  const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+(.*)$/);
  const msg = m ? m[2] : line.trim();
  if (!msg) return;
  const ts = Date.now();

  const watch = msg.match(/^WATCHLIST: (\S+) fill=([\d.]+)% vSol=([\d.]+)/);
  if (watch) {
    emit({
      mint: resolveMint(watch[1]),
      ts_ms: ts,
      event: "signal",
      price_sol: null,
      mc: null,
      fill_pct: Number(watch[2]),
      vsol: Number(watch[3]),
      reason: "near_graduation",
    });
    return;
  }

  if (msg.includes("*** PRE-GRADUATION BUY ***")) {
    pending = { ts_ms: ts };
    return;
  }

  if (pending) {
    const mint = msg.match(/\bmint:\s*(\S+)/);
    if (mint) {
      pending.mint = mint[1];
      remember(mint[1]);
      return;
    }
    const price = msg.match(/fill:\s*([\d.]+)%\s*\|\s*price:\s*([\d.eE+-]+)\s*SOL\/token/);
    if (price) {
      pending.fill_pct = Number(price[1]);
      pending.price_sol = Number(price[2]);
      return;
    }
    if (msg.includes("[DRY RUN] position tracked") || msg.includes("bought!")) {
      emit({
        mint: pending.mint || null,
        ts_ms: pending.ts_ms,
        event: "buy",
        price_sol: pending.price_sol ?? null,
        mc: null,
        fill_pct: pending.fill_pct ?? null,
        reason: "pre_graduation",
      });
      pending = null;
      return;
    }
    if (msg.includes("buy failed")) {
      emit({
        mint: pending.mint || null,
        ts_ms: pending.ts_ms,
        event: "buy_blocked",
        price_sol: pending.price_sol ?? null,
        mc: null,
        reason: "buy_failed",
      });
      pending = null;
      return;
    }
  }

  const sell = msg.match(/^(\S+): (TP hit|SL hit|timeout)\b/);
  if (sell) {
    const reason = sell[2].startsWith("TP") ? "tp" : sell[2].startsWith("SL") ? "sl" : "timeout";
    const pnl = msg.match(/([+-]?[\d.]+)%/);
    emit({
      mint: resolveMint(sell[1]),
      ts_ms: ts,
      event: "sell",
      price_sol: null,
      mc: null,
      pnl_pct: pnl ? Number(pnl[1]) : null,
      reason,
    });
    return;
  }

  const graduated = msg.match(/^(\S+): \*\*\* GRADUATED! \*\*\*/);
  if (graduated) {
    emit({
      mint: resolveMint(graduated[1]),
      ts_ms: ts,
      event: "graduated",
      price_sol: null,
      mc: null,
      reason: "curve_complete",
    });
    return;
  }

  const gone = msg.match(/^(\S+): bonding curve gone/);
  if (gone) {
    emit({
      mint: resolveMint(gone[1]),
      ts_ms: ts,
      event: "graduated",
      price_sol: null,
      mc: null,
      reason: "curve_missing",
    });
  }
}

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  process.stdout.write(chunk);
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    handle(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
  }
});
process.stdin.on("end", () => {
  if (buf.length) handle(buf);
  fs.closeSync(fd);
});
