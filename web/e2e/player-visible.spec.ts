// What Player shows, asserted on screen (operator's bugs, 2026-11-08): the top bar drawn from the
// match at t, scenes picked in Player actually shown, and the jump ring on its hero. Screenshots
// go to shots/ for a person to look at.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Locator, type Page, expect, test } from "./fixtures";
import { joinNew, revealControls, useSummary } from "./helpers";
import { ROOT, Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "130816395";
const fixture = readFileSync(join(ROOT, `crates/server/tests/fixtures/match-${ID}-trimmed.json`));
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-visible-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
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
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue });
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
async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}
const centre = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** The fixture's players as the server orders them: by team, then player slot. */
function players() {
  const m = JSON.parse(fixture.toString()).match_info as { players: Array<{ team: number; player_slot: number; hero_id: number; stats: Array<{ time_stamp_s: number; net_worth: number }> }> };
  const by = (team: number) => m.players.filter((p) => p.team === team).sort((a, b) => a.player_slot - b.player_slot);
  return { Amber: by(0), Sapphire: by(1) };
}
const soulsAt = (p: { stats: Array<{ time_stamp_s: number; net_worth: number }> }, t: number) =>
  p.stats.filter((s) => s.time_stamp_s <= t).at(-1)?.net_worth ?? null;

test("Player's top bar is the match at t: heroes, souls, team totals, the dead, the clock", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Top bar"), "Coach");
  await openMatch(a);
  const ps = players();
  for (const t of [400, 1000]) {
    await scrubTo(a, t);
    const bar = a.getByTestId("topbar");
    await expect(bar).toHaveAttribute("data-mode", "player");
    await expect(bar.getByTestId("tb-clock")).toHaveText(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`);
    for (const team of ["Amber", "Sapphire"] as const) {
      let total = 0;
      for (const [i, p] of ps[team].entries()) {
        const cell = bar.locator(`.tb-player[data-slot="${team}-${i}"]`);
        await expect(cell).toHaveAttribute("data-hero", String(p.hero_id));
        const souls = soulsAt(p, t);
        total += souls ?? 0;
        await expect(cell.getByTestId("souls")).toHaveAttribute("data-souls", String(souls ?? "untracked"));
        // The metadata tier has no ult data: untracked, not "ready".
        await expect(cell.getByTestId("ult")).toHaveAttribute("data-ult", "untracked");
      }
      await expect(bar.getByTestId(`total-${team}`)).toHaveAttribute("data-souls", String(total));
    }
  }
  // Amber's third player dies at 382 s: dark on the bar, then alive again.
  await scrubTo(a, 386);
  await expect(a.locator('.tb-player[data-slot="Amber-2"]')).toHaveClass(/\bdead\b/);
  await expect(a.locator('.tb-player[data-slot="Amber-2"]')).toHaveAttribute("data-alive", "false");
  await a.screenshot({ path: "shots/player-topbar-dead.png" });
  await scrubTo(a, 370);
  await expect(a.locator('.tb-player[data-slot="Amber-2"]')).not.toHaveClass(/\bdead\b/);
  await a.screenshot({ path: "shots/player-topbar.png" });
});

test("a scene picked in Player is shown: Sandbox on that scene, for followers too", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pick");
  const a = await joinNew(browser, url, "Coach");
  await openMatch(a);
  await a.getByTestId("chip-objective").click();
  for (const i of [0, 3, 6]) await a.getByTestId("event").nth(i).getByTestId("event-pick").check();
  await a.getByTestId("events-save").click();
  const cards = a.getByTestId("scene-card");
  await expect(cards).toHaveCount(4);
  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");

  const tok = (p: Page, slot: string) => p.locator(`.mapbox .tok[data-slot="${slot}"]`);
  const spots = async (p: Page) => [await tok(p, "Amber-0").getAttribute("transform"), await tok(p, "Sapphire-0").getAttribute("transform")];
  const seen: string[] = [];
  for (const i of [1, 2, 3]) {
    await cards.nth(i).click();
    await expect(a.getByTestId("player")).toHaveAttribute("data-state", "scene");
    await expect(a.getByTestId("mode-player")).toBeVisible();
    // Tokens glide to the scene's places: wait for them to settle, then compare.
    let last = "";
    await expect.poll(async () => {
      const now = JSON.stringify(await spots(a));
      const same = now === last;
      last = now;
      return same;
    }, { intervals: [300] }).toBe(true);
    seen.push(last);
    // The follower is on the same scene, in Sandbox, with the same places.
    await expect(b.getByTestId("player")).toHaveAttribute("data-state", "scene");
    await expect.poll(async () => JSON.stringify(await spots(b))).toBe(last);
  }
  await a.screenshot({ path: "shots/player-pick-scene.png" });
  expect(new Set(seen).size, `token places per scene: ${seen.join(" | ")}`).toBe(3);
});

test("the jump ring sits on its hero until the event, then on the event's place", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Ring"), "Coach");
  await openMatch(a);
  await a.getByTestId("events-search").fill("hero 20 6:22");
  await expect(a.getByTestId("event")).toHaveCount(1);
  await a.getByTestId("event").getByTestId("event-jump").click();
  await expect(a.getByTestId("match-clock")).toHaveText("6:17 / 21:40");
  const ring = a.getByTestId("event-highlight").locator("circle").last();
  const hero = a.locator('.mapbox .tok[data-slot="Amber-2"] circle.body');
  await expect(hero).toBeVisible();
  // Within a few pixels of the hero's token (the pulse scales about the ring's own centre).
  const [r, h] = [await centre(ring), await centre(hero)];
  expect(Math.hypot(r.x - h.x, r.y - h.y), `ring ${JSON.stringify(r)} hero ${JSON.stringify(h)}`).toBeLessThan(6);
  await a.screenshot({ path: "shots/player-ring-follows.png" });
  // At the death: the ring stays where the hero was last seen alive.
  await scrubTo(a, 383);
  await expect(hero).toHaveCount(0);
  await expect(a.getByTestId("event-highlight")).toBeVisible();
  await a.screenshot({ path: "shots/player-ring-at-event.png" });
  await scrubTo(a, 381);
  const [r2, h2] = [await centre(ring), await centre(hero)];
  expect(Math.hypot(r2.x - h2.x, r2.y - h2.y)).toBeLessThan(6);
});

test("Map layers popover stays inside viewport and above TopBar at 1024×600", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await ctx.newPage();
  await a.goto(await newBoardUrl(server, "Layers narrow"));
  await a.locator("#join-name").fill("Coach");
  await a.keyboard.press("Enter");
  await expect(a.getByTestId("join-card")).toBeHidden();
  await openMatch(a);
  await useSummary(a);
  // Upgrade to a full-replay timeline with every optional layer so all 8 Map layers rows appear.
  await revealControls(a, "match-file");
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  const range = <T,>(f: (s: number) => T) => Array.from({ length: 61 }, (_, s) => f(s));
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify({
    match_id: Number(ID), start_time: 0, duration_s: 60, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      Array.from({ length: 6 }, (_, slot) => ({
        team, slot, hero_id: slot + 1, name: `P${slot}`,
        x: range(() => (team === "amber" ? -2000 : 2000) + slot * 400),
        y: range(() => (team === "amber" ? -5000 : 5000)),
        health: range(() => 100), deaths: [], souls: [[0, 500]],
        ult: range(() => 0),
        cc: slot === 0 ? [[10, 20, 14, 6, 100]] : [],
        height: slot === 0 ? [[10, 1]] : [],
      })),
    ),
    troopers: { every_s: 1, amber: Array(61).fill(""), sapphire: Array(61).fill("") },
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: [],
  }));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await a.setViewportSize({ width: 1024, height: 600 });
  await a.getByTestId("map-layers-toggle").click();
  const pop = a.locator(".map-layers-pop");
  await expect(pop).toBeVisible();
  const box = (await pop.boundingBox())!;
  expect(box.y, "Map layers popover top >= 0").toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, "Map layers popover bottom <= 600").toBeLessThanOrEqual(600);
  const pings = a.getByTestId("pings-toggle");
  await pings.scrollIntoViewIfNeeded();
  const hit = await pings.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inside: !!top && el.contains(top), topTestId: top?.closest("[data-testid]")?.getAttribute("data-testid") ?? top?.tagName };
  });
  expect(hit.inside, `Event pings occluded by ${hit.topTestId}`).toBe(true);
  await ctx.close();
});
