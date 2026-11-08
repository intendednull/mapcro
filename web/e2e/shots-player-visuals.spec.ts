// Screenshots of Player's visuals on a real parsed replay (never committed data; skipped without
// MAPCRO_SHOT_REPLAY, like shots-replay.spec.ts): event pings through a teamfight, troopers
// mid-game, and objective fills and hero health arcs while walkers are under attack. Shots go to
// web/shots/ (gitignored). The default times are for 129738985.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

const src = process.env.MAPCRO_SHOT_REPLAY;
const ID = process.env.MAPCRO_SHOT_REPLAY_ID ?? "129738985";
const FIGHT = Number(process.env.MAPCRO_SHOT_FIGHT ?? "2536");
const TROOPERS = (process.env.MAPCRO_SHOT_TROOPERS ?? "540,900,1260").split(",").map(Number);
const HEALTH = Number(process.env.MAPCRO_SHOT_HEALTH ?? "1615");
let server: Server;

test.skip(!src, "set MAPCRO_SHOT_REPLAY to a parsed timeline");

test.beforeAll(async () => {
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-shot-")), MATCH_API_BASE: "http://127.0.0.1:9" });
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  copyFileSync(src!, join(server.dataDir, "replays", `${ID}-cdn.json`));
  await server.start();
});
test.afterAll(() => server?.stop());

const scrubTo = (p: Page, t: number) =>
  p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);

test("Player's visuals on a real replay", async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await joinNew(browser, await newBoardUrl(server, "Visuals"), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  const map = a.getByTestId("map");

  // Walkers under attack: their icons filled to their health; the heroes' arcs.
  await scrubTo(a, HEALTH);
  await a.waitForTimeout(400);
  await a.screenshot({ path: `shots/visuals-health-${HEALTH}.png` });
  await map.screenshot({ path: `shots/visuals-health-${HEALTH}-map.png` });

  // Troopers with the lanes busy.
  for (const t of TROOPERS) {
    await scrubTo(a, t);
    await a.waitForTimeout(400);
    await map.screenshot({ path: `shots/visuals-troopers-${t}.png` });
  }

  // A teamfight played at 1×: a shot each time pings are up.
  await scrubTo(a, FIGHT);
  await a.getByTestId("match-play").click();
  for (let i = 0; i < 4; i++) {
    await expect(a.getByTestId("event-ping").first()).toBeVisible({ timeout: 30_000 });
    await a.waitForTimeout(250);
    await map.screenshot({ path: `shots/visuals-pings-${i}.png` });
    await expect(a.getByTestId("event-ping")).toHaveCount(0, { timeout: 5000 });
  }
  await a.getByTestId("match-play").click();

  // Close up, zoomed in on the walker under attack: its fill, the troopers, the arcs.
  await scrubTo(a, HEALTH);
  const w = (await a.locator(`.mapbox .mk[data-key="${process.env.MAPCRO_SHOT_WALKER ?? "walker:amber:lane4:1"}"]`).boundingBox())!;
  await a.mouse.move(w.x + w.width / 2, w.y + w.height / 2);
  for (let i = 0; i < 6; i++) {
    await a.mouse.wheel(0, -240);
    await a.waitForTimeout(80);
  }
  for (const t of [HEALTH - 20, HEALTH - 6, HEALTH]) {
    await scrubTo(a, t);
    await a.waitForTimeout(300);
    await map.screenshot({ path: `shots/visuals-zoom-${t}.png` });
  }
});
