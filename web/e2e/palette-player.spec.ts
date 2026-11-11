// The palette in Player: ink, arrows and comments on Player's live layer take the colour too.

import { readFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { gesture, joinNew, mapPoint, revealControls, useSummary } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

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
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-e2e-palette-")) });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const css = (p: Page, sel: string, prop: "stroke" | "fill") => p.locator(sel).first().evaluate((el, prop) => getComputedStyle(el)[prop], prop);

test("in Player, the palette colours ink, arrows and comments", async ({ browser }) => {
  const url = await newBoardUrl(server, "palette player");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toBeVisible();
  await useSummary(a);
  await a.getByTestId("palette").click();
  await a.getByRole("radio", { name: "Colour: Ice" }).click();
  await a.keyboard.press("e");
  await gesture(a, [[0.3, 0.3], [0.45, 0.33]]);
  await expect.poll(() => css(a, ".mapbox [data-stroke] path.ink", "stroke")).toBe("rgb(127, 224, 232)");
  await a.keyboard.press("a");
  await gesture(a, [[0.5, 0.4], [0.62, 0.45]]);
  await expect.poll(() => css(a, ".mapbox [data-arrow] .arw", "stroke")).toBe("rgb(127, 224, 232)");
  await a.keyboard.press("s");
  const at = await mapPoint(a, 0.7, 0.3);
  await a.mouse.click(at.x, at.y);
  await a.getByTestId("comment-input").fill("Ice in Player");
  await a.keyboard.press("Enter");
  await a.mouse.move(5, 5);
  await expect.poll(() => css(a, ".mapbox [data-callout] .bubble-body", "fill")).toBe("rgb(127, 224, 232)");
  await a.screenshot({ path: "shots/palette-player.png" });
  // The scenes sidebar in Player: the header's "+", no bottom buttons.
  await expect(a.getByTestId("scene-from-match")).toHaveCount(0);
  // Two scenes saved from the match: their rows carry the "▶ m:ss" chip beside the clone and ×.
  await a.getByTestId("match-save").click();
  await expect(a.getByTestId("scene-chip")).toHaveCount(1);
  // Saving shows the new scene; Back returns to the match.
  await expect(a.getByTestId("player")).toHaveAttribute("data-state", "scene");
  await a.getByTestId("mode-player").click();
  await expect(a.getByTestId("player")).toHaveAttribute("data-state", "match");
  await a.getByTestId("match-save").click();
  await expect(a.getByTestId("scene-chip")).toHaveCount(2);
  const row = a.getByTestId("scene-card").filter({ has: a.getByTestId("scene-chip") }).first();
  await row.hover();
  // Nothing overlaps: name, chip and the row's buttons sit side by side.
  const [chip, clone, del] = await Promise.all(["scene-chip", "scene-clone", "scene-delete"].map((t) => row.getByTestId(t).boundingBox()));
  expect(chip!.x + chip!.width).toBeLessThanOrEqual(clone!.x + 0.5);
  expect(clone!.x + clone!.width).toBeLessThanOrEqual(del!.x + 0.5);
  await a.getByTestId("scene-tree").screenshot({ path: "shots/scene-sidebar-player.png" });
});
