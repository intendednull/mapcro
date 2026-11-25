// Importing `mapstate/undo.ts` first must never hit a circular import or TDZ (TD-86, TD-159).
import { decideStep } from "../src/mapstate/undo";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Entry } from "../src/gen/Entry";
import type { Op } from "../src/gen/Op";
import type { RecordId } from "../src/gen/RecordId";
import { WRITTEN } from "../src/mapstate/keys";

const importsOf = (rel: string): string[] => {
  const src = readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
  return [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]!);
};

describe("mapstate/undo.ts import layering (TD-86, TD-159)", () => {
  it("loads cleanly as the first module and decides a hero step immediately", () => {
    const SCENE = "00000000000000000000000000000010" as RecordId;
    const STATE = "00000000000000000000000000000011" as RecordId;
    const H = "00000000000000000000000000000020" as RecordId;
    const records = new Map<RecordId, Entry>([
      [SCENE, { record: { Scene: { name: "s", order: "a", clock: null, source: null, live: false, parent: null } } as never, deleted: false }],
      [STATE, { record: { SceneState: { scene: SCENE, more: { rows: WRITTEN, has_heroes: true } } }, deleted: false }],
      [H, { record: { PlayerState: { scene: SCENE, slot: SCENE, pos: { x: 0, y: 0 }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true, more: { hero: 77 } } } as never, deleted: false }],
    ]);
    const step: Op[] = [
      { SetIf: { id: H, expect: { More: { key: "level", value: null } }, value: { More: { key: "level", value: 4 } } } },
      { SetIf: { id: H, expect: { More: { key: "hero", value: 77 } }, value: { More: { key: "hero", value: 13 } } } },
    ];
    const decided = decideStep(step, records);
    expect(decided.changed).toBe(true);
    expect(decided.ops[0]).toEqual({ Set: { id: H, value: { More: { key: "hero", value: 13 } } } });
  });

  it("core/txChunk.ts and mapstate/keys.ts import only generated schema modules, and mapstate/undo.ts has no cycle", () => {
    expect(importsOf("core/txChunk.ts").every((p) => p.startsWith("../gen/"))).toBe(true);
    expect(importsOf("mapstate/keys.ts").every((p) => p.startsWith("../gen/"))).toBe(true);
    expect(importsOf("mapstate/undo.ts").every((p) => p.startsWith("../gen/") || p === "../core/txChunk" || p === "./keys")).toBe(true);
    expect(importsOf("board/scenes.ts").some((p) => p.includes("match/save"))).toBe(false);
  });
});
