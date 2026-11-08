// K (kill/revive) acts only on the hero under the pointer, and never under a match preview,
// where tokens show the match, not the scene (review 2026-11-07, finding 7).

import { readFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
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
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-e2e-k-")) });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const tok = (p: Page, slot: string) => p.locator(`.mapbox .tok[data-slot="${slot}"]`);

test("K under a match preview changes nothing on the board", async ({ browser }) => {
  const url = await newBoardUrl(server, "k preview");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await a.getByTestId("scene-from-match").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Metadata");
  // Any hero the preview shows: hover it and press K.
  const shown = a.locator(".mapbox .tok").first();
  await expect(shown).toBeVisible();
  const slot = (await shown.getAttribute("data-slot"))!;
  const bb = (await shown.boundingBox())!;
  await a.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await a.keyboard.press("k");
  await a.waitForTimeout(500);
  await expect(tok(b, slot)).not.toHaveClass(/dead/);
  await expect(tok(a, slot)).not.toHaveClass(/dead/);
});
