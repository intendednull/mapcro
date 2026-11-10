// Death skulls in Player (spec §6b): on a synthetic replay timeline handed to the server as the
// worker would, a hero's death draws a small skull where it fell, fading out over SKULL_S match
// seconds; scrubbing in shows it, scrubbing out removes it. In one team's view, a death that team
// didn't see draws none, and an enemy merely going out of sight never does: it just goes.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { ROOT, Server, TIMELINE_FORMAT, newBoardUrl, translate } from "./server";

const ID = "129000077";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-skull-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "20" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
const stand = (team: string, slot: number) => ({ x: slot * 1500 - 4000, y: team === "amber" ? -3000 : 3000 });

/**
 * - Amber 1 dies at 20 (back at 30); the Archmother's team sees it 10–19.8 s: a death it saw.
 * - Sapphire 2 dies at 40 (back at 50), never seen by the King's team: a death it didn't see.
 * - Sapphire 0 is seen by the King's team 10–30 s, then goes out of its sight, alive.
 */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const a1 = team === "amber" && slot === 1;
        const s2 = team === "sapphire" && slot === 2;
        const s0 = team === "sapphire" && slot === 0;
        const dead = (s: number) => (a1 && s >= 20 && s < 30) || (s2 && s >= 40 && s < 50);
        const at = stand(team, slot);
        return {
          team, slot, hero_id: 1 + slot, name: null,
          x: range((s) => (dead(s) ? null : at.x)),
          y: range((s) => (dead(s) ? null : at.y)),
          health: range((s) => (dead(s) ? 0 : 100)),
          deaths: a1 ? [20] : s2 ? [40] : [],
          respawn: a1 ? [[20, 30]] : s2 ? [[40, 50]] : [],
          souls: [[0, 500]], ult: range(() => 0),
          seen: a1 ? [[100, 198]] : s0 ? [[100, 300]] : [],
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
  };
}

async function open(p: Page) {
  await p.getByTestId("mode-player").click();
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(t).padStart(2, "0")} /`);
}
const tok = (p: Page, slot: string) => p.locator(`[data-testid=map] .tok[data-slot="${slot}"]`);
const skulls = (p: Page) => p.getByTestId("death-skull");
/** Every skull drawn: its slot. */
const drawn = (p: Page) => skulls(p).evaluateAll((els) => els.map((el) => el.getAttribute("data-slot")));

test("a death leaves a skull where it fell that fades in a couple of seconds; vision hides the ones its team didn't see", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Skulls"), "Coach");
  await open(a);
  const pick = a.getByTestId("vision-select");
  await expect(pick).toHaveValue("all");

  // Before the death: none. Amber 1 stands where it will fall.
  await scrubTo(a, 19);
  await expect(skulls(a)).toHaveCount(0);
  const spot = translate(await tok(a, "Amber-1").getAttribute("transform"));

  // Just after: its token gone, a skull on its spot, in its team's colour, part faded.
  await scrubTo(a, 21);
  await expect(tok(a, "Amber-1")).toHaveCount(0);
  expect(await drawn(a)).toEqual(["amber-1"]);
  const sk = skulls(a).first();
  await expect(sk).toHaveClass(/\bamber\b/);
  expect(translate(await sk.getAttribute("transform"))).toEqual(spot);
  const op = Number(await sk.getAttribute("opacity"));
  expect(op).toBeGreaterThan(0.5);
  expect(op).toBeLessThan(1);
  // The team's colour (`--amber`, resolved), and never in the pointer's way.
  const amber = await a.evaluate(() => {
    const d = document.body.appendChild(document.createElement("div"));
    d.style.color = "var(--amber)";
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  });
  expect(await sk.evaluate((el) => [getComputedStyle(el).pointerEvents, getComputedStyle(el.querySelector("path")!).fill])).toEqual(["none", amber]);
  await a.mouse.move(5, 5);
  await a.screenshot({ path: join(ROOT, "web/shots/death-skull.png") });
  const box = (await sk.boundingBox())!;
  await a.screenshot({ path: join(ROOT, "web/shots/death-skull-close.png"), clip: { x: box.x - 90, y: box.y - 70, width: 180 + box.width, height: 140 + box.height } });
  // Fading: dimmer a second on, gone after the window, and back on scrubbing in again.
  await scrubTo(a, 22);
  expect(Number(await sk.getAttribute("opacity"))).toBeLessThan(op);
  await scrubTo(a, 23);
  await expect(skulls(a)).toHaveCount(0);
  await scrubTo(a, 20);
  expect(await drawn(a)).toEqual(["amber-1"]);
  await expect(skulls(a).first()).toHaveAttribute("opacity", "1.000");

  // Playing through a death: it comes and goes with no scrub.
  await scrubTo(a, 38);
  await expect(skulls(a)).toHaveCount(0);
  await a.getByTestId("match-play").click();
  await expect.poll(() => drawn(a), { timeout: 10_000 }).toEqual(["sapphire-2"]);
  await expect(skulls(a)).toHaveCount(0, { timeout: 10_000 });
  await a.getByTestId("match-play").click();

  // The Archmother's view: Amber 1 was in its sight up to 0.2 s before it died: shown. Its own
  // Sapphire 2's death: shown.
  await pick.selectOption("sapphire");
  await scrubTo(a, 21);
  expect(await drawn(a)).toEqual(["amber-1"]);
  await scrubTo(a, 41);
  expect(await drawn(a)).toEqual(["sapphire-2"]);

  // The King's view: Sapphire 2 died out of its sight: no skull; in All, there is.
  await pick.selectOption("amber");
  await scrubTo(a, 41);
  await expect(skulls(a)).toHaveCount(0);
  await expect(tok(a, "Sapphire-2")).toHaveCount(0);
  // With last seen on, too: it was never seen, so no ghost and no skull.
  await a.getByTestId("last-seen-toggle").click();
  await expect(skulls(a)).toHaveCount(0);
  await a.getByTestId("last-seen-toggle").click();
  await pick.selectOption("all");
  expect(await drawn(a)).toEqual(["sapphire-2"]);

  // Sapphire 0 merely going out of the King's sight at 30: its token goes, no skull.
  await pick.selectOption("amber");
  await scrubTo(a, 29);
  await expect(tok(a, "Sapphire-0")).toHaveCount(1);
  await scrubTo(a, 31);
  await expect(tok(a, "Sapphire-0")).toHaveCount(0);
  await expect(skulls(a)).toHaveCount(0);
});

test("a follower draws the presenter's skulls, at the presenter's time and vision", async ({ browser }) => {
  const url = await newBoardUrl(server, "Skulls follow");
  const a = await joinNew(browser, url, "Coach");
  await open(a);
  const b = await joinNew(browser, url, "Second");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await scrubTo(a, 41);
  await expect(b.getByTestId("match-clock")).toContainText("0:41 /");
  expect(await drawn(b)).toEqual(["sapphire-2"]);
  await expect(skulls(b).first()).toHaveAttribute("opacity", await skulls(a).first().getAttribute("opacity") ?? "");
  // The King's view, the presenter's: the death it didn't see draws none for the follower either.
  await a.getByTestId("vision-select").selectOption("amber");
  await expect(b.getByTestId("vision-select")).toHaveValue("amber");
  await expect(skulls(b)).toHaveCount(0);
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
});
