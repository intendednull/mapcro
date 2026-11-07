// A small seeded PRNG (sfc32, seeded through splitmix32). Every decision the soak makes comes
// from one of these, so the same seed gives the same schedule of actions.

function splitmix32(a: number): () => number {
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  /** `seed` up to 2^53; `stream` picks an independent sequence for the same seed. */
  constructor(seed: number, stream = 0) {
    const lo = seed >>> 0;
    const hi = Math.floor(seed / 2 ** 32) >>> 0;
    const s = splitmix32(lo ^ Math.imul(hi, 0x85ebca6b) ^ Math.imul(stream + 1, 0xc2b2ae35));
    this.a = s();
    this.b = s();
    this.c = s();
    this.d = s();
    for (let i = 0; i < 12; i++) this.u32();
  }

  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.u32() / 2 ** 32;
  }

  int(lo: number, hiExclusive: number): number {
    return lo + Math.floor(this.next() * (hiExclusive - lo));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }

  /** Exponential with the given mean (inter-arrival times of a Poisson process). */
  exp(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  /** 32 hex digits: a record id. */
  hex128(): string {
    let s = "";
    for (let i = 0; i < 4; i++) s += this.u32().toString(16).padStart(8, "0");
    return s;
  }
}

/** FNV-1a over a string, for compact fingerprints. */
export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function parseSeed(s: string | undefined): number {
  if (!s || s === "random") return Date.now() % 2 ** 32;
  const n = s.startsWith("0x") ? parseInt(s.slice(2), 16) : Number(s);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad seed ${s}`);
  return n;
}
