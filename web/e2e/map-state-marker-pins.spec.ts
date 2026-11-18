// The markers and the two bars, pinned before map-state phase 4 moves them onto `MapState`
// (docs/specs/map-state.md §9): what each draws, frame by frame, in Player under the viewer's
// choices, and in a scene from its stored statuses and names. The fixture is synthetic: no
// player's name, id or game art. A change that means to move a pin says so in its commit.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls, viewLink } from "./helpers";
import { outline } from "./outline";
import { ROOT, Server, TIMELINE_FORMAT, newBoardUrl } from "./server";
import { heroPack } from "./synthetic";

const ID = "129000177";
const N = 120;
const RIFT_W = "rift:neutral:lane1:1";
const RIFT_E = "rift:neutral:lane6:1";
const URN_W = "urn:neutral:lane1:1";
const URN_E = "urn:neutral:lane6:1";
const BUFF_W = "powerup:neutral:lane1:1";
const BUFF_E = "powerup:neutral:lane6:1";
const CAMP = "camp:neutral:lane0:3";
const BOSS = "mid_boss:neutral:lane0:1";
const WALKER = "walker:amber:lane1:1";
const GUARDIAN = "guardian:amber:lane1:1";
const PATRON = "patron:amber:lane0:1";
const SHOP = "shop:amber:lane1:1";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-marker-pins-"));
let upstream: ReturnType<typeof createServer>;
let upstreamPort = 0;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  upstreamPort = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${upstreamPort}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "20" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
const upWhile = (spans: Array<[number, number]>) => range((s) => (spans.some(([a, b]) => s >= a && s < b) ? 1 : 0));

/**
 * Amber 1 dies at 20 (seen; back at 35). Sapphire 1 dies at 60, out of Amber's sight (back at 72).
 * Sapphire 2 is out of Amber's sight from 48 and carries the urn from 40 to 65. Amber 3 is low on
 * health. The guardian falls at 10; the patron is on its core from 70.
 */
function timeline() {
  const dead = (team: string, slot: number, s: number) => (team === "amber" && slot === 1 && s >= 20 && s < 35) || (team === "sapphire" && slot === 1 && s >= 60 && s < 72);
  const sight = (team: string, slot: number): Array<[number, number]> => (team === "amber" ? [[0, N * 10]] : slot === 2 ? [[0, 480]] : slot === 1 ? [[0, 200]] : [[0, N * 10]]);
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: `Pilot ${team[0]}${slot}`,
        x: range((s) => (dead(team, slot, s) ? null : slot * 1500 - 4000 + s * 10)),
        y: range((s) => (dead(team, slot, s) ? null : team === "amber" ? -3000 : 3000)),
        health: range((s) => (dead(team, slot, s) ? 0 : team === "amber" && slot === 3 ? 20 : 100 - slot * 10)),
        deaths: team === "amber" && slot === 1 ? [20] : team === "sapphire" && slot === 1 ? [60] : [],
        respawn: team === "amber" && slot === 1 ? [[20, 35]] : team === "sapphire" && slot === 1 ? [[60, 72]] : [],
        souls: [[0, 500 + slot * 100], [15, 2500 + slot * 300]], ult: range((s) => (s < 12 ? 100 - s * 8 : slot === 4 ? 40 : 0)),
        seen: sight(team, slot),
        level: [[0, 1], [10, 3 + slot]],
        items: [], abilities: [], casts: [], charges: [], cc: [], effects: [], recaps: [],
      })),
    ),
    objectives: [{ key: GUARDIAN, kind: "guardian", team: "amber", lane: 1, destroyed_s: 10 }],
    objective_health: [
      { key: WALKER, at: [[0, 100], [50, 62]] },
      { key: PATRON, at: [[0, 100], [50, 80], [70, 100], [90, 40]], stage: [[0, 1], [70, 2]] },
    ],
    mid_boss: [{ destroyed_s: 20, team_killed: "unknown" }],
    rifts: [
      { key: RIFT_W, start_s: 10, end_s: 82, live_s: 40, give_up_s: 100, capture: [[400, 0, 0], [500, 50, 20], [600, 50, 60], [770, 60, 100], [815, 60, 100]] },
      { key: RIFT_E, start_s: 100, end_s: 118, live_s: 110 },
    ],
    powerups: [
      { key: BUFF_W, available: upWhile([[10, 30], [80, 121]]), stale: [], spawns: [{ t: 10, buff: "gun", taken_s: 30 }, { t: 80, buff: "casting" }] },
      { key: BUFF_E, available: upWhile([[10, 12]]), stale: [], spawns: [{ t: 10, buff: "survival", taken_s: 12 }] },
    ],
    zips: [],
    camps: [
      { key: CAMP, first_s: 30, cleared: [[50, 90]] },
      { key: BOSS, first_s: 0, cleared: [[20, 100]] },
    ],
    rejuv: [{ team: "sapphire", taken_s: 30, ends_s: 200, left: [[30, 3], [57, 2]] }],
    urn: {
      spawns: [{ t: 10, key: URN_W }, { t: 110, key: URN_E }],
      at: [
        { t: 10, state: "ground", x: -6584, y: 0 },
        { t: 12, state: "ground", x: -6584, y: 0, delivery: URN_E },
        { t: 40, state: "carried", team: "sapphire", slot: 2, delivery: URN_E },
        { t: 65, state: "ground", x: 2000, y: 500, team: "sapphire", delivery: URN_E },
        { t: 90, state: "none" },
      ],
    },
    events: [],
  };
}

async function openMatch(p: Page, dir = queue) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(dir, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(dir, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}

const pressed = async (p: Page, id: string) => (await p.getByTestId(id).getAttribute("aria-pressed")) === "true";
/** Set a Map layers toggle. */
async function toggle(p: Page, id: string, on: boolean) {
  await revealControls(p, id);
  if ((await pressed(p, id)) !== on) await p.getByTestId(id).click();
}
async function view(p: Page, team: "all" | "amber" | "sapphire", lastSeen = false) {
  await p.getByTestId("vision-select").selectOption(team);
  // Offered in a team's view, beside the select.
  if (team !== "all" && (await pressed(p, "last-seen-toggle")) !== lastSeen) await p.getByTestId("last-seen-toggle").click();
}

/** What each marker's hover says at this moment ("-": nothing), and the urn's where it lies. */
async function tips(p: Page, keys: string[]): Promise<string> {
  const lines: string[] = [];
  const said = async () => ((await p.getByTestId("hover-label").count()) ? await p.getByTestId("hover-label").first().textContent() : "-");
  for (const key of keys) {
    const marker = p.locator(`[data-testid=map] .mk[data-key="${key}"]`);
    if (!(await marker.count())) {
      lines.push(`${key}: not drawn`);
      continue;
    }
    const b = (await marker.boundingBox())!;
    await p.mouse.move(2, 2);
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.waitForTimeout(120);
    lines.push(`${key}: ${await said()}`);
  }
  const urn = p.locator("[data-testid=map] [data-testid=urn]");
  if (await urn.count()) {
    const b = (await urn.boundingBox())!;
    await p.mouse.move(2, 2);
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.waitForTimeout(120);
    lines.push(`the urn: ${await said()}`);
  }
  await p.mouse.move(2, 2);
  return lines.join("\n") + "\n";
}
const TIPPED = [RIFT_W, RIFT_E, URN_W, URN_E, BUFF_W, BUFF_E, CAMP, BOSS, WALKER, GUARDIAN, PATRON];

test("Player's markers and bar, frame by frame under the viewer's choices", async ({ browser }) => {
  test.setTimeout(180_000);
  const p = await joinNew(browser, await newBoardUrl(server, "Marker pins"), "Coach");
  await openMatch(p);
  const frame = async (name: string, t: number) => {
    await scrubTo(p, t);
    await expect(p.getByTestId("match-clock")).toContainText(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")} /`);
    expect(await outline(p, "topbar")).toMatchSnapshot(`${name}-bar.txt`);
    expect(await outline(p, "map")).toMatchSnapshot(`${name}-map.txt`);
    expect(await tips(p, TIPPED)).toMatchSnapshot(`${name}-tips.txt`);
  };
  // One dead with its respawn, the boss down, the urn on the ground, a rift announced.
  await frame("all-25", 25);
  // The urn on an enemy out of the King's sight: not drawn, with or without its ghost.
  await view(p, "amber", false);
  await frame("king-55", 55);
  await view(p, "amber", true);
  await frame("king-last-seen-55", 55);
  // A death the King didn't see: no skull in his view, and one in All.
  await frame("king-last-seen-61", 61);
  await view(p, "all");
  await frame("all-61", 61);
  // The rift's capture, the Rejuvenator, the patron's core.
  await view(p, "sapphire", false);
  await frame("archmother-75", 75);
  await toggle(p, "health-toggle", false);
  await frame("no-health-75", 75);
  await toggle(p, "health-toggle", true);
  await toggle(p, "names-toggle", false);
  await view(p, "all");
  await frame("no-names-95", 95);
});

test("a portrait's focus goes where the viewer's frame draws the hero", async ({ browser }) => {
  const p = await joinNew(browser, await newBoardUrl(server, "Focus pins"), "Coach");
  await openMatch(p);
  await scrubTo(p, 55);
  await expect(p.getByTestId("match-clock")).toContainText("0:55 /");
  const focus = () => p.locator('.tb-player[data-slot="Sapphire-2"] [data-testid=focus-hero]').click();
  const pings = p.locator(".mapbox .ping");
  // Out of the King's sight, no last-seen spot shown: nowhere to go (a ping would show by now).
  await view(p, "amber", false);
  await focus();
  await p.waitForTimeout(900);
  await expect(pings).toHaveCount(0);
  await p.keyboard.press("Escape");
  // Its ghost: pinged where the King last saw it.
  await view(p, "amber", true);
  await focus();
  await expect(pings).toHaveCount(1);
  const ghost = await p.locator('.mapbox .tok[data-slot="Sapphire-2"]').boundingBox();
  const ping = await pings.boundingBox();
  expect(Math.hypot(ping!.x + ping!.width / 2 - (ghost!.x + ghost!.width / 2), ping!.y + ping!.height / 2 - (ghost!.y + ghost!.height / 2))).toBeLessThan(ghost!.width);
});

test("a skull shows its hero's portrait", async ({ browser }) => {
  const dir = mkdtempSync(join(tmpdir(), "mapcro-e2e-marker-pins-pack-"));
  const packed = new Server(heroPack(14), { MATCH_API_BASE: `http://127.0.0.1:${upstreamPort}`, REPLAY_DIR: dir, REPLAY_PER_CLIENT_PER_HOUR: "20" });
  await packed.start();
  try {
    const p = await joinNew(browser, await newBoardUrl(packed, "Skull portrait"), "Coach");
    await openMatch(p, dir);
    await scrubTo(p, 61);
    await expect(p.locator("[data-testid=death-skull] .pl-fallen-portrait")).toHaveCount(1);
  } finally {
    packed.stop();
  }
});

type Rec = [string, Record<string, Record<string, unknown>>];
const hex = (n: number) => n.toString(16).padStart(32, "0");

/** A board with one scene saved from this match: a typed name on one slot, one hero dead, one out
 * of sight, and a status stored on one marker of each kind. */
function boardFile() {
  const f = JSON.parse(readFileSync(join(ROOT, "crates/server/tests/fixtures/board-file-v1-oldest-records.mapcro.json")).toString()) as { records: Rec[] };
  const slots = f.records.filter((r) => r[1].RosterSlot);
  slots.forEach((r, i) => (r[1].RosterSlot!.hero = 1 + (i % 6)));
  slots[3]![1].RosterSlot!.name = "Typed name";
  const scene = hex(0xaaa);
  f.records.push([scene, { Scene: { name: "Match moment", order: "s", clock: 55, source: { match_id: Number(ID), t: 55, tier: "replay" } } }]);
  slots.forEach((r, i) => {
    const state = { scene, slot: r[0], pos: { x: -4000 + i * 700, y: i < 6 ? -2500 : 2500 }, alive: i !== 2, placed: true, souls: 3000 + 450 * i, ult_cooldown: i % 3 === 0 ? 0 : 40, visible: i !== 7 };
    f.records.push([hex(0xb00 + i), { PlayerState: state }]);
  });
  const stored: Array<[string, string]> = [[RIFT_W, "Active"], [URN_E, "Active"], [BUFF_W, "Destroyed"], [CAMP, "Hidden"], [BOSS, "Destroyed"], [WALKER, "Hidden"], [GUARDIAN, "Destroyed"], [PATRON, "Stage2"], [SHOP, "Hidden"]];
  stored.forEach(([key, status], i) => f.records.push([hex(0xc00 + i), { ObjectiveState: { scene, key, status } }]));
  return f;
}

async function seed(file: unknown): Promise<string> {
  const r = await fetch(`${server.url}/api/boards/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(file) });
  expect(r.status).toBe(201);
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  return `${server.url}/b/${board}#${owner_token}`;
}

test("a scene's portrait focuses its hero, dead or alive", async ({ browser }) => {
  const f = boardFile();
  const roster = f.records.filter((r) => r[1].RosterSlot)[2]![1].RosterSlot! as { team: string; slot: number };
  const p = await joinNew(browser, await seed(f), "Coach");
  await p.getByTestId("scene-card").nth(1).click();
  await expect(p.getByTestId("tb-clock")).toHaveText("0:55");
  await expect(p.locator(`.tb-player.dead[data-slot="${roster.team}-${roster.slot}"]`)).toHaveCount(1);
  await p.locator(`.tb-player[data-slot="${roster.team}-${roster.slot}"] [data-testid=focus-hero]`).click();
  await expect(p.locator(".mapbox .ping")).toHaveCount(1);
});

test("a saved scene's portrait menu knows the hero the scene holds, whatever the roster has", async ({ browser }) => {
  const p = await joinNew(browser, await newBoardUrl(server, "Scene heroes"), "Coach");
  await openMatch(p);
  await scrubTo(p, 55);
  await expect(p.getByTestId("match-clock")).toContainText("0:55 /");
  await p.getByTestId("match-save").click();
  await expect(p.locator(".pl-topbar")).toHaveCount(0);
  await p.locator('.tb-player[data-slot="Amber-1"]').click({ button: "right" });
  await expect(p.getByTestId("hero-menu-hero")).toHaveText("Change hero…");
  await expect(p.getByTestId("hero-menu-focus")).toHaveCount(0);
});

test("a scene's markers and bar: its stored statuses, for an editor and a viewer", async ({ browser }) => {
  const url = await seed(boardFile());
  const p = await joinNew(browser, url, "Coach");
  await p.getByTestId("scene-card").nth(1).click();
  await expect(p.getByTestId("tb-clock")).toHaveText("0:55");
  expect(await outline(p, "topbar")).toMatchSnapshot("scene-editor-bar.txt");
  expect(await outline(p, "map")).toMatchSnapshot("scene-editor-map.txt");
  expect(await tips(p, TIPPED)).toMatchSnapshot("scene-editor-tips.txt");
  const v = await joinNew(browser, await viewLink(server.url, url), "Guest");
  await v.getByTestId("scene-card").nth(1).click();
  await expect(v.getByTestId("tb-clock")).toHaveText("0:55");
  expect(await outline(v, "map")).toMatchSnapshot("scene-viewer-map.txt");
});

test("a scene's bar names a slot as its token does: typed, the open match's, and Names off", async ({ browser }) => {
  const p = await joinNew(browser, await seed(boardFile()), "Coach");
  await openMatch(p);
  const open = async () => {
    await p.getByTestId("scene-card").nth(1).click();
    await expect(p.getByTestId("tb-clock")).toHaveText("0:55");
  };
  /** Each slot's name, as the portrait and the token say it. */
  const names = () =>
    p.evaluate(() =>
      [...document.querySelectorAll(".tb-player[data-slot]")].map((el) => {
        const slot = el.getAttribute("data-slot")!;
        const token = document.querySelector(`.mapbox .tok[data-slot="${slot}"]`);
        return `${slot}: ${el.getAttribute("title") ?? ""} | ${token?.getAttribute("aria-label") ?? ""}`;
      }).sort().join("\n") + "\n",
    );
  await open();
  expect(await names()).toMatchSnapshot("scene-names-on.txt");
  expect(await outline(p, "topbar")).toMatchSnapshot("scene-names-on-bar.txt");
  await p.getByTestId("mode-player").click();
  await toggle(p, "names-toggle", false);
  await open();
  expect(await names()).toMatchSnapshot("scene-names-off.txt");
  expect(await outline(p, "topbar")).toMatchSnapshot("scene-names-off-bar.txt");
});

test("a scene's own name is a typed name: the bar and the token say it, with Names on or off (TD-120)", async ({ browser }) => {
  const f = boardFile();
  // One slot with no typed name, and one whose own name wins over the typed one.
  const label = (i: number) => {
    const own = f.records.find((r) => r[0] === hex(0xb00 + i))![1].PlayerState! as { slot: string; more?: unknown };
    own.more = { name: "Own name" };
    const roster = f.records.find((r) => r[0] === own.slot)![1].RosterSlot! as { team: string; slot: number };
    return `${roster.team}-${roster.slot}`;
  };
  const slots = [label(5), label(3)];
  const p = await joinNew(browser, await seed(f), "Coach");
  await openMatch(p);
  const open = async () => {
    await p.getByTestId("scene-card").nth(1).click();
    await expect(p.getByTestId("tb-clock")).toHaveText("0:55");
  };
  const said = async () => {
    for (const slot of slots) {
      await expect(p.locator(`.tb-player[data-slot="${slot}"]`)).toHaveAttribute("title", /^Own name/);
      await expect(p.locator(`.tb-player[data-slot="${slot}"] [data-testid=tb-name]`)).toHaveText("Own name");
      await expect(p.locator(`.mapbox .tok[data-slot="${slot}"]`)).toHaveAttribute("aria-label", /^Own name/);
    }
  };
  await open();
  await said();
  await p.getByTestId("mode-player").click();
  await toggle(p, "names-toggle", false);
  await open();
  await said();
});
