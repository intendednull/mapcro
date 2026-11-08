// Match import v1 on the real server, with a fake deadlock-api serving a trimmed, anonymised
// real match (crates/server/tests/fixtures). Import, scrub, save two moments as scenes; a
// second browser sees them; undo reverts a save; viewers have no import.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { joinNew, viewLink } from "./helpers";
import { ROOT, Server, newBoardUrl, translate } from "./server";

const ID = "130816395";
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  const fixture = readFileSync(join(ROOT, `crates/server/tests/fixtures/match-${ID}-trimmed.json`));
  upstream = createServer((req, res) => {
    if (req.url?.startsWith(`/v1/matches/${ID}/metadata`)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fixture);
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}` });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const tokens = async (p: Page) =>
  Object.fromEntries(
    await p.locator(".mapbox .tok").evaluateAll((els) => els.map((e) => [e.getAttribute("data-slot")!, e.getAttribute("transform")!] as const)),
  ) as Record<string, string>;
async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}

test("import, scrub, save two moments; a second browser sees them; undo reverts a save", async ({ browser }) => {
  const url = await newBoardUrl(server, "Match night");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const startB = await tokens(b);

  await a.getByTestId("scene-from-match").click();
  await a.getByTestId("match-id").fill("bogus");
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-status")).toHaveText("Invalid id");
  await a.getByTestId("match-id").fill("404");
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-status")).toHaveText("Not found");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-clock")).toHaveText("10:00 / 21:40");
  await expect(a.getByTestId("match-credit")).toHaveText("Match data: deadlock-api.com");
  await expect(a.getByTestId("match-tier")).toHaveText("Metadata");

  // Scrubbing previews the match here only: heroes move for A, not for B.
  await scrubTo(a, 120);
  await expect(a.getByTestId("match-clock")).toHaveText("2:00 / 21:40");
  const at120 = await tokens(a);
  expect(at120).not.toEqual(startB);
  await b.waitForTimeout(300);
  expect(await tokens(b)).toEqual(startB);
  // A dead hero is hidden: slot 3 (Amber-2) dies at 382 s.
  await scrubTo(a, 386);
  await expect(a.locator('.mapbox .tok[data-slot="Amber-2"]')).toHaveCount(0);
  await a.getByTestId("match-forward").click();
  await expect(a.getByTestId("match-clock")).toHaveText("6:36 / 21:40");

  // Save 2:00, then 15:00.
  await scrubTo(a, 120);
  await a.getByTestId("match-save").click();
  await scrubTo(a, 900);
  const at900 = await tokens(a);
  await a.getByTestId("match-save").click();
  const cards = b.getByTestId("scene-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(1)).toHaveAttribute("aria-label", `Scene 2: 2:00 Match ${ID} @ 2:00`);
  await expect(cards.nth(2)).toHaveAttribute("aria-label", `Scene 3: 15:00 Match ${ID} @ 15:00`);

  // B sees the moments with the match's positions and objectives.
  await cards.nth(1).click();
  await expect.poll(() => tokens(b)).toEqual(at120);
  await cards.nth(2).click();
  // Tokens glide to a flipped scene's places: wait for them to land.
  await expect.poll(async () => {
    const seen = await tokens(b);
    return Object.entries(at900).every(([slot, tr]) => JSON.stringify(translate(seen[slot]!)) === JSON.stringify(translate(tr)));
  }).toBe(true);
  const status = (k: string) => b.locator(`.mapbox .mk[data-key="${k}"]`).getAttribute("data-status");
  for (const k of ["guardian:amber:lane4:1", "guardian:sapphire:lane4:1", "guardian:amber:lane1:1", "guardian:amber:lane6:1", "walker:amber:lane1:1"])
    expect(await status(k), k).toBe("Destroyed");
  expect(await status("walker:sapphire:lane6:1")).toBe("Active"); // destroyed at 1169 s, later
  await a.screenshot({ path: "shots/match-import.png" });

  // Sandbox clears the preview; undo reverts the last save.
  await a.getByTestId("mode-sandbox").click();
  await expect(a.getByTestId("player")).toHaveCount(0);
  await expect(a.getByTestId("mode-player")).toBeVisible();
  await a.getByTestId("undo").click();
  await expect(cards).toHaveCount(2);
});

test("a viewer has no match import", async ({ browser }) => {
  const url = await newBoardUrl(server, "view");
  const v = await joinNew(browser, await viewLink(server.url, url), "Guest");
  await expect(v.getByTestId("scene-card")).toHaveCount(1);
  await expect(v.getByTestId("scene-from-match")).toHaveCount(0);
});
