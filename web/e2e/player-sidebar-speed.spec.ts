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
import { type Page, expect, test } from "./fixtures";
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
  await expect(a.locator("select.pl-speed")).toHaveCount(0);
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

  // Up through every speed to the fastest: + disables there.
  for (const s of ["1", "2", "4", "8"]) {
    await up.click();
    await expect(now).toHaveText(`${s}×`);
    await expect(down).toBeEnabled();
  }
  await expect(up).toBeDisabled();
  // The disabled button doesn't keep the keys: Space plays, and the clock runs at 8×.
  expect(await up.evaluate((el) => el === document.activeElement)).toBe(false);
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
  // And back down one.
  await down.click();
  await expect(now).toHaveText("4×");
  await expect(up).toBeEnabled();
});
