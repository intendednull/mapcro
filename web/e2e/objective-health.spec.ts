// Objective health editing in Scenes (GitHub #55; docs/specs/objective-health-edit.md):
// direct vertical click-and-drag scrub, live radial dial & readout, < 6 px 1-click toggle,
// drag-to-0% destroy & upward-drag revive, right-click obj-menu presets & Patron stages,
// showHealth auto-enable, reload persistence, Ctrl+Z / Ctrl+Y undo/redo, and .mapcro round-trip.

import { type Locator, type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const marker = (p: Page, key: string) => p.locator(`.mapbox .mk[data-key="${key}"]`);

async function centre(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

test("vertical drag scrubs objective health with live preview, persists across reload, syncs to peers, and undoes/redoes cleanly", async ({ browser }) => {
  const url = await newBoardUrl(server, "Obj Health Drag");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");

  const walkerKey = "walker:sapphire:lane6:1";
  const wA = marker(a, walkerKey);
  const wB = marker(b, walkerKey);
  const c = await centre(wA);

  // Drag DOWN by 36 CSS px (dyPx = -36 => 100 - (36/80)*100 = 55%).
  await a.mouse.move(c.x, c.y);
  await a.mouse.down();
  await a.mouse.move(c.x, c.y + 36, { steps: 6 });

  // Live zero-lag preview during drag: data-adjusting, data-health, radial dial, and §4b readout pill.
  await expect(wA).toHaveAttribute("data-adjusting", "true");
  await expect(wA).toHaveAttribute("data-health", "55");
  await expect(a.getByTestId("obj-hp-dial")).toHaveAttribute("data-key", walkerKey);
  await expect(a.getByTestId("obj-hp-dial")).toHaveAttribute("data-pct", "55");
  await expect(a.getByTestId("hover-label")).toHaveText("Walker · 55%");

  await a.mouse.up();
  await expect(wA).not.toHaveAttribute("data-adjusting", "true");
  await expect(a.getByTestId("obj-hp-dial")).toHaveCount(0);
  await expect(wA).toHaveAttribute("data-status", "Active");
  await expect(wA).toHaveAttribute("data-health", "55");

  // Live sync to Coach B.
  await expect(wB).toHaveAttribute("data-health", "55");

  // Ctrl+Z undoes in 1 step; Ctrl+Y redoes in 1 step.
  await a.keyboard.press("Control+z");
  await expect(wA).not.toHaveAttribute("data-health", /.+/);
  await expect(wB).not.toHaveAttribute("data-health", /.+/);
  await a.keyboard.press("Control+y");
  await expect(wA).toHaveAttribute("data-health", "55");
  await expect(wB).toHaveAttribute("data-health", "55");

  // Reload persistence.
  await a.reload();
  await expect(marker(a, walkerKey)).toHaveAttribute("data-health", "55");

  // Shift-snap to 5% increments while dragging: start at 55%, drag down 23 px => 55 - 28.75 = 26.25 (26% unsnapped, 25% with Shift).
  const c2 = await centre(marker(a, walkerKey));
  await a.mouse.move(c2.x, c2.y);
  await a.mouse.down();
  await a.keyboard.down("Shift");
  await a.mouse.move(c2.x, c2.y + 23, { steps: 4 });
  await expect(a.getByTestId("hover-label")).toHaveText("Walker · 25%");
  await a.mouse.up();
  await a.keyboard.up("Shift");
  await expect(marker(a, walkerKey)).toHaveAttribute("data-health", "25");
});

test("short click (< 6 px) preserves 1-click Destroyed <-> Active toggle and clears stale health; drag to 0% destroys and upward drag revives", async ({ browser }) => {
  const url = await newBoardUrl(server, "Obj Health Toggle & Revive");
  const a = await joinNew(browser, url, "Coach");

  const walkerKey = "walker:sapphire:lane6:1";
  const w = marker(a, walkerKey);
  const wc = await centre(w);

  // Set walker to 55% first via vertical drag.
  await a.mouse.move(wc.x, wc.y);
  await a.mouse.down();
  await a.mouse.move(wc.x, wc.y + 36, { steps: 4 });
  await a.mouse.up();
  await expect(w).toHaveAttribute("data-health", "55");

  // Short click (< 6 px travel) toggles to Destroyed, clearing stale health.
  await a.mouse.move(wc.x, wc.y);
  await a.mouse.down();
  await a.mouse.move(wc.x, wc.y + 2);
  await a.mouse.up();
  await expect(w).toHaveAttribute("data-status", "Destroyed");
  await expect(w).not.toHaveAttribute("data-health", /.+/);

  // Second short click revives cleanly at 100% (stale 55% is gone).
  await a.mouse.click(wc.x, wc.y);
  await expect(w).toHaveAttribute("data-status", "Active");
  await expect(w).toHaveAttribute("data-health", "100");

  // Guardian: drag all the way down (>= 80 px) to 0% -> marks Destroyed (D1).
  const guardKey = "guardian:amber:lane4:1";
  const g = marker(a, guardKey);
  const gc = await centre(g);
  await a.mouse.move(gc.x, gc.y);
  await a.mouse.down();
  await a.mouse.move(gc.x, gc.y + 90, { steps: 6 });
  await expect(a.getByTestId("hover-label")).toHaveText("Guardian · Destroyed");
  await expect(g).toHaveAttribute("data-status", "Destroyed");
  await a.mouse.up();
  await expect(g).toHaveAttribute("data-status", "Destroyed");
  await expect(g).not.toHaveAttribute("data-health", /.+/);

  // Drag UPWARD on Destroyed Guardian by 48 px (48/80 * 100 = 60%) -> revives live at 60%!
  await a.mouse.move(gc.x, gc.y);
  await a.mouse.down();
  await a.mouse.move(gc.x, gc.y - 48, { steps: 6 });
  await expect(g).toHaveAttribute("data-status", "Active");
  await expect(g).toHaveAttribute("data-health", "60");
  await expect(a.getByTestId("hover-label")).toHaveText("Guardian · 60%");
  await a.mouse.up();
  await expect(g).toHaveAttribute("data-status", "Active");
  await expect(g).toHaveAttribute("data-health", "60");

  // Patron: 1-click into Stage 2, then vertical drag down preserves Stage2 with "Patron (Weakened) · 55%" readout;
  // dragging to 0% destroys Patron, and dragging upward revives it cleanly into Stage 1 (Active).
  const patronKey = "patron:amber:lane0:1";
  const p = marker(a, patronKey);
  const pc = await centre(p);
  await a.mouse.click(pc.x, pc.y);
  await expect(p).toHaveAttribute("data-status", "Stage2");

  await a.mouse.move(pc.x, pc.y);
  await a.mouse.down();
  await a.mouse.move(pc.x, pc.y + 36, { steps: 6 });
  await expect(p).toHaveAttribute("data-status", "Stage2");
  await expect(p).toHaveAttribute("data-health", "55");
  await expect(a.getByTestId("hover-label")).toHaveText("Patron (Weakened) · 55%");
  await a.mouse.up();
  await expect(p).toHaveAttribute("data-status", "Stage2");
  await expect(p).toHaveAttribute("data-health", "55");

  // Drag Stage 2 Patron to 0% -> Destroyed, then drag upward 48 px -> revives as Stage 1 (Active) at 60%.
  await a.mouse.move(pc.x, pc.y);
  await a.mouse.down();
  await a.mouse.move(pc.x, pc.y + 60, { steps: 6 });
  await expect(a.getByTestId("hover-label")).toHaveText("Patron · Destroyed");
  await a.mouse.up();
  await expect(p).toHaveAttribute("data-status", "Destroyed");

  await a.mouse.move(pc.x, pc.y);
  await a.mouse.down();
  await a.mouse.move(pc.x, pc.y - 48, { steps: 6 });
  await expect(p).toHaveAttribute("data-status", "Active");
  await expect(p).toHaveAttribute("data-health", "60");
  await expect(a.getByTestId("hover-label")).toHaveText("Patron · 60%");
  await a.mouse.up();
  await expect(p).toHaveAttribute("data-status", "Active");
  await expect(p).toHaveAttribute("data-health", "60");
});

test("right-click obj-menu presets, Patron Stage 2, Mid-Boss Cleared/revive, showHealth auto-enable, and .mapcro export/import round-trip", async ({ browser }) => {
  const url = await newBoardUrl(server, "Obj Health Menu & Export");
  const a = await joinNew(browser, url, "Coach");

  const walkerKey = "walker:amber:lane1:1";
  const patronKey = "patron:sapphire:lane0:1";
  const bossKey = "mid_boss:neutral:lane0:1";

  // 1. Right-click Walker -> set 75%, then toggle Health bars & arcs OFF in Map layers, then set 50% -> auto-enables showHealth!
  const wc = await centre(marker(a, walkerKey));
  await a.mouse.click(wc.x, wc.y, { button: "right" });
  const menu = a.getByTestId("obj-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("aria-label", "Walker");
  await menu.getByTestId("obj-menu-hp-75").click();
  await expect(marker(a, walkerKey)).toHaveAttribute("data-health", "75");

  // Toggle Health bars & arcs OFF in Map layers.
  await a.getByTestId("map-layers-toggle").click();
  await expect(a.getByTestId("health-toggle")).toHaveAttribute("aria-pressed", "true");
  await a.getByTestId("health-toggle").click();
  await expect(a.getByTestId("health-toggle")).toHaveAttribute("aria-pressed", "false");
  await a.keyboard.press("Escape");
  await expect(marker(a, walkerKey)).not.toHaveAttribute("data-health", /.+/);

  // Edit objective health via obj-menu -> auto-enables showHealth so the edit is immediately visible!
  await a.mouse.click(wc.x, wc.y, { button: "right" });
  await a.getByTestId("obj-menu-hp-50").click();
  await expect(marker(a, walkerKey)).toHaveAttribute("data-health", "50");

  // 2. Right-click Sapphire Patron (Archmother) -> Stage 2 (Weakened) · 100%, then 25% in Stage 2.
  const pc = await centre(marker(a, patronKey));
  await a.mouse.click(pc.x, pc.y, { button: "right" });
  await expect(a.getByTestId("obj-menu")).toHaveAttribute("aria-label", "Archmother");
  await expect(a.getByTestId("obj-menu-stage1")).toHaveText("Stage 1 · 100%");
  await expect(a.getByTestId("obj-menu-stage2")).toHaveText("Stage 2 (Weakened) · 100%");
  await a.getByTestId("obj-menu-stage2").click();
  await expect(marker(a, patronKey)).toHaveAttribute("data-status", "Stage2");
  await expect(marker(a, patronKey)).toHaveAttribute("data-health", "100");

  await a.mouse.click(pc.x, pc.y, { button: "right" });
  await a.getByTestId("obj-menu-hp-25").click();
  await expect(marker(a, patronKey)).toHaveAttribute("data-status", "Stage2");
  await expect(marker(a, patronKey)).toHaveAttribute("data-health", "25");

  // 3. Right-click Mid-Boss -> Cleared, then revive to 75%.
  const bc = await centre(marker(a, bossKey));
  await a.mouse.click(bc.x, bc.y, { button: "right" });
  await expect(a.getByTestId("obj-menu")).toHaveAttribute("aria-label", "Mid-Boss");
  await expect(a.getByTestId("obj-menu-destroyed")).toHaveText("Cleared");
  await a.getByTestId("obj-menu-destroyed").click();
  await expect(marker(a, bossKey)).toHaveAttribute("data-status", "Destroyed");

  await a.mouse.click(bc.x, bc.y, { button: "right" });
  await a.getByTestId("obj-menu-hp-75").click();
  await expect(marker(a, bossKey)).toHaveAttribute("data-status", "Active");
  await expect(marker(a, bossKey)).toHaveAttribute("data-health", "75");

  // 4. `.mapcro` export & import round-trip preserves all edited objective health & Patron Stage 2.
  const m = url.match(/\/b\/([^#]+)#(.+)$/)!;
  const expRes = await fetch(`${server.url}/api/boards/${m[1]}/export`, {
    headers: { authorization: `Bearer ${m[2]}` },
  });
  expect(expRes.status).toBe(200);
  const exported = await expRes.json();

  const impRes = await fetch(`${server.url}/api/boards/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(exported),
  });
  expect(impRes.status).toBe(201);
  const imported = (await impRes.json()) as { board: string; owner_token: string };

  const b = await joinNew(browser, `${server.url}/b/${imported.board}#${imported.owner_token}`, "Scout");
  await expect(marker(b, walkerKey)).toHaveAttribute("data-health", "50");
  await expect(marker(b, patronKey)).toHaveAttribute("data-status", "Stage2");
  await expect(marker(b, patronKey)).toHaveAttribute("data-health", "25");
  await expect(marker(b, bossKey)).toHaveAttribute("data-status", "Active");
  await expect(marker(b, bossKey)).toHaveAttribute("data-health", "75");
});
