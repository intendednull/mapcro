// Screenshots of the map's neutral objectives on a real replay and pack (never committed data;
// docs/research/map-objectives-audit.md): every Sinner's Sacrifice camp with the vault icon, and
// the five whose names don't say so hovered while cleared, with their respawn timers. Set
// MAPCRO_SHOT_REPLAY to 129738985's timeline (`mapcro-replay parse x.dem out.json 129738985`)
// and MAPCRO_SHOT_PACKS to the asset packs. Skipped otherwise.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

const src = process.env.MAPCRO_SHOT_REPLAY;
const packs = process.env.MAPCRO_SHOT_PACKS;
const ID = "129738985";
/** The pack's keys for the Sinner's Sacrifice camps that don't say "vault" (build 6860). */
const SITES: Array<[string, string]> = [
  ["camp:neutral:lane4:5", "bell-tower"],
  ["camp:neutral:lane6:14", "theater-balcony"],
  ["camp:neutral:lane4:1", "slums-garage-roof"],
  ["camp:neutral:lane4:7", "drug-store"],
  ["camp:neutral:lane4:12", "hotel"],
];
let server: Server;

test.skip(!src || !packs, "set MAPCRO_SHOT_REPLAY and MAPCRO_SHOT_PACKS");

test.beforeAll(async () => {
  server = new Server(packs, { REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-shot-")), MATCH_API_BASE: "http://127.0.0.1:9" });
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  copyFileSync(src!, join(server.dataDir, "replays", `${ID}-cdn.json`));
  await server.start();
});
test.afterAll(() => server?.stop());

test("every Sinner's Sacrifice camp, and the unnamed ones' timers", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Map objectives"), "Coach");
  await a.screenshot({ path: "shots/objectives-board.png" });
  await expect(a.locator('[data-testid=map] .mk.camp[aria-label="Sinner\'s Sacrifice"]')).toHaveCount(11);
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  const at = async (t: number) => {
    await a.getByTestId("match-time").evaluate((el, t) => {
      (el as HTMLInputElement).value = String(t);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, t);
    await a.waitForTimeout(400);
  };
  // 8:20, every camp up; 15:00, all five cleared.
  await at(500);
  await a.screenshot({ path: "shots/objectives-500.png" });
  await at(900);
  for (const [key, name] of SITES) {
    const m = a.locator(`[data-testid=map] .mk[data-key="${key}"]`);
    await expect(m).toHaveAttribute("aria-label", "Sinner's Sacrifice");
    await expect(m).toHaveAttribute("data-camp", "cleared");
    const b = (await m.boundingBox())!;
    await a.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await expect(a.getByTestId("hover-label")).toHaveText(/^Respawns in \d+:\d\d$/);
    console.log(`${name} (${key}): ${await a.getByTestId("hover-label").textContent()}`);
    await a.screenshot({ path: `shots/objectives-900-${name}.png`, clip: { x: b.x + b.width / 2 - 140, y: b.y + b.height / 2 - 110, width: 280, height: 200 } });
    await a.mouse.move(5, 5);
  }
  // Each site up close at 8:20, every camp up: zoomed in on it, the icon itself.
  await at(500);
  for (const [key, name] of SITES) {
    const m = a.locator(`[data-testid=map] .mk[data-key="${key}"]`);
    let b = (await m.boundingBox())!;
    await a.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    for (let i = 0; i < 2; i++) await a.mouse.wheel(0, -150), await a.waitForTimeout(120);
    await a.mouse.move(5, 5);
    await a.waitForTimeout(300);
    b = (await m.boundingBox())!;
    await a.screenshot({ path: `shots/objectives-500-${name}.png`, clip: { x: b.x + b.width / 2 - 140, y: b.y + b.height / 2 - 100, width: 280, height: 200 } });
    // Out about the same point, back to the whole map.
    await a.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    for (let i = 0; i < 2; i++) await a.mouse.wheel(0, 150), await a.waitForTimeout(120);
    await a.mouse.move(5, 5);
  }
});
