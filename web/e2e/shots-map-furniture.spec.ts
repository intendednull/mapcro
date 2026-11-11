// Screenshots of the map's furniture on a real replay and pack (never committed data;
// docs/research/map-objectives-audit.md): the shops and teleporters, the healing pickups with
// the Heals toggle on, a teleporter's pair on hover, and 129738985's taken pickups at 8:00 with
// their timers. Set MAPCRO_SHOT_REPLAY to 129738985's format-5 timeline (`mapcro-replay parse
// x.dem out.json 129738985`; format 7 for the heavy boxes) and MAPCRO_SHOT_PACKS to the asset packs.
// Skipped otherwise.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl } from "./server";

const src = process.env.MAPCRO_SHOT_REPLAY;
const packs = process.env.MAPCRO_SHOT_PACKS;
/** Where the shots go (default shots/), so a run against an older pack can keep its own. */
const out = process.env.MAPCRO_SHOT_PREFIX ?? "shots/furniture";
const ID = "129738985";
let server: Server;

test.skip(!src || !packs, "set MAPCRO_SHOT_REPLAY and MAPCRO_SHOT_PACKS");

test.beforeAll(async () => {
  server = new Server(packs, { REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-shot-")), MATCH_API_BASE: "http://127.0.0.1:9" });
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  copyFileSync(src!, join(server.dataDir, "replays", `${ID}-cdn.json`));
  await server.start();
});
test.afterAll(() => server?.stop());

const marks = (p: Page, kind: string) => p.locator(`[data-testid=map] .mk.${kind}`);
async function hoverKey(p: Page, key: string) {
  const b = (await p.locator(`[data-testid=map] .mk[data-key="${key}"]`).boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  return b;
}
const near = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2 - 160, y: b.y + b.height / 2 - 120, width: 320, height: 220 });

test("shops, teleporters and heals on a real pack and replay", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Map furniture"), "Coach");
  await expect(marks(a, "shop")).toHaveCount(8);
  await expect(marks(a, "teleporter")).toHaveCount(4);
  await a.screenshot({ path: `${out}-board.png` });
  await revealControls(a, "heals-toggle");
  await a.getByTestId("heals-toggle").click();
  await expect(marks(a, "heal")).toHaveCount(36);
  await a.screenshot({ path: `${out}-board-heals.png` });
  const tele = (await marks(a, "teleporter").first().getAttribute("data-key"))!;
  await hoverKey(a, tele);
  await expect(a.getByTestId("teleporter-link")).toHaveCount(1);
  await a.screenshot({ path: `${out}-teleporter-hover.png` });
  await a.mouse.move(5, 5);
  // The Archmother's view: icons upright, the runners facing the middle.
  await a.getByTestId("viewpoint-flip").first().click();
  await a.waitForTimeout(300);
  await a.screenshot({ path: `${out}-board-flipped.png` });
  await a.getByTestId("viewpoint-flip").first().click();

  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await a.getByTestId("match-time").evaluate((el) => {
    (el as HTMLInputElement).value = "480";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await a.waitForTimeout(400);
  // 8:00: the west pickups taken at 6:42 and 7:57.
  const taken = a.locator('[data-testid=map] .mk.heal[data-camp="cleared"]');
  await expect(taken).toHaveCount(3);
  await a.screenshot({ path: `${out}-player-480.png` });
  for (const key of await taken.evaluateAll((els) => els.map((e) => e.getAttribute("data-key")!))) {
    const b = await hoverKey(a, key);
    await expect(a.getByTestId("hover-label")).toHaveText(/^Respawns in \d+:\d\d$/);
    console.log(`${key}: ${await a.getByTestId("hover-label").textContent()}`);
    await a.screenshot({ path: `${out}-player-480-${key.replaceAll(":", "_")}.png`, clip: near(b) });
  }
});

test("heavy boxes on a real pack and replay", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Heavy boxes"), "Coach");
  await revealControls(a, "crates-toggle");
  await a.getByTestId("crates-toggle").click();
  await expect(marks(a, "crate")).toHaveCount(78);
  await a.screenshot({ path: `${out}-board-crates.png` });
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await a.getByTestId("match-time").evaluate((el) => {
    (el as HTMLInputElement).value = "480";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await a.waitForTimeout(400);
  // 8:00 on 129738985 (format 7): 12 crates broken, back at 9:04 to 9:21.
  const broken = a.locator('[data-testid=map] .mk.crate[data-camp="cleared"]');
  await expect(broken).toHaveCount(12);
  await a.screenshot({ path: `${out}-player-480-crates.png` });
  const key = (await broken.first().getAttribute("data-key"))!;
  const b = await hoverKey(a, key);
  await expect(a.getByTestId("hover-label")).toHaveText(/^Respawns in \d+:\d\d$/);
  await a.screenshot({ path: `${out}-player-480-crate-hover.png`, clip: near(b) });
});
