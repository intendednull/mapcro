// Match import's replay tier on the real server (spec §6a). An editor uploads a small fake
// `.dem` with progress; the test plays the sandboxed worker (the on-disk queue is the contract;
// a real demo can't be committed) and finishes the job with a synthetic replay timeline. The
// panel swaps to the replay tier; scrubbing previews ults, rifts, powerups and zipline colours; "Save
// as scene" writes them all, and a second browser sees them.

import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

const ID = "122134063";
const N = 200;
let upstream: ReturnType<typeof createServer>;
let server: Server;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-replays-"));

test.beforeAll(async () => {
  // deadlock-api knows nothing of this match: the replay tier needs no metadata.
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

const heroes = { amber: [20, 7, 27, 80, 77, 67], sapphire: [63, 12, 13, 17, 76, 6] };
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/** A replay timeline as the worker writes it (crates/replay/src/timeline.rs). */
function timeline() {
  const players = (["amber", "sapphire"] as const).flatMap((team) =>
    heroes[team].map((hero_id, slot) => ({
      team,
      slot,
      hero_id,
      name: `${team} ${slot}`,
      x: range((s) => (team === "amber" ? -3000 : 3000) + slot * 500 + s * 5),
      y: range((s) => (team === "amber" ? -6000 : 6000) + s * 10),
      health: range(() => 100),
      deaths: [],
      souls: [[0, 600]],
      // Amber's first hero casts at 60 s with a 100 s cooldown; the others are ready.
      ult: range((s) => (team === "amber" && slot === 0 ? (s < 60 ? 0 : Math.max(0, Math.ceil(100 - (s - 60)))) : 0)),
    })),
  );
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: TIMELINE_FORMAT,
    players,
    objectives: [{ key: "walker:sapphire:lane4:1", kind: "walker", team: "sapphire", lane: 4, destroyed_s: 150 }],
    mid_boss: [],
    rifts: [{ key: "rift:neutral:lane6:1", start_s: 90, end_s: 130 }],
    powerups: [
      { key: "powerup:neutral:lane1:1", available: range((s) => (s >= 80 && s < 110 ? 1 : 0)), stale: [] },
      { key: "powerup:neutral:lane6:1", available: range((s) => (s >= 80 ? 1 : 0)), stale: [[150, N + 1]] },
    ],
    zips: [
      { lane: "lane1", at: [[0, 0, 1000], [30, 420, 620]] },
      { lane: "lane4", at: [[0, 450, 550], [110, 500, 580]] },
      { lane: "lane6", at: [[0, 600, 700]] },
    ],
  };
}

/** Play the worker (it only reads the inbox): post the timeline to its outbox. */
async function work() {
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  const name = job.replace(/\.dem$/, "");
  writeFileSync(join(queue, "outbox", `${name}.json`), JSON.stringify(timeline()));
  return name;
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}
const status = (p: Page, k: string) => p.locator(`.mapbox .mk[data-key="${k}"]`);
const split = (p: Page, lane: string) => p.locator(`.mapbox g[data-key="${lane}"]`);

test("upload a replay, scrub ults, rifts, powerups and zipline colours, save them as a scene", async ({ browser }) => {
  const url = await newBoardUrl(server, "Replay night");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");

  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-notice-text")).toHaveText("Match not found yet.");
  await revealControls(a, "match-upload");
  await expect(a.getByTestId("match-upload")).toBeVisible();

  // Not a demo: refused before it's queued.
  await revealControls(a, "match-file");
  await a.getByTestId("match-file").setInputFiles({ name: "x.dem", mimeType: "application/octet-stream", buffer: Buffer.from("MZ not a demo at all") });
  await expect(a.getByTestId("match-notice-text")).toHaveText("Not a replay. Pick the match's .dem file.");

  const demo = Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(256 * 1024, 7)]);
  await revealControls(a, "match-file");
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: demo });
  await expect(a.getByTestId("match-job")).toHaveText("Queued");
  const job = await work();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(a.getByTestId("match-job")).toHaveText("");
  await expect(a.getByTestId("match-clock")).toHaveText("3:20 / 3:20");
  expect(existsSync(join(server.dataDir, "replays", `${job}.json`))).toBe(true);
  // (The server's parse order, `.order`, stays.)
  await expect.poll(() => readdirSync(join(queue, "inbox")).filter((f) => !f.startsWith(".")).length, { message: "the demo goes with its result" }).toBe(0);
  await expect(a.getByTestId("match-credit")).toHaveText("Replay: uploaded");

  // Scrubbing previews the replay's extras here only.
  await scrubTo(a, 100);
  const ult = a.locator('.tb-player[data-slot="Amber-0"] [data-testid=ult]');
  await expect(ult).toHaveAttribute("data-ult", "60");
  await expect(a.locator('.tb-player[data-slot="Amber-1"] [data-testid=ult]')).toHaveAttribute("data-ult", "0");
  await expect(status(a, "rift:neutral:lane6:1")).toHaveAttribute("data-status", "Active");
  await expect(status(a, "rift:neutral:lane1:1")).toHaveAttribute("data-status", "Destroyed");
  await expect(status(a, "powerup:neutral:lane1:1")).toHaveAttribute("data-status", "Active");
  await expect(split(a, "lane4")).toHaveAttribute("data-amber", "450");
  await expect(split(a, "lane4")).toHaveAttribute("data-sapphire", "550");
  await expect(split(a, "lane6")).toHaveAttribute("data-amber", "600");
  await expect(status(b, "rift:neutral:lane6:1")).toHaveAttribute("data-status", "Destroyed");

  await scrubTo(a, 120);
  await expect(ult).toHaveAttribute("data-ult", "40");
  await expect(status(a, "powerup:neutral:lane1:1")).toHaveAttribute("data-status", "Destroyed");
  await expect(split(a, "lane4")).toHaveAttribute("data-sapphire", "580");
  await a.screenshot({ path: "shots/match-replay.png" });
  await a.getByTestId("match-save").click();
  await revealControls(a, "mode-sandbox");
  await a.getByTestId("mode-sandbox").click();

  // The saved scene carries them, for everyone.
  const cards = b.getByTestId("scene-card");
  await expect(cards).toHaveCount(2);
  await cards.nth(1).click();
  await expect(b.locator('.tb-player[data-slot="Amber-0"] [data-testid=ult]')).toHaveAttribute("data-ult", "40");
  await expect(b.locator('.tb-player[data-slot="Amber-1"] [data-testid=ult]')).toHaveAttribute("data-ult", "0");
  await expect(status(b, "rift:neutral:lane6:1")).toHaveAttribute("data-status", "Active");
  await expect(status(b, "powerup:neutral:lane1:1")).toHaveAttribute("data-status", "Destroyed");
  await expect(status(b, "powerup:neutral:lane6:1")).toHaveAttribute("data-status", "Active");
  // One split per lane in a scene: the middle of the zipline colours' gap.
  await expect(split(b, "lane4")).toHaveAttribute("data-t", "540");
  await expect(split(b, "lane1")).toHaveAttribute("data-t", "520");
  await expect(split(b, "lane6")).toHaveAttribute("data-t", "650");
});
