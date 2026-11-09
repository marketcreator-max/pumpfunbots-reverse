export const GAP_MS = 60_000;
export const STALL_MS = 60_000;
export const HEARTBEAT_MS = 30_000;
export const SILENCE_MS = 20_000;
export const MAX_HOOD_RANGE = 200;

export function durationMs({ hours = 0, minutes = 0 } = {}) {
  return (Number(hours) || 0) * 3_600_000 + (Number(minutes) || 0) * 60_000;
}

export function shouldRestart({ now, startedAt, heartbeatAt, stallMs = STALL_MS, graceMs = 45_000 }) {
  if (now - startedAt < graceMs) return false;
  if (heartbeatAt == null) return true;
  return now - heartbeatAt > stallMs;
}

export function gapDue(lastTapeAt, now, gapMs = GAP_MS) {
  if (lastTapeAt == null) return false;
  return now - lastTapeAt >= gapMs;
}

export function hoodWindow(cursor, head, maxRange = MAX_HOOD_RANGE) {
  const tip = Number(head);
  if (!Number.isFinite(tip) || tip < 0) return { from: 0, to: 0, skipped: 0 };
  if (cursor == null || cursor > tip) return { from: tip, to: tip, skipped: 0 };
  const behind = tip - cursor;
  if (behind > maxRange) {
    return { from: tip - maxRange, to: tip, skipped: behind - maxRange };
  }
  return { from: cursor, to: tip, skipped: 0 };
}

export function isHoodRateLimit(error) {
  const message = String(error?.message ?? error ?? "");
  return /429|too many requests|rate limit|archive requires token|archived/i.test(message);
}

export function assessRun({ decided, incomplete, gapMs, durationMs }) {
  const reasons = [];
  const decidedN = Number(decided) || 0;
  const incompleteN = Number(incomplete) || 0;
  const gaps = Number(gapMs) || 0;
  const duration = Number(durationMs) || 0;
  if (decidedN > 0 && incompleteN / decidedN > 0.5) {
    reasons.push("more than half of decided tokens lack a full outcome window");
  }
  if (duration > 0 && gaps / duration > 0.1) {
    reasons.push("gap time exceeds 10% of the run");
  }
  return { valid: reasons.length === 0, reasons, decided: decidedN, incomplete: incompleteN, gapMs: gaps, durationMs: duration };
}

export function sumGaps(gaps) {
  let total = 0;
  const rows = [];
  for (const gap of gaps ?? []) {
    const start = Number(gap.gapStart ?? gap.start);
    const end = Number(gap.gapEnd ?? gap.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    total += end - start;
    rows.push({ start, end, ms: end - start, reason: gap.reason ?? "gap" });
  }
  return { total, rows };
}
