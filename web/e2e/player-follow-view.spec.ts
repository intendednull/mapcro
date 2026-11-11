// Following mirrors the presenter's view (spec §8 "Follow mode"), on a synthetic replay timeline
// handed to the server as the worker would, with two browsers, presenter and follower:
// - every "Map layers" toggle but Player names is the presenter's while following; the
//   follower's own come back when it stops, or when the presenter leaves (as its Vision does);
//   a follower's own toggle stops following and keeps what it saw with that one change;
// - the presenter's death recap (a skull's card, an events row) opens and closes for the
//   follower, and the card follows the follower's Vision (the presenter's) as it does theirs;
// - the presenter's open builds (one hero's, or All builds) open for the follower.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129000091";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-follow-view-"));
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
const pack = (rows: [number, number, number][]) => {
  const b = Buffer.alloc(rows.length * 6);
  rows.forEach(([id, x, y], i) => {
    b.writeUInt16LE(id, i * 6);
    b.writeInt16LE(x, i * 6 + 2);
    b.writeInt16LE(y, i * 6 + 4);
  });
  return b.toString("base64");
};

/**
 * - Amber 1 dies at 20 (back at 30), seen by Sapphire 10–19.8 s; Sapphire 2 dies at 40 (back at
 *   50), never seen by Amber. Both deaths have recaps, and both are in the events list.
 * - Sapphire 0 is stunned 10–30 s (CC) and above ground all match (Elevation); four troopers.
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
        const at = { x: slot * 1500 - 4000, y: team === "amber" ? -3000 : 3000 };
        return {
          team, slot, hero_id: 1 + slot, name: `${team === "amber" ? "A" : "S"}${slot}`,
          x: range((s) => (dead(s) ? null : at.x)),
          y: range((s) => (dead(s) ? null : at.y)),
          health: range((s) => (dead(s) ? 0 : 100)),
          deaths: a1 ? [20] : s2 ? [40] : [],
          respawn: a1 ? [[20, 30]] : s2 ? [[40, 50]] : [],
          souls: [[0, 500]], ult: range(() => 0),
          seen: a1 ? [[100, 198]] : [],
          items: [[50, 715_762_406, 0]],
          abilities: [], casts: [], charges: [], effects: [],
          cc: s0 ? [[100, 300, 20, 255, 0]] : [],
          height: s0 ? [[0, 1]] : [],
          recaps: a1 ? [{ t: 200, damage: [[7, 0, 640], [255, 0, 120]], cc: [] }] : s2 ? [{ t: 400, damage: [[1, 0, 900]], cc: [] }] : [],
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [],
    events: [
      { t: 20, kind: "death", team: "amber", slot: 1, hero_id: 2, x: -2500, y: -3000 },
      { t: 40, kind: "death", team: "sapphire", slot: 2, hero_id: 3, x: -1000, y: 3000 },
    ],
    waves: [{ lane: "lane4", t: range(() => 500), stale: [] }],
    troopers: { every_s: 1, amber: range(() => pack([[0, 0, -1000], [1, 150, -1000]])), sapphire: range(() => pack([[10, 0, 1000], [11, 150, 1000]])) },
  };
}

const answered = new Set<string>();
async function open(p: Page) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
  answered.add(job);
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

const TOGGLES = ["troopers", "health", "pings", "cc", "movement", "heals", "crates"] as const;
type Layers = Record<(typeof TOGGLES)[number], boolean>;
/** What each mirrored toggle shows, with the Layers popover opened to read it. */
async function layers(p: Page): Promise<Layers> {
  await revealControls(p, "pings-toggle");
  const out = {} as Layers;
  for (const k of TOGGLES) out[k] = (await p.getByTestId(`${k}-toggle`).getAttribute("aria-pressed")) === "true";
  return out;
}
const expectLayers = (p: Page, want: Layers) => expect.poll(() => layers(p)).toEqual(want);
async function toggle(p: Page, k: string) {
  await revealControls(p, `${k}-toggle`);
  await p.getByTestId(`${k}-toggle`).click();
}
const following = (p: Page) => p.getByTestId("stop-following");
async function followCoach(b: Page) {
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
}
const DEFAULTS: Layers = { troopers: true, health: true, pings: true, cc: false, movement: false, heals: false, crates: false };

test("a follower draws the presenter's map layers but keeps its own names; stopping, or the presenter leaving, brings its own back", async ({ browser }) => {
  const url = await newBoardUrl(server, "Follow layers");
  const a = await joinNew(browser, url, "Coach");
  await open(a);
  await scrubTo(a, 15);
  // A board with a match opens in Player.
  const b = await joinNew(browser, url, "Second");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  // The follower's own: no health, heals on, the Archmother's view, and no names.
  await toggle(b, "health");
  await toggle(b, "heals");
  await toggle(b, "names");
  await b.getByTestId("vision-select").selectOption("sapphire");
  const own: Layers = { ...DEFAULTS, health: false, heals: true };
  await expectLayers(b, own);

  await followCoach(b);
  await expectLayers(b, DEFAULTS);
  await expect(b.getByTestId("vision-select")).toHaveValue("all");
  await expect(b.locator("[data-testid=map] .mk.heal")).toHaveCount(0);
  await expect(b.getByTestId("tb-health")).not.toHaveCount(0);

  // The presenter changes every layer: the follower's map follows, live.
  for (const k of TOGGLES) await toggle(a, k);
  const theirs: Layers = { troopers: false, health: false, pings: false, cc: true, movement: true, heals: true, crates: true };
  await expectLayers(a, theirs);
  await expectLayers(b, theirs);
  await expect(b.locator("[data-testid=trooper]")).toHaveCount(0);
  await expect(b.getByTestId("tb-health")).toHaveCount(0);
  await expect(b.getByTestId("tok-cc")).toHaveText("Stunned");
  await expect(b.locator("[data-testid=map] .mk.heal")).not.toHaveCount(0);
  await expect(b.locator("[data-testid=map] .mk.crate")).not.toHaveCount(0);
  await expect(following(b)).toHaveCount(1);
  // Names are each browser's own: the presenter's stay on, the follower's off.
  await expect(a.locator('.tb-player[data-slot="Amber-0"] [data-testid=tb-name]')).toHaveText("A0");
  await expect(b.getByTestId("tb-name")).toHaveCount(0);
  await toggle(a, "names");
  await expect(a.getByTestId("tb-name")).toHaveCount(0);
  await toggle(a, "names");
  await expect(a.locator('.tb-player[data-slot="Amber-0"] [data-testid=tb-name]')).toHaveText("A0");
  await expect(b.getByTestId("tb-name")).toHaveCount(0);
  await expect(following(b)).toHaveCount(1);

  // Stopping: the follower's own come back, untouched.
  await following(b).click();
  await expect(following(b)).toHaveCount(0);
  await expectLayers(b, own);
  await expect(b.getByTestId("vision-select")).toHaveValue("sapphire");
  await expect(b.locator("[data-testid=trooper]")).not.toHaveCount(0);
  await expect(b.locator("[data-testid=map] .mk.crate")).toHaveCount(0);
  await expectLayers(a, theirs);

  // A follower's own toggle while following stops it, keeping the presenter's with that change.
  await followCoach(b);
  await expectLayers(b, theirs);
  await toggle(b, "troopers");
  await expect(following(b)).toHaveCount(0);
  const mine: Layers = { ...theirs, troopers: true };
  await expectLayers(b, mine);
  await expectLayers(a, theirs);

  // The presenter leaves mid-follow: the follower's own layers and Vision come back.
  await b.getByTestId("vision-select").selectOption("sapphire");
  await followCoach(b);
  await expectLayers(b, theirs);
  await expect(b.getByTestId("vision-select")).toHaveValue("all");
  await a.context().close();
  // The follower waits a few seconds for a presenter's own reconnect first (spec §8).
  await expect(following(b)).toHaveCount(0, { timeout: 15_000 });
  await expectLayers(b, mine);
  await expect(b.getByTestId("vision-select")).toHaveValue("sapphire");
});

const skull = (p: Page, slot: string) => p.locator(`[data-testid=death-skull][data-slot="${slot}"]`);
const row = (p: Page, t: number) => p.locator(`[data-testid=event][data-kind=death][data-t="${t}"] [data-testid=death-recap]`);

test("a follower opens the presenter's death recaps and builds, closes them with the presenter, and the card follows Vision", async ({ browser }) => {
  const url = await newBoardUrl(server, "Follow recaps");
  const a = await joinNew(browser, url, "Coach");
  await open(a);
  const b = await joinNew(browser, url, "Second");
  await followCoach(b);
  await scrubTo(a, 41);
  await expect(b.getByTestId("match-clock")).toContainText("0:41 /");

  // The skull's card: opens and closes with the presenter's.
  const card = b.getByTestId("skull-recap");
  await skull(a, "sapphire-2").click();
  await expect(a.getByTestId("skull-recap")).toBeVisible();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Died at 0:40");
  await expect(card).toContainText("Death recap · 900 damage");
  await a.getByTestId("skull-recap-close").click();
  await expect(card).toHaveCount(0);
  // The King's view didn't see that death: the presenter's card closes, and the follower's,
  // drawn in the presenter's Vision, with it.
  await skull(a, "sapphire-2").click();
  await expect(card).toBeVisible();
  await a.getByTestId("vision-select").selectOption("amber");
  await expect(a.getByTestId("skull-recap")).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await a.getByTestId("vision-select").selectOption("all");
  await expect(b.getByTestId("vision-select")).toHaveValue("all");

  // An events row's recap: the follower's opens and closes with the presenter's.
  await expect(row(b, 20)).not.toHaveAttribute("open");
  await row(a, 20).locator("summary").click();
  await expect(row(a, 20)).toHaveAttribute("open", "");
  await expect(row(b, 20)).toHaveAttribute("open", "");
  await expect(row(b, 40)).not.toHaveAttribute("open");
  // A second one: the follower opens it too; closing it leaves the first open on both.
  await row(a, 40).locator("summary").click();
  await expect(row(b, 40)).toHaveAttribute("open", "");
  await row(a, 40).locator("summary").click();
  await expect(row(b, 40)).not.toHaveAttribute("open");
  await expect(row(a, 20)).toHaveAttribute("open", "");
  await row(a, 20).locator("summary").click();
  await expect(row(b, 20)).not.toHaveAttribute("open");
  await expect(following(b)).toHaveCount(1);

  // The builds: one hero's, then all of them, then none.
  await a.locator('.tb-player[data-slot="Amber-0"] [data-testid=focus-hero]').click();
  await expect(a.getByTestId("hero-build")).toHaveCount(1);
  await expect(b.getByTestId("hero-build")).toHaveCount(1);
  await expect(b.locator('.tb-player[data-slot="Amber-0"] [data-testid=hero-build]')).toHaveCount(1);
  await expect(b.getByTestId("build-order")).toHaveCount(1);
  await a.locator(".tb-all-builds").click();
  await expect(b.getByTestId("hero-build")).toHaveCount(12);
  await a.locator(".tb-all-builds").click();
  await expect(b.getByTestId("hero-build")).toHaveCount(0);
  await expect(following(b)).toHaveCount(1);
});
