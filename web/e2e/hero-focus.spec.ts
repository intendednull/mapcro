// A click on a hero focuses it (operator, 2026-11-09: "when I click on a hero, it should focus
// them. if zoomed in, it pans to that hero. also it can ping them too"): a portrait in either top
// bar (an editor's hero-less slot: "Show on the map" in its portrait menu). Zoomed in, the view glides to centre the hero (same zoom); at the fit
// view it stays; it pings the hero's spot (others see it like any ping) and flashes the token.
// Following someone, the view stays theirs. A hero with no spot (in Player, dead) gets nothing.
// An editor's portrait with a hero picked focuses; its corner swap button still picks.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { dragToken, joinNew, mapPoint, pickHero, viewOf } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";
import { heroPack } from "./synthetic";

const ID = "129000031";
const N = 240;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-herofocus-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(heroPack(14), { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const centreOf = async (p: Page, sel: string) => {
  const r = (await p.locator(sel).first().boundingBox())!;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
/** How far a hero's token is from the middle of the map's box, in page pixels. */
const offCentre = async (p: Page, slot: string) => {
  const t = await centreOf(p, `.mapbox .tok[data-slot="${slot}"]`);
  const m = await centreOf(p, "[data-testid=map]");
  return Math.hypot(t.x - m.x, t.y - m.y);
};
async function zoomIn(p: Page) {
  const c = await mapPoint(p, 0.5, 0.5);
  await p.mouse.move(c.x, c.y);
  await p.mouse.wheel(0, -300);
  await p.mouse.wheel(0, -300);
  await expect.poll(async () => (await viewOf(p))[2]).toBeLessThan(400);
}
const portrait = (p: Page, slot: string) => p.locator(`.tb-player[data-slot="${slot}"] [data-testid=focus-hero]`);
const pings = (p: Page, who: string) => p.locator(`.mapbox .ping[data-ping="${who}"]`);

test("on a board, a portrait (or its menu, without a hero) pans to the hero, pings it for everyone and flashes it", async ({ browser }) => {
  const url = await newBoardUrl(server, "hero focus");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  // An editor's empty slot: the portrait is the picker, nothing to focus by it yet.
  await expect(portrait(a, "Amber-3")).toHaveCount(0);
  await expect(a.locator('.tb-player[data-slot="Amber-3"] [data-testid=pick-hero]')).not.toHaveClass(/swap/);
  for (const [slot, h] of [["Amber-0", "A"], ["Amber-3", "B"], ["Sapphire-1", "C"]] as const) await pickHero(a, slot, `Testhero ${h}`);
  await expect(a.locator('.tb-player[data-slot="Amber-3"] [data-testid=pick-hero]')).toHaveClass(/swap/);
  // Two heroes out on the map, apart.
  await dragToken(a, "Amber-3", 0.3, 0.4);
  await dragToken(a, "Sapphire-1", 0.7, 0.62);
  await dragToken(a, "Amber-4", 0.62, 0.3);

  // Zoomed in: the view glides to centre Amber-3, at the same zoom.
  await zoomIn(a);
  const w = (await viewOf(a))[2];
  expect(await offCentre(a, "Amber-3")).toBeGreaterThan(60);
  await portrait(a, "Amber-3").click();
  await expect(a.locator('.mapbox .tok[data-slot="Amber-3"] .focus-ring')).toHaveCount(1);
  await expect.poll(() => offCentre(a, "Amber-3")).toBeLessThan(4);
  expect((await viewOf(a))[2]).toBe(w);
  // The ping: the other editor sees it, in Coach's name.
  await expect(pings(b, "Coach")).toHaveCount(1);
  await a.screenshot({ path: "shots/hero-focus-board-A.png" });
  await b.screenshot({ path: "shots/hero-focus-board-B.png" });

  // A hero-less slot (its portrait is the picker): "Show on the map" in its menu does the same.
  await a.locator('.tb-player[data-slot="Amber-4"]:visible').first().click({ button: "right" });
  await a.getByTestId("hero-menu-focus").click();
  await expect.poll(() => offCentre(a, "Amber-4")).toBeLessThan(4);

  // At the fit view nothing moves; the ping still goes.
  const fit = await viewOf(b);
  await portrait(b, "Sapphire-1").click();
  await expect(pings(a, "Marrow")).toHaveCount(1);
  await b.waitForTimeout(500);
  expect(await viewOf(b)).toEqual(fit);

  // Following Coach, Marrow's view stays Coach's: a ping and a flash, still following.
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  const theirs = await viewOf(b);
  await portrait(b, "Amber-3").click();
  await expect(b.locator('.mapbox .tok[data-slot="Amber-3"] .focus-ring')).toHaveCount(1);
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await b.waitForTimeout(500);
  expect(await viewOf(b)).toEqual(theirs);

  // The editor still changes a hero: the corner swap button opens the picker.
  await a.locator('.tb-player[data-slot="Amber-0"]').hover();
  await a.locator('.tb-player[data-slot="Amber-0"]').getByTestId("pick-hero").click();
  await expect(a.getByTestId("hero-picker")).toBeVisible();
  await a.keyboard.press("Escape");
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
/** Every hero stands still, apart; Amber's slot 2 is dead the whole match (no spot). */
const spot = (team: string, slot: number) => ({ x: slot * 1500 - 3500, y: team === "amber" ? -2500 : 2500 });
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const dead = team === "amber" && slot === 2;
        return {
          team, slot, hero_id: 1 + slot + (team === "sapphire" ? 6 : 0), name: null,
          x: range(() => (dead ? null : spot(team, slot).x)), y: range(() => (dead ? null : spot(team, slot).y)),
          health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0),
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: [],
  };
}

test("in Player, a portrait focuses the hero where the match has it at t; a dead one gets nothing", async ({ browser }) => {
  const url = await newBoardUrl(server, "hero focus player");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");

  await zoomIn(a);
  // The dead hero: nothing pans, nothing pings.
  const before = await viewOf(a);
  await portrait(a, "Amber-2").click();
  await a.waitForTimeout(500);
  expect(await viewOf(a)).toEqual(before);
  await expect(a.locator(".mapbox .ping")).toHaveCount(0);
  await expect(b.locator(".mapbox .ping")).toHaveCount(0);

  // A live one: centred here, pinged for the follower, whose view follows the glide.
  await portrait(a, "Sapphire-4").click();
  await expect.poll(() => offCentre(a, "Sapphire-4")).toBeLessThan(4);
  await expect(pings(b, "Coach")).toHaveCount(1);
  await expect.poll(() => offCentre(b, "Sapphire-4")).toBeLessThan(6);
  await a.screenshot({ path: "shots/hero-focus-player-A.png" });
});
