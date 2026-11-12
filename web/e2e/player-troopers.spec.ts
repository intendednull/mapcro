// The replay's lane troopers as dots (operator, 2026-11-08: to check the wave splits by eye), on
// a synthetic replay timeline the test hands the server as the worker would.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

const ID = "122134063";
const N = 120;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-troopers-"));
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

const pack = (list: Array<[number, number, number]>) => {
  const b = Buffer.alloc(list.length * 6);
  list.forEach(([id, x, y], i) => {
    b.writeUInt16LE(id, i * 6);
    b.writeInt16LE(x, i * 6 + 2);
    b.writeInt16LE(y, i * 6 + 4);
  });
  return b.toString("base64");
};
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/** Bit 15 of a trooper's id: a captured rift spawned it (timeline.rs `RIFT_TROOPER`). */
const RIFT = 0x8000;

/** Four troopers a side marching up and down the mid lane, and one rift trooper standing on the
 * Archmother's side; nothing recorded from 60 to 70 s. */
function timeline() {
  const side = (team: "amber" | "sapphire") =>
    range((s) =>
      s >= 60 && s < 70
        ? ""
        : pack([
            ...[0, 1, 2, 3].map((i) => [i + (team === "amber" ? 0 : 10), (i - 1.5) * 150, team === "amber" ? -6000 + s * 40 : 6000 - s * 40] as [number, number, number]),
            ...(team === "sapphire" ? [[RIFT | 20, -3000, 0] as [number, number, number]] : []),
          ]),
    );
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
    waves: [{ lane: "lane4", t: range((s) => 500), stale: [] }],
    troopers: { every_s: 1, amber: side("amber"), sapphire: side("sapphire") },
  };
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}
const spots = (p: Page) => p.locator("[data-testid=trooper]").evaluateAll((els) => els.map((e) => `${e.getAttribute("cx")},${e.getAttribute("cy")}`).sort());

/** A new board in Player with the synthetic replay loaded, by the presenter "Coach". */
async function loaded(browser: Parameters<typeof joinNew>[0], name: string) {
  const url = await newBoardUrl(server, name);
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
  return { a, url };
}

test("trooper dots render, move between times, keep gaps empty, and toggle off", async ({ browser }) => {
  const { a } = await loaded(browser, "Troopers");
  await scrubTo(a, 20);
  await expect(a.locator("[data-testid=trooper]")).toHaveCount(9);
  const at20 = await spots(a);
  await scrubTo(a, 40);
  await expect(a.locator("[data-testid=trooper]")).toHaveCount(9);
  expect(await spots(a)).not.toEqual(at20);
  await a.screenshot({ path: "shots/troopers-synthetic.png" });
  // Nothing recorded: nothing drawn.
  await scrubTo(a, 65);
  await expect(a.locator("[data-testid=trooper]")).toHaveCount(0);
  await scrubTo(a, 40);
  await revealControls(a, "troopers-toggle");
  await a.getByTestId("troopers-toggle").click();
  await expect(a.locator("[data-testid=trooper]")).toHaveCount(0);
});

test("a rift's trooper is bigger and darker, says so on hover, and a follower sees it the same", async ({ browser }) => {
  const { a, url } = await loaded(browser, "Rift troopers");
  await scrubTo(a, 20);
  const rift = a.locator("[data-testid=trooper][data-rift]");
  await expect(rift).toHaveCount(1);
  const lane = a.locator("[data-testid=trooper]:not([data-rift])").first();
  const r = async (l: typeof rift) => Number(await l.getAttribute("r"));
  expect((await r(rift)) / (await r(lane))).toBeCloseTo(1.6, 5);
  const fill = (l: typeof rift) => l.evaluate((e) => getComputedStyle(e).fill);
  const lum = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).reduce((x, y) => x + y, 0);
  const sapphire = a.locator("[data-testid=trooper].sapphire:not([data-rift])").first();
  expect(lum(await fill(rift))).toBeLessThan(lum(await fill(sapphire)) * 0.7);
  // Hovered, it's tagged; the dot never takes the pointer from the map.
  expect(await rift.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe("none");
  const box = (await rift.boundingBox())!;
  await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(a.getByTestId("hover-label")).toHaveText("Rift trooper");
  // A follower draws it the same, and shows the presenter's hover on it.
  const b = await joinNew(browser, url, "Second");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  const theirs = b.locator("[data-testid=trooper][data-rift]");
  await expect(theirs).toHaveCount(1);
  expect(await r(theirs)).toBeGreaterThan(await r(b.locator("[data-testid=trooper]:not([data-rift])").first()));
  await a.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
  await expect(b.getByTestId("hover-label")).toHaveText("Rift trooper");
  await a.mouse.move(5, 5);
  await expect(a.getByTestId("hover-label")).toHaveCount(0);
  await expect(b.getByTestId("hover-label")).toHaveCount(0);
});

test("playing moves the dots and rebuilds none of the map's icons", async ({ browser }) => {
  // #39: every frame of playback rebuilt each powerup's icon (its parts removed and inserted),
  // relaying out and repainting the map. Counted as DOM work, not time.
  const { a } = await loaded(browser, "Still icons");
  await scrubTo(a, 20);
  await expect(a.locator("[data-testid=trooper]")).toHaveCount(9);
  await expect(a.locator("[data-testid=map] .mk.powerup")).not.toHaveCount(0);
  await a.getByTestId("match-play").click();
  const work = await a.evaluate(async () => {
    const map = document.querySelector("[data-testid=map]")!;
    const n = { icons: 0, iconAttrs: 0, dots: 0, frames: 0 };
    const mo = new MutationObserver((ms) => {
      for (const m of ms) {
        const el = (m.target.nodeType === 1 ? m.target : m.target.parentNode) as Element;
        if (el.closest(".mm-objs")) {
          if (m.type === "childList") n.icons += m.addedNodes.length + m.removedNodes.length;
          else n.iconAttrs++;
        } else if (el.closest(".pl-troopers") && m.type === "attributes") n.dots++;
      }
    });
    mo.observe(map, { subtree: true, childList: true, attributes: true });
    let on = true;
    const tick = () => {
      if (!on) return;
      n.frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, 1000));
    on = false;
    mo.disconnect();
    return n;
  });
  await a.getByTestId("match-play").click();
  // It played: the dots moved, frame by frame.
  expect(work.frames).toBeGreaterThan(10);
  expect(work.dots).toBeGreaterThan(work.frames);
  // And no icon was rebuilt.
  expect(work.icons).toBe(0);
});
