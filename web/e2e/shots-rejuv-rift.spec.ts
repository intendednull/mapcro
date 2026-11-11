// Screenshots of a real parsed replay (never committed data) for the Rejuvenator badge, the
// rift's capture rings and the hover timers: set MAPCRO_SHOT_REPLAY to a format-3 timeline the
// worker wrote, MAPCRO_SHOT_PACKS to the asset packs; MAPCRO_SHOT_DIR (default shots/) is where
// they go. Skipped otherwise.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl } from "./server";

const src = process.env.MAPCRO_SHOT_REPLAY;
const ID = process.env.MAPCRO_SHOT_REPLAY_ID ?? "129738985";
const OUT = process.env.MAPCRO_SHOT_DIR ?? "shots";
let server: Server;

test.skip(!src, "set MAPCRO_SHOT_REPLAY to a parsed timeline");

test.beforeAll(async () => {
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-shot-")), MATCH_API_BASE: "http://127.0.0.1:9" });
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  copyFileSync(src!, join(server.dataDir, "replays", `${ID}-cdn.json`));
  await server.start();
});
test.afterAll(() => server?.stop());

async function at(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await p.waitForTimeout(500);
}

/** Hover the marker, off-centre if a hero token sits on it; logs what it says. */
async function hover(p: Page, sel: string) {
  const m = p.locator(`[data-testid=map] .mk${sel}`).first();
  const key = await m.getAttribute("data-key");
  const b = (await m.boundingBox())!;
  const l = p.getByTestId("hover-label");
  for (const [dx, dy] of [[0, 0], [0, -0.18], [0.18, 0], [-0.18, 0], [0, 0.18], [0.13, -0.13], [-0.13, 0.13]]) {
    await p.mouse.move(b.x + b.width * (0.5 + dx!), b.y + b.height * (0.5 + dy!));
    if ((await l.count()) && (await l.getAttribute("data-key")) === key) break;
  }
  console.log(`${sel}: ${(await l.count()) ? await l.textContent() : "(no label)"}`);
}

test("the Rejuvenator, rift capture and urn walk-back on a real replay", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Real replay"), "Coach");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  // The first rift, contested then captured; the fourth, Amber's run-in.
  for (const t of [740, 755, 770, 779, 2060, 2075]) {
    await at(a, t);
    await hover(a, ".koth[data-status=Active]");
    await a.screenshot({ path: `${OUT}/rift-${t}.png` });
  }
  // Sapphire's Rejuvenator, then Amber's.
  for (const t of [1880, 1940, 2040, 2400, 2466, 2560]) {
    await at(a, t);
    await hover(a, ".midboss");
    await a.screenshot({ path: `${OUT}/rejuv-${t}.png` });
  }
  // The 25:00 urn lying at the east site, then walking back.
  for (const t of [1600, 1700]) {
    await at(a, t);
    const u = (await a.locator('[data-testid=urn][data-state="ground"]').boundingBox())!;
    await a.mouse.move(u.x + u.width / 2, u.y + u.height / 2);
    console.log(`urn ${t}: ${await a.getByTestId("hover-label").textContent()}`);
    await a.screenshot({ path: `${OUT}/urn-${t}.png` });
  }
});
