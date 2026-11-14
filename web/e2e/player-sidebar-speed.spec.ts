// Feedback #57 and #58, on the real server with a fake deadlock-api serving the trimmed,
// anonymised real match (crates/server/tests/fixtures).
//
// #57: the sidebar shows what the mode is about and nothing else. In Player, the events list and
// no scene note; on a scene, the note and no events list (Player is one press away).
// #58: speed is two buttons, − and +, stepping through 0.5, 1, 2, 4 and 8, with the current
// speed between them; each is disabled at its end.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page, devices, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
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

async function openMatch(p: Page) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await expect(p.getByTestId("match-tier")).toHaveText("API summary");
}

test("the sidebar: a scene shows its note and no events list; Player shows the events and no note (#57)", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Sidebar"), "Coach");
  const side = a.locator("aside.side");
  const note = a.getByTestId("scene-note-edit");
  const events = side.getByTestId("events");
  // A scene, before any match: the note, no events list, and no tabs to pick between them.
  await expect(note).toBeVisible();
  await expect(events).toHaveCount(0);
  await expect(side.getByRole("tab")).toHaveCount(0);
  await note.fill("Rotate mid");
  await note.blur();

  // Player: the events list, and the note is not there at all (nor a way to it).
  await openMatch(a);
  await expect(events).toBeVisible();
  expect(await side.getByTestId("event").count()).toBeGreaterThan(0);
  await expect(note).toHaveCount(0);
  await expect(side.locator(".note-section")).toHaveCount(0);
  await expect(side.getByRole("tab")).toHaveCount(0);
  await expect(side.getByText("Rotate mid")).toHaveCount(0);

  // Back on the scene, with the match still loaded: the note as it was left, and no events list.
  await revealControls(a, "mode-sandbox");
  await a.getByTestId("mode-sandbox").click();
  await expect(note).toHaveValue("Rotate mid");
  await expect(events).toHaveCount(0);
  await expect(side.getByTestId("player-side")).toHaveCount(0);
  // Player is one press away, and the list is there again.
  await a.getByTestId("replay-entry").click();
  await expect(events).toBeVisible();
  await expect(note).toHaveCount(0);
});

test("speed: − and + step through the five speeds, each disabled at its end, and the keys stay the board's (#58)", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Speed"), "Coach");
  await openMatch(a);
  const group = a.getByTestId("match-speed");
  const [down, up, now] = [a.getByTestId("speed-down"), a.getByTestId("speed-up"), a.getByTestId("speed-now")];
  // No list any more: two buttons and the speed between them, in that order.
  await expect(a.getByTestId("match-speed-list")).toBeHidden();
  expect(await group.evaluate((el) => [...el.children].map((c) => c.getAttribute("data-testid")))).toEqual(["speed-down", "speed-now", "speed-up"]);
  await expect(now).toHaveText("1×");
  await expect(down).toBeEnabled();
  await expect(up).toBeEnabled();

  // Down to the slowest: − disables there.
  await down.click();
  await expect(now).toHaveText("0.5×");
  await expect(group).toHaveAttribute("data-speed", "0.5");
  await expect(down).toBeDisabled();
  await expect(up).toBeEnabled();
  // The button that just disabled can't hold the focus: it is on the other one, not lost.
  const focused = () => a.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  expect(await focused()).toBe("speed-up");

  // Up through every speed to the fastest: + disables there.
  for (const s of ["1", "2", "4", "8"]) {
    await up.click();
    await expect(now).toHaveText(`${s}×`);
    await expect(down).toBeEnabled();
  }
  await expect(up).toBeDisabled();
  // The focus is on − now, and the keys are still the board's: Space plays (it doesn't press
  // the button), and the clock runs at 8×.
  expect(await focused()).toBe("speed-down");
  const clock = async () => {
    const [m, s] = ((await a.getByTestId("match-clock").textContent()) ?? "").split(" / ")[0]!.split(":").map(Number);
    return m! * 60 + s!;
  };
  const from = await clock();
  await a.keyboard.press("Space");
  await expect(a.getByTestId("match-play")).toHaveText("Pause");
  await expect.poll(clock).toBeGreaterThan(from + 8);
  await a.keyboard.press("Space");
  await expect(a.getByTestId("match-play")).toHaveText("Play");
  await expect(now).toHaveText("8×");
  // And back down one.
  await down.click();
  await expect(now).toHaveText("4×");
  await expect(up).toBeEnabled();
  // By keyboard alone: Enter on + steps up to the end, the focus moves to −, and Enter there
  // steps back down.
  await up.focus();
  await a.keyboard.press("Enter");
  await expect(now).toHaveText("8×");
  expect(await focused()).toBe("speed-down");
  await a.keyboard.press("Enter");
  await expect(now).toHaveText("4×");
  expect(await focused()).toBe("speed-down");
});

/** A phone or tablet on the board, in Player (the board's match is open). */
async function touchPlayer(browser: Browser, url: string, name: string, device: object): Promise<Page> {
  const ctx = await browser.newContext({ ...device, defaultBrowserType: undefined } as never);
  const p = await ctx.newPage();
  await p.goto(url);
  await p.locator("#join-name").fill(name);
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("player")).toHaveAttribute("data-state", "match");
  if (!(await p.locator(".phone-player").count())) await p.getByTestId("mode-player").tap();
  await expect(p.locator(".phone-player")).toHaveCount(1);
  await expect(p.getByTestId("match-play")).toBeVisible();
  return p;
}

test("speed on a phone: the list when it is held upright, the buttons on its side; the desktop has the buttons (#58)", async ({ browser }) => {
  const url = await newBoardUrl(server, "Phone speed");
  const a = await joinNew(browser, url, "Coach");
  await openMatch(a);
  const controls = (p: Page) => ({ list: p.getByTestId("match-speed-list"), down: p.getByTestId("speed-down"), up: p.getByTestId("speed-up"), group: p.getByTestId("match-speed") });
  const size = async (p: Page, id: string) => {
    const r = (await p.getByTestId(id).boundingBox())!;
    return Math.min(r.width, r.height);
  };

  // The desktop: the buttons, and no list.
  const desk = controls(a);
  await expect(desk.down).toBeVisible();
  await expect(desk.up).toBeVisible();
  await expect(desk.list).toBeHidden();

  // Upright (390 and 360 px wide): the list alone, a touch target, and it sets the speed.
  for (const viewport of [devices["iPhone 13"].viewport, { width: 360, height: 740 }]) {
    const phone = await touchPlayer(browser, url, `Phone ${viewport.width}`, { ...devices["iPhone 13"], viewport });
    const c = controls(phone);
    await expect(c.list).toBeVisible();
    await expect(c.down).toBeHidden();
    await expect(c.up).toBeHidden();
    expect(await size(phone, "match-speed-list")).toBeGreaterThanOrEqual(43.9);
    await expect(c.list).toHaveValue("1");
    await c.list.selectOption("4");
    await expect(c.group).toHaveAttribute("data-speed", "4");
    await expect(c.list).toHaveValue("4");
    // The scrubber keeps the row's width: the speed control takes none of it.
    expect((await phone.getByTestId("match-time").boundingBox())!.width).toBeGreaterThan(250);
    await phone.context().close();
  }

  // On its side: the buttons, each a touch target, and no list.
  const side = await touchPlayer(browser, url, "Phone on its side", devices["iPhone 13 landscape"]);
  const c = controls(side);
  await expect(c.down).toBeVisible();
  await expect(c.up).toBeVisible();
  await expect(c.list).toBeHidden();
  expect(await size(side, "speed-down")).toBeGreaterThanOrEqual(43.9);
  expect(await size(side, "speed-up")).toBeGreaterThanOrEqual(43.9);
  await c.up.tap();
  await expect(c.group).toHaveAttribute("data-speed", "2");
  await expect(side.getByTestId("speed-now")).toHaveText("2×");
});

test("a follower typing the scene note keeps what they typed when the presenter opens Player (#57)", async ({ browser }) => {
  const url = await newBoardUrl(server, "Note under follow");
  const a = await joinNew(browser, url, "Coach");
  await openMatch(a);
  await revealControls(a, "mode-sandbox");
  await a.getByTestId("mode-sandbox").click();
  // Marrow follows Coach, on the scene; Quill watches the scene and follows no one.
  // (A board with a match opens in Player: Quill steps out to the scene.)
  const b = await joinNew(browser, url, "Marrow");
  const c = await joinNew(browser, url, "Quill");
  await revealControls(c, "mode-sandbox");
  await c.getByTestId("mode-sandbox").click();
  await expect(c.getByTestId("scene-note-edit")).toBeVisible();
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  const note = b.getByTestId("scene-note-edit");
  await note.click();
  await note.pressSequentially("Rotate mid");
  await expect(c.getByTestId("note-editing")).toHaveCount(1);
  await expect(c.getByTestId("scene-note-edit")).toHaveValue(""); // typed, not saved yet

  // Coach goes back to Player: Marrow follows there, and the note's field leaves Marrow's page
  // with the focus still in it. No blur fires for a removed field.
  await a.getByTestId("replay-entry").click();
  await expect(b.locator("aside.side").getByTestId("events")).toBeVisible();
  await expect(note).toHaveCount(0);
  // What Marrow typed is saved, and nobody is shown editing any more.
  await expect(c.getByTestId("scene-note-edit")).toHaveValue("Rotate mid");
  await expect(c.getByTestId("note-editing")).toHaveCount(0);
  // Back on the scene, Marrow's own note is the saved one.
  await revealControls(a, "mode-sandbox");
  await a.getByTestId("mode-sandbox").click();
  await expect(note).toHaveValue("Rotate mid");
});
