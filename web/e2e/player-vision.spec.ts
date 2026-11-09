// Vision in Player (spec §6b): on a synthetic replay timeline handed to the server as the worker
// would, "Vision: Hidden King" / "Archmother" draws the map as that team saw it. Its own heroes
// always show; an enemy out of its sight is a ghost at the spot it was last seen, labelled with
// how long ago; one it hasn't seen (yet, or since it died) isn't drawn. "All" is the map as
// before. The choice is this browser's: followers keep their own, and a reload keeps it.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl, translate } from "./server";

const ID = "129000044";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-vision-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
const stand = (team: string, slot: number) => ({ x: slot * 1500 - 4000, y: team === "amber" ? -3000 : 3000 });

/**
 * - Sapphire 0 walks east 100 units a second; the King's team sees it 10–20 s.
 * - Amber 1 is seen by the Archmother's team 0–30 s, dies at 35 and is back at 40, unseen since.
 * - Amber 0 is seen by the Archmother's team all match; every other hero by nobody.
 */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const walker = team === "sapphire" && slot === 0;
        const victim = team === "amber" && slot === 1;
        const dead = (s: number) => victim && s >= 35 && s < 40;
        const at = (s: number) => (walker ? { x: -4000 + 100 * s, y: 0 } : stand(team, slot));
        return {
          team, slot, hero_id: 1 + slot, name: null,
          x: range((s) => (dead(s) ? null : at(s).x)),
          y: range((s) => (dead(s) ? null : at(s).y)),
          health: range((s) => (dead(s) ? 0 : 100)),
          deaths: victim ? [35] : [],
          respawn: victim ? [[35, 40]] : [],
          souls: [[0, 500]], ult: range(() => 0),
          seen: walker ? [[100, 200]] : victim ? [[0, 300]] : team === "amber" && slot === 0 ? [[0, N * 10]] : [],
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
const at = async (p: Page, slot: string) => translate(await tok(p, slot).getAttribute("transform"));
/** Every drawn token: its slot and whether it's a ghost. */
const drawn = (p: Page) =>
  p.locator("[data-testid=map] .tok[data-slot]").evaluateAll((els) => Object.fromEntries(els.map((el) => [el.getAttribute("data-slot"), el.getAttribute("data-seen") === "false" ? "ghost" : "shown"])));
const everyone = (state: string) => Object.fromEntries(["Amber", "Sapphire"].flatMap((t) => [0, 1, 2, 3, 4, 5].map((s) => [`${t}-${s}`, state])));

test("each team's view shows its own heroes, ghosts the enemies it lost sight of, and hides the ones it never saw", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Vision"), "Coach");
  await open(a);
  await a.emulateMedia({ reducedMotion: "reduce" });
  const pick = a.getByTestId("vision-select");
  await expect(pick).toHaveValue("all");
  await expect(pick.locator("option")).toHaveText(["Vision: All", "Vision: Hidden King", "Vision: Archmother"]);

  // All: every living hero, none a ghost, where the match has it, as before.
  const all: Record<number, Record<string, { x: number; y: number }>> = {};
  for (const t of [5, 15, 20, 30, 42]) {
    await scrubTo(a, t);
    expect(await drawn(a)).toEqual(everyone("shown"));
    all[t] = { s0: await at(a, "Sapphire-0"), a0: await at(a, "Amber-0"), a2: await at(a, "Amber-2") };
  }
  await expect(tok(a, "Sapphire-0")).not.toHaveAttribute("aria-label", /Seen/);

  // The King's view.
  await pick.selectOption("amber");
  const kingOwn = { "Amber-0": "shown", "Amber-1": "shown", "Amber-2": "shown", "Amber-3": "shown", "Amber-4": "shown", "Amber-5": "shown" };
  await scrubTo(a, 5);
  expect(await drawn(a)).toEqual(kingOwn);
  await scrubTo(a, 15);
  expect(await drawn(a)).toEqual({ ...kingOwn, "Sapphire-0": "shown" });
  expect(await at(a, "Sapphire-0")).toEqual(all[15]!.s0);
  // Out of sight at 20: a ghost at its spot then, while it really walks on.
  await scrubTo(a, 30);
  expect(await drawn(a)).toEqual({ ...kingOwn, "Sapphire-0": "ghost" });
  expect(await at(a, "Sapphire-0")).toEqual(all[20]!.s0);
  const [p30, p20] = [all[30]!.s0!, all[20]!.s0!];
  expect(Math.hypot(p30.x - p20.x, p30.y - p20.y)).toBeGreaterThan(30);
  expect(await at(a, "Amber-2")).toEqual(all[30]!.a2);
  const ghost = tok(a, "Sapphire-0");
  await expect(ghost).toHaveClass(/\bghost\b/);
  await expect(ghost).toHaveAttribute("aria-label", /Seen 0:10 ago$/);
  // Dim and desaturated; its health isn't known out of sight.
  expect(await ghost.evaluate((el) => [getComputedStyle(el).filter, getComputedStyle(el.querySelector(".body")!).opacity])).toEqual(["saturate(0.25)", "0.6"]);
  await expect(ghost.getByTestId("tok-health")).toHaveCount(0);
  await expect(tok(a, "Amber-2").getByTestId("tok-health")).toHaveCount(1);
  const b = (await ghost.locator("circle.body").boundingBox())!;
  await a.mouse.move(b.x + b.width / 2, b.y + 2);
  await expect(a.getByTestId("hover-label")).toHaveText(/Seen 0:10 ago$/);
  await a.mouse.move(5, 5);
  await a.screenshot({ path: "/tmp/vision/synthetic-king-30.png" });

  // The Archmother's view: Amber 0 always seen; Amber 1 a ghost after 30 s, gone once it dies.
  await pick.selectOption("sapphire");
  const archOwn = { "Sapphire-0": "shown", "Sapphire-1": "shown", "Sapphire-2": "shown", "Sapphire-3": "shown", "Sapphire-4": "shown", "Sapphire-5": "shown" };
  await scrubTo(a, 20);
  expect(await drawn(a)).toEqual({ ...archOwn, "Amber-0": "shown", "Amber-1": "shown" });
  expect(await at(a, "Sapphire-0")).toEqual(all[20]!.s0);
  await scrubTo(a, 30);
  expect(await drawn(a)).toEqual({ ...archOwn, "Amber-0": "shown", "Amber-1": "ghost" });
  await expect(tok(a, "Amber-1")).toHaveAttribute("aria-label", /Seen 0:00 ago$/);
  await scrubTo(a, 42);
  expect(await drawn(a)).toEqual({ ...archOwn, "Amber-0": "shown" });
  expect(await at(a, "Amber-0")).toEqual(all[42]!.a0);

  // All again: exactly as before.
  await pick.selectOption("all");
  for (const t of [5, 30]) {
    await scrubTo(a, t);
    expect(await drawn(a)).toEqual(everyone("shown"));
    expect(await at(a, "Sapphire-0")).toEqual(all[t]!.s0);
  }
});

test("a ghost eases in and out, and jumps under reduced motion", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Vision ease"), "Coach");
  await open(a);
  await a.getByTestId("vision-select").selectOption("amber");
  await scrubTo(a, 15);
  const s0 = tok(a, "Sapphire-0");
  const ease = () => s0.evaluate((el) => [getComputedStyle(el).transitionDuration, getComputedStyle(el.querySelector(".body")!).transitionDuration]);
  expect(await ease()).toEqual(["0.35s", "0.35s"]);
  await a.emulateMedia({ reducedMotion: "reduce" });
  expect(await ease()).toEqual(["0s", "0s"]);
});

test("the view is this browser's: a follower keeps its own, and a reload keeps it", async ({ browser }) => {
  const url = await newBoardUrl(server, "Vision local");
  const a = await joinNew(browser, url, "Coach");
  await open(a);
  const b = await joinNew(browser, url, "Second");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await a.getByTestId("vision-select").selectOption("amber");
  await scrubTo(a, 30);
  await expect(tok(a, "Sapphire-0")).toHaveAttribute("data-seen", "false");
  // The follower is at the same moment, with every hero shown.
  await expect(b.getByTestId("match-clock")).toContainText("0:30 /");
  await expect(b.getByTestId("vision-select")).toHaveValue("all");
  await expect(tok(b, "Sapphire-0")).toHaveAttribute("data-seen", "true");
  await expect(tok(b, "Sapphire-1")).toHaveCount(1);

  await a.reload();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(a.getByTestId("vision-select")).toHaveValue("amber");
  await expect(tok(a, "Sapphire-1")).toHaveCount(0);
  await expect(tok(a, "Amber-1")).toHaveCount(1);
});
