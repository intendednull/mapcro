// The game's tooltips in Player (spec §6b "Tooltips"; docs/plans/2026-11-10-game-tooltips.md), on
// a synthetic pack (made-up records shaped like crates/extract/src/tooltips.rs writes them, 1×1
// PNGs, never game art):
// - hovering an item in the Tab column shows its tooltip: name, "Owned", innate stats, the Active
//   section with its cooldown, the description's markup, a property card and "Upgrades From";
//   the values are the replay patch's (6839 reads the 6837 overlay), not the pack's;
// - hovering an ability shows its cooldown and upgrade tiers, the bought ones marked;
// - hovering an investment bar shows its stat panel with the ladder's current row and the "≈";
// - hovering a hero's ult indicator on the top bar shows the ult's tooltip (feedback #9);
// - a single click on a hero's minimap token opens its panel (feedback #8); Escape and × close
//   it; in a team's view, an enemy out of sight shows no cooldowns.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const N = 40;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-tooltips-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const INFUSER = 101, LIFESTEAL = 102, ABILITY = 201, ULT = 204;
const LADDER = [[800, 9, 7], [1600, 12, 7], [2400, 15, 8], [3200, 18, 8], [4800, 46, 9], [6400, 54, 9], [8000, 62, 10], [11200, 74, 10], [16000, 86, 10], [22400, 100, 11], [28800, 115, 11]];

function pack(): string {
  const root = mkdtempSync(join(tmpdir(), "mapcro-packs-tooltips-"));
  const dir = join(root, "synthetic");
  const blobs: Record<string, unknown> = {};
  const write = (key: string, bytes: Buffer, ext: string, mime: string) => {
    const file = `${key}.${ext}`;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), bytes);
    blobs[key] = { sha256: createHash("sha256").update(bytes).digest("hex"), w: 1, h: 1, mime, file };
    return key;
  };
  const json = (key: string, v: unknown) => write(key, Buffer.from(JSON.stringify(v)), "json", "application/json");
  const png = (key: string) => write(key, PNG, "png", "image/png");
  const table = (version: number) => ({
    format: 1, client_version: version, source: "test",
    heroes: Object.fromEntries([1, 2, 3, 4, 5, 6].map((id) => [id, { max_health: 700, per_boon: { max_health: 50, spirit_power: 2 }, boon_levels: [2, 3, 4, 5], cost_bonuses: [LADDER, LADDER, LADDER], bullet_resist: 0, spirit_resist: 0, bullet_resist_per_spirit: 0, spirit_resist_per_spirit: 0 }])),
    items: { [INFUSER]: { slot: 0, price: 6400, passive: [["spirit_resist", 10], ["spirit_power", 8]] }, [LIFESTEAL]: { slot: 1, price: 1600, passive: [] } },
  });
  json("data/stats/boon-6837", table(6837));
  json("data/stats/vdata-6860", table(6860));
  const records = {
    [INFUSER]: { name: "upgrade_test_infuser", kind: "item", label: "Test Infuser", label_from: "localisation", ability_type: "item", slot: "vitality", tier: 4, cost: 6400, components: [LIFESTEAL], icon: png("abilities/items/infuser") },
    [LIFESTEAL]: { name: "upgrade_test_lifesteal", kind: "item", label: "Test Lifesteal", label_from: "localisation", ability_type: "item", slot: "spirit", tier: 2, cost: 1600, icon: png("abilities/items/lifesteal") },
    [ABILITY]: { name: "ability_test_mark", kind: "ability", label: "Test Mark", label_from: "localisation", ability_type: "signature", icon: png("abilities/hud/mark") },
    202: { name: "ability_test_2", kind: "ability", label: "Test Two", label_from: "localisation", ability_type: "signature" },
    203: { name: "ability_test_3", kind: "ability", label: "Test Three", label_from: "localisation", ability_type: "signature" },
    [ULT]: { name: "ability_test_ult", kind: "ability", label: "Test Ultimate", label_from: "localisation", ability_type: "ultimate", icon: png("abilities/hud/ult") },
  };
  json("data/abilities", { records });
  const p = (key: string, label: string, extra: object = {}) => ({ key, label, ...extra });
  json("data/tooltips", {
    format: 1, client_version: 6860,
    strings: { Citadel_Mod_Tooltip_Active: "Active", Citadel_Mod_Tooltip_Passive: "Passive", Citadel_Shop_Purchased: "Owned", Citadel_ComponentRequired: "Upgrades From:", Citadel_IsComponentOf: "Upgrades To:", CitadelHeroStats_Vitality: "Vitality Stats", Citadel_ModBonus_ArmorInvestment: "Vitality Investment", Citadel_ModBonus_ArmorInvestmentDesc: "Health Increases", StatDesc_MaxHealth: "Max Health", inlineattribute_spiritdamage: "spirit damage" },
    icons: { healing: { img: png("tooltips/icons/heal"), wash: "#00FF99" } },
    inline: { "icon:SpiritDamage": { img: png("tooltips/icons/magic") }, "name:SpiritDamage": { color: "#CE90FF" } },
    art: { purchased_check_png: png("tooltips/shop/purchased_check_png") },
    records: {
      [INFUSER]: {
        tip: { sections: [
          { kind: "innate", blocks: [{ basic: [p("TechResist", "Spirit Resist", { prefix: "{s:sign}", postfix: "%" }), p("TechPower", "Spirit Power", { prefix: "{s:sign}" })] }] },
          { kind: "active", cooldown: p("AbilityCooldown", "Cooldown", { postfix: "s", css: "cooldown" }), blocks: [{ text: "Gain <span class=\"highlight\">Spirit Lifesteal</span> and {g:citadel_inline_attribute:'SpiritDamage'}.", important: [p("Lifesteal", "Spirit Lifesteal", { prefix: "{s:sign}", postfix: "%", css: "healing", conditional: true })], basic: [p("AbilityDuration", "Duration", { postfix: "s" })] }] },
        ] },
        values: { props: { TechResist: "10", TechPower: "8", AbilityCooldown: "30", Lifesteal: "75", AbilityDuration: "7" } },
      },
      [LIFESTEAL]: { tip: { sections: [{ kind: "innate", blocks: [{ basic: [p("Lifesteal", "Spirit Lifesteal", { postfix: "%" })] }] }] }, values: { props: { Lifesteal: "15" } } },
      [ABILITY]: {
        tip: {
          header: [p("AbilityCooldown", "Cooldown", { postfix: "s", css: "cooldown" })],
          sections: [{ kind: "info", blocks: [{ text: "Deals {g:citadel_inline_attribute:'SpiritDamage'}.", important: [p("Damage", "Base Damage", { scale: ["ETechPower", 0.35] })], basic: [p("Duration", "Duration", { postfix: "s" })] }] }],
          upgrades: [{ text: "+{s:Damage} Base Damage", props: ["Damage"] }, { text: "{s:AbilityCooldown}s Cooldown", props: ["AbilityCooldown"] }, { text: "Third", props: [] }],
        },
        values: { props: { AbilityCooldown: "10", Damage: "11", Duration: "5" }, upgrades: [{ Damage: "20" }, { AbilityCooldown: "-2" }, {}] },
      },
      [ULT]: { tip: { header: [p("AbilityCooldown", "Cooldown", { postfix: "s" })], sections: [{ kind: "info", blocks: [{ text: "The <span class=\"highlight\">ultimate</span>." }] }] }, values: { props: { AbilityCooldown: "120" } } },
    },
  });
  // 6837's values differ: what a 6839 replay shows.
  json("data/tooltips/boon-6837", { format: 1, client_version: 6837, records: { [INFUSER]: { props: { TechResist: "12" } } } });
  const heroes = [1, 2, 3, 4, 5, 6].map((id) => ({ hero_id: id, class_name: `hero_t${id}`, name: `Testhero ${id}`, minimap_blob: png(`heroes/${id}`), topbar_blob: png(`topbar/heroes/${id}`), abilities: [ABILITY, 202, 203, ULT] }));
  const manifest = {
    schema: 4, game: { client_version: 6860, source_revision: 1, date: "Nov 05 2026" }, blobs, heroes, entities: [],
    abilities: { blob: "data/abilities" },
    stats: { format: 1, covered_through: 6860, builds: { 6837: "boon-6837", 6839: "boon-6837", 6860: "vdata-6860" }, tables: { "boon-6837": { blob: "data/stats/boon-6837", client_version: 6837, source: "test" }, "vdata-6860": { blob: "data/stats/vdata-6860", client_version: 6860, source: "test" } } },
    tooltips: { format: 1, blob: "data/tooltips", records: 4, overlays: { "boon-6837": "data/tooltips/boon-6837" } },
  };
  writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest));
  return root;
}

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(pack(), { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "20" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/**
 * Every hero buys Test Lifesteal at 5 s and upgrades it into Test Infuser at 12 s, casts the
 * Infuser at 13 s (ready at 40 s), has its first ability at tier 1 from 15 s and its ult unlocked.
 * Amber 0 is seen by Sapphire until 20 s; Sapphire's heroes are always seen by Amber.
 */
function timeline(id: string) {
  return {
    match_id: Number(id), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: null,
        x: range((s) => (dies(team, slot) && s >= 30 && s < 35 ? null : slot * 1500 - 4000)), y: range((s) => (dies(team, slot) && s >= 30 && s < 35 ? null : team === "amber" ? -3000 : 3000)),
        health: range(() => 100), deaths: dies(team, slot) ? [30] : [], respawn: dies(team, slot) ? [[30, 35]] : [], souls: [[0, 500]], ult: range(() => 0),
        seen: team === "amber" && slot === 0 ? [[0, 200]] : [[0, N * 10]],
        level: [[0, 3]], max_health: [[0, 777]], kills: [[0, 0]], assists: [[0, 0]], pickups: [],
        items: [[50, LIFESTEAL, 0], [120, LIFESTEAL, 2], [120, INFUSER, 0]],
        abilities: [[0, ABILITY, 1], [0, ULT, 1], [15, ABILITY, 2]],
        casts: [[130, INFUSER, 400]], charges: [], cc: [], effects: [],
        // Sapphire 0 (players[6]) kills Amber 1 with the first ability.
        recaps: dies(team, slot) ? [{ t: 300, damage: [[6, ABILITY, 500]], cc: [] }] : [],
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [],
    events: [{ t: 30, kind: "death", team: "amber", slot: 1, hero_id: 2, x: -2500, y: -3000 }],
  };
}
const dies = (team: string, slot: number) => team === "amber" && slot === 1;

const answered = new Set<string>();
async function open(p: Page, id: string) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(id);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${id}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
  answered.add(job);
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline(id)));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(t).padStart(2, "0")} /`);
}

const column = (p: Page) => p.locator('.tb-player[data-slot="Amber-0"] [data-testid=hero-build]');
const float = (p: Page) => p.getByTestId("game-tooltip-float");

test("hovering items, abilities and investment shows the game's tooltips with the replay patch's values", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Tooltips"), "Coach");
  await open(a, "129000101");
  await scrubTo(a, 20);
  await a.locator(".tb-all-builds").click();
  const c = column(a);
  const item = c.locator(`[data-item-id="${INFUSER}"]`);
  // With tooltips, the plain title gives way to the game's tooltip.
  await expect(item).not.toHaveAttribute("title");
  await item.hover();
  const tip = float(a).getByTestId("game-tooltip");
  await expect(tip).toHaveAttribute("data-kind", "item");
  await expect(tip.getByTestId("game-tooltip-name")).toHaveText("Test Infuser");
  await expect(tip.getByTestId("game-tooltip-owned")).toHaveText("Owned");
  // 6839 reads 6837's values: 12, not the pack's 10.
  await expect(tip.locator('[data-section=innate] [data-prop=TechResist]')).toHaveText("+12% Spirit Resist");
  await expect(tip.locator('[data-section=innate] [data-prop=TechPower]')).toHaveText("+8 Spirit Power");
  await expect(tip.locator("[data-section=active] .gt-section-label")).toHaveText("Active");
  await expect(tip.getByTestId("game-tooltip-cooldown")).toHaveText("30s");
  await expect(tip.locator(".gt-desc")).toHaveText("Gain Spirit Lifesteal and spirit damage.");
  await expect(tip.locator(".gt-desc .gt-m-highlight")).toHaveText("Spirit Lifesteal");
  await expect(tip.locator('.gt-card[data-prop=Lifesteal]')).toContainText("+75%");
  await expect(tip.locator('.gt-card[data-prop=Lifesteal]')).toContainText("Spirit Lifesteal");
  await expect(tip.locator('.gt-rows [data-prop=AbilityDuration]')).toHaveText("7s Duration");
  await expect(tip.getByTestId("game-tooltip-from")).toContainText("Upgrades From:");
  await expect(tip.getByTestId("game-tooltip-from")).toContainText("Test Lifesteal");
  // Off the item, it goes; Escape closes one too.
  await a.mouse.move(5, 400);
  await expect(float(a)).toHaveCount(0);

  // The ability: its cooldown with the bought tier applied? Tier 1 is +20 damage; the cooldown is tier 2's.
  await c.locator(`[data-ability-id="${ABILITY}"]`).hover();
  const at = float(a).getByTestId("game-tooltip");
  await expect(at).toHaveAttribute("data-kind", "ability");
  await expect(at.getByTestId("game-tooltip-cooldown")).toHaveText("10s");
  await expect(at.locator(".gt-desc")).toHaveText("Deals spirit damage.");
  // 11 + 20 (tier 1) = 31, scaled by the calculated spirit power: "≈" marks it.
  await expect(at.locator('.gt-card[data-prop=Damage] .gt-value')).toHaveClass(/\bcalc\b/);
  await expect(at.locator('.gt-card[data-prop=Damage] .gt-scale')).toHaveText("×0.35");
  const tiers = at.getByTestId("game-tooltip-tier");
  await expect(tiers).toHaveCount(3);
  await expect(tiers.nth(0)).toHaveClass(/\bbought\b/);
  await expect(tiers.nth(1)).not.toHaveClass(/\bbought\b/);
  await expect(tiers.nth(0)).toContainText("+20 Base Damage");
  // The tiers' ability-point costs, as the game's cards show them.
  await expect(at.getByTestId("game-tooltip-tier-cost")).toHaveText(["1", "2", "5"]);
  await expect(tiers.nth(1)).toContainText("-2s Cooldown");
  await a.keyboard.press("Escape");
  await expect(float(a)).toHaveCount(0);

  // The vitality bar: the stat panel with the ladder, its current row the souls reach (6,400).
  await c.getByTestId("invest-vitality").hover();
  const panel = float(a).getByTestId("stat-panel");
  await expect(panel).toHaveAttribute("data-category", "vitality");
  await expect(panel.locator(".sp-title")).toHaveText("Vitality Stats");
  await expect(panel.locator(".sp-invest")).toHaveText("Vitality Investment");
  await expect(panel.locator(".sp-invest-desc")).toHaveText("Health Increases");
  const current = panel.locator('[data-testid=ladder-row][data-current="true"]');
  await expect(current).toHaveAttribute("data-souls", "6400");
  await expect(current).toContainText("+54%");
  await expect(current).toContainText("6.4K");
  await expect(panel.getByTestId("ladder-row")).toHaveCount(11);
  // Calculated values carry the "≈" (spec §4b rule 5).
  await expect(panel.locator("[data-testid=sp-max_health] b")).toHaveClass(/\bcalc\b/);
  await expect(panel.locator("[data-testid=sp-spirit_resist] b")).toHaveText("10%");
});

test("the events list's purchases and the death recap's icons show their tooltips", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Event tooltips"), "Coach");
  await open(a, "129000104");
  await scrubTo(a, 31);
  await a.getByTestId("chip-purchase").click();
  const buy = a.locator('[data-testid=event][data-kind=item_buy]').first();
  await buy.getByTestId("event-jump").hover();
  await expect(float(a).getByTestId("game-tooltip-name")).toHaveText("Test Infuser");
  await a.mouse.move(5, 500);
  await expect(float(a)).toHaveCount(0);
  // The chip filters the list to purchases; off again for the death.
  await a.getByTestId("chip-purchase").click();
  const death = a.locator('[data-testid=event][data-kind=death]');
  await death.getByTestId("death-recap").locator("summary").click();
  await death.getByTestId("recap-icon").hover();
  await expect(float(a).getByTestId("game-tooltip-name")).toHaveText("Test Mark");
});

test("hovering a hero's ult indicator shows its ultimate's tooltip", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Ult tooltip"), "Coach");
  await open(a, "129000102");
  await scrubTo(a, 20);
  const ult = a.locator('.tb-player[data-slot="Sapphire-2"] [data-testid=ult]');
  await expect(ult).not.toHaveAttribute("title");
  await ult.hover();
  const tip = float(a).getByTestId("game-tooltip");
  await expect(tip).toHaveAttribute("data-tip-id", String(ULT));
  await expect(tip.getByTestId("game-tooltip-name")).toHaveText("Test Ultimate");
  await expect(tip.getByTestId("game-tooltip-cooldown")).toHaveText("120s");
  await expect(tip.locator(".gt-desc")).toHaveText("The ultimate.");
});

test("a click on a hero's token opens its panel; Escape and × close it; an unseen enemy shows no cooldowns", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Hero panel"), "Coach");
  await open(a, "129000103");
  await scrubTo(a, 15);
  const token = (slot: string) => a.locator(`.mapbox .tok[data-slot="${slot}"]`);
  const card = a.getByTestId("hero-card");
  await token("Sapphire-1").click();
  await expect(card).toHaveAttribute("data-slot", "sapphire-1");
  await expect(card).toContainText("Testhero 2");
  // The Tab column's parts: the items with their cooldown, and their tooltips.
  await expect(card.locator(`[data-item-id="${INFUSER}"] .tb-build-cooldown`)).toHaveText("25s");
  await card.locator(`[data-item-id="${INFUSER}"]`).hover();
  await expect(float(a).getByTestId("game-tooltip-name")).toHaveText("Test Infuser");
  await a.keyboard.press("Escape");
  await expect(float(a)).toHaveCount(0);
  await a.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  // Another token opens its own beside it (#37); × closes.
  await token("Amber-0").click();
  await expect(card).toHaveAttribute("data-slot", "amber-0");
  await card.getByTestId("hero-card-close").click();
  await expect(card).toHaveCount(0);
  // The Archmother's view: Amber 0 is seen until 0:20. Open it while seen, then past it: the
  // panel keeps the scoreboard's info, but no cooldowns.
  await a.getByTestId("vision-select").selectOption("sapphire");
  await scrubTo(a, 15);
  await token("Amber-0").click();
  await expect(card).toHaveAttribute("data-limited", "false");
  await expect(card.locator(`[data-item-id="${INFUSER}"] .tb-build-cooldown`)).toHaveText("25s");
  await scrubTo(a, 25);
  await expect(card).toHaveAttribute("data-limited", "true");
  await expect(card.locator(`[data-item-id="${INFUSER}"]`)).toHaveCount(1);
  await expect(card.locator(".tb-build-cooldown")).toHaveCount(0);
  // An enemy the view can't see has no token to click.
  await expect(token("Amber-0")).toHaveCount(0);
});

test("holding Tab shows every build wherever the focus is, but in a text field; Shift+Tab moves focus (#24)", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Tab builds"), "Coach");
  await open(a, "129000104");
  await scrubTo(a, 20);
  const bar = a.locator(".pl-topbar");
  const focused = () => a.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.className ?? "");
  await revealControls(a, "pings-toggle");
  // A list (Vision, speed), a button, the scrubber, a toggle and the top bar's own button: Tab
  // shows every build while held, and the focus stays where it was.
  const targets = [a.getByTestId("vision-select"), a.getByTestId("match-speed"), a.getByTestId("match-play"), a.getByTestId("match-time"), a.getByTestId("pings-toggle"), a.locator(".tb-all-builds")];
  for (const target of targets) {
    await target.focus();
    const was = await focused();
    await a.keyboard.down("Tab");
    await expect(bar).toHaveClass(/\ball-builds\b/);
    await expect(column(a)).toBeVisible();
    expect(await focused()).toBe(was);
    await a.keyboard.up("Tab");
    await expect(bar).not.toHaveClass(/\ball-builds\b/);
    await expect(target).toBeFocused();
  }
  // Shift+Tab still moves focus back (keyboard use), and shows nothing.
  await a.getByTestId("match-play").focus();
  await a.keyboard.press("Shift+Tab");
  await expect(a.getByTestId("match-play")).not.toBeFocused();
  await expect(bar).not.toHaveClass(/\ball-builds\b/);
  // In a text field, Tab is the field's: focus moves on.
  const search = a.getByTestId("events-search");
  await search.focus();
  await a.keyboard.down("Tab");
  await expect(search).not.toBeFocused();
  await expect(bar).not.toHaveClass(/\ball-builds\b/);
  await a.keyboard.up("Tab");
});

test("an open build column draws over its hero's ult and the bar's marks (#27)", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Ult under column"), "Coach");
  await open(a, "129000105");
  await scrubTo(a, 20);
  const ult = a.locator('.tb-player[data-slot="Amber-0"] [data-testid=ult]');
  await expect(ult).toBeVisible();
  const box = (await ult.boundingBox())!;
  const hits = (draw: boolean) =>
    a.evaluate(({ x, y, draw }) => {
      // `draw`: the ult forced visible, so only the stacking order can put the column over it.
      const style = document.createElement("style");
      if (draw) style.textContent = ".tb-ult { visibility: visible !important; }";
      document.head.append(style);
      const out: string[] = [];
      const inColumn = (el: Element | null) => !!el?.closest("[data-testid=hero-build]");
      if (!inColumn(document.elementFromPoint(x, y))) out.push("ult");
      // Every part of every open column is on top at its centre: no mark of the bar covers one.
      for (const part of document.querySelectorAll(".pl-topbar [data-testid=hero-build] > *")) {
        const r = part.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 6));
        if (!inColumn(hit)) out.push(`${part.className} under ${hit?.className}`);
      }
      style.remove();
      return out;
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2, draw });
  // Tab's view (every column) and a single hero's column.
  await a.locator(".tb-all-builds").click();
  await expect(column(a)).toBeVisible();
  expect(await hits(false)).toEqual([]);
  expect(await hits(true)).toEqual([]);
  await a.locator(".tb-all-builds").click();
  await a.locator('.tb-player[data-slot="Amber-0"] [data-testid=souls-banner]').click();
  await expect(column(a)).toBeVisible();
  expect(await hits(true)).toEqual([]);
});

test("the hero panel reads at the app's sizes, its K/D/A and investment bars on its centre line (#34)", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Hero panel sizes"), "Coach");
  await open(a, "129000106");
  await scrubTo(a, 15);
  await a.locator('.mapbox .tok[data-slot="Sapphire-1"]').click();
  const card = a.getByTestId("hero-card");
  await expect(card).toBeVisible();
  const m = await card.evaluate((el) => {
    const px = (e: Element) => parseFloat(getComputedStyle(e).fontSize);
    // Every element that draws text of its own, and its size.
    const small: string[] = [];
    for (const e of el.querySelectorAll("*")) {
      const own = [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      if (own && (e as HTMLElement).offsetParent !== null && px(e) < 11) small.push(`${e.className || e.tagName} ${px(e)}px`);
    }
    const panel = el.querySelector(".tb-build-column")!.getBoundingClientRect();
    const mid = (r: DOMRect) => r.left + r.width / 2;
    const kda = [...el.querySelectorAll(".tb-build-kda > div")].map((d) => d.getBoundingClientRect());
    const bars = [...el.querySelectorAll("[data-testid^=invest-]")].map((d) => d.getBoundingClientRect());
    return {
      small,
      centre: mid(panel),
      kdaMid: (kda[0]!.left + kda[2]!.right) / 2,
      kdaWidths: kda.map((r) => Math.round(r.width)),
      kdaGaps: [kda[1]!.left - kda[0]!.right, kda[2]!.left - kda[1]!.right].map(Math.round),
      kdaValue: px(el.querySelector(".tb-build-kda b")!),
      barsMid: (bars[0]!.left + bars[2]!.right) / 2,
      barWidths: bars.map((r) => Math.round(r.width)),
      barHeights: bars.map((r) => Math.round(r.height)),
      barGaps: [bars[1]!.left - bars[0]!.right, bars[2]!.left - bars[1]!.right].map(Math.round),
    };
  });
  expect(m.small).toEqual([]);
  expect(m.kdaValue).toBeGreaterThanOrEqual(16);
  // K/D/A: three equal columns, evenly spaced, on the centre line; the bars a group there too.
  expect(new Set(m.kdaWidths).size).toBe(1);
  expect(m.kdaGaps[0]).toBe(m.kdaGaps[1]);
  expect(m.kdaGaps[0]).toBeGreaterThanOrEqual(4);
  expect(Math.abs(m.kdaMid - m.centre)).toBeLessThan(1.5);
  expect(Math.abs(m.barsMid - m.centre)).toBeLessThan(1.5);
  expect(new Set(m.barWidths).size).toBe(1);
  expect(m.barWidths[0]).toBeGreaterThanOrEqual(10);
  expect(new Set(m.barHeights).size).toBe(1);
  expect(m.barHeights[0]).toBeGreaterThanOrEqual(32);
  expect(m.barGaps[0]).toBe(m.barGaps[1]);
  // The calculated stats keep their "≈".
  await expect(card.getByTestId("stat-max-health")).toHaveClass(/\bcalc\b/);
});
