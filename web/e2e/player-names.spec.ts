import { revealControls } from "./helpers";
// Player names (operator, 2026-11-08): the metadata tier looks the players' public Steam names up
// once (deadlock-api's profiles, by the match's account ids, which the server never keeps) and
// shows them by the heroes: in the top bar (its portraits' hover labels, never under the bar, as
// in game), the roster, the events and the tokens' hover titles.
// The Names toggle (operator, 2026-11-08: content creators hide them for videos) hides every one,
// for this browser only. With MAPCRO_SHOT_PACKS set
// (`MAPCRO_SHOT_PACKS=~/.local/share/mapcro/packs`), the screenshots use the real art.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";
import { slotPlaceholder } from "../src/board/roster";

const ID = "130816395";
const NAMES = ["Coach", "Marrow", "Juno", "Pike", "Wren", "Ash", "Vale", "Rook", "Sable", "Tarn", "Kite", "Moss"];
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  // The trimmed fixture has no account ids: give each player a made-up one, as the API would.
  const m = JSON.parse(readFileSync(join(ROOT, `crates/server/tests/fixtures/match-${ID}-trimmed.json`)).toString());
  for (const p of m.match_info.players) p.account_id = 900000 + p.player_slot;
  const fixture = JSON.stringify(m);
  const profiles = JSON.stringify(
    m.match_info.players.map((p: { player_slot: number }) => ({ account_id: 900000 + p.player_slot, personaname: NAMES[p.player_slot - 1], profileurl: "", avatar: "", avatarmedium: "", avatarfull: "", last_updated: "2026-01-01T00:00:00Z", friends: [], matches_played_last_30d: 1 })),
  );
  upstream = createServer((req, res) => {
    if (req.url?.startsWith(`/v1/matches/${ID}/metadata`)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fixture);
    } else if (req.url?.startsWith("/v1/players/steam?account_ids=")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(profiles);
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { MATCH_API_BASE: `http://127.0.0.1:${port}` });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

test("names show by their heroes: top bar, roster, events", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Names"), "Coach");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await revealControls(a, "match-load");
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  // Slot order: the server sorts each team by player slot (1–6 Amber, 7–12 Sapphire).
  await expect(a.locator('.tb-player[data-slot="Amber-0"] [data-testid=tb-name]')).toHaveText("Coach");
  await expect(a.locator('.tb-player[data-slot="Sapphire-5"] [data-testid=tb-name]')).toHaveText("Moss");
  await expect(a.locator('.tb-player[data-slot="Amber-0"]')).toHaveAttribute("title", /^Coach(, |$)/);
  // As in game, never under the bar (operator, 2026-11-10), so never under the map either (QA
  // 2026-11-08: the map's disc covered them).
  await expect(a.locator('.tb-player[data-slot="Amber-0"] [data-testid=tb-name]')).toBeHidden();
  const covered = await a.evaluate(() => {
    const map = document.querySelector(".stage .mapfit")!;
    const top = map.getBoundingClientRect().top;
    return [...document.querySelectorAll("[data-testid=tb-name]")].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.bottom > top || map.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    }).map((n) => n.textContent);
  });
  expect(covered).toEqual([]);
  await a.getByTestId("events-search").fill("juno");
  await expect(a.getByTestId("event").first()).toContainText("Juno");
  await a.getByTestId("events-search").fill("");
  await a.screenshot({ path: "shots/player-names.png" });
});

/** A hero panel opened by a click on its token: the panel's top edge is clear of the top bar. */
async function openCard(p: import("@playwright/test").Page, slot: string) {
  const body = (await p.locator(`.tok[data-slot="${slot}"] circle.body`).boundingBox())!;
  await p.mouse.click(body.x + body.width / 2, body.y + 2);
  return p.locator(`[data-testid=hero-card][data-slot="${slot.toLowerCase()}"]`);
}

/** Every player name anywhere on the page: its text, tooltips (title attributes and SVG titles)
 * and aria-labels. */
const namesOnPage = (p: import("@playwright/test").Page) =>
  p.evaluate((names) => {
    const svgTitles = [...document.querySelectorAll("title")].map((t) => t.textContent ?? "");
    const attrs = [...document.querySelectorAll("[title], [aria-label]")].flatMap((el) => [el.getAttribute("title") ?? "", el.getAttribute("aria-label") ?? ""]);
    const all = [document.body.innerText, ...svgTitles, ...attrs].join("\n");
    return names.filter((n) => new RegExp(`\\b${n}\\b`).test(all));
  }, NAMES);

test("a token's hover label names its player; Names off hides every name, here only, and stays off", async ({ browser }) => {
  const url = await newBoardUrl(server, "Anonymous");
  const a = await joinNew(browser, url, "Viewer");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await revealControls(a, "match-load");
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  const b = await joinNew(browser, url, "Second");
  await b.getByTestId("follow-Viewer").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Viewer");

  // On (the default): the token's hover label (and aria-label) leads with the player's name (then the hero, with
  // the art).
  await revealControls(a, "names-toggle");
  const toggle = a.getByTestId("names-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(a.locator('.tok[data-slot="Amber-0"]')).toHaveAttribute("aria-label", /^Coach(, |$)/);
  await expect(a.locator('.tb-player[data-slot="Amber-0"] [data-testid=tb-name]')).toHaveText("Coach");
  await expect(a.getByTestId("event").filter({ hasText: "Juno" }).first()).toBeVisible();
  expect(await namesOnPage(a)).toEqual(expect.arrayContaining(["Coach", "Juno", "Moss"]));
  // The hero panel's header names the player when Names shows it.
  const card = await openCard(a, "Amber-0");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".tb-build-name")).toHaveText("Coach");
  await card.getByTestId("hero-card-close").click();
  await expect(card).toHaveCount(0);
  await a.screenshot({ path: "shots/player-names-on.png" });

  // Off: no name in the top bar, the events, the tokens' titles, or anywhere else on the page.
  // (The click on the token above put the revealed controls away.)
  await revealControls(a, "names-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(a.getByTestId("tb-name")).toHaveCount(0);
  await expect(a.locator('.tok[data-slot="Amber-0"]')).toHaveAttribute("aria-label", /^King 1(, |$)/);
  // The hover label says the same, without the name (map/HoverLabel.tsx).
  // Its top edge: the wave's handle sits over its middle here.
  const tb = (await a.locator('.tok[data-slot="Amber-0"] circle.body').boundingBox())!;
  await a.mouse.move(tb.x + tb.width / 2, tb.y + 2);
  await expect(a.getByTestId("hover-label")).toHaveText(/^King 1(, |$)/);
  await a.mouse.move(5, 5);
  await expect(a.getByTestId("event").first()).toBeVisible();
  expect(await namesOnPage(a)).toEqual([]);
  // The hero panel's header is never empty with Names off (feedback #50): the same placeholder
  // the token's label uses stands in, from the one function.
  const offCard = await openCard(a, "Amber-0");
  await expect(offCard).toHaveCount(1);
  await expect(offCard.locator(".tb-build-name")).toHaveText(slotPlaceholder("Amber", 0));
  await offCard.getByTestId("hero-card-close").click();
  await expect(offCard).toHaveCount(0);
  // Searching by a hidden name doesn't reveal it.
  await a.getByTestId("events-search").fill("juno");
  await expect(a.getByTestId("event")).toHaveCount(0);
  await a.getByTestId("events-search").fill("");
  await a.screenshot({ path: "shots/player-names-off.png" });

  // The follower still sees the names: the toggle is this browser's alone.
  await expect(b.locator('.tb-player[data-slot="Amber-0"] [data-testid=tb-name]')).toHaveText("Coach");
  await expect(b.getByTestId("names-toggle")).toHaveAttribute("aria-pressed", "true");

  // A reload keeps it off.
  await a.reload();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await expect(a.getByTestId("names-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(a.getByTestId("event").first()).toBeVisible();
  expect(await namesOnPage(a)).toEqual([]);

  // On again: back everywhere.
  await revealControls(a, "names-toggle");
  await a.getByTestId("names-toggle").click();
  await expect(a.locator('.tb-player[data-slot="Amber-0"] [data-testid=tb-name]')).toHaveText("Coach");
  await expect(a.locator('.tok[data-slot="Amber-0"]')).toHaveAttribute("aria-label", /^Coach(, |$)/);
  await expect(a.getByTestId("event").filter({ hasText: "Juno" }).first()).toBeVisible();
});

// Scenes on a match board (operator, 2026-11-09: "in the scene the player names are not showing"):
// a slot with no name of its own takes the open match's, in its portrait's hover label (as in
// Player, never under the bar: operator, 2026-11-10) and in its token's label, for the default
// scene and one saved from a moment; a name typed into the slot ("Rename…" in the portrait menu,
// its editor in place while open) wins. No roster in the side panel: the top bar has it all.
test("Scenes show the match's names; a typed name wins; no side roster", async ({ browser }) => {
  const url = await newBoardUrl(server, "Scene names");
  const a = await joinNew(browser, url, "Viewer");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await revealControls(a, "match-load");
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await revealControls(a, "mode-sandbox");
  await a.getByTestId("mode-sandbox").click();
  await expect(a.getByTestId("topbar").first()).not.toHaveAttribute("data-mode", "player");

  const col = (p: typeof a, slot: string) => p.locator(`.tb-player[data-slot="${slot}"]:visible`).first();
  const tok = (p: typeof a, slot: string) => p.locator(`.mapbox .tok[data-slot="${slot}"]`);
  // The default scene: names on the portraits' hover labels and on the tokens.
  await expect(col(a, "Amber-0").getByTestId("tb-name")).toHaveText("Coach");
  await expect(col(a, "Amber-0").getByTestId("tb-name")).toBeHidden();
  await expect(col(a, "Sapphire-5").getByTestId("tb-name")).toHaveText("Moss");
  await expect(col(a, "Amber-0")).toHaveAttribute("title", /^Coach(, |$)/);
  await expect(tok(a, "Amber-0")).toHaveAttribute("aria-label", /^Coach(, |$)/);
  const tb = (await tok(a, "Sapphire-5").locator("circle.body").boundingBox())!;
  await a.mouse.move(tb.x + tb.width / 2, tb.y + 2);
  await expect(a.getByTestId("hover-label")).toHaveText(/^Moss(, |$)/);
  await a.mouse.move(5, 5);
  // Never under the bar, so never under the map.
  const covered = await a.evaluate(() => {
    const map = document.querySelector(".stage .mapfit")!;
    const top = map.getBoundingClientRect().top;
    return [...document.querySelectorAll("[data-testid=tb-name]")].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && (r.bottom > top || map.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)));
    }).map((n) => n.textContent);
  });
  expect(covered).toEqual([]);
  // No roster in the side panel.
  await expect(a.locator("aside.side h2", { hasText: "Roster" })).toHaveCount(0);
  await expect(a.locator("[data-testid^=hero-pick-], [data-testid=roster-focus]")).toHaveCount(0);
  await a.screenshot({ path: "shots/scene-names.png" });

  // Rename… in the portrait menu: the typed name wins, for everyone in Scenes.
  const b = await joinNew(browser, url, "Second");
  await revealControls(b, "mode-sandbox");
  await b.getByTestId("mode-sandbox").click();
  await expect(col(b, "Amber-0").getByTestId("tb-name")).toHaveText("Coach");
  await col(a, "Amber-0").click({ button: "right" });
  await a.getByTestId("hero-menu-rename").click();
  const input = col(a, "Amber-0").getByTestId("tb-name-input");
  await expect(input).toBeFocused();
  await expect(input).toBeVisible();
  await input.fill("Captain");
  await a.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
  for (const p of [a, b]) {
    await expect(col(p, "Amber-0").getByTestId("tb-name")).toHaveText("Captain");
    await expect(col(p, "Amber-0").getByTestId("tb-name")).toBeHidden();
    await expect(col(p, "Amber-0")).toHaveAttribute("title", /^Captain(, |$)/);
    await expect(tok(p, "Amber-0")).toHaveAttribute("aria-label", /^Captain(, |$)/);
  }
  await a.screenshot({ path: "shots/scene-names-renamed.png" });
  // Cleared, the match's name is back.
  await col(a, "Amber-0").click({ button: "right" });
  await a.getByTestId("hero-menu-rename").click();
  await input.fill("");
  await a.keyboard.press("Enter");
  await expect(col(b, "Amber-0").getByTestId("tb-name")).toHaveText("Coach");

  // A scene saved from a moment shows them too.
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-save").click();
  await expect(a.getByTestId("scene-card")).toHaveCount(2);
  await expect(a.getByTestId("player")).toHaveAttribute("data-state", "scene");
  await expect(a.getByTestId("scene-card").nth(1)).toHaveAttribute("aria-current", "true");
  await expect(col(a, "Amber-0").getByTestId("tb-name")).toHaveText("Coach");
  await expect(tok(a, "Sapphire-5")).toHaveAttribute("aria-label", /^Moss(, |$)/);

  // Names off (this browser): none in Scenes either.
  await a.getByTestId("mode-player").click();
  await revealControls(a, "names-toggle");
  await a.getByTestId("names-toggle").click();
  await revealControls(a, "mode-sandbox");
  await a.getByTestId("mode-sandbox").click();
  await expect(a.getByTestId("tb-name")).toHaveCount(0);
  await expect(tok(a, "Amber-0")).toHaveAttribute("aria-label", /^King 1(, |$)/);
  expect(await namesOnPage(a)).toEqual([]);
});
