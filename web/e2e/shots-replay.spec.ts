// Screenshots of a real parsed replay (never committed data): set MAPCRO_SHOT_REPLAY to a
// timeline the worker wrote (`mapcro-replay parse x.dem out.json <id>`) and MAPCRO_SHOT_PACKS to
// the asset packs. Skipped otherwise.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

const src = process.env.MAPCRO_SHOT_REPLAY;
const ID = process.env.MAPCRO_SHOT_REPLAY_ID ?? "122134063";
const TIMES = (process.env.MAPCRO_SHOT_TIMES ?? "300,500,700").split(",").map(Number);
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
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  for (const t of TIMES) {
    await a.getByTestId("match-time").evaluate((el, t) => {
      (el as HTMLInputElement).value = String(t);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, t);
    await a.waitForTimeout(300);
    await a.screenshot({ path: `shots/replay-real-${t}.png` });
  }
});
