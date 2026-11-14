// Whose hero a saved scene draws (docs/specs/map-state.md §2, D2), on a synthetic replay with
// a hero pack.
//
// A scene saved before scenes held their own heroes (`has_heroes`) draws the board roster's
// hero. Where that differs from the hero its build was captured for, a coach picked another
// since: the pick wins, on every scene of the board, and the stored build is hidden. Written as
// a characterisation before D2, which keeps exactly this for every such scene; the scene comes
// from a board file that says what a save from before stored, so it holds whatever this build
// writes.
//
// A scene that holds its heroes (saved once the row is written) draws its own: the roster and
// the board's other scenes keep theirs, and a pick in it is that scene's alone and drops the old
// hero's build. Those tests run once the row is `live`.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, pickHero, revealControls } from "./helpers";
import { ROWS } from "../src/gen/rows";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";
import { heroPack } from "./synthetic";

/** Whether this build's Save gives a scene its own heroes. */
const OWN = ROWS.has_heroes.status === "live";
const ID = "129000152";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-scene-hero-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  // Fourteen heroes: the match plays twelve (1 to 6 for the Hidden King, 7 to 12 for the
  // Archmother), so "Testhero M" and "Testhero N" are free to pick.
  server = new Server(heroPack(14), { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "50" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
/** Twelve heroes, each its own, with souls, health, a level, items and abilities. */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const at = { x: slot * 1500 - 4000, y: team === "amber" ? -3000 : 3000 };
        return {
          team, slot, hero_id: (team === "amber" ? 1 : 7) + slot, name: null,
          x: range((s) => at.x + s * 10), y: range(() => at.y), health: range(() => 100 - slot * 12), deaths: [], respawn: [],
          souls: [[0, 500 + slot * 100], [15, 2500 + slot * 300]], ult: range((s) => (s < 12 ? 100 - s * 8 : 0)), seen: [],
          level: [[0, 1], [10, 3 + slot]],
          items: [[50, 715_762_406, 0], [120, 1_009_965_641, 0]],
          abilities: [[3, 9_000 + slot, 1], [14, 9_000 + slot, 2]], casts: [], charges: [], cc: [], effects: [], recaps: [],
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
  };
}

const answered = new Set<string>();
async function openMatch(p: Page) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
  answered.add(job);
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

const portrait = (p: Page, slot: string) => p.locator(`.tb-player[data-slot="${slot}"]`);
const img = (p: Page, slot: string) => portrait(p, slot).locator(".tb-img");
const token = (p: Page, slot: string) => p.locator(`[data-testid=map] .tok[data-slot="${slot}"]`);
const builds = (p: Page) => p.locator("[data-testid=hero-build]:not([hidden])");
const heroArt = (n: number) => new RegExp(`topbar/heroes/${n}\\.png`);
/** What a hero's open build shows: its level, items and abilities. */
const shown = async (p: Page, slot: string) => ({
  level: await portrait(p, slot).getByTestId("tb-level").textContent(),
  items: await portrait(p, slot).locator(".tb-build-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-item-id"))),
  abilities: await portrait(p, slot).locator(".tb-build-ability").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-ability-id")}:${e.getAttribute("data-level")}`)),
});

/** Player at 25 s, saved as a scene: the page is left on the new scene (the board's second). */
async function savedScene(p: Page) {
  await openMatch(p);
  await p.getByTestId("match-time").evaluate((el) => {
    (el as HTMLInputElement).value = "25";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(p.getByTestId("match-clock")).toContainText("0:25 /");
  await p.getByTestId("match-save").click();
  await expect(p.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
}

/** Change a slot's hero from its portrait's menu. */
async function changeHero(p: Page, slot: string, hero: string) {
  await portrait(p, slot).click({ button: "right", position: { x: 20, y: 30 } });
  await p.getByTestId("hero-menu").getByRole("menuitem", { name: "Change hero…" }).click();
  await expect(p.getByTestId("hero-picker")).toBeVisible();
  await p.locator(`.hero-cell[data-hero="${hero}"]`).click();
  await expect(p.getByTestId("hero-picker")).toHaveCount(0);
}

type BoardFile = { version: number; rows?: number; matches: number[]; records: Array<[string, Record<string, { more?: Record<string, unknown>; team?: string; slot?: number; hero?: number | null }>]> };
async function seed(file: unknown): Promise<string> {
  const r = await fetch(`${server.url}/api/boards/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(file) });
  expect(r.status).toBe(201);
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  return `${server.url}/b/${board}#${owner_token}`;
}
/** A board with a scene saved from the match as a build from before `has_heroes` left it: the
 * scene's state doesn't say it holds its heroes, and the roster holds the match's (that save
 * set it). Without the match, so it opens on its scenes. */
async function boardFromBefore(browser: Parameters<typeof joinNew>[0]): Promise<string> {
  const from = await newBoardUrl(server, "Saved before");
  const maker = await joinNew(browser, from, "Coach");
  await savedScene(maker);
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(from)!;
  const file = (await (await fetch(`${server.url}/api/boards/${board}/export`, { headers: { authorization: `Bearer ${token}` } })).json()) as BoardFile;
  await maker.close();
  const before = ROWS.has_heroes.index;
  let states = 0;
  for (const [, rec] of file.records) {
    const state = rec.SceneState;
    if (state?.more) {
      states++;
      delete state.more.has_heroes;
      state.more.rows = Math.min(state.more.rows as number, before);
    }
    const slot = rec.RosterSlot;
    if (slot) slot.hero = (slot.team === "Amber" ? 1 : 7) + slot.slot!;
  }
  expect(states).toBe(1);
  file.rows = Math.min(file.rows ?? before, before);
  file.matches = [];
  return seed(file);
}

test("a scene saved before scenes held their heroes: a slot given another hero since draws that hero and hides the stored build, on every scene; the first hero back, so is the build", async ({ browser }) => {
  const url = await boardFromBefore(browser);
  const p = await joinNew(browser, url, "Coach");
  await expect(p.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await p.getByTestId("scene-card").nth(1).click();
  // The match's hero in the slot (hero 4, "Testhero D"), with its build.
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(4));
  await expect(token(p, "Amber-3")).toHaveAttribute("aria-label", /Testhero D/);
  await portrait(p, "Amber-3").getByTestId("focus-hero").click();
  await expect(builds(p)).toHaveCount(1);
  const first = await shown(p, "Amber-3");
  expect(first.items).toEqual(["715762406", "1009965641"]);
  await p.keyboard.press("Escape");
  await expect(builds(p)).toHaveCount(0);

  // Another hero. The other eleven are taken, by the roster's heroes; "No hero" is offered.
  await portrait(p, "Amber-3").click({ button: "right", position: { x: 20, y: 30 } });
  await p.getByTestId("hero-menu").getByRole("menuitem", { name: "Change hero…" }).click();
  await expect(p.locator(".hero-cell.taken")).toHaveCount(11);
  await expect(p.locator(".hero-cell.current")).toHaveAttribute("data-hero", "Testhero D");
  await expect(p.getByTestId("hero-clear")).toHaveCount(1);
  await p.locator('.hero-cell[data-hero="Testhero M"]').click();
  await expect(p.getByTestId("hero-picker")).toHaveCount(0);
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(13));
  await expect(token(p, "Amber-3")).toHaveAttribute("aria-label", /Testhero M/);
  // Its stored build was the first hero's: the portrait opens none, and All builds shows eleven.
  await portrait(p, "Amber-3").getByTestId("focus-hero").click();
  await expect(builds(p)).toHaveCount(0);
  await p.getByTestId("all-builds").click();
  await expect(builds(p)).toHaveCount(11);
  await expect(portrait(p, "Amber-3").locator("[data-testid=hero-build]:not([hidden])")).toHaveCount(0);
  await p.getByTestId("all-builds").click();
  await expect(builds(p)).toHaveCount(0);

  // The pick is the board's: the first scene draws the new hero too, and so does a second person.
  await p.getByTestId("scene-card").nth(0).click();
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(13));
  await p.getByTestId("scene-card").nth(1).click();
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(13));
  const q = await joinNew(browser, url, "Player");
  await expect(q.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await q.getByTestId("scene-card").nth(1).click();
  await expect(img(q, "Amber-3")).toHaveAttribute("style", heroArt(13));
  await q.getByTestId("all-builds").click();
  await expect(builds(q)).toHaveCount(11);

  // The first hero back in the slot: its build is back as it was, for both.
  await changeHero(p, "Amber-3", "Testhero D");
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(4));
  await expect(builds(q)).toHaveCount(12);
  await portrait(p, "Amber-3").getByTestId("focus-hero").click();
  await expect(builds(p)).toHaveCount(1);
  expect(await shown(p, "Amber-3")).toEqual(first);
});

test("before Save holds a scene's heroes, it sets the board's roster to the match's: every scene draws them", async ({ browser }) => {
  test.skip(OWN, "Save leaves the roster alone once it writes `has_heroes`");
  const p = await joinNew(browser, await newBoardUrl(server, "Scene roster"), "Coach");
  await savedScene(p);
  for (const [slot, hero] of [["Amber-0", 1], ["Amber-5", 6], ["Sapphire-0", 7], ["Sapphire-5", 12]] as const) await expect(img(p, slot)).toHaveAttribute("style", heroArt(hero));
  // The board's first scene, made by hand, draws the match's heroes now too.
  await p.getByTestId("scene-card").nth(0).click();
  for (const [slot, hero] of [["Amber-0", 1], ["Amber-5", 6], ["Sapphire-0", 7], ["Sapphire-5", 12]] as const) await expect(img(p, slot)).toHaveAttribute("style", heroArt(hero));
});

test("a scene saved from a match holds its own heroes: the roster and the board's other scenes keep theirs, and a pick in it is its alone", async ({ browser }) => {
  test.skip(!OWN, "nothing writes `has_heroes` yet: the row is ahead of its writer");
  const url = await newBoardUrl(server, "Scene heroes");
  const p = await joinNew(browser, url, "Coach");
  // The board's own hero for one slot, picked by hand before any match.
  await pickHero(p, "Amber-3", "Testhero N");
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(14));
  await savedScene(p);
  // The saved scene draws the match's heroes.
  for (const [slot, hero] of [["Amber-0", 1], ["Amber-3", 4], ["Sapphire-0", 7], ["Sapphire-5", 12]] as const) await expect(img(p, slot)).toHaveAttribute("style", heroArt(hero));
  await expect(token(p, "Amber-3")).toHaveAttribute("aria-label", /Testhero D/);
  // The roster is as it was: the scene made by hand draws the hero picked there, and none elsewhere.
  await p.getByTestId("scene-card").nth(0).click();
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(14));
  await expect(img(p, "Amber-0")).toHaveCount(0);
  await p.getByTestId("scene-card").nth(1).click();
  await portrait(p, "Amber-3").getByTestId("focus-hero").click();
  await expect(builds(p)).toHaveCount(1);
  const first = await shown(p, "Amber-3");
  expect(first.items).toEqual(["715762406", "1009965641"]);
  await p.keyboard.press("Escape");

  // The picker in the saved scene: the scene's heroes are the taken ones (so the roster's
  // "Testhero N" is free here), and a hero can be changed but not taken away.
  await portrait(p, "Amber-3").click({ button: "right", position: { x: 20, y: 30 } });
  await p.getByTestId("hero-menu").getByRole("menuitem", { name: "Change hero…" }).click();
  await expect(p.locator(".hero-cell.current")).toHaveAttribute("data-hero", "Testhero D");
  await expect(p.locator(".hero-cell.taken")).toHaveCount(11);
  await expect(p.locator('.hero-cell[data-hero="Testhero N"]')).toBeEnabled();
  await expect(p.getByTestId("hero-clear")).toHaveCount(0);
  await p.locator('.hero-cell[data-hero="Testhero M"]').click();
  await expect(p.getByTestId("hero-picker")).toHaveCount(0);
  // The scene's hero changed, and the old hero's build went with it.
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(13));
  await expect(token(p, "Amber-3")).toHaveAttribute("aria-label", /Testhero M/);
  await portrait(p, "Amber-3").getByTestId("focus-hero").click();
  await expect(builds(p)).toHaveCount(0);
  await p.getByTestId("all-builds").click();
  await expect(builds(p)).toHaveCount(11);
  await p.getByTestId("all-builds").click();
  // That scene alone: the one made by hand still draws the roster's hero. A second person
  // sees both.
  await p.getByTestId("scene-card").nth(0).click();
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(14));
  const q = await joinNew(browser, url, "Player");
  await expect(q.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await q.getByTestId("scene-card").nth(1).click();
  await expect(q.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await expect(img(q, "Amber-3")).toHaveAttribute("style", heroArt(13));
  await q.getByTestId("scene-card").nth(0).click();
  await expect(img(q, "Amber-3")).toHaveAttribute("style", heroArt(14));
  await q.getByTestId("scene-card").nth(1).click();

  // One undo brings back the hero and its build together.
  await p.getByTestId("scene-card").nth(1).click();
  await p.getByTestId("map").hover();
  await p.keyboard.press("Control+z");
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(4));
  await expect(img(q, "Amber-3")).toHaveAttribute("style", heroArt(4));
  await portrait(p, "Amber-3").getByTestId("focus-hero").click();
  await expect(builds(p)).toHaveCount(1);
  expect(await shown(p, "Amber-3")).toEqual(first);
  await p.keyboard.press("Escape");

  // In the scene made by hand the pick is still the board's, and "No hero" is still offered.
  await p.getByTestId("scene-card").nth(0).click();
  await portrait(p, "Amber-3").click({ button: "right", position: { x: 20, y: 30 } });
  await p.getByTestId("hero-menu").getByRole("menuitem", { name: "Change hero…" }).click();
  await p.getByTestId("hero-clear").click();
  await expect(p.getByTestId("hero-picker")).toHaveCount(0);
  await expect(img(p, "Amber-3")).toHaveCount(0);
  await p.getByTestId("scene-card").nth(1).click();
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(4));
  // It is the scene's own: it survives a reload.
  await p.reload();
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await p.getByTestId("scene-card").nth(1).click();
  await expect(p.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(4));
});
