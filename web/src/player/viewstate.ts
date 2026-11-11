// The view-state store (spec §8 "Follow mode"): one value per key of the registry
// (crates/engine/src/view_state.rs, generated into gen/viewState.ts), with what following does
// to it read from the key's row, not written per feature. A key has your own value and, while
// you follow, maybe the presenter's; `get` is what the screen shows.
//
// To add view state: add a row to the registry, run `just ts`, give it a first value where the
// store is made (host.ts), and read and write it with `get` and `set`. Presence, the follower's
// mirror, the restore on stopping, stopping the follow on your own change, and the tests
// (test/view-state.test.ts) come from the row.

import { type Accessor, type Setter, batch, createSignal, untrack } from "solid-js";
import { VIEW_STATE, type ViewKey } from "../gen/viewState";
import { type Death, deathFromWire, deathKey, deathToWire, slotFromWire, slotToWire } from "./layers";

export const VIEW_KEYS = Object.keys(VIEW_STATE) as ViewKey[];
type Rows = typeof VIEW_STATE;
type Row = Rows[ViewKey];

/** What a key holds, by its kind (view_state.rs `Kind`). */
type KindValue<R> = R extends { kind: "bool" }
  ? boolean
  : R extends { kind: "choice"; options: readonly (infer O)[] }
    ? O
    : R extends { kind: "slot" }
      ? string | undefined
      : R extends { kind: "death" }
        ? Death | undefined
        : R extends { kind: "deaths" }
          ? Death[]
          : R extends { kind: "text" }
            ? string
            : never;
export type ValueOf<K extends ViewKey> = KindValue<Rows[K]>;
export type Values = { [K in ViewKey]: ValueOf<K> };

/** A presence, as far as the registry reads and writes it (fields by dotted path). */
export type Wire = Record<string, unknown>;

const row = (k: ViewKey): Row => VIEW_STATE[k];
type Extra = { options?: readonly string[]; wires?: readonly (string | null)[]; max?: number };
const extra = (r: Row) => r as Row & Extra;

/** Whether two values of a key are the same (a death by its slot and second). */
function same(r: Row, a: unknown, b: unknown): boolean {
  if (r.kind === "death") return deathKey(a as Death | undefined) === deathKey(b as Death | undefined);
  if (r.kind === "deaths") return (a as Death[]).map(deathKey).join() === (b as Death[]).map(deathKey).join();
  return a === b;
}

/** Text as presence may carry it (wire.rs `text_ok`): no control characters, at most `max` bytes. */
export function clipText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  // By code point, so a cut never splits a surrogate pair: a lone half isn't UTF-8, the
  // server can't parse the frame and closes the socket (review 2026-11-11). A lone half the
  // input already had becomes U+FFFD, as TextEncoder would send it.
  let out = "";
  let bytes = 0;
  for (const ch of clean) {
    const c = ch.codePointAt(0)!;
    const ok = c < 0xd800 || c > 0xdfff ? ch : "\ufffd";
    const n = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (bytes + n > max) break;
    out += ok;
    bytes += n;
  }
  return out;
}

/** A value as presence carries it (`undefined`: left out). */
function toWire(r: Row, v: unknown): unknown {
  switch (r.kind) {
    case "bool":
      return r.omit && !v ? undefined : v === true;
    case "choice": {
      const x = extra(r);
      const w = x.wires![Math.max(0, x.options!.indexOf(v as string))] ?? null;
      return r.omit && w === null ? undefined : w;
    }
    case "slot":
      return slotToWire((v as string | undefined) ?? "");
    case "death":
      return deathToWire(v as Death | undefined);
    case "deaths":
      return deathToWire((v as Death[]).at(-1));
    case "text": {
      const s = clipText(v as string, extra(r).max!);
      return r.omit && !s ? undefined : s;
    }
  }
}
/** A value presence carried (its parent is there: a missing value is the default). */
function fromWire(r: Row, w: unknown): unknown {
  switch (r.kind) {
    case "bool":
      return w === true;
    case "choice": {
      const x = extra(r);
      return x.options![Math.max(0, x.wires!.indexOf((w ?? null) as string | null))];
    }
    case "slot":
      return slotFromWire(w as never);
    case "death":
    case "deaths":
      return deathFromWire(w as never);
    case "text":
      return typeof w === "string" ? clipText(w, extra(r).max!) : "";
  }
}

/** A presenter sent nothing for a key: an older client, or nothing at its place (no match). */
const ABSENT = Symbol("absent");
function read(src: Wire | null | undefined, r: Row): unknown {
  if (!r.field) return ABSENT;
  const parts = r.field.split(".");
  let at: unknown = src;
  for (const p of parts.slice(0, -1)) at = at != null && typeof at === "object" ? (at as Wire)[p] : undefined;
  if (at == null || typeof at !== "object") return ABSENT;
  const w = (at as Wire)[parts.at(-1)!];
  if (r.mask !== null) return typeof w === "number" ? (w & r.mask) !== 0 : r.omit ? false : ABSENT;
  return fromWire(r, w);
}
/** The object at a dotted path's parent in `out`, made as needed, and the leaf's name. */
function place(out: Wire, path: string): [Wire, string] {
  const parts = path.split(".");
  let at = out;
  for (const p of parts.slice(0, -1)) at = (at[p] ??= {}) as Wire;
  return [at, parts.at(-1)!];
}

export interface ViewState {
  /** What the screen shows: the presenter's while you follow one who sends it, else your own. */
  get<K extends ViewKey>(k: K): ValueOf<K>;
  /**
   * Your own choice. A `stop` key is a change to what you see: you keep everything the screen
   * shows now (a presenter's, while following) with this one change, and following stops
   * (`onStop`). A `local` key is yours until the presenter's next change to its group.
   */
  set<K extends ViewKey>(k: K, v: ValueOf<K>): void;
  /** What presence carries for the shared keys, at their fields' paths: the shown values.
   * `under`: only the keys in that top-level field (`layers`, `playback`). */
  wire(under?: string): Wire;
  /**
   * A followed presenter's presence. With no `group`: the keys outside a group (the map layers,
   * Vision), on every frame. With one: that group's keys, only when the presenter's values for
   * it changed since last heard, so a follower's own stays until then. A key whose place isn't
   * in `src` (an older client, no match) leaves the follower on its own; unknown bits and
   * choices are ignored.
   */
  mirror(src: Wire | null | undefined, group?: string): void;
  /**
   * Following stopped. `restore` (Stop following, or the presenter left): `restore` keys show
   * your own again. `keep` (your own change stopped it): you keep what the screen shows.
   * `keep` keys stay as they are either way.
   */
  forget(how: "restore" | "keep"): void;
  /** Another match: keys that name its deaths or slots go back to their first values. */
  reset(): void;
}

export interface Options {
  /** Your own value of a key changed (to remember it); not called for a presenter's. */
  onOwn?: (k: ViewKey, v: unknown) => void;
  /** Your own change to a `stop` key: stop following (spec §8). */
  onStop?: () => void;
}

/** `first`: each key's value to start with (a default, or what this browser remembers). */
export function createViewState(first: Values, o: Options = {}): ViewState {
  type Cell = { own: Accessor<unknown>; setOwn: Setter<unknown>; theirs: Accessor<unknown>; setTheirs: Setter<unknown> };
  const cells = {} as Record<ViewKey, Cell>;
  for (const k of VIEW_KEYS) {
    const equals = (a: unknown, b: unknown) => (a === ABSENT || b === ABSENT ? a === b : same(row(k), a, b));
    const [own, setOwn] = createSignal<unknown>(first[k], { equals });
    const [theirs, setTheirs] = createSignal<unknown>(ABSENT, { equals });
    cells[k] = { own, setOwn, theirs, setTheirs };
  }
  const get = (k: ViewKey) => {
    const t = cells[k].theirs();
    return t === ABSENT ? cells[k].own() : t;
  };
  const setOwn = (k: ViewKey, v: unknown) => {
    if (same(row(k), untrack(cells[k].own), v)) return;
    cells[k].setOwn(() => v);
    o.onOwn?.(k, v);
  };
  /** Each `restore` key showing a presenter's value takes it as your own (and remembers it). */
  const adopt = () =>
    VIEW_KEYS.forEach((k) => {
      const t = untrack(cells[k].theirs);
      if (t === ABSENT) return;
      setOwn(k, t);
      cells[k].setTheirs(() => ABSENT);
    });
  /** The presenter's values for each group, as last heard: a change applies the group. */
  let heard: Record<string, string> = {};
  /** The death a `deaths` key last heard: the presenter's next change closes it. */
  let lastDeath: Partial<Record<ViewKey, Death | undefined>> = {};
  const apply = (k: ViewKey, w: unknown) => {
    const r = row(k);
    if (r.unfollow === "restore") return cells[k].setTheirs(() => w);
    if (w === ABSENT) return;
    if (r.kind !== "deaths") return cells[k].setOwn(() => w);
    // The presenter's last one closes as theirs does (or another opens); your own stay.
    const now = w as Death | undefined;
    const was = lastDeath[k];
    let list = untrack(cells[k].own) as Death[];
    if (was && deathKey(was) !== deathKey(now)) list = list.filter((d) => deathKey(d) !== deathKey(was));
    if (now && !list.some((d) => deathKey(d) === deathKey(now))) list = [...list, now];
    lastDeath[k] = now;
    cells[k].setOwn(() => list);
  };
  const shared = (group: string | undefined) => VIEW_KEYS.filter((k) => row(k).sync === "shared" && (row(k).group ?? undefined) === group);
  return {
    get: get as ViewState["get"],
    set: (k, v) =>
      batch(() => {
        const stop = row(k).override === "stop";
        if (stop) adopt();
        setOwn(k, v);
        if (stop) o.onStop?.();
      }),
    wire: (under) => {
      const out: Wire = {};
      for (const k of VIEW_KEYS) {
        const r = row(k);
        if (r.sync !== "shared" || !r.field || (under !== undefined && r.field.split(".")[0] !== under)) continue;
        const [at, leaf] = place(out, r.field);
        if (r.mask !== null) {
          // An integer field: a bit per key; sent whole, or left out at zero (`omit`).
          const n = ((at[leaf] as number | undefined) ?? 0) | (get(k) ? r.mask : 0);
          if (n || !r.omit) at[leaf] = n;
          continue;
        }
        const w = toWire(r, get(k));
        if (w !== undefined) at[leaf] = w;
      }
      return out;
    },
    mirror: (src, group) => {
      // Read where the caller tracks (presence is a store: an effect mirroring it re-runs on
      // what it read); apply untracked.
      const keys = shared(group);
      const heardNow = keys.map((k) => read(src, row(k)));
      untrack(() =>
        batch(() => {
          if (group !== undefined) {
            const now = JSON.stringify(heardNow.map((w, i) => {
              const r = row(keys[i]!);
              return w === ABSENT ? null : r.kind === "death" || r.kind === "deaths" ? deathKey(w as Death | undefined) : (w ?? null);
            }));
            if (heard[group] === now) return;
            heard[group] = now;
          }
          keys.forEach((k, i) => apply(k, heardNow[i]));
        }),
      );
    },
    forget: (how) =>
      batch(() => {
        heard = {};
        lastDeath = {};
        if (how === "keep") adopt();
        else VIEW_KEYS.forEach((k) => cells[k].setTheirs(() => ABSENT));
      }),
    reset: () =>
      batch(() => {
        // Only what goes back to its first value is heard afresh: a group with no such key
        // (the events filters and search) keeps the follower's own until the presenter's next
        // change to it (review 2026-11-11).
        for (const k of VIEW_KEYS) {
          const r = row(k);
          if (!r.reset) continue;
          if (r.group !== null) delete heard[r.group];
          delete lastDeath[k];
          setOwn(k, first[k]);
        }
      }),
  };
}
