// The markers and the two bars read `MapState` (map-state spec §6, phase 4 step 4). In Player what
// each reads is compared with what the frame gave it before (`previewAt`, the definition), at
// many times, on both tiers, under every Vision; in a scene, with the records. The match is made
// up (no names, no ids; 6v6).
import { describe, expect, it, vi } from "vitest";

// The browser build: the reactive one (node resolves solid-js to the server's, which doesn't
// track). For this file's imports, the sources' too.
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createRoot, createSignal } from "solid-js";
import type { ObjectiveStatus } from "../src/gen/ObjectiveStatus";
import type { PlayerState as HeroRecord } from "../src/gen/PlayerState";
import type { RecordId } from "../src/gen/RecordId";
import type { RosterSlot } from "../src/gen/RosterSlot";
import { type Shown, previewAt } from "../src/mapstate/frame";
import { fromScene } from "../src/mapstate/scene";
import { playerPlace, shownDeaths, shownUrn } from "../src/mapstate/shown";
import { fromTimeline } from "../src/mapstate/state";
import { type MatchPreview } from "../src/match/preview";
import { type Timeline, playersAt, slotKey } from "../src/match/timeline";
import { barSlot, barSlotOf } from "../src/player/barSlot";
import { markerTip, tipFacts } from "../src/player/Camps";
import { markerStates } from "../src/player/markerStates";
import { heroesAt } from "./support/player-frame";
import { factsOf } from "./support/tips";
import { N, markers, metadata, model, replay } from "./support/synthetic-match";

const VIEWS: Array<Pick<Shown, "vision" | "lastSeen">> = [
  { vision: "all", lastSeen: false }, { vision: "amber", lastSeen: false }, { vision: "amber", lastSeen: true },
  { vision: "sapphire", lastSeen: false }, { vision: "sapphire", lastSeen: true },
];
const SLOTS = (["amber", "sapphire"] as const).flatMap((team) => [0, 1, 2, 3, 4, 5].map((n) => slotKey(team, n)));
const KEYS = markers.map((m) => m.key);
const shownOf = (view: Pick<Shown, "vision" | "lastSeen">, health: boolean): Shown => ({ health, names: true, movement: true, cc: true, ...view });
/** Whole seconds, tenths, and between them. */
const TIMES = Array.from({ length: N * 10 + 1 }, (_, k) => k / 10 + (k % 3) * 0.013);

/** What the map showed for a marker from the frame, as `markerStates` did before `MapState`. */
function statusFrom(pv: MatchPreview, k: string) {
  if (k.startsWith("shop:")) return pv.shops?.has(k) ? "Hidden" : undefined;
  const site = pv.sites.get(k);
  if (site) return site;
  if (k.startsWith("rift:") || k.startsWith("urn:")) return "Destroyed";
  if (pv.down.has(k)) return "Destroyed";
  return pv.health?.get(k)?.stage === 2 ? "Stage2" : "Active";
}

/** Runs `check` for every time and view on a tier, with Player's state at that time. */
function everyFrame(tl: Timeline, check: (ctx: { state: ReturnType<typeof fromTimeline>; pv: MatchPreview; shown: Shown; t: number }) => void) {
  for (const t of TIMES) {
    createRoot((dispose) => {
      const state = fromTimeline({ tl: () => tl, t: () => t, markers: () => markers });
      for (const view of VIEWS) for (const health of [true, false]) {
        const shown = shownOf(view, health);
        check({ state, pv: previewAt(tl, t, markers, shown, false), shown, t });
      }
      dispose();
    });
  }
}

describe.each([["the replay tier", replay()], ["the metadata tier", metadata]] as const)("Player's frame on %s", (_name, tl) => {
  it("the markers show what the frame gave them", () => {
    const seen = new Set<unknown>();
    everyFrame(tl, ({ state, pv, shown }) => {
      const marks = markerStates({ ms: () => state, player: () => true, health: () => shown.health }, () => KEYS);
      for (const k of KEYS) {
        const b = pv.powerups?.get(k);
        expect([k, marks.status(k), marks.health(k), marks.camp(k), marks.buff(k)]).toEqual([k, statusFrom(pv, k), pv.health?.get(k)?.pct, pv.camps.get(k)?.state, b?.state === "up" ? b.buff : undefined]);
        seen.add(marks.status(k));
      }
    });
    expect(seen.has("Destroyed") && seen.has("Active")).toBe(true);
  });

  it("the hovers say what they said", () => {
    const said = new Set<string>();
    everyFrame(tl, ({ state, pv, shown, t }) => {
      for (const m of model.markers) {
        const now = markerTip(m, tipFacts(state, m.key, shown.health, shownUrn(state, shown.vision)), t);
        expect([m.key, now]).toEqual([m.key, markerTip(m, factsOf(pv, m.key), t)]);
        if (now) said.add(now.replace(/[\d:%]+/g, "#"));
      }
    });
    if (tl.tier === "replay") expect(said.size).toBeGreaterThan(6);
  });

  it("the urn is where the viewer may see it", () => {
    const hidden = { carried: 0, unseen: 0 };
    everyFrame(tl, ({ state, pv, shown }) => {
      const now = shownUrn(state, shown.vision);
      expect(now).toEqual(pv.urn);
      if (now?.state === "carried") hidden[now.unseen ? "unseen" : "carried"]++;
    });
    if (tl.tier === "replay") expect(hidden.unseen > 0 && hidden.carried > 0, JSON.stringify(hidden)).toBe(true);
  });

  it("a skull shows the deaths the viewer saw", () => {
    // Sapphire 3 dies at 5 out of Amber's sight (the fixture's own deaths are all seen).
    const m = tl.tier === "replay" ? { ...tl, players: tl.players.map((p, i) => (i === 9 ? { ...p, seen: [[0, 14]] as Array<[number, number]> } : p)) } : tl;
    let filtered = 0;
    everyFrame(m, ({ state, pv, shown }) => {
      const now = shownDeaths(state, shown.vision).map(({ seen: _seen, ...skull }) => skull);
      expect(now).toEqual(pv.skulls ?? []);
      if (now.length < state.scene().deaths().length) filtered++;
    });
    if (tl.tier === "replay") expect(filtered).toBeGreaterThan(0);
  });

  it("a portrait's focus goes where the frame draws the hero: its ghost, or nowhere", () => {
    const tally = { there: 0, ghost: 0, none: 0 };
    everyFrame(tl, ({ state, pv, shown }) => {
      for (const s of SLOTS) {
        const drawn = pv.players.get(s);
        expect([s, playerPlace(state, s, shown)]).toEqual([s, drawn?.pos ?? undefined]);
        tally[drawn?.pos ? (drawn.ghost != null ? "ghost" : "there") : "none"]++;
      }
    });
    if (tl.tier === "replay") expect(Object.values(tally).every((n) => n > 0), JSON.stringify(tally)).toBe(true);
  });

  it("the bar's portraits show the hero at t", () => {
    for (const t of TIMES) {
      createRoot((dispose) => {
        const state = fromTimeline({ tl: () => tl, t: () => t, markers: () => markers });
        const rows = new Map(heroesAt(tl, t, playersAt(tl, Math.floor(t))).map((x) => [slotKey(x.team, x.slot), x]));
        for (const s of SLOTS) {
          const x = rows.get(s)!;
          expect([s, barSlot(state.hero(s))()]).toEqual([s, { hero_id: x.hero_id, dead: x.pos === null, souls: x.souls, ult: x.ult, health: x.health, respawn: x.respawn }]);
        }
        dispose();
      });
    }
  });
});

describe("a slot the match doesn't hold", () => {
  it("has no portrait, and no timeline shows no markers' detail", () => {
    createRoot((dispose) => {
      const state = fromTimeline({ tl: () => undefined, t: () => 3, markers: () => markers });
      expect(barSlotOf(state.hero("amber-0"))).toBeUndefined();
      expect(playerPlace(state, "amber-0", shownOf(VIEWS[0]!, true))).toBeUndefined();
      expect(shownUrn(state, "amber")).toBeUndefined();
      expect(shownDeaths(state, "amber")).toEqual([]);
      dispose();
    });
  });
});

describe("a scene's markers", () => {
  const roster: Array<{ id: RecordId; slot: RosterSlot }> = [{ id: "r0" as RecordId, slot: { team: "Amber", slot: 0, hero: 3, name: "" } as RosterSlot }];
  const heroRec = (over: Partial<HeroRecord> = {}): { state: HeroRecord } => ({ state: { scene: "s" as RecordId, slot: "r0" as RecordId, pos: { x: 1, y: 2 }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true, ...over } as HeroRecord });
  const sceneState = (stored: Map<string, ObjectiveStatus>) =>
    fromScene({ heroes: () => [heroRec()], roster: () => roster, objectives: () => new Map([...stored].map(([k, status]) => [k, { status }])), waves: () => new Map(), state: () => undefined });

  it("show the status the scene stores; a marker with none says so, and a shop is never hidden", () => {
    createRoot((dispose) => {
      const stored = new Map<string, ObjectiveStatus>([
        ["rift:neutral:lane1:1", "Active"], ["urn:neutral:lane6:1", "Destroyed"], ["guardian:amber:lane1:1", "Destroyed"],
        ["patron:amber:lane0:1", "Stage2"], ["walker:amber:lane1:1", "Hidden"], ["shop:amber:lane1:1", "Hidden"],
      ]);
      const ms = sceneState(stored);
      const marks = markerStates({ ms: () => ms, player: () => false, health: () => true }, () => KEYS);
      expect(marks.status("rift:neutral:lane1:1")).toBe("Active");
      expect(marks.status("urn:neutral:lane6:1")).toBe("Destroyed");
      expect(marks.status("guardian:amber:lane1:1")).toBe("Destroyed");
      expect(marks.status("patron:amber:lane0:1")).toBe("Stage2");
      expect(marks.status("walker:amber:lane1:1")).toBe("Hidden");
      // A shop has only Player's rule (closed with its guardian): as before, a stored one is ignored.
      expect(marks.status("shop:amber:lane1:1")).toBeUndefined();
      // No record: nothing, so the map's defaults stand (a rift off, an objective up).
      expect(marks.status("rift:neutral:lane6:1")).toBeUndefined();
      expect(marks.status("guardian:sapphire:lane1:1")).toBeUndefined();
      expect(KEYS.every((k) => marks.health(k) === undefined && marks.camp(k) === undefined && marks.buff(k) === undefined)).toBe(true);
      dispose();
    });
  });

  it("follow a status another editor stores, and say nothing on hover", () => {
    createRoot((dispose) => {
      const [stored, setStored] = createSignal(new Map<string, ObjectiveStatus>());
      const ms = fromScene({ heroes: () => [heroRec()], roster: () => roster, objectives: () => new Map([...stored()].map(([k, status]) => [k, { status }])), waves: () => new Map(), state: () => undefined });
      const marks = markerStates({ ms: () => ms, player: () => false, health: () => true }, () => KEYS);
      expect(marks.status("walker:amber:lane1:1")).toBeUndefined();
      setStored(new Map([["walker:amber:lane1:1", "Destroyed" as ObjectiveStatus]]));
      expect(marks.status("walker:amber:lane1:1")).toBe("Destroyed");
      for (const m of model.markers) expect([m.key, markerTip(m, tipFacts(ms, m.key, true, shownUrn(ms, "amber")), 30)]).toEqual([m.key, undefined]);
      expect(shownUrn(ms, "amber")).toBeUndefined();
      expect(shownDeaths(ms, "amber")).toEqual([]);
      dispose();
    });
  });
});

describe("a scene's names", () => {
  const roster = (name: string): Array<{ id: RecordId; slot: RosterSlot }> => [{ id: "r0" as RecordId, slot: { team: "Amber", slot: 0, hero: 3, name } as RosterSlot }];
  const named = (own: string | undefined, typed: string, match: string | undefined) =>
    fromScene({
      heroes: () => [{ state: { scene: "s" as RecordId, slot: "r0" as RecordId, pos: { x: 0, y: 0 }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true, ...(own !== undefined ? { more: { name: own } } : {}) } as HeroRecord }],
      roster: () => roster(typed), objectives: () => new Map(), waves: () => new Map(), state: () => undefined,
      names: () => () => match,
    }).hero("amber-0").name();

  it("put the scene's own first, then the typed name, then the open match's (TD-120)", () => {
    createRoot((dispose) => {
      expect(named("Own", "Typed", "Match")).toBe("Own");
      expect(named(undefined, "Typed", "Match")).toBe("Typed");
      expect(named(undefined, "  ", "Match")).toBe("Match");
      expect(named(undefined, "", undefined)).toBeNull();
      // Names off: the open match's is gone (`names` asks the host under Names); a typed one and
      // the scene's own are typed, and stay.
      expect(named("Own", "", undefined)).toBe("Own");
      expect(named(undefined, "Typed", undefined)).toBe("Typed");
      dispose();
    });
  });
});
