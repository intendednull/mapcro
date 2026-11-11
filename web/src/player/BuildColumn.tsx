// The HUD's PlayerNameNWContainer: abilities above the two-column inventory.
import { ActiveEffects } from "./ActiveEffects";
import { BuildOrder } from "./BuildOrder";
import { For, Index, Show, createMemo } from "solid-js";
import type { Art, Hero } from "../map/pack";
import { buildAt, killsAt, type BuildEntry } from "../match/builds";
import { PICKUPS_FORMAT, SLOT, investFill, statBuild, statsAt, type LoadedTable } from "../match/stats";
import { scoreboardValueAt, type Timeline, type TimelinePlayer } from "../match/timeline";
import { cx } from "../ui/cx";
import { LABELS } from "./labels";


/**
 * - `stats`: the replay build's stat table (none: the calculated values show "—").
 * - `ladder`: the investment ladder's table (the build's, else the pack's own patch).
 */
export function BuildColumn(p: { inspect?: boolean; onSeek?: ((t: number) => void) | undefined; player: TimelinePlayer; timeline: Timeline | undefined; t: number; art: Art; hero: Hero | undefined; name: string | undefined; id: string; stats?: LoadedTable | undefined; ladder?: LoadedTable | undefined }) {
  const build = createMemo(() => buildAt(p.player, p.t));
  const record = (id: number) => p.art.buildCatalog?.records.get(id);
  const abilityIds = () => p.hero?.abilities?.length ? p.hero.abilities : (build().abilities ?? []).map(a => a.id);
  const abilities = () => Array.from({ length: 4 }, (_, i) => {
    const id = abilityIds()[i];
    const entry = build().abilities?.find(a => a.id === id);
    return { id, entry, level: id == null || build().abilities === null ? null : (entry?.level ?? 0) };
  });
  const cooldown = (entry: BuildEntry | undefined) => entry?.cooldown != null && entry.cooldown > 0 ? `${Math.ceil(entry.cooldown)}s` : undefined;
  const kills = createMemo(() => p.player.kills != null ? scoreboardValueAt(p.player.kills, p.t) : killsAt(p.timeline, p.t, p.player.team, p.player.slot));
  const assists = () => scoreboardValueAt(p.player.assists, p.t);
  // Calculated from the build and the replay patch's data (crates/stats); "—" without a table.
  const calc = createMemo(() => (p.timeline?.format ?? 0) >= PICKUPS_FORMAT ? statsAt(p.stats, statBuild(p.player, p.t, build())) : null);
  // The recorded max health refreshes only at (re)spawn, so the calculated one replaces it.
  const maxHealth = () => calc()?.shown.max_health ?? scoreboardValueAt(p.player.max_health, p.t);
  const deaths = createMemo(() => p.player.deaths.filter(t => t <= p.t).length);
  // Souls in owned items per category, as the game counts them for the ladder: each owned item's
  // tier price at the replay's patch (sold and used-up items don't count); without that patch's
  // table, the pack's prices.
  const investment = createMemo(() => {
    const c = calc();
    if (c) return { weapon: c.invested[SLOT.weapon], vitality: c.invested[SLOT.vitality], spirit: c.invested[SLOT.spirit] };
    const values = { weapon: 0, vitality: 0, spirit: 0 };
    for (const item of build().items ?? []) {
      const info = record(item.id);
      if (info?.slot && info.cost != null) values[info.slot] += info.cost;
    }
    return values;
  });
  const ladder = (category: keyof typeof SLOT) => {
    const heroes = p.ladder?.data.heroes;
    // Every hero has the same ladder (deadbot asserts it); any one stands in for a missing hero.
    const own = heroes?.[String(p.player.hero_id)] ?? (heroes ? Object.values(heroes)[0] : undefined);
    return own?.cost_bonuses[SLOT[category]];
  };
  const value = (v: number | null | undefined, unit = "") => v == null ? "—" : `${v}${unit}`;
  const tag = (label: string, v: number | null | undefined) => v == null ? LABELS.missing : label;
  const tier = (n?: number) => n ? ["", "I", "II", "III", "IV", "V"][n] ?? String(n) : "";
  return (
    <section id={p.id} class="tb-build-column" data-testid="hero-build" aria-label={`${p.hero?.name ?? "Hero"} build`}>
      <Show when={p.name}><div class="tb-build-name">{p.name}</div></Show>
      <div class="tb-build-hero">{p.hero?.name ?? "Hero"}</div>
      <div class="tb-build-kda" aria-label="Kills, deaths, assists">
        <div title={tag(LABELS.kills, kills())}><small>K</small><b>{kills() ?? "—"}</b></div>
        <div title={LABELS.deaths}><small>D</small><b>{deaths()}</b></div>
        <div title={tag(LABELS.assists, assists())}><small>A</small><b>{assists() ?? "—"}</b></div>
      </div>
      <div class="tb-build-investment">
        <For each={["weapon", "spirit", "vitality"] as const}>{category =>
          <span class={category} data-testid={`invest-${category}`} data-fill={investFill(ladder(category), investment()[category]).toFixed(3)} title={LABELS[category]} role="img" aria-label={`${LABELS[category]}, ${investment()[category].toLocaleString("en-US")}`}>
            <i style={{ height: `${investFill(ladder(category), investment()[category]) * 100}%` }} />
          </span>
        }</For>
      </div>
      <div class="tb-build-vitals" data-testid="build-stats">
        <div data-testid="stat-max-health" classList={{ calc: calc()?.shown.max_health != null }} title={tag(LABELS.maxHealth, maxHealth())}><span aria-hidden="true">♥</span> <span class="tb-stat-v">{value(maxHealth())}</span></div>
        <div class="tb-build-resists">
          <span aria-hidden="true">⛨</span>
          <b data-testid="stat-bullet-resist" classList={{ calc: calc()?.shown.bullet_resist != null }} title={tag(LABELS.bulletResist, calc()?.shown.bullet_resist)}>{value(calc()?.shown.bullet_resist, "%")}</b>
          <b data-testid="stat-spirit-resist" classList={{ calc: calc()?.shown.spirit_resist != null }} class="spirit" title={tag(LABELS.spiritResist, calc()?.shown.spirit_resist)}>{value(calc()?.shown.spirit_resist, "%")}</b>
        </div>
        <div class="tb-build-power">
          <b data-testid="stat-weapon-damage" classList={{ calc: calc()?.shown.weapon_damage != null }} class="weapon" title={tag(LABELS.weaponDamage, calc()?.shown.weapon_damage)}>{value(calc()?.shown.weapon_damage, "%")}</b>
          <b data-testid="stat-spirit-power" classList={{ calc: calc()?.shown.spirit_power != null }} class="spirit" title={tag(LABELS.spiritPower, calc()?.shown.spirit_power)}>{value(calc()?.shown.spirit_power)}</b>
        </div>
      </div>
      <div class="tb-build-abilities" aria-label="Abilities">
        <Index each={abilities()}>{(a, i) => {
          const info = () => a().id == null ? undefined : record(a().id!);
          const name = () => info()?.label ?? `Ability ${i + 1}`;
          // Tags only (spec §4b): the name on hover; the state as a tag for screen readers.
          const label = () => `${name()}, ${a().level == null ? LABELS.missing : a().level === 0 ? "Locked" : `Tier ${a().level! - 1}`}`;
          return (
            <div class={cx("tb-build-ability", a().level === 0 && "locked")} data-ability-id={a().id} data-level={a().level ?? "unknown"} title={name()} role="img" aria-label={label()}>
              <div class="tb-build-levels" aria-hidden="true"><For each={[1, 2, 3]}>{n => <i classList={{ on: a().level != null && a().level! > n }} />}</For></div>
              <div class="tb-build-circle">
                <Show when={info()?.icon} fallback={<span class="tb-build-fallback">{i + 1}</span>}>{src => <img src={src()} alt="" />}</Show>
                <Show when={cooldown(a().entry)}>{cd => <span class="tb-build-cooldown">{cd().replace("s", "")}</span>}</Show>
                <Show when={a().entry?.charges != null}><span class="tb-build-charges">{a().entry!.charges}</span></Show>
                <Show when={a().level === 0}><span class="tb-build-locked" aria-hidden="true">×</span></Show>
              </div>
            </div>
          );
        }}</Index>
      </div>
      <Show when={build().abilities === null}><p class="tb-build-empty" title={LABELS.missing}>—</p></Show>
      <Show when={p.inspect}>
        <div class="tb-build-popovers">
          <ActiveEffects player={p.player} t={p.t} art={p.art} endDs={p.timeline ? p.timeline.duration_s * 10 : undefined} />
          <BuildOrder player={p.player} t={p.t} art={p.art} onSeek={p.onSeek} />
        </div>
      </Show>
      <div class="tb-build-items" aria-label="Equipped items">
        <Index each={build().items ?? []}>{entry => {
          const info = () => record(entry().id);
          const name = () => info()?.label ?? "Unknown item";
          const label = () => `${name()}${info()?.tier ? `, Tier ${tier(info()?.tier)}` : ""}`;
          return (
            <div class={cx("tb-build-item", info()?.slot)} data-item-id={entry().id} role="img" aria-label={label()} title={name()}>
              <Show when={info()?.icon} fallback={<span class="tb-build-fallback">?</span>}>{src => <img src={src()} alt="" />}</Show>
              <span class="tb-build-tier" aria-hidden="true">{tier(info()?.tier)}</span>
              <Show when={cooldown(entry())}>{cd => <span class="tb-build-cooldown">{cd()}</span>}</Show>
              <Show when={entry().charges != null}><span class="tb-build-charges">{entry().charges}</span></Show>
            </div>
          );
        }}</Index>
      </div>
      <Show when={!build().items?.length}><p class="tb-build-empty">{build().items === null ? "—" : "No items"}</p></Show>
    </section>
  );
}
