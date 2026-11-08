// Screenshots of the Soul Urn on a real parsed replay (never committed data), at 1440×900 and
// at phone width: MAPCRO_SHOT_REPLAY (a timeline the worker wrote), MAPCRO_SHOT_PACKS (the
// asset packs), MAPCRO_SHOT_TIMES (seconds) and MAPCRO_SHOT_OUT (where the PNGs go). Skipped
// otherwise. Each shot logs the urn's state and the lit delivery point.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, devices } from "@playwright/test";
import { expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

const src = process.env.MAPCRO_SHOT_REPLAY;
const ID = process.env.MAPCRO_SHOT_REPLAY_ID ?? "129738985";
const TIMES = (process.env.MAPCRO_SHOT_TIMES ?? "605,640,1855,2450").split(",").map(Number);
const OUT = process.env.MAPCRO_SHOT_OUT ?? "shots";
let server: Server;

test.skip(!src, "set MAPCRO_SHOT_REPLAY to a parsed timeline");

test.beforeAll(async () => {
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-shot-")), MATCH_API_BASE: "http://127.0.0.1:9" });
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  copyFileSync(src!, join(server.dataDir, "replays", `${ID}-cdn.json`));
  await server.start();
  mkdirSync(OUT, { recursive: true });
});
test.afterAll(() => server?.stop());

const scrub = (a: Page, t: number) =>
  a.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);

async function log(a: Page, tag: string, t: number) {
  const urn = a.locator("[data-testid=map] [data-testid=urn]");
  const state = (await urn.count()) ? `${await urn.getAttribute("data-state")} ${await urn.getAttribute("data-team")}` : "no urn";
  const lit = await a.locator("[data-testid=map] .mk.urn.lit").evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
  console.log(`${tag} ${t}s: urn ${state}; lit ${lit.join(",") || "none"}`);
}

test("the urn on a real replay, desktop and phone", async ({ browser }) => {
  const url = await newBoardUrl(server, "Real replay");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  for (const t of TIMES) {
    await scrub(a, t);
    await a.waitForTimeout(400);
    await a.screenshot({ path: join(OUT, `desk-${t}.png`) });
    await log(a, "desk", t);
  }
  // The phone follows the desktop's playback (as a coach's audience does).
  const ctx = await browser.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined } as never);
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.locator("#join-name").fill("Guest");
  await phone.keyboard.press("Enter");
  const follow = phone.getByTestId("follow-presenter");
  if (await follow.isVisible({ timeout: 5000 }).catch(() => false)) await follow.tap();
  await expect(phone.getByTestId("player")).toBeVisible();
  for (const t of TIMES.slice(0, 2)) {
    await scrub(a, t);
    // An editor's phone keeps its own playback: scrub it too.
    if (await phone.getByTestId("match-time").count()) await scrub(phone, t);
    await phone.waitForTimeout(1200);
    await phone.screenshot({ path: join(OUT, `phone-${t}.png`) });
    await log(phone, "phone", t);
  }
});
