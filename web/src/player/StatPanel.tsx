// The Tab scoreboard's stat panels (docs/plans/2026-11-10-game-tooltips.md part 2; spec §6b
// "Calculated stats"): hovering a hero's investment bar or stats shows the game's WEAPON /
// VITALITY / SPIRIT STATS panel (`citadel_hero_stats_panels_shared.vcss`) beside its investment
// ladder (`citadel_tooltip_mod_bonus_display.vcss`). The panel holds the stats mapcro calculates,
// each with the quiet "≈" (spec §4b rule 5); the ladder is the patch's `m_MapModCostBonuses` with
// the row the hero's souls reach lit, and the bar filled as the column's.

import { For, Show } from "solid-js";
import { type Ladder, investFill } from "../match/stats";
import type { ShownStats } from "../match/stats";
import type { Tooltips } from "../match/tooltips";
import { soulsLabel, tierReached } from "../match/ladder";
import { cx } from "../ui/cx";

export type Category = "weapon" | "vitality" | "spirit";

/** The game's localisation keys and English words for each panel's header and ladder. */
const WORDS: Record<Category, { title: [string, string]; invest: [string, string]; desc: [string, string]; percent: boolean }> = {
  weapon: { title: ["CitadelHeroStats_Weapon", "Weapon Stats"], invest: ["Citadel_ModBonus_WeaponInvestment", "Weapon Investment"], desc: ["Citadel_ModBonus_WeaponInvestmentDesc", "Weapon Damage Increases"], percent: true },
  vitality: { title: ["CitadelHeroStats_Vitality", "Vitality Stats"], invest: ["Citadel_ModBonus_ArmorInvestment", "Vitality Investment"], desc: ["Citadel_ModBonus_ArmorInvestmentDesc", "Health Increases"], percent: true },
  spirit: { title: ["CitadelHeroStats_Spirit", "Spirit Stats"], invest: ["Citadel_ModBonus_TechInvestment", "Spirit Investment"], desc: ["Citadel_ModBonus_TechInvestmentDesc", "Spirit Power Increases"], percent: false },
};

export function StatPanel(p: {
  category: Category;
  /** The calculated stats (null: not calculated, "—"). */
  stats: ShownStats | null | undefined;
  /** Max health when there's no calculated one (the recorded value; no "≈"). */
  recordedHealth?: number | null | undefined;
  ladder: Ladder | undefined;
  souls: number;
  tips: Tooltips | undefined;
}) {
  const w = () => WORDS[p.category];
  const str = (k: [string, string]) => p.tips?.str(k[0], k[1]) ?? k[1];
  const bg = () => p.tips?.blob(p.tips.data.art[`catalog_tooltip_bg_modifies_${p.category}_psd`]);
  const star = () => p.tips?.blob(p.tips.data.art["icon_star"]);
  const at = () => (p.ladder ? tierReached(p.ladder, p.souls) : -1);
  const fill = () => investFill(p.ladder, p.souls);
  const health = () => p.stats?.max_health ?? p.recordedHealth ?? null;
  type Line = { key: string; label: string; value: number | null | undefined; unit?: string; calc: boolean };
  const lines = (): Line[] => {
    const s = p.stats;
    const label = (k: string, f: string) => p.tips?.str(k, f) ?? f;
    if (p.category === "weapon") return [{ key: "weapon_damage", label: label("BaseAttackDamagePercent_label", "Weapon Damage"), value: s?.weapon_damage, unit: "%", calc: true }];
    if (p.category === "vitality")
      return [
        { key: "max_health", label: label("StatDesc_MaxHealth", "Max Health"), value: health(), calc: p.stats?.max_health != null },
        { key: "bullet_resist", label: label("StatDesc_BulletArmorDamageReduction", "Bullet Resist"), value: s?.bullet_resist, unit: "%", calc: true },
        { key: "spirit_resist", label: label("StatDesc_TechArmorDamageReduction", "Spirit Resist"), value: s?.spirit_resist, unit: "%", calc: true },
      ];
    return [];
  };
  const value = (l: Line) => (l.value == null ? "—" : String(l.value));
  return (
    <div class={cx("sp", p.category)} data-testid="stat-panel" data-category={p.category}>
      <div class="sp-stats" style={bg() ? { "background-image": `url(${JSON.stringify(bg())})` } : {}}>
        <div class="sp-title">{str(w().title)}</div>
        <div class="sp-grid">
          <For each={lines()}>
            {(l) => (
              <div class={cx("sp-stat", l.value === 0 && "zero")} data-testid={`sp-${l.key}`}>
                <b class={cx(l.value != null && l.calc && "calc")}>{value(l)}<Show when={l.value != null && l.unit}><small>{l.unit}</small></Show></b>
                <span title={l.value == null ? "Not recorded" : undefined}>{l.label}</span>
              </div>
            )}
          </For>
        </div>
        <Show when={p.category === "spirit"}>
          <div class="sp-impact">
            <div class="sp-impact-title">{p.tips?.str("CitadelHeroStats_SpiritPower_Impact", "Spirit Power Impact") ?? "Spirit Power Impact"}</div>
            <div class="sp-stat" data-testid="sp-spirit_power">
              <b class={cx(p.stats?.spirit_power != null && "calc")}>{p.stats?.spirit_power ?? "—"}</b>
              <span>{p.tips?.str("StatDesc_TechPower", "Spirit Power") ?? "Spirit Power"}</span>
            </div>
            <p class="sp-impact-desc">{p.tips?.str("CitadelHeroStats_SpiritPower_Desc", "") ?? ""}</p>
          </div>
        </Show>
      </div>
      <Show when={p.ladder?.length}>
        <div class="sp-ladder" data-testid="stat-ladder">
          <div class="sp-ladder-head">
            <div class="sp-invest">{str(w().invest)}</div>
            <div class="sp-invest-desc">{str(w().desc)}</div>
          </div>
          <div class="sp-ladder-body">
            <div class="sp-bar" aria-hidden="true">
              <i style={{ height: `${fill() * 100}%` }} />
            </div>
            <div class="sp-rows">
              <For each={[...p.ladder!.entries()].reverse()}>
                {([i, [to, bonus]]) => (
                  <div class={cx("sp-row", i === at() ? "current" : i < at() ? "reached" : "not-reached", i === 4 && "starred")} data-testid="ladder-row" data-souls={to} data-current={String(i === at())}>
                    <b>+{bonus}{w().percent ? "%" : ""}</b>
                    <span>{soulsLabel(to)}</span>
                    <Show when={i === 4 && star()}>{(u) => <i class="sp-star" style={{ "-webkit-mask-image": `url(${JSON.stringify(u())})`, "mask-image": `url(${JSON.stringify(u())})` }} />}</Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
