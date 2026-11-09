// Screenshots of a real parsed replay (never committed data) for the powerup types and the
// objectives' hover timers: set MAPCRO_SHOT_REPLAY to a timeline the worker wrote, and
// MAPCRO_SHOT_PACKS to the asset packs; MAPCRO_SHOT_DIR (default shots/) is where they go.
// Skipped otherwise.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
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
  await p.waitForTimeout(400);
}

/** Hover the marker, off-centre if a hero token sits on it (a token's label wins). */
async function hoverKind(p: Page, sel: string, i = 0) {
  const m = p.locator(`[data-testid=map] .mk${sel}`).nth(i);
  const key = await m.getAttribute("data-key");
  const b = (await m.boundingBox())!;
  const l = p.getByTestId("hover-label");
  for (const [dx, dy] of [[0, 0], [0, -0.18], [0.18, 0], [-0.18, 0], [0, 0.18], [0.13, -0.13], [-0.13, 0.13], [0.13, 0.13], [-0.13, -0.13]]) {
    await p.mouse.move(b.x + b.width * (0.5 + dx!), b.y + b.height * (0.5 + dy!));
    if ((await l.count()) && (await l.getAttribute("data-key")) === key) break;
  }
  const ok = (await l.count()) > 0 && (await l.getAttribute("data-key")) === key;
  console.log(`${sel}: ${ok ? await l.textContent() : "covered by a token"}`);
  return ok;
}

test("buff types and objective timers on a real replay", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Real replay"), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  for (const [t, name, sel, i] of [
    [602, "buffs-602", '[data-key="powerup:neutral:lane1:1"]', 0],
    [1205, "buffs-1205", '[data-key="powerup:neutral:lane6:1"]', 0],
    [1250, "buff-down-1250", '[data-key="powerup:neutral:lane1:1"]', 0],
    ...[660, 690, 720, 1120, 1150, 1180, 1550, 1580].map((t) => [t, `rift-${t}`, '[data-key="rift:neutral:lane1:1"]', 0] as const),
    ...[750, 1200, 2000, 2060].map((t) => [t, `rift-${t}`, ".koth", 1] as const),
    ...[1900, 1950, 2000, 2100, 2200, 2300].map((t) => [t, `midboss-${t}`, ".midboss", 0] as const),
  ] as const) {
    await at(a, t);
    console.log(`${t}s buffs: ${await a.locator("[data-testid=map] .mk.powerup").evaluateAll((ms) => ms.map((m) => `${m.getAttribute("data-key")}=${m.getAttribute("data-buff") ?? "-"}`).join(", "))}`);
    if (await hoverKind(a, sel, i)) await a.screenshot({ path: `${OUT}/${name}.png` });
  }
  await at(a, 1205);
  const tok = (await a.locator(".tok circle.body").first().boundingBox())!;
  await a.mouse.move(tok.x + tok.width / 2, tok.y + 3);
  await expect(a.getByTestId("hover-label")).toHaveAttribute("data-kind", "token");
  await a.screenshot({ path: `${OUT}/token-1205.png` });
});
