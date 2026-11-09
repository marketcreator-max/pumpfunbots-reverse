import { roundUsd } from "./util.mjs";

function money(value) {
  if (value == null || Number.isNaN(value)) return "";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function num(value, digits = 1) {
  if (value == null || Number.isNaN(value)) return "";
  return Number(value).toFixed(digits);
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "/");
}

export function aggregateRows(scored, exits, gateList) {
  const delays = [2000, 3000];
  const rows = [];
  const gates = (gateList ?? []).map((gate) => gate.id);
  const gateIds = gates.length ? gates : ["G0", "G3", "G3F", "G3N"];
  for (const exit of exits) {
    for (const gateId of gateIds) {
      const mine = scored.filter((row) => row.gateId === gateId && row.exitId === exit.id && row.filled);
      const at = (delay) => mine.filter((row) => row.delayMs === delay);
      const primary = at(delays[0]);
      const slow = at(delays[1]);
      const sum = (list) => roundUsd(list.reduce((total, row) => total + (row.pnlUsd ?? 0), 0));
      const worst = primary.reduce((pick, row) => (pick == null || row.pnlUsd < pick.pnlUsd ? row : pick), null);
      const biggest = primary.reduce((pick, row) => (pick == null || row.peakMultiple > pick.peakMultiple ? row : pick), null);
      rows.push({
        gate: gateId,
        exit: exit.label,
        exitId: exit.id,
        house: Boolean(exit.house),
        research: Boolean(exit.research),
        entries: primary.length,
        entries3s: slow.length,
        rugsEntered: primary.filter((row) => row.rugged).length,
        runners2x: primary.filter((row) => row.reached2x).length,
        runners5x: primary.filter((row) => row.reached5x).length,
        runnersKept: primary.filter((row) => row.kept2x).length,
        biggestName: biggest?.name || biggest?.symbol || "",
        biggestMint: biggest?.mint ?? null,
        peakMultiple: biggest ? roundUsd(biggest.peakMultiple) : null,
        ourMultiple: biggest ? roundUsd(biggest.exitMultiple) : null,
        pnl2s: sum(primary),
        pnl3s: sum(slow),
        worstName: worst?.name || worst?.symbol || "",
        worstPnl: worst ? roundUsd(worst.pnlUsd) : null,
      });
    }
  }
  return rows;
}

function bucketLine(name, bucket) {
  if (!bucket) return "";
  return `| ${name} | ${bucket.tokens} | ${num(bucket.blatantShare)} | ${num(bucket.nurtureShare)} | ${money(bucket.botNetUsd)} | ${money(bucket.nurtureNetUsd)} | ${num(bucket.realBuyers, 1)} | ${num(bucket.peakBlatant)} | ${num(bucket.peakNurture)} | ${money(bucket.peakNurtureNet)} | ${num(bucket.dumpBlatant)} | ${num(bucket.dumpNurture)} | ${money(bucket.dumpNurtureNet)} |`;
}

function confusionTable(table) {
  const lines = ["| predicted \\ actual | RUNNER | RUG | DUD |", "| --- | ---: | ---: | ---: |"];
  for (const predicted of ["RUNNER", "RUG", "UNKNOWN"]) {
    const row = table?.[predicted] ?? { RUNNER: 0, RUG: 0, DUD: 0 };
    lines.push(`| ${predicted} | ${row.RUNNER} | ${row.RUG} | ${row.DUD} |`);
  }
  return lines.join("\n");
}

export function buildReport({ identity, scored, exits, gates, north }) {
  const rows = aggregateRows(scored, exits.exits, gates?.gates);
  const chain = `${identity.chain} ${identity.chain_id}`;
  const lines = [];
  lines.push(`# paper_m10 ${identity.chain}`);
  lines.push("");
  lines.push(`Chain \`${identity.chain}\` / chain_id \`${identity.chain_id}\`. strategy_version \`${identity.strategy_version}\`. run_id \`${identity.run_id}\`.`);
  lines.push("");
  lines.push("## Rug bots vs nurture bots");
  lines.push("");
  lines.push("Entry figures use only the tape up to minute 10. Peak and dump figures are what the same classifier said at those later prints. They are not entry signals.");
  lines.push("");
  lines.push("| bucket | tokens | blatant % entry | nurture % entry | bot net entry | nurture net entry | real buyers | blatant % peak | nurture % peak | nurture net peak | blatant % dump | nurture % dump | nurture net dump |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  const buckets = north?.buckets ?? {};
  for (const [name, label] of [["runners2x", "runners ≥2x"], ["runners5x", "runners ≥5x"], ["rugs", "rugs"], ["duds", "duds"]]) {
    lines.push(bucketLine(label, buckets[name]));
  }
  lines.push("");
  const coverage = north?.coverage ?? {};
  lines.push(`Classifier coverage: signer on ${num(coverage.signerPct, 1)}% of swaps. Predictor fired on ${num(coverage.predictorPct, 1)}% of completed tokens (${coverage.observed ?? 0} completed, ${coverage.incomplete ?? 0} incomplete).`);
  lines.push("");
  lines.push("A completed token is RUNNER when the mid price after minute 10 reaches 2x that minute-10 mid inside the next 60 minutes, RUG when it does not and the path falls 80% from its peak or the pool drains, and DUD otherwise. A runner that later rugs stays a RUNNER here and is also counted in the rugs bucket above.");
  lines.push("");
  lines.push("### Does the entry mix call the outcome?");
  lines.push("");
  lines.push("Predictor, frozen before the run: RUG if last-60s blatant share ≥ 70 or nurturing share < 20; RUNNER if nurturing share ≥ 50 and blatant share < 50; otherwise UNKNOWN.");
  lines.push("");
  lines.push(confusionTable(north?.confusion));
  lines.push("");
  lines.push("Control sample (G0 only):");
  lines.push("");
  lines.push(confusionTable(north?.confusionG0));
  lines.push("");
  lines.push("### Runners by name");
  lines.push("");
  const runners = north?.runners ?? [];
  if (!runners.length) lines.push("No completed token reached 2x the minute-10 mid.");
  else {
    lines.push("| token | peak x | blatant % | nurture % | real buyers | outcome |");
    lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
    for (const row of runners) {
      lines.push(`| ${cell(row.name || row.symbol || row.mint)} | ${num(row.peakMultiple, 2)} | ${num(row.entryBlatant)} | ${num(row.entryNurture)} | ${row.entryReal ?? ""} | ${row.outcome} |`);
    }
  }
  lines.push("");
  lines.push("### Recurring wallets");
  lines.push("");
  lines.push("This table is an end-of-run evaluation. A wallet's earlier outcomes are not known at the later token's minute 10 unless that earlier token had already finished.");
  lines.push("");
  const wallets = north?.recurring?.wallets ?? [];
  if (!wallets.length) lines.push("No wallet traded two completed tokens.");
  else {
    lines.push("| wallet | tokens | runners | rugs | duds |");
    lines.push("| --- | ---: | ---: | ---: | ---: |");
    for (const row of wallets.slice(0, 30)) {
      lines.push(`| ${row.wallet} | ${row.mints} | ${row.runners} | ${row.rugs} | ${row.duds} |`);
    }
  }
  const flagged = (north?.recurring?.calls ?? []).filter((row) => row.flaggedRug);
  lines.push("");
  lines.push(`Recurring rug flag (2+ earlier rugs and no earlier runner): ${flagged.length} later tokens. ${flagged.filter((row) => row.actual === "RUG").length} of those later tokens were rugs.`);
  lines.push("");
  lines.push("### Testable rules");
  lines.push("");
  for (const rule of north?.rules ?? []) {
    lines.push(`- **${rule.id}** (${rule.status}): ${rule.text}`);
  }
  lines.push("");
  lines.push("## Gate × exit");
  lines.push("");
  lines.push("Every exit is scored at a 2s fill and a 3s fill. P&L is USD. The biggest runner is the highest peak in that gate's 2s entries and is always listed.");
  lines.push("");
  lines.push("| gate | exit | entries | rugs entered | runners ≥2x | runners ≥5x | runners kept ≥2x | biggest runner | peak x | our x | P&L 2s | P&L 3s | worst trade |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |");
  for (const row of rows) {
    const worst = row.worstName ? `${cell(row.worstName)} ${money(row.worstPnl)}` : "";
    lines.push(`| ${row.gate} | ${cell(row.exit)} | ${row.entries} | ${row.rugsEntered} | ${row.runners2x} | ${row.runners5x} | ${row.runnersKept} | ${cell(row.biggestName)} | ${num(row.peakMultiple, 2)} | ${num(row.ourMultiple, 2)} | ${money(row.pnl2s)} | ${money(row.pnl3s)} | ${worst} |`);
  }
  lines.push("");
  const markdown = lines.join("\n");
  const json = {
    chain: identity.chain,
    chain_id: identity.chain_id,
    strategy_version: identity.strategy_version,
    run_id: identity.run_id,
    north,
    rows,
  };
  return { markdown, json, rows, chain: identity.chain };
}

export function combineReports(reports) {
  return reports.map((report) => report.markdown).join("\n\n");
}
