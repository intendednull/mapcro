// A follower sees the presenter's jump (QA 2026-11-08): the jump ring at the same place and the
// same events row marked. Presence's playback carries the jump (the event's key and the time it
// landed at); before, the ring was local and the follower marked by its own clock, a row early.
// The synthetic replay timeline of player-events-click.spec.ts.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

const ID = "129000007";
const N = 240;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-followjump-"));
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


/** Where the jump ring is on `p`, and where event `t` happened there. */
async function ringAndPlace(p: Page, t: number) {
  const e = EVENTS.find((x) => x.t === t)!;
  const ring = await centre(p, "[data-testid=event-highlight] circle");
  const at = e.kind === "death" ? await centre(p, `.mapbox .tok[data-slot="Sapphire-${e.slot}"]`) : await centre(p, `.mapbox .mk[data-key="${e.key}"]`);
  return Math.hypot(ring.x - at.x, ring.y - at.y);
}
const marked = (p: Page) => p.locator("[data-testid=event][data-current=true]");

test("a follower sees the presenter's jump: the same ring, the same row marked", async ({ browser }) => {
  const url = await newBoardUrl(server, "Follow a jump");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(a.getByTestId("event")).toHaveCount(30);

  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await expect(b.getByTestId("event")).toHaveCount(30);
  await expect(b.locator("[data-testid=event-highlight]")).toHaveCount(0);

  // With the 5 s lead, events 5 s apart: each jump lands on the previous event's time, so a
  // follower marking by its own clock marks the row before the one clicked.
  for (const i of [7, 3, 22]) {
    const row = a.getByTestId("event").nth(i);
    const key = (await row.getAttribute("data-key"))!;
    const t = Number(await row.getAttribute("data-t"));
    await row.getByTestId("event-jump").click();
    await expect.poll(() => clock(b)).toBe(t - 5);
    await expect(marked(b)).toHaveCount(1);
    await expect(marked(b)).toHaveAttribute("data-key", key);
    await expect(b.locator("[data-testid=event-highlight] circle").first()).toBeVisible();
    await expect.poll(() => ringAndPlace(b, t)).toBeLessThan(8);
    expect(await ringAndPlace(a, t)).toBeLessThan(8);
  }
  await b.screenshot({ path: "shots/follow-jump-B.png" });
  await a.screenshot({ path: "shots/follow-jump-A.png" });

  // The presenter seeks elsewhere: the row unpins for the follower too, who marks by the clock.
  await a.getByTestId("match-forward").click();
  const t = await clock(a);
  await expect.poll(() => clock(b)).toBe(t);
  const byClock = EVENTS.filter((e) => e.t <= t).length - 1;
  await expect(marked(b)).toHaveAttribute("data-key", (await b.getByTestId("event").nth(byClock).getAttribute("data-key"))!);
});
