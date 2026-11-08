// Clicking an event in the list selects that event (operator bug, 2026-11-08): the clicked row is
// the marked one, through the lead and until playback passes the next listed event; playback
// sits at its time less the lead; the jump ring sits at the event. With a filter, a search, and
// a lead of 5 s and of 0. A synthetic replay timeline the test hands the server as the worker
// would.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

const ID = "129000003";
const N = 240;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-evclick-"));
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
/** Each slot's spot: an Amber hero and a Sapphire one stand there all match; Amber's dies there. */
const spot = (slot: number) => ({ x: slot * 1500 - 3500, y: 2500 });
const ev = (t: number, kind: string, extra: Record<string, unknown>) => ({ t, kind, team: null, slot: null, hero_id: null, by: null, key: null, x: null, y: null, amount: null, ability: null, ...extra });

/** 30 events 5 s apart from 20 s: two deaths, then an objective, over and over (20 deaths). */
const EVENTS = Array.from({ length: 30 }, (_, i) => {
  const t = 20 + 5 * i;
  if (i % 3 === 2) return ev(t, "objective", { team: "amber", key: "walker:amber:lane1:1" });
  const slot = i % 6;
  return ev(t, "death", { team: "amber", slot, hero_id: 1 + slot, ...spot(slot) });
});

function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: null,
        x: range(() => spot(slot).x), y: range(() => spot(slot).y),
        health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0),
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: EVENTS,
  };
}

const clock = async (p: Page) => {
  const [m, s] = ((await p.getByTestId("match-clock").textContent()) ?? "").split(" / ")[0]!.split(":").map(Number);
  return m! * 60 + s!;
};
const centre = async (p: Page, sel: string) => {
  const r = (await p.locator(sel).first().boundingBox())!;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};

/** Click the `i`th listed event (a negative `i` counts from the end) and check what it selected. */
async function clickAndCheck(p: Page, i: number, lead: number) {
  const rows = p.getByTestId("event");
  const n = await rows.count();
  const row = rows.nth(i < 0 ? n + i : i);
  const key = (await row.getAttribute("data-key"))!;
  const t = Number(await row.getAttribute("data-t"));
  await row.getByTestId("event-jump").click();
  // Playback at the event less the lead, paused.
  await expect.poll(() => clock(p)).toBe(Math.max(0, t - lead));
  await expect(p.getByTestId("match-play")).toHaveText("Play");
  // The clicked row is the marked one, and only it.
  await expect(p.locator("[data-testid=event][data-current=true]")).toHaveCount(1);
  await expect(p.locator("[data-testid=event][data-current=true]")).toHaveAttribute("data-key", key);
  // It's still in view: the list didn't scroll it away.
  await expect(row).toBeInViewport();
  // The jump ring sits at the event: on the spot where its hero stands and dies.
  const e = EVENTS.find((x) => x.t === t)!;
  const ring = await centre(p, "[data-testid=event-highlight] circle");
  const at = e.kind === "death" ? await centre(p, `.mapbox .tok[data-slot="Sapphire-${e.slot}"]`) : await centre(p, `.mapbox .mk[data-key="${e.key}"]`);
  expect(Math.hypot(ring.x - at.x, ring.y - at.y)).toBeLessThan(8);
  return { key, t };
}

test("clicking an event selects that event, with a filter, a search and any lead", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Event clicks"), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(a.getByTestId("event")).toHaveCount(30);

  // Deaths only: 20 listed, each 5 s or 10 s after the one before, so with a 5 s lead the jump
  // lands on or before the previous listed event's time.
  await a.getByTestId("chip-death").click();
  await expect(a.getByTestId("event")).toHaveCount(20);
  for (const lead of [5, 0]) {
    await a.getByTestId("events-lead").fill(String(lead));
    for (const i of [2, 9, -1]) await clickAndCheck(a, i, lead);
  }

  // The mark holds through the lead and moves on once playback passes the next listed event.
  await a.getByTestId("events-lead").fill("5");
  const { key, t } = await clickAndCheck(a, 4, 5);
  const next = (await a.getByTestId("event").nth(5).getAttribute("data-key"))!;
  const nextT = Number(await a.getByTestId("event").nth(5).getAttribute("data-t"));
  await a.getByTestId("match-play").click();
  await expect.poll(() => clock(a), { timeout: 10_000 }).toBeGreaterThanOrEqual(t);
  await expect(a.locator("[data-testid=event][data-current=true]")).toHaveAttribute("data-key", key);
  await expect.poll(() => clock(a), { timeout: 15_000 }).toBeGreaterThan(nextT);
  await expect(a.locator("[data-testid=event][data-current=true]")).toHaveAttribute("data-key", next);
  await a.getByTestId("match-play").click();

  // A search on top of the filter (its words each match a label, a hero or a clock).
  await a.getByTestId("events-search").fill("Hero 4");
  await expect.poll(() => a.getByTestId("event").count()).toBeLessThan(20);
  expect(await a.getByTestId("event").count()).toBeGreaterThan(2);
  for (const i of [0, -1]) await clickAndCheck(a, i, 5);
  await a.screenshot({ path: "shots/events-click.png" });
});
