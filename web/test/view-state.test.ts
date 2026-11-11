// The view-state registry (crates/engine/src/view_state.rs → src/gen/viewState.ts) and the
// store built from it (src/player/viewstate.ts): each key behaves as its row says, and no
// signal is added to Player or the board without saying what following does with it.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VIEW_STATE, type ViewKey } from "../src/gen/viewState";
import { type ValueOf, type Values, VIEW_KEYS, clipText, createViewState } from "../src/player/viewstate";
import { GROUPS } from "../src/player/events";
import { DISCLOSURES, SCANNED, SIGNALS } from "./view-state-ledger";

type Row = { sync: string; kind: string; options?: readonly string[]; max?: number; field: string | null; mask: number | null; omit: boolean; unfollow: string; override: string; group: string | null; reset: boolean };
const row = (k: ViewKey): Row => VIEW_STATE[k];

/** Three values of a key, all different: a first one, and two others. */
function samples(k: ViewKey): [unknown, unknown, unknown] {
  const r = row(k);
  switch (r.kind) {
    case "bool":
      // A boolean has two: the third is the first again (enough to tell a change).
      return [false, true, false];
    case "choice":
      return [r.options![0], r.options![1], r.options![2] ?? r.options![0]];
    case "slot":
      return [undefined, "amber-2", "sapphire-4"];
    case "death":
      return [undefined, { slot: "sapphire-2", t: 40 }, { slot: "amber-1", t: 20 }];
    case "deaths":
      return [[], [{ slot: "sapphire-2", t: 40 }], [{ slot: "amber-1", t: 20 }]];
    case "text":
      return ["", "urn", "haze"];
  }
  throw new Error(`${k}: kind ${r.kind}`);
}
/** Every key at its first sample, or at its second with `others`. */
const everything = (i: 0 | 1 = 0) => Object.fromEntries(VIEW_KEYS.map((k) => [k, samples(k)[i]])) as Values;
/** A presenter: a store of its own; its `wire()` is what presence carries. */
const presenter = (vals: Partial<Values> = {}) => createViewState({ ...everything(), ...vals });
type Follower = ReturnType<typeof follower>;
function follower(first = everything()) {
  const remembered: Array<[ViewKey, unknown]> = [];
  let stops = 0;
  const s = createViewState(first, { onOwn: (k, v) => remembered.push([k, v]), onStop: () => void stops++ });
  return { s, remembered, stopped: () => stops };
}
/** A follower hears a presenter's presence, as host.ts `mirror` passes it: every group. */
const hear = (f: Follower, from: ReturnType<typeof presenter>) => {
  const w = from.wire();
  f.s.mirror(w);
  for (const g of new Set(VIEW_KEYS.map((k) => row(k).group).filter((g) => g !== null))) f.s.mirror(w, g!);
};
const shownAs = (k: ViewKey, v: unknown) => JSON.stringify(v ?? null) + `@${k}`;
const shows = (f: Follower, k: ViewKey) => shownAs(k, f.s.get(k));

describe("the wire", () => {
  it("has the map layers' bits shipped in presence's `layers` (wire.rs LAYER_*)", () => {
    const layers = ["layer.troopers", "layer.health", "layer.pings", "layer.cc", "layer.movement", "layer.heals", "layer.crates"] as const;
    expect(layers.map((k) => presenter({ [k]: true }).wire("layers").layers)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(presenter(Object.fromEntries(layers.map((k) => [k, true]))).wire().layers).toBe(127);
    // Sent whole, even all off: absent means an older client.
    expect(presenter().wire().layers).toBe(0);
  });
  it("leaves out what is closed, and carries Vision whole", () => {
    const w = presenter().wire();
    expect(w.playback).toEqual({ vision: { team: null, last_seen: false } });
    const open = presenter({ "builds.all": true, "recap.skull": { slot: "amber-1", t: 20 }, "builds.popover": "order", "events.filter.urn": true, "events.search": "x", "vision.team": "sapphire" }).wire().playback as Record<string, unknown>;
    expect(open).toMatchObject({ all_builds: true, skull_recap: { team: "Amber", slot: 1, t: 20 }, build_popover: "order", event_filters: 64, event_search: "x", vision: { team: "Sapphire", last_seen: false } });
  });
  it("the events filters are the list's chips, a bit each in order", () => {
    expect(GROUPS.map((g) => g.id).map((id) => row(`events.filter.${id}` as ViewKey).mask)).toEqual(GROUPS.map((_, i) => 1 << i));
    expect(VIEW_KEYS.filter((k) => k.startsWith("events.filter.")).length).toBe(GROUPS.length);
  });
  it("a follower ignores unknown bits and choices, and keeps its own under an older presenter", () => {
    const f = follower();
    f.s.mirror({ layers: 128 | 2 });
    expect(f.s.wire("layers").layers).toBe(2);
    f.s.mirror({ layers: undefined, playback: { vision: { team: "Purple", last_seen: true } } });
    expect(f.s.get("layer.health")).toBe(false);
    expect(f.s.get("vision.team")).toBe("all");
    expect(f.s.get("vision.last_seen")).toBe(true);
    // No playback at all (Sandbox without a match, an older client): your own Vision.
    const mine = follower({ ...everything(), "vision.team": "amber" });
    mine.s.mirror({ playback: { vision: { team: "Sapphire", last_seen: false } } });
    expect(mine.s.get("vision.team")).toBe("sapphire");
    mine.s.mirror({});
    expect(mine.s.get("vision.team")).toBe("amber");
    // Filters left out at zero mean none when the presenter's playback is there.
    const g = follower({ ...everything(), "events.filter.death": true });
    g.s.mirror({ playback: { player: true } }, "events");
    expect(g.s.get("events.filter.death")).toBe(false);
    g.s.set("events.filter.death", true);
    g.s.mirror({}, "events");
    expect(g.s.get("events.filter.death")).toBe(true);
  });
  it("text is clipped to its bytes and loses control characters", () => {
    const max = VIEW_STATE["events.search"].max;
    expect(clipText("a\nb\u0007c", max)).toBe("abc");
    expect(new TextEncoder().encode(clipText("é".repeat(max), max)).length).toBeLessThanOrEqual(max);
    expect((presenter({ "events.search": "x".repeat(max + 10) }).wire().playback as { event_search: string }).event_search.length).toBe(max);
  });
});

describe("every registry key follows its row", () => {
  for (const k of VIEW_KEYS) {
    const d = row(k);
    const [first, second, third] = samples(k);
    if (d.sync === "personal") {
      it(`${k} (personal): never sent, never a presenter's, never stops a follow`, () => {
        const f = follower();
        expect(d.field).toBeNull();
        hear(f, presenter(everything(1)));
        expect(f.s.get(k)).toEqual(first);
        f.s.set(k, second as never);
        expect(f.s.get(k)).toEqual(second);
        expect(f.remembered.filter(([j]) => j === k)).toEqual([[k, second]]);
        expect(f.stopped()).toBe(0);
        f.s.forget("restore");
        expect(f.s.get(k)).toEqual(second);
        const sent = JSON.stringify(f.s.wire());
        f.s.set(k, first as never);
        expect(JSON.stringify(f.s.wire())).toBe(sent);
      });
      continue;
    }
    it(`${k}: a follower shows the presenter's, sends what it shows, and remembers nothing of it`, () => {
      const f = follower();
      hear(f, presenter({ [k]: second }));
      expect(shows(f, k)).toBe(shownAs(k, second));
      expect(JSON.stringify(f.s.wire())).toBe(JSON.stringify(presenter({ [k]: second }).wire()));
      expect(f.remembered).toEqual([]);
      expect(f.stopped()).toBe(0);
    });
    it(`${k}: Stop following ${d.unfollow === "restore" ? "brings your own back" : "leaves it"}; the presenter's ${d.unfollow === "restore" ? "comes back on following again" : "stays"}`, () => {
      const f = follower();
      const p = presenter({ [k]: second });
      hear(f, p);
      f.s.forget("restore");
      expect(shows(f, k)).toBe(shownAs(k, d.unfollow === "restore" ? first : second));
      hear(f, p);
      expect(shows(f, k)).toBe(shownAs(k, second));
    });
    it(`${k}: your own change that stops a follow keeps what you saw (operator 2026-11-11)`, () => {
      const f = follower();
      hear(f, presenter({ [k]: second }));
      f.s.forget("keep");
      expect(shows(f, k)).toBe(shownAs(k, second));
      // Now your own: a presenter's frame from before no longer counts.
      f.s.mirror({});
      expect(shows(f, k)).toBe(shownAs(k, second));
    });
    it(`${k}: your change while following ${d.override === "stop" ? "stops it, keeping everything else you saw" : "is yours until the presenter's next change"}`, () => {
      const f = follower();
      const p = presenter(everything(1));
      hear(f, p);
      f.s.set(k, third as never);
      expect(shows(f, k)).toBe(shownAs(k, third));
      expect(new Map(f.remembered).get(k)).toEqual(third);
      if (d.override === "stop") {
        expect(f.stopped()).toBe(1);
        // Every other shared key keeps the presenter's on screen, now as your own: remembered,
        // and kept when following ends.
        f.s.forget("restore");
        for (const j of VIEW_KEYS) if (j !== k && row(j).sync === "shared") expect(shows(f, j)).toBe(shownAs(j, samples(j)[1]));
        for (const j of VIEW_KEYS) if (j !== k && row(j).unfollow === "restore") expect(new Map(f.remembered).get(j)).toEqual(samples(j)[1]);
        return;
      }
      expect(f.stopped()).toBe(0);
      // The same presence again (it is resent on every cursor move) doesn't undo yours.
      hear(f, p);
      expect(shows(f, k)).toBe(shownAs(k, third));
      // The presenter's next change to the group wins (for open deaths, the presenter's own:
      // the follower's stay open beside them).
      const plus = (v: unknown) => (d.kind === "deaths" ? [...(third as unknown[]), ...(v as unknown[])] : v);
      p.set(k, first as never);
      hear(f, p);
      expect(shows(f, k)).toBe(shownAs(k, plus(first)));
      p.set(k, second as never);
      hear(f, p);
      expect(shows(f, k)).toBe(shownAs(k, plus(second)));
    });
    it(`${k}: another match ${d.reset ? "resets it" : "leaves it"}`, () => {
      const f = follower();
      f.s.set(k, second as never);
      f.s.reset();
      expect(shows(f, k)).toBe(shownAs(k, d.reset ? first : second));
    });
  }
  it("a presenter's events recap closes its last; the follower's own stay open", () => {
    const f = follower();
    const mine = { slot: "amber-1", t: 20 };
    const theirs = { slot: "sapphire-2", t: 40 };
    f.s.set("recap.event", [mine]);
    const p = presenter();
    p.set("recap.event", [theirs]);
    hear(f, p);
    expect(f.s.get("recap.event")).toEqual([mine, theirs]);
    p.set("recap.event", []);
    hear(f, p);
    expect(f.s.get("recap.event")).toEqual([mine]);
  });
  it("the events list's recaps: presence carries the last opened", () => {
    const p = presenter();
    p.set("recap.event", [{ slot: "amber-1", t: 20 }, { slot: "sapphire-2", t: 40 }]);
    expect((p.wire().playback as { event_recap: unknown }).event_recap).toEqual({ team: "Sapphire", slot: 2, t: 40 });
  });
  it("following again applies the presenter's panels afresh, even unchanged", () => {
    const f = follower();
    const p = presenter({ "recap.skull": { slot: "amber-1", t: 20 } });
    hear(f, p);
    f.s.set("recap.skull", undefined);
    f.s.forget("restore");
    hear(f, p);
    expect(f.s.get("recap.skull")).toEqual({ slot: "amber-1", t: 20 });
  });
  it("your own value is remembered when it changes, not on a repeat", () => {
    const f = follower();
    f.s.set("layer.heals", true);
    f.s.set("layer.heals", true);
    expect(f.remembered).toEqual([["layer.heals", true]]);
  });
  it("a group applies whole: a presenter's change to one panel brings back the panels you closed", () => {
    const f = follower();
    const p = presenter({ "recap.skull": { slot: "amber-1", t: 20 } });
    hear(f, p);
    f.s.set("recap.skull", undefined);
    p.set("builds.inspect", "amber-0");
    hear(f, p);
    expect(f.s.get("recap.skull")).toEqual({ slot: "amber-1", t: 20 });
    // The inspected build's popover is one of the panels.
    p.set("builds.popover", "order");
    hear(f, p);
    f.s.set("builds.popover", "none");
    p.set("recap.skull", { slot: "sapphire-2", t: 40 });
    hear(f, p);
    expect(f.s.get("builds.popover")).toBe("order");
    // Another group's change doesn't: typing in the events search leaves the panels alone.
    f.s.set("recap.skull", undefined);
    p.set("events.search", "urn");
    hear(f, p);
    expect(f.s.get("recap.skull")).toBeUndefined();
    expect(f.s.get("events.search")).toBe("urn");
  });
  it("a local key's change doesn't stop a follow; nothing stops one but a stop key", () => {
    for (const k of VIEW_KEYS) {
      const f = follower();
      f.s.set(k, samples(k)[1] as never);
      expect(f.stopped(), k).toBe(row(k).override === "stop" ? 1 : 0);
    }
  });
  it("another match while following hears the panels afresh, and leaves the follower's own filters and search", () => {
    const f = follower();
    const p = presenter({ "events.filter.urn": true, "events.search": "urn", "recap.skull": { slot: "amber-1", t: 20 } });
    hear(f, p);
    expect(f.s.get("events.filter.urn")).toBe(true);
    // The follower's own chips and search (local: theirs until the presenter changes the group).
    f.s.set("events.filter.urn", false);
    f.s.set("events.filter.death", true);
    f.s.set("events.search", "haze");
    f.s.reset();
    hear(f, p);
    expect(f.s.get("events.filter.urn")).toBe(false);
    expect(f.s.get("events.filter.death")).toBe(true);
    expect(f.s.get("events.search")).toBe("haze");
    // The panels went back to their first values and the presenter's are applied again.
    expect(f.s.get("recap.skull")).toEqual({ slot: "amber-1", t: 20 });
    // The presenter's next change to the events still wins.
    p.set("events.search", "souls");
    hear(f, p);
    expect(f.s.get("events.search")).toBe("souls");
    expect(f.s.get("events.filter.urn")).toBe(true);
  });
});

describe("text clipped for presence", () => {
  const max = VIEW_STATE["events.search"].max;
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  /** Valid UTF-16: no lone surrogate (so it is valid UTF-8 on the wire). */
  const whole = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
  it("cuts by code point: astral characters at every offset around the limit", () => {
    for (const astral of ["😀", "𝄞", "🇸🇪"]) {
      for (let n = max - 8; n <= max + 2; n++) {
        for (const s of [`${"x".repeat(n)}${astral}`, `${"x".repeat(n)}${astral}${astral}`, `${"é".repeat(Math.floor(n / 2))}${astral}x`, `${astral.repeat(n)}`]) {
          const out = clipText(s, max);
          expect(whole(out), JSON.stringify(out)).toBe(true);
          expect(bytes(out)).toBeLessThanOrEqual(max);
          expect(s.startsWith(out)).toBe(true);
          // As much as fits: the next code point would go over.
          const next = [...s.slice(out.length)][0];
          if (next !== undefined) expect(bytes(out + next)).toBeGreaterThan(max);
        }
      }
    }
  });
  it("is the table wire.rs checks the server takes", () => {
    const x = (n: number) => "x".repeat(n);
    expect(clipText(`${x(61)}😀`, max)).toBe(x(61));
    expect(clipText(`${x(60)}😀x`, max)).toBe(`${x(60)}😀`);
    expect(clipText(`${x(62)}éé`, max)).toBe(`${x(62)}é`);
    expect(clipText(`${x(61)}\ud83d`, max)).toBe(`${x(61)}�`);
    expect(clipText("😀".repeat(20), max)).toBe("😀".repeat(16));
    expect(clipText("ж".repeat(40), max)).toBe("ж".repeat(32));
  });
  it("a lone surrogate it was given goes out as U+FFFD, within the bytes", () => {
    for (const s of ["a\ud83d", "\udc00b", `${"x".repeat(62)}\ud83d`]) {
      const out = clipText(s, max);
      expect(whole(out)).toBe(true);
      expect(bytes(out)).toBeLessThanOrEqual(max);
    }
  });
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
    for (const gone of ["ownLayers", "theirLayers", "allBuilds", "showNames", "ownVision", "ownLastSeen", "theirVision", "skullRecap", "eventRecaps", "openBuild"]) expect(host).not.toMatch(new RegExp(`\\[\\s*${gone}\\s*,[^\\]]*\\]\\s*=\\s*createSignal`));
  });
});
