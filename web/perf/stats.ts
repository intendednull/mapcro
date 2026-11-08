// Percentiles and small table helpers for the perf harness.

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  max: number;
}

export function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export function summarize(xs: number[]): Summary {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), mean, max: s.length ? s[s.length - 1]! : NaN };
}

const f = (x: number) => (Number.isNaN(x) ? "–" : x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));

/** A markdown table of stage summaries (milliseconds unless the label says otherwise). */
export function table(rows: Array<[string, Summary]>): string {
  const out = ["| Stage | n | p50 | p95 | p99 | max |", "|---|---:|---:|---:|---:|---:|"];
  for (const [name, s] of rows) out.push(`| ${name} | ${s.n} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.p99)} | ${f(s.max)} |`);
  return out.join("\n");
}

export const now = () => performance.timeOrigin + performance.now();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type PresenceLike = { cursor?: { x: number; y: number } | null; drag?: { pos: { x: number; y: number } } | null; focus?: string | null };
/** What identifies one presence update for matching a send to its receipt (the server re-serializes). */
export function presenceKey(s: PresenceLike): string {
  const c = s.cursor ? `${s.cursor.x},${s.cursor.y}` : "-";
  const d = s.drag ? `${s.drag.pos.x},${s.drag.pos.y}` : "-";
  return `${c}|${d}|${s.focus ?? "-"}`;
}
