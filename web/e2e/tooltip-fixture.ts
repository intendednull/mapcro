// Synthetic assets and replay shared by desktop and phone tooltip coverage.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TIMELINE_FORMAT } from "./server";
const N = 40;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export const INFUSER = 101, LIFESTEAL = 102, ABILITY = 201, ULT = 204;
const LADDER = [[800, 9, 7], [1600, 12, 7], [2400, 15, 8], [3200, 18, 8], [4800, 46, 9], [6400, 54, 9], [8000, 62, 10], [11200, 74, 10], [16000, 86, 10], [22400, 100, 11], [28800, 115, 11]];

export function pack(): string {
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
        ], stack_label: "Current Stacks:" },
        values: { props: { TechResist: "10", TechPower: "8", AbilityCooldown: "30", Lifesteal: "75", AbilityDuration: "7" } },
      },
      [LIFESTEAL]: { tip: { sections: [{ kind: "innate", blocks: [{ basic: [p("Lifesteal", "Spirit Lifesteal", { postfix: "%" })] }] }] }, values: { props: { Lifesteal: "15" } } },
      [ABILITY]: {
        tip: {
          header: [p("AbilityCooldown", "Cooldown", { postfix: "s", css: "cooldown" })],
          sections: [{ kind: "info", blocks: [{ text: "Deals {g:citadel_inline_attribute:'SpiritDamage'}.", important: [p("Damage", "Base Damage", { scale: ["ETechPower", 0.35] })], basic: [p("Duration", "Duration", { postfix: "s" })] }] }],
          upgrades: [{ text: "+{s:Damage} Base Damage", props: ["Damage"] }, { text: "{s:AbilityCooldown}s Cooldown", props: ["AbilityCooldown"] }, { text: "Third", props: [] }],
          stack_label: "Leeches Collected:",
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

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/**
 * Every hero buys Test Lifesteal at 5 s and upgrades it into Test Infuser at 12 s, casts the
 * Infuser at 13 s (ready at 40 s), has its first ability at tier 1 from 15 s and its ult unlocked.
 * Amber 0 is seen by Sapphire until 20 s; Sapphire's heroes are always seen by Amber.
 */
export function timeline(id: string) {
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
        // Amber 0 collects leeches on the first ability (a death at 38 s takes some), and stacks
        // on the Infuser.
        stacks: team === "amber" && slot === 0 ? [[100, ABILITY, 3], [150, INFUSER, 4], [180, ABILITY, 8], [380, ABILITY, 6]] : [],
        // Sapphire 0 (players[6]) kills Amber 1 with the first ability.
        recaps: dies(team, slot) ? [{ t: 300, damage: [[6, ABILITY, 500]], cc: [] }] : [],
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [],
    events: [{ t: 30, kind: "death", team: "amber", slot: 1, hero_id: 2, x: -2500, y: -3000 }],
  };
}
const dies = (team: string, slot: number) => team === "amber" && slot === 1;

