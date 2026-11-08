// The events list follows playback (operator, 2026-11-08): the latest event at or before t is
// marked and kept in view while playing; scrolling the list yourself stops that until Play, or
// "↓ Now".

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
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
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { MATCH_API_BASE: `http://127.0.0.1:${port}` });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

test("the current event is marked and kept in view as the match plays", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Follow list"), "Coach");
  await a.getByTestId("scene-from-match").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await a.getByTestId("match-time").evaluate((el) => {
    (el as HTMLInputElement).value = "500";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const current = a.locator('[data-testid=event][data-current="true"]');
  await expect(current).toHaveCount(1);
  expect(Number(await current.getAttribute("data-t"))).toBeLessThanOrEqual(500);

  await a.getByTestId("match-speed").selectOption("8");
  await a.getByTestId("match-play").click();
  const seen: number[] = [];
  const list = (await a.locator(".pl-list").boundingBox())!;
  for (let i = 0; i < 12; i++) {
    await a.waitForTimeout(400);
    seen.push(Number(await current.getAttribute("data-t")));
    const row = (await current.boundingBox())!;
    expect(row.y, "the current row is in view").toBeGreaterThanOrEqual(list.y - 1);
    expect(row.y + row.height).toBeLessThanOrEqual(list.y + list.height + 1);
  }
  await a.screenshot({ path: "shots/events-follow.png" });
  expect(seen.every((t, i) => i === 0 || t >= seen[i - 1]!), seen.join(",")).toBe(true);
  expect(new Set(seen).size, seen.join(",")).toBeGreaterThan(2);

  // Your own scroll stops following; "↓ Now" brings it back.
  await a.locator(".pl-list").hover();
  await a.mouse.wheel(0, -2000);
  await expect(a.getByTestId("events-now")).toBeVisible();
  await a.getByTestId("events-now").click();
  await expect(a.getByTestId("events-now")).toHaveCount(0);
});
