// Fractional-index keys for scene order: a port of `OrderKey::between` (crates/schema/src/ids.rs),
// so the keys this client mints are the ones the server would mint and always validate.

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = 36;

export const FIRST_KEY = "i";

export function isValidKey(k: string): boolean {
  return k.length >= 1 && k.length <= 32 && /^[0-9a-z]+$/.test(k) && !k.endsWith("0");
}

function midpoint(lo: number[], hi: number[] | undefined): number[] {
  const loAt = (i: number) => lo[i] ?? 0;
  if (hi) {
    let n = 0;
    while (n < hi.length && loAt(n) === hi[n]) n++;
    if (n > 0) return [...hi.slice(0, n), ...midpoint(lo.slice(n), hi.slice(n))];
  }
  const dl = loAt(0);
  const dh = hi?.[0] ?? BASE;
  if (dh - dl > 1) return [Math.floor((dl + dh) / 2)];
  if (hi && hi.length > 1) return [hi[0]!];
  return [dl, ...midpoint(lo.slice(1), undefined)];
}

/** A key strictly between `lo` and `hi` (either may be open). Requires `lo < hi`. */
export function keyBetween(lo: string | undefined, hi: string | undefined): string {
  const digits = (k: string) => [...k].map((c) => Math.max(0, DIGITS.indexOf(c)));
  return midpoint(lo ? digits(lo) : [], hi === undefined ? undefined : digits(hi))
    .map((d) => DIGITS[d])
    .join("");
}
