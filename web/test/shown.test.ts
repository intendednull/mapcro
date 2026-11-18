// The viewer's choices over a frame's facts (map-state spec D3, D5; mapstate/shown.ts): Player's
// Vision logic for both producers, an unseen hero faded in a scene instead of gone.

import { describe, expect, it, vi } from "vitest";

vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createRoot } from "solid-js";
import { type Shown, previewAt } from "../src/mapstate/frame";
import { type HeroDraw, type HeroSight, type PlayerHero, heroDraw, playerHero } from "../src/mapstate/shown";
import { fromTimeline } from "../src/mapstate/state";
import type { Vision } from "../src/player/vision";
import { N, markers, metadata, replay } from "./support/synthetic-match";

const SLOTS = (["amber", "sapphire"] as const).flatMap((team) => [0, 1, 2, 3, 4, 5].map((n) => ({ key: `${team}-${n}`, team })));
const VIEWS: Array<{ vision: Vision; lastSeen: boolean }> = [
  { vision: "all", lastSeen: false }, { vision: "all", lastSeen: true },
  { vision: "amber", lastSeen: false }, { vision: "amber", lastSeen: true },
  { vision: "sapphire", lastSeen: false }, { vision: "sapphire", lastSeen: true },
];
const at = { x: 3, y: 4 };
const hero = (over: Partial<HeroSight> = {}): HeroSight => ({ team: "sapphire", inSight: false, lastSeen: { at, ago: 2.5 }, ...over });

describe("a hero under the viewer's Vision", () => {
  it("in Player is what the frame drew: seen, a ghost where last seen, or not drawn", () => {
    const tally = { seen: 0, ghost: 0, hidden: 0 };
    for (const tl of [replay(), metadata]) {
      for (let k = 0; k <= N * 10; k++) {
        const t = k / 10 + (k % 3) * 0.031;
        createRoot((dispose) => {
          const state = fromTimeline({ tl: () => tl, t: () => t, markers: () => markers });
          for (const view of VIEWS) {
            const shown: Shown = { health: false, names: false, movement: false, cc: false, ...view };
            const frame = previewAt(tl, t, markers, shown, false);
            for (const s of SLOTS) {
              const h = state.hero(s.key);
              // A dead hero isn't drawn at all: sight says nothing of it.
              if (!h.alive()) continue;
              const p = frame.players.get(s.key)!;
              const was: HeroDraw = p.ghost != null ? { as: "ghost", at: p.pos!, ago: p.ghost } : p.unseen ? { as: "hidden" } : { as: "seen" };
              const now = heroDraw({ team: s.team, inSight: h.inSight(), lastSeen: h.lastSeen() }, view, state.has("sight"), false);
              expect(now, `${s.key} at ${t} in ${view.vision}${view.lastSeen ? " with last seen" : ""}`).toEqual(was);
              tally[now.as as keyof typeof tally]++;
            }
          }
          dispose();
        });
      }
    }
    expect(Object.values(tally).every((n) => n > 100)).toBe(true);
  });

  it("in a scene that holds sight is Player's, but faded where it stands instead of gone or moved (D3)", () => {
    for (const view of VIEWS) {
      for (const h of [hero(), hero({ lastSeen: null }), hero({ inSight: true }), hero({ team: "amber" }), hero({ team: "amber", inSight: true, lastSeen: null })]) {
        const player = heroDraw(h, view, true, false);
        const scene = heroDraw(h, view, true, true);
        // Where Player draws a ghost or nothing, a scene draws only the faded hero (operator,
        // 2026-11-14): no ghost where it was last seen, with Show last seen location on or off.
        expect(scene).toEqual(player.as === "seen" ? { as: "seen" } : { as: "faded" });
      }
    }
    // Each branch, by name.
    expect(heroDraw(hero(), { vision: "amber", lastSeen: true }, true, true)).toEqual({ as: "faded" });
    expect(heroDraw(hero(), { vision: "amber", lastSeen: false }, true, true)).toEqual({ as: "faded" });
    expect(heroDraw(hero({ lastSeen: null }), { vision: "amber", lastSeen: true }, true, true)).toEqual({ as: "faded" });
    expect(heroDraw(hero(), { vision: "amber", lastSeen: true }, true, false)).toEqual({ as: "ghost", at, ago: 2.5 });
    expect(heroDraw(hero(), { vision: "amber", lastSeen: false }, true, false)).toEqual({ as: "hidden" });
    expect(heroDraw(hero({ lastSeen: null }), { vision: "amber", lastSeen: true }, true, false)).toEqual({ as: "hidden" });
    // Its own team's view, every hero's view, and in sight: as it is.
    expect(heroDraw(hero(), { vision: "sapphire", lastSeen: true }, true, true)).toEqual({ as: "seen" });
    expect(heroDraw(hero(), { vision: "all", lastSeen: true }, true, false)).toEqual({ as: "seen" });
    expect(heroDraw(hero({ inSight: true }), { vision: "amber", lastSeen: true }, true, false)).toEqual({ as: "seen" });
  });

  it("in a scene with no sight data keeps the legacy meaning: marked out of sight is faded for every viewer (D5)", () => {
    for (const view of VIEWS) {
      expect(heroDraw(hero(), view, false, true)).toEqual({ as: "faded" });
      expect(heroDraw(hero({ team: "amber" }), view, false, true)).toEqual({ as: "faded" });
      expect(heroDraw(hero({ inSight: true }), view, false, true)).toEqual({ as: "seen" });
      // Player without sight data draws everyone.
      expect(heroDraw(hero(), view, false, false)).toEqual({ as: "seen" });
    }
  });

  it("in Player draws on its token what the frame drew for its slot, under every choice, the dead too", () => {
    // What a token reads of a slot (board/Tokens.tsx); a missing flag is the same as false.
    const drawn = (x: PlayerHero | undefined) =>
      x && { hero: x.hero, name: x.name ?? null, pos: x.pos, health: x.health ?? null, respawn: x.respawn ?? null, ghost: x.ghost ?? null, unseen: !!x.unseen, cc: x.cc, height: x.height, zipline: !!x.zipline };
    const tally = { seen: 0, ghost: 0, hidden: 0, dead: 0, live: 0, health: 0 };
    for (const tl of [replay(), metadata]) {
      for (let k = 0; k <= N * 10; k += 3) {
        const t = k / 10 + (k % 2) * 0.047;
        createRoot((dispose) => {
          const state = fromTimeline({ tl: () => tl, t: () => t, markers: () => markers });
          for (const view of VIEWS) {
            for (const on of [false, true]) {
              const shown: Shown = { health: on, names: on, movement: on, cc: !on, ...view };
              const frame = previewAt(tl, t, markers, shown, false);
              for (const s of SLOTS) {
                const h = state.hero(s.key);
                const now = playerHero(h, heroDraw({ team: s.team, inSight: h.inSight(), lastSeen: h.lastSeen() }, view, state.has("sight"), false), shown);
                expect(drawn(now), `${s.key} at ${t} in ${view.vision}${view.lastSeen ? " with last seen" : ""}, ${on ? "on" : "off"}`).toEqual(drawn(frame.players.get(s.key)));
                tally[now!.ghost != null ? "ghost" : now!.unseen ? "hidden" : "seen"]++;
                if (!now!.pos) tally.dead += h.alive() ? 0 : 1;
                if (now!.cc !== undefined || now!.height !== undefined) tally.live++;
                if (now!.health != null) tally.health++;
              }
            }
          }
          dispose();
        });
      }
    }
    expect(Object.values(tally).every((n) => n > 50), JSON.stringify(tally)).toBe(true);
    // A slot the frame has no hero in: none.
    createRoot((dispose) => {
      const state = fromTimeline({ tl: () => undefined, t: () => 0, markers: () => markers });
      const h = state.hero("amber-0");
      expect(playerHero(h, { as: "seen" }, { health: true, names: true, movement: true, cc: true, vision: "all", lastSeen: true })).toBeUndefined();
      dispose();
    });
  });
});
