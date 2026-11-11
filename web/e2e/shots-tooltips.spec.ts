// Screenshots of the game tooltips on a real pack and replay (never committed: web/shots/ is
// ignored, and they show game art). Set MAPCRO_SHOT_PACKS to a PACKS_DIR holding a pack with
// tooltips and MAPCRO_SHOT_REPLAY to a parsed timeline; MAPCRO_SHOT_SLOT picks the hero
// ("Sapphire-1": Mirage in 129738985), MAPCRO_SHOT_ITEM an item's label to hover. Compare with
// the operator's reference shots (docs/plans/2026-11-10-game-tooltips.md "Reference").

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl } from "./server";

const src = process.env.MAPCRO_SHOT_REPLAY;
const ID = process.env.MAPCRO_SHOT_REPLAY_ID ?? "129738985";
const T = Number(process.env.MAPCRO_SHOT_T ?? "2400");
const SLOT = process.env.MAPCRO_SHOT_SLOT ?? "Sapphire-1";
const ITEM = process.env.MAPCRO_SHOT_ITEM ?? "Escalating Exposure";
let server: Server;

test.skip(!src || !process.env.MAPCRO_SHOT_PACKS, "set MAPCRO_SHOT_PACKS and MAPCRO_SHOT_REPLAY");

test.beforeAll(async () => {
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-shot-")), MATCH_API_BASE: "http://127.0.0.1:9" });
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  copyFileSync(src!, join(server.dataDir, "replays", `${ID}-cdn.json`));
  await server.start();
});
test.afterAll(() => server?.stop());

test("the game tooltips on a real replay", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Real tooltips"), "Coach");
  await a.setViewportSize({ width: 1700, height: 1000 });
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await a.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, T);
  const float = a.getByTestId("game-tooltip-float");
  // The ult first: the column hides the indicator once open.
  await a.locator(`.tb-player[data-slot="${SLOT}"] [data-testid=ult]`).hover();
  await expect(float).toBeVisible();
  await a.waitForTimeout(300);
  await a.screenshot({ path: "shots/tooltips-ult.png" });
  await a.mouse.move(5, 500);
  await a.locator(".tb-all-builds").click();
  const col = a.locator(`.tb-player[data-slot="${SLOT}"] [data-testid=hero-build]`);
  await col.locator(`.tb-build-item[aria-label^="${ITEM}"]`).hover();
  await expect(float).toBeVisible();
  await a.waitForTimeout(300);
  await a.screenshot({ path: "shots/tooltips-item.png" });
  for (const [i, ab] of (await col.locator(".tb-build-ability").all()).entries()) {
    await ab.hover();
    await expect(float).toBeVisible();
    await a.waitForTimeout(200);
    await a.screenshot({ path: `shots/tooltips-ability-${i + 1}.png` });
  }
  for (const k of ["weapon", "vitality", "spirit"]) {
    await col.getByTestId(`invest-${k}`).hover();
    await expect(float.getByTestId("stat-panel")).toBeVisible();
    await a.waitForTimeout(200);
    await a.screenshot({ path: `shots/tooltips-stats-${k}.png` });
  }
  await a.mouse.move(5, 500);
  await a.locator(".tb-all-builds").click();
  await a.locator(`.mapbox .tok[data-slot="${SLOT}"]`).click({ force: true });
  await expect(a.getByTestId("hero-card")).toBeVisible();
  await a.screenshot({ path: "shots/tooltips-hero-card.png" });
});
