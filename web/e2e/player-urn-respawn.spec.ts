// Respawn timers and the Soul Urn in Player (spec §6b), on a synthetic replay timeline the test
// hands the server as the worker would: a dead hero's portrait counts down to its respawn with
// the playback; the urn draws as the game's minimap draws it, on the ground where it lies and
// on its carrier's icon, its delivery point lit while open; hovering a point says when the next urn spawns;
// pick-ups, drops and the delivery are listed and ping where they happened.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

const ID = "129000005";
const N = 120;
const WEST = "urn:neutral:lane1:1";
const EAST = "urn:neutral:lane6:1";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-urn-"));
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
/** Where each hero stands all match: Amber at the bottom, Sapphire at the top. */
const stand = (team: string, slot: number) => ({ x: slot * 1500 - 4000, y: team === "amber" ? -3000 : 3000 });
const DROP = { x: 2000, y: 500 };
const ev = (t: number, kind: string, extra: Record<string, unknown>) => ({ t, kind, team: null, slot: null, hero_id: null, by: null, key: null, x: null, y: null, amount: null, ability: null, ...extra });

function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: 1,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        // Amber 0 dies at 20 and respawns at 35.
        const dead = (s: number) => team === "amber" && slot === 0 && s >= 20 && s < 35;
        return {
          team, slot, hero_id: 1 + slot, name: null,
          x: range((s) => (dead(s) ? null : stand(team, slot).x)),
          y: range((s) => (dead(s) ? null : stand(team, slot).y)),
          health: range((s) => (dead(s) ? 0 : 100)),
          deaths: team === "amber" && slot === 0 ? [20] : [],
          respawn: team === "amber" && slot === 0 ? [[20, 35]] : [],
          souls: [[0, 500]], ult: range(() => 0),
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [],
    // The urn spawns over the west point at 10 and the east point opens at 12; Amber 1 picks it
    // up at 30 and drops it at 45; Sapphire 2 picks it up at 50 and delivers it at 60. The next
    // spawns over the east point at 100.
    urn: {
      spawns: [{ t: 10, key: WEST }, { t: 100, key: EAST }],
      at: [
        { t: 10, state: "ground", x: -6584, y: 0 },
        { t: 12, state: "ground", x: -6584, y: 0, delivery: EAST },
        { t: 30, state: "carried", team: "amber", slot: 1, delivery: EAST },
        { t: 45, state: "ground", x: DROP.x, y: DROP.y, team: "amber", delivery: EAST },
        { t: 50, state: "carried", team: "sapphire", slot: 2, delivery: EAST },
        { t: 60, state: "none" },
        { t: 100, state: "ground", x: 6304, y: -96 },
      ],
    },
    events: [
      ev(30, "urn_pickup", { team: "amber", slot: 1, hero_id: 2, x: -6584, y: 0 }),
      ev(45, "urn_drop", { team: "amber", slot: 1, hero_id: 2, ...DROP }),
      ev(50, "urn_pickup", { team: "sapphire", slot: 2, hero_id: 3, ...DROP }),
      ev(60, "urn_delivered", { team: "sapphire", slot: 2, hero_id: 3, key: EAST, x: 6304, y: -96 }),
    ],
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
}
const clock = async (p: Page) => {
  const [m, s] = ((await p.getByTestId("match-clock").textContent()) ?? "").split(" / ")[0]!.split(":").map(Number);
  return m! * 60 + s!;
};
const centre = async (p: Page, sel: string) => {
  const r = (await p.locator(sel).first().boundingBox())!;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
};
const marker = (p: Page, key: string) => p.locator(`[data-testid=map] .mk[data-key="${key}"]`);
const urn = (p: Page) => p.locator("[data-testid=map] [data-testid=urn]");
const ART = "[data-testid=map] [data-testid=urn] .pl-urn-art";
const RIFT = "rift:neutral:lane1:1";

test("a dead hero's portrait counts down to its respawn with the playback", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Respawn"), "Coach");
  await open(a);
  const count = a.locator('[data-testid=topbar] .tb-player[data-slot="Amber-0"] [data-testid=tb-respawn]');
  await scrubTo(a, 15);
  await expect(count).toHaveCount(0);
  await scrubTo(a, 25);
  await expect(count).toHaveText("10");
  // Only the dead hero counts.
  await expect(a.getByTestId("tb-respawn")).toHaveCount(1);
  await a.getByTestId("match-play").click();
  await expect.poll(async () => Number(await count.textContent()), { timeout: 10_000 }).toBeLessThanOrEqual(8);
  await a.getByTestId("match-play").click();
  // It follows a scrub back as well.
  await scrubTo(a, 21);
  await expect(count).toHaveText("14");
  await scrubTo(a, 36);
  await expect(count).toHaveCount(0);
  await expect(a.locator('[data-testid=topbar] .tb-player[data-slot="Amber-0"]')).toHaveAttribute("data-alive", "true");
  await scrubTo(a, 25);
  await a.screenshot({ path: "/tmp/urn-game-pw/respawn-synthetic.png" });
});

test("the urn draws where it lies and on its carrier at the game's sizes, and lights its delivery point", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Urn"), "Coach");
  await open(a);
  // Sizes are read at rest: the carried urn and the pulses animate their scale.
  await a.emulateMedia({ reducedMotion: "reduce" });
  await scrubTo(a, 5);
  await expect(urn(a)).toHaveCount(0);
  await expect(marker(a, WEST)).toHaveAttribute("data-status", "Destroyed");
  await expect(marker(a, EAST)).toHaveAttribute("data-status", "Destroyed");

  // On the ground over the west point, the east point open.
  await scrubTo(a, 15);
  await expect(urn(a)).toHaveAttribute("data-state", "ground");
  const g = await centre(a, ART);
  const site = await centre(a, `[data-testid=map] .mk[data-key="${WEST}"]`);
  expect(Math.hypot(g.x - site.x, g.y - site.y)).toBeLessThan(4);
  await expect(marker(a, EAST)).toHaveAttribute("data-status", "Active");
  await expect(marker(a, WEST)).toHaveAttribute("data-status", "Destroyed");
  // hud_minimap.vcss: .idol_spawn is 32 px, a rift's box (.capture_point); never bigger.
  const rift = await centre(a, `[data-testid=map] .mk[data-key="${RIFT}"]`);
  expect(g.w).toBeLessThanOrEqual(rift.w + 1);
  expect(g.w).toBeGreaterThan(rift.w * 0.8);
  // None of our own additions: no ring, halo or disc.
  await expect(urn(a).locator("circle")).toHaveCount(0);
  // The open point is lit: the game's three pulses; the closed one shows none.
  await expect(marker(a, EAST)).toHaveClass(/\blit\b/);
  await expect(marker(a, WEST)).not.toHaveClass(/\blit\b/);
  const pulses = (p: Page, key: string) =>
    p.locator(`[data-testid=map] .mk[data-key="${key}"] > .urn-pulse`).evaluateAll((els) => els.map((el) => `${getComputedStyle(el).display} ${getComputedStyle(el).animationName}`));
  // Reduced motion: the first pulse at rest, unanimated.
  expect(await pulses(a, EAST)).toEqual(["block none", "none none", "none none"]);
  expect(await pulses(a, WEST)).toEqual(["none none", "none none", "none none"]);
  await a.emulateMedia({ reducedMotion: "no-preference" });
  expect(await pulses(a, EAST)).toEqual(["block urn-idol-pulse", "block urn-idol-pulse", "block urn-idol-pulse"]);
  expect(await pulses(a, WEST)).toEqual(["none none", "none none", "none none"]);
  await a.emulateMedia({ reducedMotion: "reduce" });

  // Carried by Amber 1: .held_idol_image, a hero icon's size, offset 8 and 10 of 32 px to the
  // lower right of the carrier's icon, pulsing; no team ring.
  await scrubTo(a, 40);
  await expect(urn(a)).toHaveAttribute("data-state", "carried");
  await expect(urn(a)).toHaveAttribute("data-team", "amber");
  const c = await centre(a, ART);
  const tok = await centre(a, '.mapbox .tok[data-slot="Amber-1"] circle.body');
  expect(Math.abs(c.w - tok.w)).toBeLessThan(2);
  expect(Math.abs(c.x - tok.x - tok.w * (8 / 32))).toBeLessThan(2);
  expect(Math.abs(c.y - tok.y - tok.w * (10 / 32))).toBeLessThan(2);
  await expect(urn(a).locator("circle")).toHaveCount(0);
  await a.emulateMedia({ reducedMotion: "no-preference" });
  expect(await a.locator(ART).evaluate((el) => getComputedStyle(el).animationName)).toBe("urn-held");
  await a.emulateMedia({ reducedMotion: "reduce" });
  await a.screenshot({ path: "/tmp/urn-game-pw/urn-carried-synthetic.png" });

  // Dropped: on the ground where it fell, the ground marker as in game. Then Sapphire's carrier.
  await scrubTo(a, 47);
  await expect(urn(a)).toHaveAttribute("data-state", "ground");
  await expect(urn(a)).toHaveAttribute("data-x", String(DROP.x));
  await expect(urn(a)).toHaveAttribute("data-team", "amber");
  expect(Math.abs((await centre(a, ART)).w - g.w)).toBeLessThan(1);
  await scrubTo(a, 55);
  await expect(urn(a)).toHaveAttribute("data-team", "sapphire");
  const s = await centre(a, ART);
  const stok = await centre(a, '.mapbox .tok[data-slot="Sapphire-2"] circle.body');
  expect(Math.hypot(s.x - stok.x, s.y - stok.y)).toBeLessThan(stok.w);

  // Delivered: gone, and the point closed.
  await scrubTo(a, 65);
  await expect(urn(a)).toHaveCount(0);
  await expect(marker(a, EAST)).toHaveAttribute("data-status", "Destroyed");
});

test("hovering an urn point says when the next urn spawns, and it counts down", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Urn tips"), "Coach");
  await open(a);
  const tip = a.getByTestId("camp-tip");
  const hover = async (key: string) => {
    const b = (await marker(a, key).boundingBox())!;
    await a.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  };
  await scrubTo(a, 5);
  await expect(tip).toHaveCount(0);
  await hover(WEST);
  await expect(tip).toHaveText("Urn spawns here in 0:05 (at 0:10)");
  await a.mouse.move(5, 5);
  await expect(tip).toHaveCount(0);

  await scrubTo(a, 70);
  await hover(EAST);
  await expect(tip).toHaveText("Urn spawns here in 0:30 (at 1:40)");
  await scrubTo(a, 80);
  await expect(tip).toHaveText("Urn spawns here in 0:20 (at 1:40)");
  await hover(WEST);
  await expect(tip).toHaveText("Next urn spawns at the other site in 0:20 (at 1:40)");
  await scrubTo(a, 40);
  await hover(EAST);
  await expect(tip).toHaveText("Urn delivery point: open, urn carried");
});

test("urn pick-ups, drops and the delivery are listed and ping where they happened", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Urn events"), "Coach");
  await open(a);
  const rows = a.locator('[data-testid=event][data-kind^="urn_"]');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Urn picked up by");
  await expect(rows.nth(1)).toContainText("Urn dropped by");
  await expect(rows.nth(3)).toContainText("Urn delivered by");
  // Their own filter.
  await a.getByTestId("chip-urn").click();
  await expect(a.getByTestId("event")).toHaveCount(4);
  await a.getByTestId("chip-urn").click();

  await a.evaluate(() => {
    const w = window as unknown as { pings: Array<{ t: string; kind: string; x: number; y: number }>; pingLog?: MutationObserver };
    w.pings = [];
    w.pingLog = new MutationObserver((ms) => {
      for (const m of ms)
        for (const n of m.addedNodes) {
          const els = n instanceof Element ? [n, ...n.querySelectorAll("[data-testid=event-ping]")] : [];
          for (const el of els) {
            if (el.getAttribute("data-testid") !== "event-ping") continue;
            const r = el.querySelector("circle")!.getBoundingClientRect();
            w.pings.push({ t: el.getAttribute("data-t")!, kind: el.getAttribute("data-kind")!, x: r.x + r.width / 2, y: r.y + r.height / 2 });
          }
        }
    });
    w.pingLog.observe(document.body, { childList: true, subtree: true });
  });
  await scrubTo(a, 42);
  await a.getByTestId("match-speed").selectOption("4");
  await a.getByTestId("match-play").click();
  await expect.poll(() => clock(a), { timeout: 15_000 }).toBeGreaterThanOrEqual(46);
  await a.getByTestId("match-play").click();
  const pings = await a.evaluate(() => (window as unknown as { pings: Array<{ t: string; kind: string; x: number; y: number }> }).pings);
  expect(pings.map((x) => x.kind)).toEqual(["urn_drop"]);
  // The drop pings where the urn now lies.
  await expect(urn(a)).toHaveAttribute("data-state", "ground");
  const lies = await centre(a, ART);
  expect(Math.hypot(pings[0]!.x - lies.x, pings[0]!.y - lies.y)).toBeLessThan(6);
});
