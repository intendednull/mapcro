// The view-state registry (crates/engine/src/view_state.rs → src/gen/viewState.ts) and the
// store built from it (src/player/viewstate.ts): each key behaves as its row says, and no
// signal is added to Player or the board without saying what following does with it.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VIEW_STATE, type ViewKey } from "../src/gen/viewState";
import { type BitField, type FlagKey, VIEW_KEYS, createViewState } from "../src/player/viewstate";
import { DISCLOSURES, SCANNED, SIGNALS } from "./view-state-ledger";

const all = (on: boolean) => Object.fromEntries(VIEW_KEYS.map((k) => [k, on])) as Record<ViewKey, boolean>;
const row = (k: ViewKey): { sync: string; field: string | null; mask: number | null; unfollow: string; override: string } => VIEW_STATE[k];
/** A presenter's value for one key arrives, as presence carries that key. */
const hear = (s: ReturnType<typeof createViewState>, k: ViewKey, on: boolean, others = false) => {
  const d = row(k);
  if (d.mask !== null) {
    const rest = VIEW_KEYS.filter((j) => j !== k && row(j).field === d.field).reduce((n, j) => (others ? n | row(j).mask! : n), 0);
    s.mirrorBits(d.field as BitField, rest | (on ? d.mask : 0));
  } else s.mirrorFlag(k as FlagKey, on);
};

describe("the map layers on the wire", () => {
  it("has the bits shipped in presence's `layers` (wire.rs LAYER_*)", () => {
    const bit = (k: ViewKey) => createViewState({ ...all(false), [k]: true }).bits("layers");
    expect(["layer.troopers", "layer.health", "layer.pings", "layer.cc", "layer.movement", "layer.heals", "layer.crates"].map((k) => bit(k as ViewKey))).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(createViewState(all(true)).bits("layers")).toBe(127);
  });
  it("a follower ignores unknown bits, and keeps its own under an older presenter", () => {
    const s = createViewState(all(false));
    s.mirrorBits("layers", 128 | 2);
    expect(s.bits("layers")).toBe(2);
    s.mirrorBits("layers", undefined);
    expect(s.bits("layers")).toBe(0);
    s.mirrorBits("layers", 2);
    s.mirrorBits("layers", null);
    expect(s.bits("layers")).toBe(0);
  });
});

describe("every registry key follows its row", () => {
  for (const k of VIEW_KEYS) {
    const d = row(k);
    for (const mine of [false, true]) {
      const theirs = !mine;
      const fresh = () => {
        const remembered: Array<[ViewKey, boolean]> = [];
        const s = createViewState(all(mine), (key, on) => remembered.push([key, on]));
        return { s, remembered };
      };
      if (d.sync === "personal") {
        it(`${k} (personal, own ${mine}): never sent, never a presenter's`, () => {
          const { s, remembered } = fresh();
          expect(d.field).toBeNull();
          for (const j of VIEW_KEYS) if (j !== k && row(j).sync === "shared") hear(s, j, theirs, theirs);
          expect(s.get(k)).toBe(mine);
          s.set(k, theirs);
          expect(s.get(k)).toBe(theirs);
          expect(remembered).toEqual([[k, theirs]]);
          expect(s.stops(k)).toBe(false);
          s.forget();
          expect(s.get(k)).toBe(theirs);
        });
        continue;
      }
      it(`${k} (own ${mine}): a follower shows the presenter's, and sends what it shows`, () => {
        const { s, remembered } = fresh();
        hear(s, k, theirs, mine);
        expect(s.get(k)).toBe(theirs);
        if (d.mask !== null) expect((s.bits(d.field as BitField) & d.mask) !== 0).toBe(theirs);
        // A presenter's value is not your choice: nothing is remembered.
        expect(remembered).toEqual([]);
      });
      it(`${k} (own ${mine}): stopping ${d.unfollow === "restore" ? "brings your own back" : "leaves it"}`, () => {
        const { s } = fresh();
        hear(s, k, theirs, mine);
        s.forget();
        expect(s.get(k)).toBe(d.unfollow === "restore" ? mine : theirs);
      });
      it(`${k} (own ${mine}): your change while following ${d.override === "stop" ? "stops, keeping the rest of what you saw" : "is yours until theirs changes"}`, () => {
        const { s, remembered } = fresh();
        hear(s, k, theirs, theirs);
        expect(s.stops(k)).toBe(d.override === "stop");
        s.set(k, mine);
        // The caller stops the follow for a `stop` key (Player's `mine`); a `local` one goes on.
        if (d.override === "stop") s.forget();
        expect(s.get(k)).toBe(mine);
        const kept = VIEW_KEYS.filter((j) => j !== k && row(j).field === d.field && row(j).override === "stop");
        // The field's other keys: the presenter's stay on screen, now as your own (remembered).
        if (d.override === "stop") for (const j of kept) expect(s.get(j)).toBe(theirs);
        expect(new Map(remembered).get(k)).toBe(mine);
        if (d.override === "stop") expect(remembered.map(([j]) => j).sort()).toEqual([k, ...kept].sort());
        if (d.override === "local") {
          hear(s, k, theirs);
          expect(s.get(k)).toBe(theirs);
        }
      });
    }
  }
});

describe("no state in Player or the board without a follow policy", () => {
  const src = new URL("../src/", import.meta.url);
  const files = [...SCANNED.dirs.flatMap((d) => readdirSync(new URL(`${d}/`, src)).filter((f) => /\.tsx?$/.test(f)).map((f) => `${d}/${f}`)), ...SCANNED.files].sort();
  const found = (re: RegExp) =>
    Object.fromEntries(files.map((f) => [f, [...readFileSync(new URL(f, src), "utf8").matchAll(re)].map((m) => m[1]!)] as const).filter(([, names]) => names.length > 0));
  const HOW = "say what following does with it: a row in crates/engine/src/view_state.rs (and the store), or an entry in web/test/view-state-ledger.ts";

  it("every createSignal is in the ledger", () => {
    const signals = found(/\[\s*(\w+)\s*(?:,\s*\w+\s*)?\]\s*=\s*createSignal\b/g);
    const calls = found(/(createSignal)\s*[<(]/g);
    for (const f of files) {
      // Every call is destructured where it is made, so the name scan sees them all.
      expect((signals[f] ?? []).length, `${f}: a createSignal the guard can't name; destructure it as [get, set]`).toBe((calls[f] ?? []).length);
      for (const name of signals[f] ?? []) expect(SIGNALS[f]?.[name], `${f}: signal \`${name}\` has no follow policy; ${HOW}`).toBeDefined();
    }
    for (const [f, entries] of Object.entries(SIGNALS)) for (const name of Object.keys(entries)) expect(signals[f] ?? [], `ledger: ${f} has no signal \`${name}\` any more; remove the entry`).toContain(name);
  });

  it("every <details> is in the ledger", () => {
    const named = found(/<details\b[^>]*?\bclass=(?:"|\{cx\(")([^"]+)"/g);
    const tags = found(/(<details)\b/g);
    for (const f of files) {
      expect((named[f] ?? []).length, `${f}: a <details> without a class the guard can name`).toBe((tags[f] ?? []).length);
      for (const cls of named[f] ?? []) expect(DISCLOSURES[f]?.[cls], `${f}: <details class="${cls}"> has no follow policy; ${HOW}`).toBeDefined();
    }
    for (const [f, entries] of Object.entries(DISCLOSURES)) for (const cls of Object.keys(entries)) expect(named[f] ?? [], `ledger: ${f} has no <details class="${cls}"> any more; remove the entry`).toContain(cls);
  });

  it("no registry key is also kept as a signal of its own in the host", () => {
    // The migrated ones, by the names they had: back as signals, they would bypass the store.
    const host = readFileSync(new URL("player/host.ts", src), "utf8");
    for (const gone of ["ownLayers", "theirLayers", "allBuilds", "showNames"]) expect(host).not.toMatch(new RegExp(`\\[\\s*${gone}\\s*,[^\\]]*\\]\\s*=\\s*createSignal`));
  });
});
