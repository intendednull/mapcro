// While a replay plays, the top bar writes only what changed (#39). A portrait's class was set
// again on every sample with the same value. Each write restyled its disc and re-checked the
// stage's `:has()` rules, at 12 portraits a sample (every frame before late-perf). This counts
// the writes as DOM work, not time, on a synthetic replay with a synthetic pack (no game art).

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";
import { heroPack } from "./synthetic";

const ID = "129700001";
const N = 120;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-topbar-writes-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(heroPack(6), { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/** Twelve heroes walking, their souls going up every second; same heroes all match. */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6860, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: null,
        x: range((s) => slot * 1500 - 4000 + s * 20), y: range(() => (team === "amber" ? -3000 : 3000)),
        health: range(() => 100), deaths: [], souls: range((s) => [s, 500 + s * 37 + slot]), ult: range(() => 0),
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
  };
}

test("playing rewrites no portrait whose hero didn't change", async ({ browser }) => {
  const url = await newBoardUrl(server, "Bar writes");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  const badges = a.locator("[data-testid=topbar] .tb-badge");
  await expect(badges).toHaveCount(12);
  await a.getByTestId("match-speed").selectOption("4");
  await a.getByTestId("match-play").click();
  const work = await a.evaluate(async () => {
    const bar = document.querySelector("[data-testid=topbar]")!;
    const n = { badgeClass: 0, other: 0 };
    const mo = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "attributes" && m.attributeName === "class" && (m.target as Element).classList.contains("tb-badge")) n.badgeClass++;
        else n.other++;
      }
    });
    mo.observe(bar, { subtree: true, attributes: true, childList: true, characterData: true });
    await new Promise((r) => setTimeout(r, 2000));
    mo.disconnect();
    return n;
  });
  await a.getByTestId("match-play").click();
  // It played: the bar moved on (souls, the clock).
  expect(work.other).toBeGreaterThan(12);
  // And no portrait's class was written again.
  expect(work.badgeClass).toBe(0);
});
