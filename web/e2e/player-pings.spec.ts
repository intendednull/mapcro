// Event pings during playback (spec §6b): each event the playback passes while it plays gets a
// short ring at its place, for the presenter and a follower alike; events a seek skips, events
// the list's filters hide, and everything with Pings off get none. A synthetic replay timeline
// the test hands the server as the worker would.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

const ID = "129000002";
const N = 120;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-pings-"));
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
/** Where each Sapphire hero stands, the whole match: deaths happen on top of two of them. */
const stand = (slot: number) => ({ x: slot * 1500 - 3500, y: 2500 });
const ev = (t: number, kind: string, extra: Record<string, unknown>) => ({ t, kind, team: null, slot: null, hero_id: null, by: null, key: null, x: null, y: null, amount: null, ability: null, ...extra });
const death = (t: number, slot: number, at: { x: number; y: number }) => ev(t, "death", { team: "amber", slot, hero_id: 1 + slot, ...at });

function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: null,
        x: range(() => (team === "sapphire" ? stand(slot).x : slot * 600 - 1500)),
        y: range(() => (team === "sapphire" ? stand(slot).y : -3000)),
        health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0),
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [],
    events: [
      death(14, 0, stand(3)),
      ev(16, "objective", { team: "amber", key: "walker:amber:lane1:1" }),
      death(18, 1, stand(4)),
      // Skipped by a short seek (shorter than the largest step a running clock may take, so
      // only the seek itself says it's a jump).
      death(22, 2, stand(1)),
      // A death and an objective while only Objectives are listed.
      death(60, 3, stand(2)),
      ev(62, "objective", { team: "sapphire", key: "walker:sapphire:lane1:1" }),
      // With Pings off.
      death(80, 4, stand(3)),
    ],
  };
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

/**
 * Record every ping ring that appears from now on, with where its centre was on screen when it
 * first showed: the rings are short-lived, so the test reads the log rather than racing them.
 */
async function recordPings(p: Page) {
  await p.evaluate(() => {
    const w = window as unknown as { pings: Array<{ t: string; x: number; y: number }>; pingLog?: MutationObserver };
    w.pings = [];
    if (w.pingLog) return;
    w.pingLog = new MutationObserver((ms) => {
      for (const m of ms)
        for (const n of m.addedNodes) {
          const els = n instanceof Element ? [n, ...n.querySelectorAll("[data-testid=event-ping]")] : [];
          for (const el of els) {
            if (el.getAttribute("data-testid") !== "event-ping") continue;
            const r = el.querySelector("circle")!.getBoundingClientRect();
            w.pings.push({ t: el.getAttribute("data-t")!, x: r.x + r.width / 2, y: r.y + r.height / 2 });
          }
        }
    });
    w.pingLog.observe(document.body, { childList: true, subtree: true });
  });
}
const pinged = (p: Page) => p.evaluate(() => (window as unknown as { pings: Array<{ t: string; x: number; y: number }> }).pings);
const centre = async (p: Page, sel: string) => {
  const r = (await p.locator(sel).first().boundingBox())!;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

test("events ping at their place as playback passes them, for a follower too; never for a skipped or filtered event", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pings");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(a.getByTestId("pings-toggle")).toHaveAttribute("aria-pressed", "true");
  await scrubTo(a, 12);

  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await expect(b.getByTestId("match-clock")).toHaveText("0:12 / 2:00");
  await recordPings(a);
  await recordPings(b);

  // Play across three events at 2×.
  await a.getByTestId("match-speed").selectOption("2");
  await a.getByTestId("match-play").click();
  await expect.poll(() => clock(a), { timeout: 10_000 }).toBeGreaterThanOrEqual(19);
  // Seek just past the death at 22 s, still playing, and run on a little.
  await scrubTo(a, 23);
  await expect.poll(() => clock(a), { timeout: 5000 }).toBeGreaterThanOrEqual(25);
  await a.getByTestId("match-play").click();

  for (const [who, p] of [["presenter", a], ["follower", b]] as const) {
    await expect.poll(async () => (await pinged(p)).map((x) => x.t).sort(), { timeout: 5000, message: `the ${who}'s pings` }).toEqual(["14", "16", "18"]);
    const log = await pinged(p);
    // Each ring sits where its event happened: the deaths on the heroes standing there, the
    // objective on its icon.
    expect(near(log.find((x) => x.t === "14")!, await centre(p, '.mapbox .tok[data-slot="Sapphire-3"]'))).toBeLessThan(8);
    expect(near(log.find((x) => x.t === "18")!, await centre(p, '.mapbox .tok[data-slot="Sapphire-4"]'))).toBeLessThan(8);
    expect(near(log.find((x) => x.t === "16")!, await centre(p, '.mapbox .mk[data-key="walker:amber:lane1:1"]'))).toBeLessThan(8);
  }
  // Short-lived: gone a moment later.
  await expect(a.getByTestId("event-ping")).toHaveCount(0, { timeout: 3000 });

  // Only Objectives listed: the death at 60 s doesn't ping, the objective at 62 does.
  await a.getByTestId("chip-objective").click();
  await recordPings(a);
  await scrubTo(a, 58);
  await a.getByTestId("match-play").click();
  await expect.poll(() => clock(a), { timeout: 10_000 }).toBeGreaterThanOrEqual(64);
  await a.getByTestId("match-play").click();
  expect((await pinged(a)).map((x) => x.t)).toEqual(["62"]);
  await a.getByTestId("chip-objective").click();

  // Pings off: nothing.
  await a.getByTestId("pings-toggle").click();
  await expect(a.getByTestId("pings-toggle")).toHaveAttribute("aria-pressed", "false");
  await recordPings(a);
  await scrubTo(a, 78);
  await a.getByTestId("match-play").click();
  await expect.poll(() => clock(a), { timeout: 10_000 }).toBeGreaterThanOrEqual(82);
  await a.getByTestId("match-play").click();
  expect(await pinged(a)).toEqual([]);
});
