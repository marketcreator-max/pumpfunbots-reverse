#!/usr/bin/env python3
"""Score $100 paper trades from decisions.jsonl and a price CSV.

CSV columns: mint, ts_ms, price_usd
Optional price_sol plus quote_reserve (SOL) and base_reserve (tokens).
A $100 buy is converted to SOL with price_usd/price_sol and sent through
the constant-product reserves. Without price_sol, quote_reserve is treated
as USD. Without reserves, fills use the spot print.

Fill is the sample nearest to decision+2s, within 3s. A second pass uses
decision+3s (sensitivity). Fee is 0.5% per side.

Strategies (exits vs the bot's own sell):
  bot          sell decision + 2s
  T30          30% trailing stop from the running peak, armed at entry
  H10          hard stop at -10% from entry; else 15 min
  TP2x_trail   sell at 2x or on the 30% trail, whichever first
  TP5x_trail   sell at 5x or on the 30% trail, whichever first
  t5m          time exit 5 min after the fill
  t15m         time exit 15 min after the fill

Rugs are prints at or below 0.2x entry inside 15 min. Runners are mints
whose max print is at least 2x or 5x. Every runner is listed.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict

NOTIONAL = 100.0
FEE = 0.005
FILL_DELAY_MS = 2000
SENSITIVITY_DELAY_MS = 3000
TOL_MS = 3000
TRAIL = 0.30
HARD = 0.10
MAX_HOLD_MS = 15 * 60 * 1000
STRATEGIES = ("bot", "T30", "H10", "TP2x_trail", "TP5x_trail", "t5m", "t15m")


def load_prices(path):
    by_mint = defaultdict(list)
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or "mint" not in reader.fieldnames:
            raise SystemExit("CSV needs columns mint, ts_ms, price_usd")
        for row in reader:
            mint = (row.get("mint") or "").strip()
            if not mint:
                continue
            try:
                ts = int(float(row["ts_ms"]))
                px = float(row["price_usd"])
            except (KeyError, TypeError, ValueError):
                continue
            if px <= 0:
                continue
            qr = row.get("quote_reserve") or row.get("virtual_sol") or ""
            br = row.get("base_reserve") or row.get("virtual_token") or ""
            try:
                quote = float(qr) if qr != "" else None
            except ValueError:
                quote = None
            try:
                base = float(br) if br != "" else None
            except ValueError:
                base = None
            raw_sol = row.get("price_sol") or ""
            try:
                price_sol = float(raw_sol) if raw_sol != "" else None
            except ValueError:
                price_sol = None
            sol_usd = (px / price_sol) if price_sol and price_sol > 0 else None
            by_mint[mint].append({
                "ts": ts,
                "price": px,
                "quote": quote,
                "base": base,
                "sol_usd": sol_usd,
            })
    for mint in by_mint:
        by_mint[mint].sort(key=lambda s: s["ts"])
    return by_mint


def load_decisions(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "mint" in obj and "ts_ms" in obj and "event" in obj:
                rows.append(obj)
    return rows


def nearest(samples, target, tol=TOL_MS):
    """Closest sample to target. The match must fall within tol."""
    if not samples:
        return None
    lo, hi = 0, len(samples)
    while lo < hi:
        mid = (lo + hi) // 2
        if samples[mid]["ts"] < target:
            lo = mid + 1
        else:
            hi = mid
    cands = []
    if lo < len(samples):
        cands.append(samples[lo])
    if lo > 0:
        cands.append(samples[lo - 1])
    if not cands:
        return None
    best = min(cands, key=lambda s: abs(s["ts"] - target))
    if abs(best["ts"] - target) > tol:
        return None
    return best


def buy_exec(spot_row):
    """Return (exec_price_usd, tokens). Fee reduces the quote that hits the pool.

    When sol_usd is set, quote_reserve is SOL and base_reserve is tokens.
    $100 is converted to SOL, then constant-product impact is applied.
    Otherwise quote_reserve is already USD.
    """
    spot = spot_row["price"]
    q, b = spot_row.get("quote"), spot_row.get("base")
    sol_usd = spot_row.get("sol_usd")
    if q and b and q > 0 and b > 0 and sol_usd and sol_usd > 0:
        quote_in_sol = (NOTIONAL * (1.0 - FEE)) / sol_usd
        base_out = b - ((q * b) / (q + quote_in_sol))
        if base_out > 0:
            return (quote_in_sol / base_out) * sol_usd, base_out
    quote_in = NOTIONAL * (1.0 - FEE)
    if q and b and q > 0 and b > 0 and not sol_usd:
        base_out = b - ((q * b) / (q + quote_in))
        if base_out > 0:
            return quote_in / base_out, base_out
    return spot, quote_in / spot


def sell_proceeds(tokens, row):
    q, b = row.get("quote"), row.get("base")
    sol_usd = row.get("sol_usd")
    if q and b and q > 0 and b > 0 and tokens > 0 and sol_usd and sol_usd > 0:
        quote_out = q - ((q * b) / (b + tokens))
        if quote_out > 0:
            return quote_out * (1.0 - FEE) * sol_usd
    if q and b and q > 0 and b > 0 and tokens > 0 and not sol_usd:
        quote_out = q - ((q * b) / (b + tokens))
        if quote_out > 0:
            return quote_out * (1.0 - FEE)
    return tokens * row["price"] * (1.0 - FEE)


def pnl_of(tokens, row):
    return sell_proceeds(tokens, row) - NOTIONAL


def exit_time(samples, when):
    hit = nearest(samples, when, TOL_MS)
    if hit:
        return hit, "time"
    earlier = [s for s in samples if s["ts"] <= when]
    if earlier:
        return earlier[-1], "time_fallback"
    return None, "no_price"


def walk_exit(samples, entry_px, mode, horizon):
    peak = entry_px
    last = None
    for s in samples:
        if s["ts"] > horizon:
            break
        last = s
        px = s["price"]
        if px > peak:
            peak = px
        if mode == "T30" and px <= peak * (1.0 - TRAIL):
            return s, "trail_30"
        if mode == "H10" and px <= entry_px * (1.0 - HARD):
            return s, "hard_10"
        if mode == "TP2x_trail":
            if px >= entry_px * 2.0:
                return s, "tp_2x"
            if px <= peak * (1.0 - TRAIL):
                return s, "trail_30"
        if mode == "TP5x_trail":
            if px >= entry_px * 5.0:
                return s, "tp_5x"
            if px <= peak * (1.0 - TRAIL):
                return s, "trail_30"
    if last is None:
        return None, "no_price"
    return last, "max_hold_15m"


def pair_trades(decisions):
    buys = [d for d in decisions if d.get("event") == "buy" and d.get("mint")]
    sells = [d for d in decisions if d.get("event") == "sell" and d.get("mint")]
    used = set()
    pairs = []
    for i, buy in enumerate(buys):
        sell = None
        for j, s in enumerate(sells):
            if j in used:
                continue
            if s["mint"] == buy["mint"] and int(s["ts_ms"]) >= int(buy["ts_ms"]):
                sell = s
                used.add(j)
                break
        pairs.append((buy, sell))
    return pairs


def score(decisions, prices, delay_ms):
    trades = []
    for buy, sell in pair_trades(decisions):
        mint = buy["mint"]
        samples = prices.get(mint) or []
        target = int(buy["ts_ms"]) + delay_ms
        spot = nearest(samples, target, TOL_MS)
        trade = {
            "mint": mint,
            "decision_ts_ms": int(buy["ts_ms"]),
            "fill_target_ms": target,
            "filled": spot is not None,
            "reason_buy": buy.get("reason"),
            "bot_sell_ts_ms": int(sell["ts_ms"]) if sell else None,
            "bot_sell_reason": sell.get("reason") if sell else None,
        }
        if spot is None:
            trade["strategies"] = {}
            trades.append(trade)
            continue
        exec_px, tokens = buy_exec(spot)
        fill_ts = spot["ts"]
        horizon = fill_ts + MAX_HOLD_MS
        after = [s for s in samples if s["ts"] >= fill_ts]
        in_hold = [s for s in after if s["ts"] <= horizon]
        max_px = max((s["price"] for s in in_hold), default=spot["price"])
        min_px = min((s["price"] for s in in_hold), default=spot["price"])
        entry_spot = spot["price"]
        max_x = max_px / entry_spot if entry_spot else None
        trade.update({
            "fill_ts_ms": fill_ts,
            "fill_price_usd": exec_px,
            "spot_usd": entry_spot,
            "tokens": tokens,
            "impact": exec_px != entry_spot,
            "max_x_15m": max_x,
            "min_x_15m": (min_px / entry_spot) if entry_spot else None,
            "runner_2x": bool(max_x and max_x >= 2.0),
            "runner_5x": bool(max_x and max_x >= 5.0),
            "rug": bool(entry_spot and min_px <= entry_spot * 0.2),
        })
        exits = {}

        def record(name, row, why):
            if row is None:
                exits[name] = {"pnl_usd": None, "reason": why}
                return
            exits[name] = {
                "pnl_usd": round(pnl_of(tokens, row), 6),
                "exit_ts_ms": row["ts"],
                "exit_price_usd": row["price"],
                "reason": why,
            }

        if sell:
            row, why = exit_time(samples, int(sell["ts_ms"]) + delay_ms)
            record("bot", row, sell.get("reason") or why)
        else:
            record("bot", None, "no_bot_exit")
        row, why = walk_exit(after, entry_spot, "T30", horizon)
        record("T30", row, why)
        row, why = walk_exit(after, entry_spot, "H10", horizon)
        record("H10", row, why)
        row, why = walk_exit(after, entry_spot, "TP2x_trail", horizon)
        record("TP2x_trail", row, why)
        row, why = walk_exit(after, entry_spot, "TP5x_trail", horizon)
        record("TP5x_trail", row, why)
        row, why = exit_time(samples, fill_ts + 5 * 60 * 1000)
        record("t5m", row, why)
        row, why = exit_time(samples, fill_ts + 15 * 60 * 1000)
        record("t15m", row, why)
        trade["strategies"] = exits
        trades.append(trade)
    return trades


def summarize(trades):
    out = {}
    for name in STRATEGIES:
        pnls = []
        for t in trades:
            cell = (t.get("strategies") or {}).get(name) or {}
            if cell.get("pnl_usd") is not None:
                pnls.append(cell["pnl_usd"])
        wins = sum(1 for p in pnls if p > 0)
        out[name] = {
            "n": len(pnls),
            "pnl_usd": round(sum(pnls), 4) if pnls else 0.0,
            "avg_usd": round(sum(pnls) / len(pnls), 4) if pnls else 0.0,
            "win_rate": round(wins / len(pnls), 4) if pnls else 0.0,
        }
    return out


def markdown(primary, sensitivity, meta):
    lines = []
    lines.append("# Paper score")
    lines.append("")
    lines.append(
        f"${meta['notional_usd']:.0f} notional, {meta['fee_per_side']*100:.1f}% fee per side, "
        f"fill at decision+{meta['fill_delay_ms']/1000:.0f}s "
        f"(nearest within {meta['tol_ms']/1000:.0f}s). "
        f"Sensitivity column is decision+{meta['sensitivity_delay_ms']/1000:.0f}s."
    )
    lines.append("")
    lines.append("| strategy | trades | pnl_usd | avg_usd | win_rate | pnl_usd_+3s |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
    for name in STRATEGIES:
        a = primary[name]
        b = sensitivity[name]
        lines.append(
            f"| {name} | {a['n']} | {a['pnl_usd']:.2f} | {a['avg_usd']:.2f} | {a['win_rate']:.1%} | {b['pnl_usd']:.2f} |"
        )
    lines.append("")
    runners = [t for t in meta["trades"] if t.get("runner_2x") or t.get("runner_5x")]
    runners.sort(key=lambda t: t.get("max_x_15m") or 0, reverse=True)
    lines.append(f"## Runners ({len(runners)}, none dropped)")
    lines.append("")
    lines.append("| mint | max_x | rug | bot_pnl | T30 | H10 | TP2x_trail | TP5x_trail | t5m | t15m |")
    lines.append("| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for t in runners:
        s = t.get("strategies") or {}

        def cell(n):
            v = (s.get(n) or {}).get("pnl_usd")
            return "" if v is None else f"{v:.2f}"

        lines.append(
            "| {mint} | {mx:.2f} | {rug} | {bot} | {t30} | {h10} | {tp2} | {tp5} | {t5} | {t15} |".format(
                mint=t["mint"],
                mx=t.get("max_x_15m") or 0,
                rug="yes" if t.get("rug") else "",
                bot=cell("bot"),
                t30=cell("T30"),
                h10=cell("H10"),
                tp2=cell("TP2x_trail"),
                tp5=cell("TP5x_trail"),
                t5=cell("t5m"),
                t15=cell("t15m"),
            )
        )
    if not runners:
        lines.append("| (none) | | | | | | | | | |")
    rugs = [t for t in meta["trades"] if t.get("rug")]
    lines.append("")
    lines.append(f"## Rugs ({len(rugs)})")
    lines.append("")
    lines.append("| mint | min_x | max_x | runner_2x | runner_5x |")
    lines.append("| --- | ---: | ---: | --- | --- |")
    for t in rugs:
        lines.append(
            f"| {t['mint']} | {t.get('min_x_15m') or 0:.3f} | {t.get('max_x_15m') or 0:.2f} | "
            f"{'yes' if t.get('runner_2x') else ''} | {'yes' if t.get('runner_5x') else ''} |"
        )
    if not rugs:
        lines.append("| (none) | | | | |")
    lines.append("")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Score graduation paper decisions against a price CSV")
    ap.add_argument("decisions", help="decisions.jsonl")
    ap.add_argument("prices", help="CSV mint,ts_ms,price_usd[,quote_reserve,base_reserve]")
    ap.add_argument("-o", "--markdown", help="write the markdown table to this path")
    ap.add_argument("--json", dest="json_path", help="write the full JSON report to this path")
    args = ap.parse_args()

    decisions = load_decisions(args.decisions)
    prices = load_prices(args.prices)
    primary_trades = score(decisions, prices, FILL_DELAY_MS)
    sens_trades = score(decisions, prices, SENSITIVITY_DELAY_MS)
    primary = summarize(primary_trades)
    sensitivity = summarize(sens_trades)
    report = {
        "notional_usd": NOTIONAL,
        "fee_per_side": FEE,
        "fill_delay_ms": FILL_DELAY_MS,
        "sensitivity_delay_ms": SENSITIVITY_DELAY_MS,
        "tol_ms": TOL_MS,
        "trail_drawdown": TRAIL,
        "hard_stop": HARD,
        "strategies": primary,
        "strategies_plus_3s": sensitivity,
        "trades": primary_trades,
        "runners_2x": [t["mint"] for t in primary_trades if t.get("runner_2x")],
        "runners_5x": [t["mint"] for t in primary_trades if t.get("runner_5x")],
        "rugs": [t["mint"] for t in primary_trades if t.get("rug")],
    }
    # Keep the primary trade list (with runner flags) for the markdown.
    text = markdown(primary, sensitivity, {**report, "trades": primary_trades})
    sys.stdout.write(text)
    if args.markdown:
        with open(args.markdown, "w") as f:
            f.write(text)
    if args.json_path:
        with open(args.json_path, "w") as f:
            json.dump(report, f, indent=2)
            f.write("\n")


if __name__ == "__main__":
    main()
