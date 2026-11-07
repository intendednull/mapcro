// Souls as the HUD writes them (design/parity/README.md, "Souls format"): the integer under
// 1,000; one decimal and a small "k" up to 9,999; an integer "k" from 10,000. Truncated, never
// rounded: 44,830 is "44k".

export function formatSouls(n: number | null | undefined): { value: string; k: boolean } {
  if (n == null) return { value: "–", k: false };
  if (n < 1000) return { value: String(Math.floor(n)), k: false };
  if (n < 10000) return { value: (Math.floor(n / 100) / 10).toFixed(1), k: true };
  return { value: String(Math.floor(n / 1000)), k: true };
}

/** What people type: "9040", "9k", "9.0k", "12,500". `null` clears; `undefined` refuses. */
export function parseSouls(text: string): number | null | undefined {
  const t = text.trim().toLowerCase().replace(/[,_\s]/g, "");
  if (t === "" || t === "–" || t === "-") return null;
  const m = /^(\d+(?:\.\d+)?)(k?)$/.exec(t);
  if (!m) return undefined;
  const v = Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
  return Number.isSafeInteger(v) && v <= 999_999 ? v : undefined;
}

export const teamTotal = (souls: Array<number | null>) => souls.reduce<number>((a, s) => a + (s ?? 0), 0);

/** Ult ring drag: the pointer's angle around the ring, clockwise from 12 o'clock, as 0–100. */
export function ultFromVector(dx: number, dy: number): number {
  const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  return Math.min(100, Math.round(deg / 3.6));
}

/** One scroll step on the ring: 5%, clamped; an untracked ult starts from ready. */
export function ultStep(current: number | null, down: boolean): number {
  return Math.max(0, Math.min(100, (current ?? 0) + (down ? 5 : -5)));
}
