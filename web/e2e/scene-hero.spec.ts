// Whose hero a saved scene draws (docs/specs/map-state.md §2, D2), on a synthetic replay with
// a hero pack.
//
// Characterisation, written before D2: a scene saved before scenes held their own heroes
// (`has_heroes`) draws the board roster's hero. Where that differs from the hero its build was
// captured for, a coach picked another since: the pick wins, on every scene of the board, and
// the stored build is hidden. D2 keeps exactly this for every such scene.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";
import { heroPack } from "./synthetic";

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

test("a saved scene's slot given another hero since draws that hero and hides the stored build, on every scene; the first hero back, so is the build", async ({ browser }) => {
  const url = await newBoardUrl(server, "Scene hero pick");
  const p = await joinNew(browser, url, "Coach");
  await savedScene(p);
  // The match's hero in the slot (hero 4, "Testhero D"), with its build.
  await expect(img(p, "Amber-3")).toHaveAttribute("style", heroArt(4));
  await expect(token(p, "Amber-3")).toHaveAttribute("aria-label", /Testhero D/);
  await portrait(p, "Amber-3").getByTestId("focus-hero").click();
  await expect(builds(p)).toHaveCount(1);
  const first = await shown(p, "Amber-3");
  expect(first.items).toEqual(["715762406", "1009965641"]);
  await p.keyboard.press("Escape");
  await expect(builds(p)).toHaveCount(0);

  // Another hero. The other eleven are taken, by the match's heroes.
  await portrait(p, "Amber-3").click({ button: "right", position: { x: 20, y: 30 } });
  await p.getByTestId("hero-menu").getByRole("menuitem", { name: "Change hero…" }).click();
  await expect(p.locator(".hero-cell.taken")).toHaveCount(11);
  await expect(p.locator(".hero-cell.current")).toHaveAttribute("data-hero", "Testhero D");
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
  await expect(q.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
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

test("saving a scene from a match sets the board's roster to the match's heroes: every scene draws them", async ({ browser }) => {
  const p = await joinNew(browser, await newBoardUrl(server, "Scene roster"), "Coach");
  await savedScene(p);
  for (const [slot, hero] of [["Amber-0", 1], ["Amber-5", 6], ["Sapphire-0", 7], ["Sapphire-5", 12]] as const) await expect(img(p, slot)).toHaveAttribute("style", heroArt(hero));
  // The board's first scene, made by hand, draws the match's heroes now too.
  await p.getByTestId("scene-card").nth(0).click();
  for (const [slot, hero] of [["Amber-0", 1], ["Amber-5", 6], ["Sapphire-0", 7], ["Sapphire-5", 12]] as const) await expect(img(p, slot)).toHaveAttribute("style", heroArt(hero));
});
