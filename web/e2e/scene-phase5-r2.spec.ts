// Map-state phase 5, Release R2 (Writer A, store v16, docs/specs/map-state-phase5-plan.md §5 & §8):
// - saved scene at an unseen-enemy moment under every Vision × Show last seen (6 combinations):
//   faded under enemy Vision, unfaded under All, never hidden, zero ghosts, Show last seen is a DOM no-op;
// - "Mark not seen" / "Mark in vision" (`hero-menu-vision`) in a `has_sight` scene under All vs enemy Vision (Q2);
// - scene token health arc (`tok-health`) under Health, absent on dead/faded heroes and pre-SceneState scenes (Q3);
// - static death skull in a saved scene, clicking opens no recap (Q5);
// - dragged lane split keeps zipline colours following the dragged split (Q7);
// - `MapControls` (Health, CC, Movement, Vision select, VisionMark, `1`/`2`/`3` keys) work on an
//   exported/imported R2 scene with NO match open on the board (TD-162).

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129000162";
const N = 40;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-phase5-r2-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "50" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/** Synthetic 6v6 replay at t=15:
 * - Amber-1 & Sapphire-1 seen by enemies (`[100, 198]`); all other slots unseen at t=15
 * - Sapphire-0 stunned (cc), elevated (height 1) and on zipline at t=15
 * - Amber-2 died at t=14 (dead at t=15, static skull < 2.5s old)
 * - lane4 zipline edges [300, 500] (midpoint 400, gap 200)
 */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const a2 = team === "amber" && slot === 2;
        const s0 = team === "sapphire" && slot === 0;
        const dead = (s: number) => a2 && s >= 14 && s < 24;
        const at = { x: slot * 1400 - 3500, y: team === "amber" ? -2800 : 2800 };
        return {
          team, slot, hero_id: 1 + slot, name: null,
          x: range((s) => (dead(s) ? null : at.x)),
          y: range((s) => (dead(s) ? null : at.y)),
          health: range((s) => (dead(s) ? 0 : 100 - slot * 10)),
          deaths: a2 ? [14] : [],
          respawn: a2 ? [[14, 24]] : [],
          souls: [[0, 600 + slot * 100]], ult: range(() => 0),
          seen: slot === 1 ? [[100, 198]] : [],
          level: [[0, 3]],
          items: [[50, 715_762_406, 0]],
          abilities: [], casts: [], charges: [], effects: [],
          cc: s0 ? [[100, 200, 20, 255, 0]] : [],
          height: s0 ? [[0, 1]] : [],
          zipline: s0 ? [[10, 20]] : [],
          recaps: a2 ? [{ t: 140, damage: [[1, 0, 800]], cc: [] }] : [],
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [],
    zips: [
      { lane: "lane1", at: [[0, 500, 500]] },
      { lane: "lane4", at: [[0, 300, 500]] },
      { lane: "lane6", at: [[0, 450, 550]] },
    ],
    events: [{ t: 14, kind: "death", team: "amber", slot: 2, hero_id: 3, x: -700, y: -2800 }],
  };
}

const answered = new Set<string>();
async function openMatch(p: Page) {
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
  await p.getByTestId("match-time").evaluate((el, sec) => {
    (el as HTMLInputElement).value = String(sec);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(t).padStart(2, "0")} /`);
}

async function saveAt15(p: Page) {
  await openMatch(p);
  await scrubTo(p, 15);
  await p.getByTestId("match-save").click();
  await expect(p.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
}

async function seed(file: unknown): Promise<string> {
  const r = await fetch(`${server.url}/api/boards/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(file) });
  expect(r.status).toBe(201);
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  return `${server.url}/b/${board}#${owner_token}`;
}

const tok = (p: Page, slot: string) => p.locator(`[data-testid=map] .tok[data-slot="${slot}"]`);
const portrait = (p: Page, slot: string) => p.locator(`.tb-player[data-slot="${slot}"]`);
const tokenSnapshot = (p: Page) =>
  p.locator("[data-testid=map] .tok[data-slot]").evaluateAll((els) =>
    els.map((e) => ({
      slot: e.getAttribute("data-slot"),
      visible: e.getAttribute("data-visible"),
      transform: e.getAttribute("transform"),
      health: !!e.querySelector("[data-testid=tok-health]"),
      unseen: !!e.querySelector("[data-testid=unseen-mark]"),
    })),
  );

test("R2 saved scene: Vision × Show last seen (6 combos), health arcs (Q3), static skulls (Q5) and Mark not seen (Q2)", async ({ browser }) => {
  const p = await joinNew(browser, await newBoardUrl(server, "R2 Vision & Q2/Q3/Q5"), "Coach");
  await saveAt15(p);

  // Vision × Show last seen across all 6 combinations.
  for (const vision of ["all", "amber", "sapphire"] as const) {
    await p.getByTestId("vision-select").selectOption(vision);
    await expect(p.getByTestId("vision-select")).toHaveValue(vision);
    const snapOff = await tokenSnapshot(p);
    expect(snapOff).toHaveLength(12);
    await expect(p.locator("[data-testid=map] .tok[data-echo]")).toHaveCount(0);

    if (vision === "all") {
      expect(snapOff.every((x) => x.visible === "true" && !x.unseen)).toBe(true);
      // 11 living heroes show health arcs (Amber-2 is dead at t=15).
      expect(snapOff.filter((x) => x.health)).toHaveLength(11);
      expect(snapOff.find((x) => x.slot === "Amber-2")!.health).toBe(false);
    } else if (vision === "sapphire") {
      // Amber-1 is seen by Sapphire; Amber-0,2,3,4,5 are unseen (faded, no health arc); all Sapphire seen.
      expect(snapOff.find((x) => x.slot === "Amber-0")).toMatchObject({ visible: "false", unseen: true, health: false });
      expect(snapOff.find((x) => x.slot === "Amber-1")).toMatchObject({ visible: "true", unseen: false, health: true });
      expect(snapOff.find((x) => x.slot === "Sapphire-0")).toMatchObject({ visible: "true", unseen: false, health: true });
      // Toggle Show last seen: DOM no-op on tokens, zero ghosts.
      const toggle = p.getByTestId("last-seen-toggle");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(p.locator("[data-testid=map] .tok[data-echo]")).toHaveCount(0);
      expect(await tokenSnapshot(p)).toEqual(snapOff);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
    } else {
      // Amber vision: Sapphire-1 seen, Sapphire-0 unseen (faded, no health arc); all Amber seen (Amber-2 dead).
      expect(snapOff.find((x) => x.slot === "Sapphire-0")).toMatchObject({ visible: "false", unseen: true, health: false });
      expect(snapOff.find((x) => x.slot === "Sapphire-1")).toMatchObject({ visible: "true", unseen: false, health: true });
      expect(snapOff.find((x) => x.slot === "Amber-0")).toMatchObject({ visible: "true", unseen: false, health: true });
      const toggle = p.getByTestId("last-seen-toggle");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await expect(p.locator("[data-testid=map] .tok[data-echo]")).toHaveCount(0);
      expect(await tokenSnapshot(p)).toEqual(snapOff);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
    }
  }

  // Q5: static death skull renders for Amber-2's death at t=14, and clicking opens no recap.
  const skull = p.locator('[data-testid=map] [data-testid=death-skull][data-slot="amber-2"]');
  await expect(skull).toHaveCount(1);
  await skull.click({ force: true });
  await expect(p.getByTestId("skull-recap")).toHaveCount(0);

  // Q2: "Mark not seen" on seen Amber-1 stays unfaded under Vision All, fades under enemy Vision (Sapphire).
  await p.getByTestId("vision-select").selectOption("all");
  await portrait(p, "Amber-1").click({ button: "right", position: { x: 20, y: 30 } });
  await p.getByTestId("hero-menu-vision").click();
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(tok(p, "Amber-1")).toHaveAttribute("data-visible", "true");
  await p.getByTestId("vision-select").selectOption("sapphire");
  await expect(tok(p, "Amber-1")).toHaveAttribute("data-visible", "false");
  // "Mark in vision" brings Amber-1 back into Sapphire's sight.
  await portrait(p, "Amber-1").click({ button: "right", position: { x: 20, y: 30 } });
  await p.getByTestId("hero-menu-vision").click();
  await expect(tok(p, "Amber-1")).toHaveAttribute("data-visible", "true");

  // Q3: health arc toggles with Health layer, and pre-SceneState initial scene has zero health arcs.
  await p.getByTestId("vision-select").selectOption("all");
  await revealControls(p, "health-toggle");
  await expect(p.locator("[data-testid=map] [data-testid=tok-health]")).toHaveCount(11);
  await p.getByTestId("health-toggle").click();
  await expect(p.locator("[data-testid=map] [data-testid=tok-health]")).toHaveCount(0);
  await p.getByTestId("health-toggle").click();
  await expect(p.locator("[data-testid=map] [data-testid=tok-health]")).toHaveCount(11);
  await p.getByTestId("scene-card").nth(0).click();
  await expect(p.locator("[data-testid=map] [data-testid=tok-health]")).toHaveCount(0);
});

test("R2 saved scene: dragged lane split keeps zipline colours following the split (Q7)", async ({ browser }) => {
  const p = await joinNew(browser, await newBoardUrl(server, "R2 Lane drag Q7"), "Coach");
  await saveAt15(p);

  const lane = p.locator('[data-testid=map] g[data-key="lane4"]');
  await expect(lane).toHaveAttribute("data-t", "400");
  await expect(lane).toHaveAttribute("data-amber", "300");
  await expect(lane).toHaveAttribute("data-sapphire", "500");

  // Drag the lane4 wave handle downward/upward along the center lane.
  const handle = p.getByTestId("wave-gap-lane4");
  const box = (await handle.boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 90, { steps: 8 });
  await p.mouse.up();
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const next = await lane.evaluate((el) => ({
    t: Number(el.getAttribute("data-t")),
    amber: Number(el.getAttribute("data-amber")),
    sapphire: Number(el.getAttribute("data-sapphire")),
  }));
  expect(next.t).not.toBe(400);
  // Gap width (200) stayed centred on the dragged split, clamped to [0, 1000].
  expect(next.amber).toBe(Math.max(0, Math.min(1000, next.t - 100)));
  expect(next.sapphire).toBe(Math.max(0, Math.min(1000, next.t + 100)));
});

test("TD-162: exported R2 scene with NO match on the board activates MapControls, VisionMark and 1/2/3 keys", async ({ browser }) => {
  const from = await newBoardUrl(server, "R2 No-match controls");
  const maker = await joinNew(browser, from, "Coach");
  await saveAt15(maker);
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(from)!;
  const file = (await (await fetch(`${server.url}/api/boards/${board}/export`, { headers: { authorization: `Bearer ${token}` } })).json()) as { version: number; rows: number; matches: number[] };
  expect(file.version).toBe(5);
  expect(file.rows).toBe(27);
  file.matches = [];
  await maker.close();

  const p = await joinNew(browser, await seed(file), "Coach");
  await expect(p.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await p.getByTestId("scene-card").nth(1).click();

  // MapControls (Health, CC, Movement, Vision select) are active with NO match open.
  await revealControls(p, "health-toggle");
  await expect(p.getByTestId("health-toggle")).toBeVisible();
  await expect(p.getByTestId("cc-toggle")).toBeVisible();
  await expect(p.getByTestId("movement-toggle")).toBeVisible();
  await expect(p.getByTestId("vision-select")).toBeVisible();

  // CC and Movement layers toggle badges on Sapphire-0.
  await expect(tok(p, "Sapphire-0").getByTestId("tok-cc")).toHaveCount(0);
  await p.getByTestId("cc-toggle").click();
  await expect(tok(p, "Sapphire-0").getByTestId("tok-cc")).toHaveCount(1);
  await p.getByTestId("movement-toggle").click();
  await expect(tok(p, "Sapphire-0").getByTestId("tok-height")).toHaveCount(1);
  await expect(tok(p, "Sapphire-0").getByTestId("tok-zipline")).toHaveCount(1);

  // Vision keys 1 (Amber) / 2 (Sapphire) / 3 (All) and VisionMark work without a match open.
  await p.getByTestId("map").click({ position: { x: 10, y: 10 } });
  await p.keyboard.press("1");
  await expect(p.getByTestId("vision-select")).toHaveValue("amber");
  await expect(p.getByTestId("vision-mark")).toHaveAttribute("data-team", "amber");
  await expect(tok(p, "Sapphire-0")).toHaveAttribute("data-visible", "false");
  // Faded Sapphire-0 hides CC, height, zipline and health arc.
  await expect(tok(p, "Sapphire-0").getByTestId("tok-cc")).toHaveCount(0);
  await expect(tok(p, "Sapphire-0").getByTestId("tok-height")).toHaveCount(0);

  await p.keyboard.press("2");
  await expect(p.getByTestId("vision-select")).toHaveValue("sapphire");
  await expect(p.getByTestId("vision-mark")).toHaveAttribute("data-team", "sapphire");
  await expect(tok(p, "Amber-0")).toHaveAttribute("data-visible", "false");
  await expect(tok(p, "Sapphire-0")).toHaveAttribute("data-visible", "true");
  await expect(tok(p, "Sapphire-0").getByTestId("tok-cc")).toHaveCount(1);

  await p.keyboard.press("3");
  await expect(p.getByTestId("vision-select")).toHaveValue("all");
  await expect(p.getByTestId("vision-mark")).toHaveCount(0);
  await expect(tok(p, "Amber-0")).toHaveAttribute("data-visible", "true");
});
