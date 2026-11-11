// Player's keys while watching (operator, 2026-11-08; spec §6b): ← → seek 5 s (Shift: 30 s),
// clamped to the match and keeping play or pause; ↑ ↓ step through the events, with the jump's
// ring and the list's mark; a Space tap plays or pauses, while a Space-drag pans and doesn't.
// None of them fire while typing.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, mapPoint, revealControls, viewOf } from "./helpers";
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
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}` });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const clock = (p: Page) => p.getByTestId("match-clock");
async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}
/** Focus on nothing in particular, as after a click on the page's background. */
const unfocus = (p: Page) => p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test("← → seek, ↑ ↓ step events, a Space tap plays and pauses, a Space-drag only pans", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Keys"), "Coach");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(clock(a)).toHaveText(/ \/ 21:40$/);
  const play = a.getByTestId("match-play");
  // The title names the key; the button says which it does now.
  await expect(play).toHaveAttribute("title", "Play / Pause (Space)");
  await scrubTo(a, 300);
  await unfocus(a);

  // ← → seek, paused stays paused, and the page doesn't scroll.
  await a.keyboard.press("ArrowRight");
  await expect(clock(a)).toHaveText("5:05 / 21:40");
  await a.keyboard.press("Shift+ArrowRight");
  await expect(clock(a)).toHaveText("5:35 / 21:40");
  await a.keyboard.press("ArrowLeft");
  await expect(clock(a)).toHaveText("5:30 / 21:40");
  await a.keyboard.press("Shift+ArrowLeft");
  await expect(clock(a)).toHaveText("5:00 / 21:40");
  await expect(play).toHaveText("Play");
  // Clamped to the match.
  await scrubTo(a, 1290);
  await a.keyboard.press("Shift+ArrowRight");
  await expect(clock(a)).toHaveText("21:40 / 21:40");
  await scrubTo(a, 10);
  await a.keyboard.press("Shift+ArrowLeft");
  await expect(clock(a)).toHaveText("0:00 / 21:40");

  // ↓ ↑: the next and previous event, ringed on the map and marked in the list.
  await scrubTo(a, 300);
  await a.keyboard.press("ArrowDown");
  await expect(a.getByTestId("event-highlight")).toBeVisible();
  const first = a.locator('[data-testid=event][data-current="true"]');
  const t1 = Number(await first.getAttribute("data-t"));
  expect(t1).toBeGreaterThan(300);
  await a.keyboard.press("ArrowDown");
  await expect.poll(async () => Number(await a.locator('[data-testid=event][data-current="true"]').getAttribute("data-t"))).toBeGreaterThan(t1);
  await a.keyboard.press("ArrowUp");
  await expect.poll(async () => Number(await a.locator('[data-testid=event][data-current="true"]').getAttribute("data-t"))).toBe(t1);
  expect(await a.evaluate(() => window.scrollY)).toBe(0);

  // A Space tap plays; another pauses. Where it was, it keeps going from.
  await unfocus(a);
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Pause");
  await a.keyboard.press("ArrowRight");
  await expect(play).toHaveText("Pause");
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Play");
  // With the Play button focused (clicked), Space toggles it once, not twice.
  await play.click();
  await expect(play).toHaveText("Pause");
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Play");
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Pause");
  await play.click();
  await expect(play).toHaveText("Play");
  // On another focused button, Space still plays and doesn't press the button.
  await revealControls(a, "pings-toggle");
  await a.getByTestId("pings-toggle").focus();
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Pause");
  await expect(a.getByTestId("pings-toggle")).toHaveAttribute("aria-pressed", "true");
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Play");
  // #11, #3: the scrubber, the speed list and the Map layers disclosure, focused or clicked,
  // don't take Space either: it plays and pauses, and the control is as it was.
  await a.getByTestId("match-time").focus();
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Pause");
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Play");
  const speed = a.getByTestId("match-speed");
  const speedWas = await speed.inputValue();
  await speed.focus();
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Pause");
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Play");
  await expect(speed).toHaveValue(speedWas);
  const layers = a.getByTestId("map-layers-toggle");
  const open = () => a.locator("details.map-layers").evaluate((d) => (d as HTMLDetailsElement).open);
  await layers.focus();
  const wasOpen = await open();
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Pause");
  expect(await open()).toBe(wasOpen);
  await a.keyboard.press("Space");
  await expect(play).toHaveText("Play");
  // Enter still presses a focused button (keyboard-only use).
  await play.focus();
  await a.keyboard.press("Enter");
  await expect(play).toHaveText("Pause");
  await a.keyboard.press("Enter");
  await expect(play).toHaveText("Play");

  // A Space-drag pans the map and leaves playback alone.
  const mid = await mapPoint(a, 0.5, 0.5);
  await a.mouse.move(mid.x, mid.y);
  await a.mouse.wheel(0, -400);
  await expect.poll(async () => (await viewOf(a))[2]).toBeLessThan(700);
  await unfocus(a);
  const v0 = await viewOf(a);
  await a.keyboard.down("Space");
  await a.mouse.down();
  await a.mouse.move(mid.x + 80, mid.y + 40, { steps: 5 });
  await a.mouse.up();
  await a.keyboard.up("Space");
  expect((await viewOf(a))[0]).toBeLessThan(v0[0]);
  await expect(play).toHaveText("Play");

  // Typing: the keys are the field's.
  const t = await clock(a).textContent();
  await a.getByTestId("events-search").fill("x");
  await a.keyboard.press("ArrowLeft");
  await a.keyboard.press("Space");
  await a.keyboard.press("ArrowDown");
  await expect(a.getByTestId("events-search")).toHaveValue(" x");
  await expect(clock(a)).toHaveText(t!);
  await expect(play).toHaveText("Play");
});
