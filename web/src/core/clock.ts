// The match clock as people type it ("8:00", "12:30", "8") and as the HUD shows it.

export const MAX_CLOCK = 4 * 3600; // the schema's bound

export function formatClock(s: number | null | undefined): string {
  if (s == null) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * `null` clears the clock, `undefined` means "not a clock" (the edit is refused, nothing sent).
 * A bare number is minutes, as people say it: "8" is 8:00.
 */
export function parseClock(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  let s: number;
  if (/^\d{1,3}$/.test(t)) s = Number(t) * 60;
  else {
    const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/.exec(t);
    if (!m) return undefined;
    const sec = Number(m[3]);
    if (sec > 59) return undefined;
    s = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + sec;
  }
  return s <= MAX_CLOCK ? s : undefined;
}
