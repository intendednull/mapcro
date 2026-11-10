// The HUD's PlayerNameNWContainer: abilities above the two-column inventory.
import { For, Index, Show, createMemo } from "solid-js";
import type { Art, Hero } from "../map/pack";
import { buildAt, killsAt, type BuildEntry } from "../match/builds";
import { scoreboardValueAt, type Timeline, type TimelinePlayer } from "../match/timeline";
import { cx } from "../ui/cx";

export function BuildColumn(p: { player: TimelinePlayer; timeline: Timeline | undefined; t: number; art: Art; hero: Hero | undefined; name: string | undefined; id: string }) {
  const build = createMemo(() => buildAt(p.player, p.t));
  const record = (id: number) => p.art.buildCatalog?.records.get(id);
  const abilityIds = () => p.hero?.abilities?.length ? p.hero.abilities : (build().abilities ?? []).map(a => a.id);
  const abilities = () => Array.from({ length: 4 }, (_, i) => {
    const id = abilityIds()[i];
    const entry = build().abilities?.find(a => a.id === id);
    return { id, entry, level: id == null || build().abilities === null ? null : (entry?.level ?? 0) };
  });
  const cooldown = (entry: BuildEntry | undefined) => entry?.cooldown != null && entry.cooldown > 0 ? `${Math.ceil(entry.cooldown)}s` : undefined;
  const detail = (entry: BuildEntry | undefined) => {
    const cd = entry?.cooldown;
    return `${cd == null ? "Cooldown unavailable" : cd > 0 ? `${Math.ceil(cd)}s cooldown` : "Cooldown complete"}${entry?.charges != null ? ` · ${entry.charges} charges` : ""}`;
  };
  const kills = createMemo(() => p.player.kills != null ? scoreboardValueAt(p.player.kills, p.t) : killsAt(p.timeline, p.t, p.player.team, p.player.slot));
  const assists = () => scoreboardValueAt(p.player.assists, p.t);
  const level = () => scoreboardValueAt(p.player.level, p.t);
  const maxHealth = () => scoreboardValueAt(p.player.max_health, p.t);
  const deaths = createMemo(() => p.player.deaths.filter(t => t <= p.t).length);
  const investment = createMemo(() => {
    const values = { weapon: 0, vitality: 0, spirit: 0 };
    for (const item of build().items ?? []) {
      const info = record(item.id);
      if (info?.slot && info.cost != null) values[info.slot] += info.cost;
    }
    return values;
  });
  const investmentMax = () => Math.max(1, ...Object.values(investment()));
  const tier = (n?: number) => n ? ["", "I", "II", "III", "IV", "V"][n] ?? String(n) : "";
  return (
    <section id={p.id} class="tb-build-column" data-testid="hero-build" aria-label={`${p.hero?.name ?? "Hero"} abilities and items`}>
      <Show when={p.name}><div class="tb-build-name">{p.name}</div></Show>
      <div class="tb-build-hero">{p.hero?.name ?? "Hero"}</div><Show when={level() != null}><div class="tb-build-hero-level" title="Hero level">Lv {level()}</div></Show>
      <div class="tb-build-kda" aria-label="Kills, deaths, assists">
        <div title={kills() == null ? "Kill attribution is unavailable in this replay" : "Kills"}><small>K</small><b>{kills() ?? "—"}</b></div>
        <div><small>D</small><b>{deaths()}</b></div>
        <div title={assists() == null ? "Assists are unavailable in this replay" : "Assists"}><small>A</small><b>{assists() ?? "—"}</b></div>
      </div>
      <div class="tb-build-investment" aria-label="Equipped item value by category">
        <For each={["weapon", "spirit", "vitality"] as const}>{category =>
          <span class={category} title={`${category}: ${investment()[category].toLocaleString()} souls in equipped items (current shop prices)`}>
            <i style={{ height: `${investment()[category] / investmentMax() * 100}%` }} />
          </span>
        }</For>
      </div>
      <div class="tb-build-vitals">
        <div title={maxHealth() == null ? "Maximum health is unavailable in this replay" : "Maximum health"}><span aria-hidden="true">♥</span> {maxHealth()?.toLocaleString() ?? "—"}</div>
        <div class="tb-build-resists" title="Bullet and spirit resistance are not recorded in this replay"><span aria-hidden="true">⛨</span> — &nbsp; —</div>
      </div>
      <div class="tb-build-abilities" aria-label="Abilities">
        <Index each={abilities()}>{(a, i) => {
          const info = () => a().id == null ? undefined : record(a().id!);
          const label = () => `${info()?.label ?? `Ability ${i + 1}`} · ${a().level == null ? "Upgrade data unavailable" : a().level === 0 ? "Locked" : `Unlocked · Tier ${a().level! - 1}/3`} · ${detail(a().entry)}`;
          return (
            <div class={cx("tb-build-ability", a().level === 0 && "locked")} data-ability-id={a().id} data-level={a().level ?? "unknown"} title={label()} role="img" aria-label={label()}>
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
      <Show when={build().abilities === null}><p class="tb-build-empty">Upgrades unavailable</p></Show>
      <div class="tb-build-items" aria-label="Equipped items">
        <Index each={build().items ?? []}>{entry => {
          const info = () => record(entry().id);
          const label = () => `${info()?.label ?? "Unknown item"}${info()?.tier ? ` · Tier ${tier(info()?.tier)}` : ""}${info()?.slot ? ` · ${info()!.slot}` : ""} · ${detail(entry())}`;
          return (
            <div class={cx("tb-build-item", info()?.slot)} data-item-id={entry().id} role="img" aria-label={label()} title={label()}>
              <Show when={info()?.icon} fallback={<span class="tb-build-fallback">?</span>}>{src => <img src={src()} alt="" />}</Show>
              <span class="tb-build-tier" aria-hidden="true">{tier(info()?.tier)}</span>
              <Show when={cooldown(entry())}>{cd => <span class="tb-build-cooldown">{cd()}</span>}</Show>
              <Show when={entry().charges != null}><span class="tb-build-charges">{entry().charges}</span></Show>
            </div>
          );
        }}</Index>
      </div>
      <Show when={!build().items?.length}><p class="tb-build-empty">{build().items === null ? "Items unavailable" : "No items yet"}</p></Show>
    </section>
  );
}
