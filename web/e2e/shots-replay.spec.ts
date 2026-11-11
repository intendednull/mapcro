// Screenshots of a real parsed replay (never committed data): set MAPCRO_SHOT_REPLAY to a
// timeline the worker wrote (`mapcro-replay parse x.dem out.json <id>`) and MAPCRO_SHOT_PACKS to
// the asset packs. Skipped otherwise.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl } from "./server";

const src = process.env.MAPCRO_SHOT_REPLAY;
const ID = process.env.MAPCRO_SHOT_REPLAY_ID ?? "129738985";
const TIMES = (process.env.MAPCRO_SHOT_TIMES ?? "600,1200,1800,2400").split(",").map(Number);
let server: Server;

test.skip(!src, "set MAPCRO_SHOT_REPLAY to a parsed timeline");

test.beforeAll(async () => {
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-shot-")), MATCH_API_BASE: "http://127.0.0.1:9" });
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  copyFileSync(src!, join(server.dataDir, "replays", `${ID}-cdn.json`));
  await server.start();
});
test.afterAll(() => server?.stop());

test("a real replay at a few moments", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Real replay"), "Coach");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  for (const t of TIMES) {
    await a.getByTestId("match-time").evaluate((el, t) => {
      (el as HTMLInputElement).value = String(t);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, t);
    // Past the ziplines' 350 ms ease (spec §4a), so the edges read are the parse's.
    await a.waitForTimeout(400);
    await a.screenshot({ path: `shots/replay-real-${t}.png` });
    // What the map draws for each lane's zipline colours, to check against the parse.
    const lanes = await a.locator("[data-testid=map] svg.lanes g[data-key]").evaluateAll((gs) => gs.map((g) => `${g.getAttribute("data-key")} ${g.getAttribute("data-amber")}-${g.getAttribute("data-sapphire")}`));
    console.log(`${t}s lanes: ${lanes.join(", ")}`);
    // A cleared camp's tooltip, on hover.
    const cleared = a.locator('[data-testid=map] .mk[data-camp="cleared"]').first();
    if (await cleared.count()) {
      const b = (await cleared.boundingBox())!;
      await a.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await expect(a.getByTestId("hover-label")).toBeVisible();
      console.log(`${t}s ${await cleared.getAttribute("data-key")}: ${await a.getByTestId("hover-label").textContent()}`);
      await a.locator("[data-testid=map]").screenshot({ path: `shots/replay-real-${t}-camp.png` });
      await a.mouse.move(5, 5);
    }
  }
});
