// The palette in Player: ink, arrows and comments on Player's live layer take the colour too.

import { readFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { gesture, joinNew, mapPoint } from "./helpers";
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
  await a.getByTestId("scene-from-match").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toBeVisible();
  await a.getByTestId("palette").click();
  await a.getByRole("radio", { name: "Colour: Ice" }).click();
  await a.keyboard.press("d");
  await gesture(a, [[0.3, 0.3], [0.45, 0.33]]);
  await expect.poll(() => css(a, ".mapbox [data-stroke] path.ink", "stroke")).toBe("rgb(127, 224, 232)");
  await a.keyboard.press("a");
  await gesture(a, [[0.5, 0.4], [0.62, 0.45]]);
  await expect.poll(() => css(a, ".mapbox [data-arrow] .arw", "stroke")).toBe("rgb(127, 224, 232)");
  await a.keyboard.press("c");
  const at = await mapPoint(a, 0.7, 0.3);
  await a.mouse.click(at.x, at.y);
  await a.getByTestId("comment-input").fill("Ice in Player");
  await a.keyboard.press("Enter");
  await a.mouse.move(5, 5);
  await expect.poll(() => css(a, ".mapbox [data-callout] .bubble-body", "fill")).toBe("rgb(127, 224, 232)");
  await a.screenshot({ path: "shots/palette-player.png" });
});
