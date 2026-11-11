// The game tooltips' pure parts (match/tooltips.ts, match/ladder.ts): the markup the
// localisation uses, value formatting, upgrade tiers, the per-patch overlay and the manifest
// section. Synthetic records shaped like crates/extract/src/tooltips.rs writes them.
import { expect, it } from "vitest";
import { type PackManifest, tooltipIndex } from "../src/map/pack";
import { soulsLabel, tierReached } from "../src/match/ladder";
import { type Tip, type TipProp, type TooltipData, blockShown, fmt, parseMarkup, shown, substitute, upgraded, upgradesTo, withOverlay } from "../src/match/tooltips";

it("parses the game's markup into a tree, never HTML", () => {
  const nodes = parseMarkup(`Gain <span class="highlight">Spirit</span> {g:citadel_inline_attribute:'SpiritDamage'}<br><span class="diminish">x <b>y</b></span><img src=x onerror=alert(1)> {g:citadel_binding:'Attack'}<Panel class="AbilityPropertyIcon prop_slow"></Panel>`);
  expect(nodes).toEqual([
    { t: "text", s: "Gain " },
    { t: "span", cls: ["highlight"], kids: [{ t: "text", s: "Spirit" }] },
    { t: "text", s: " " },
    { t: "attr", name: "SpiritDamage" },
    { t: "br" },
    { t: "span", cls: ["diminish"], kids: [{ t: "text", s: "x " }, { t: "b", kids: [{ t: "text", s: "y" }] }] },
    // An unknown tag stays text.
    { t: "text", s: "<img src=x onerror=alert(1)> " },
    { t: "key", name: "Attack" },
    { t: "icon", cls: ["AbilityPropertyIcon", "prop_slow"] },
  ]);
  // An unclosed span closes at the end; a stray close is dropped.
  expect(parseMarkup("a <span class=\"highlight\">b</i>")).toEqual([{ t: "text", s: "a " }, { t: "span", cls: ["highlight"], kids: [{ t: "text", s: "b" }] }]);
});

it("substitutes {s:Prop} from the values, through a token override, unknown ones empty", () => {
  expect(substitute("+{s:MaxStacks} and {s:DMarkMaxMarks} {s:Nope}.", { MaxStacks: "1" }, { DMarkMaxMarks: "MaxStacks" })).toBe("+1 and 1 .");
});

const prop = (key: string, extra: Partial<TipProp> = {}): TipProp => ({ key, label: key, ...extra });

it("writes a value as the game does: sign, postfix, zero hidden, spirit scaling marked calculated", () => {
  const values = { props: { A: "15", B: "-8", Z: "0", S: "11" } };
  expect(shown(prop("A", { prefix: "{s:sign}", postfix: "%" }), values)).toEqual({ prefix: "+", value: "15", postfix: "%", calc: false });
  expect(shown(prop("B", { prefix: "{s:sign}", postfix: "%" }), values)?.prefix).toBe("");
  expect(shown(prop("Z"), values)).toBeNull();
  expect(shown(prop("Missing"), values)).toBeNull();
  // Djinn's Mark: 11 + 0.35 × 176 spirit = 72.6 → 73, as the operator's screenshot shows.
  const scaled = prop("S", { scale: ["ETechPower", 0.35] });
  expect(shown(scaled, values, 176)).toEqual({ prefix: "", value: "73", postfix: "", calc: true });
  expect(shown(scaled, values)?.value).toBe("11");
  expect(fmt(2.0)).toBe("2");
  expect(fmt(2.754)).toBe("2.75");
});

const tip: Tip = {
  sections: [{ kind: "info", blocks: [{ important: [prop("Dmg", { scale: ["ETechPower", 0.35] })] }, { text: "x", requires: "Stun" }] }],
  upgrades: [
    { props: ["Slow"] },
    { props: ["Dmg"], kinds: { Dmg: "EAddToScale" } },
    { props: ["Cd", "Stun"] },
  ],
};
const values = { props: { Dmg: "11", Cd: "2.75", Slow: "0" }, upgrades: [{ Slow: "48" }, { Dmg: "0.2" }, { Cd: "-0.75", Stun: "0.5" }] };

it("applies the bought upgrade tiers to the values, a scale bonus to the scale", () => {
  expect(upgraded(tip, values, 0).values.props).toEqual(values.props);
  const one = upgraded(tip, values, 1);
  expect(one.values.props.Slow).toBe("48");
  const three = upgraded(tip, values, 3);
  expect(three.values.props.Cd).toBe("2");
  expect(three.values.props.Stun).toBe("0.5");
  expect(three.scale.Dmg).toBeCloseTo(0.55);
  expect(three.values.props.Dmg).toBe("11");
  // A block that needs an upgrade shows once a bought tier changes its property.
  const needs = tip.sections[0]!.blocks[1]!;
  expect(blockShown(needs, tip, 2)).toBe(false);
  expect(blockShown(needs, tip, 3)).toBe(true);
  expect(blockShown(needs, tip, null)).toBe(false);
  expect(blockShown(tip.sections[0]!.blocks[0]!, tip, null)).toBe(true);
});

it("merges a patch's overlay over the install's values", () => {
  const data: TooltipData = { format: 1, client_version: 6860, strings: { Citadel_Shop_Purchased: "Owned" }, icons: {}, inline: {}, art: {}, records: { 7: { tip, values } } };
  const base = withOverlay(data, undefined);
  expect(base.clientVersion).toBe(6860);
  expect(base.tip(7)?.values.props.Dmg).toBe("11");
  expect(base.tip(8)).toBeUndefined();
  expect(base.str("Citadel_Shop_Purchased", "x")).toBe("Owned");
  expect(base.str("Missing", "Fallback")).toBe("Fallback");
  const old = withOverlay(data, { client_version: 6837, records: { 7: { props: { Dmg: "9" }, upgrades: [{}, {}, { Cd: "-0.5" }] } } });
  expect(old.clientVersion).toBe(6837);
  expect(old.tip(7)?.values.props).toEqual({ Dmg: "9", Cd: "2.75", Slow: "0" });
  expect(old.tip(7)?.values.upgrades?.[2]).toEqual({ Cd: "-0.5", Stun: "0.5" });
  expect(old.tip(7)?.values.upgrades?.[0]).toEqual({ Slow: "48" });
});

it("finds what an item upgrades into", () => {
  const records = [{ id: 1 }, { id: 2, components: [1] }, { id: 3, components: [1, 9] }, { id: 4, components: [1], disabled: true }];
  expect(upgradesTo(1, records)).toEqual([2, 3]);
  expect(upgradesTo(2, records)).toEqual([]);
});

it("reads the manifest's tooltips section with its overlays", () => {
  const m: PackManifest = {
    game: { client_version: 6860 },
    blobs: { "data/tooltips": { sha256: "x", mime: "application/json", file: "data/tooltips.json" }, "data/tooltips/boon-6837": { sha256: "y", mime: "application/json", file: "data/tooltips/boon-6837.json" } },
    tooltips: { format: 1, blob: "data/tooltips", overlays: { "boon-6837": "data/tooltips/boon-6837", "boon-6700": "data/tooltips/missing" } },
  };
  const url = (k: string) => (m.blobs[k] ? `/packs/p/${m.blobs[k]!.file}` : undefined);
  const ix = tooltipIndex(m, url)!;
  expect(ix.url).toBe("/packs/p/data/tooltips.json");
  expect([...ix.overlays]).toEqual([["boon-6837", "/packs/p/data/tooltips/boon-6837.json"]]);
  expect(tooltipIndex({ ...m, tooltips: { ...m.tooltips!, format: 2 } }, url)).toBeUndefined();
  expect(tooltipIndex({ game: m.game, blobs: m.blobs }, url)).toBeUndefined();
});

it("writes the ladder's souls and finds the row reached", () => {
  expect(soulsLabel(800)).toBe("800");
  expect(soulsLabel(8000)).toBe("8.0K");
  expect(soulsLabel(28800)).toBe("28.8K");
  const ladder: Array<[number, number, number]> = [[800, 9, 7], [1600, 12, 7], [8000, 62, 10]];
  expect(tierReached(ladder, 0)).toBe(-1);
  expect(tierReached(ladder, 800)).toBe(0);
  expect(tierReached(ladder, 7999)).toBe(1);
  expect(tierReached(ladder, 30000)).toBe(2);
});
