// Player's top bar (spec §6b): the in-game bar drawn from the match at playback time t, read-only.
// The same look as the scene's (board/TopBar.tsx): portraits, souls with team totals, ult rings,
// the dead greyed out with their respawn countdown (when the tier has it), and the clock at t.
// Only what the match's tier has is shown: no ult data (the metadata tier) reads as untracked,
// never as ready.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { cx } from "../ui/cx";
import { formatSouls, teamTotal } from "../core/souls";
import { clockLabel, playersAt, type PlayerAt } from "../match/timeline";
import { slotKey } from "../match/save";
import type { Art } from "../map/pack";
import type { Viewpoint } from "../map/transform";
import type { BoardState } from "../board/state";
import { HeroBadge, hasCard } from "../board/HeroBadge";
import { easedNumber } from "../board/smooth";
import type { PlayerHost } from "./host";

const BAR = 1260;
/**
 * Health at or under this percent puts a portrait in the HUD's `.healthLow` state. The game sets
 * that class from code, so its threshold isn't in the panorama files; 30 is ours, the same as
 * the map tokens' red arc (board/Tokens.tsx).
 */
export const LOW_HEALTH = 30;

function Souls(p: { n: number | null }) {
  const f = () => formatSouls(p.n);
  return (
    <>
      {f().value}
      <Show when={f().k}>
        <span class="demote">k</span>
      </Show>
    </>
  );
}

/** The scene bar's ult ring, read-only. */
function Ult(p: { left: number | null; label: string }) {
  const u = () => p.left;
  return (
    <div
      class={cx("tb-ult", u() == null && "untracked", u() != null && u()! <= 0 && "ready", u() != null && u()! > 0 && "cooldown")}
      style={u() != null && u()! > 0 ? { "--left": `${Math.min(100, u()!)}%` } : {}}
      data-testid="ult"
      data-ult={u() == null ? "untracked" : String(u())}
      aria-label={`${p.label} ult cooldown`}
      title={u() == null ? "Ult: untracked" : u()! <= 0 ? "Ult ready" : `Ult ${Math.round(u()!)}%`}
    >
      <i class="tb-ult-bg" />
      <i class="tb-ult-icon" />
      <i class="tb-ult-sweep" />
      <i class="tb-ult-fb" />
    </div>
  );
}

export function PlayerTopBar(p: { host: PlayerHost; state: BoardState; art: Art; vp: Viewpoint; compact?: boolean }) {
  let el!: HTMLDivElement;
  const [unit, setUnit] = createSignal(1);
  onMount(() => {
    setUnit(el.clientWidth / BAR || 1);
    const ro = new ResizeObserver(() => setUnit(el.clientWidth / BAR));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  const friend = () => (p.vp === "sapphire" ? "Sapphire" : "Amber");
  const enemy = () => (friend() === "Amber" ? "Sapphire" : "Amber");
  const at = createMemo(() => {
    const m = p.host.tl();
    return m ? new Map(playersAt(m, p.host.t()).map((x) => [slotKey(x.team, x.slot), x])) : new Map<string, PlayerAt>();
  });
  // Rows by the roster's slots, so the order and names are the board's; the hero is the match's.
  const team = (t: "Amber" | "Sapphire") => p.state.roster().filter((s) => s.slot.team === t);
  const total = (t: "Amber" | "Sapphire") => teamTotal(team(t).map((s) => at().get(slotKey(t, s.slot.slot))?.souls ?? null));
  const known = (t: "Amber" | "Sapphire") => team(t).some((s) => at().get(slotKey(t, s.slot.slot))?.souls != null);
  // Changing values ease (spec §4a): the totals count to each new value.
  const shown = { Amber: easedNumber(() => (known("Amber") ? total("Amber") : null)), Sapphire: easedNumber(() => (known("Sapphire") ? total("Sapphire") : null)) };

  const column = (t: "Amber" | "Sapphire", side: "friend" | "enemy") => (
    <div class={`tb-team ${side} ${t.toLowerCase()}`}>
      <For each={team(t)}>
        {(s) => {
          const x = () => at().get(slotKey(t, s.slot.slot));
          const hero = () => (x() ? p.art.heroes.get(x()!.hero_id) : undefined);
          const label = () => s.slot.name || `${t} ${s.slot.slot + 1}`;
          const dead = () => !!x() && x()!.pos === null;
          const nameOf = () => p.host.playerName(t.toLowerCase(), s.slot.slot);
          /** Health to draw: replay tier, Health on, alive (.Dead #HealthBar collapses). */
          const hp = () => (p.host.showHealth() && !dead() && x()?.health != null ? Math.max(0, Math.min(100, x()!.health!)) : null);
          const low = () => hp() != null && hp()! <= LOW_HEALTH;
          // Changing values ease (spec §4a): souls count to each new value, and the respawn
          // countdown runs down through the seconds a scrub skips. Shown rounded from the eased
          // value; the data attributes keep the exact one.
          const souls = easedNumber(() => x()?.souls ?? null);
          const respawn = easedNumber(() => (dead() ? (x()?.respawn ?? null) : null));
          return (
            <div
              class={cx("tb-player", t.toLowerCase(), side, hasCard(p.art, hero()) && "card-art", dead() && "dead", low() && "health-low")}
              data-slot={`${t}-${s.slot.slot}`}
              data-hero={x()?.hero_id ?? ""}
              data-alive={x() ? String(!dead()) : "unknown"}
              title={`${label()}${hero() ? `, ${hero()!.name}` : ""}`}
            >
              <div class="tb-souls" data-testid="souls-banner">
                <span class="tb-souls-value" data-testid="souls" data-souls={x()?.souls ?? "untracked"}>
                  <Show when={souls() != null} fallback={"–"}>
                    <Souls n={Math.round(souls()!)} />
                  </Show>
                </span>
              </div>
              {/* The hero badge; low health swaps in the critical card (m_strIconHeroCardCritical), as the HUD does. */}
              <HeroBadge art={p.art} slot={s.slot} hero={hero()} low={low()} />
              <Show when={dead() && x()?.respawn != null && respawn() != null}>
                <span class="tb-respawn" data-testid="tb-respawn" data-respawn={Math.ceil(x()!.respawn!)} aria-label={`${label()} respawns in ${Math.ceil(x()!.respawn!)} s`}>
                  {Math.ceil(respawn()!)}
                </span>
              </Show>
              {/* #HealthBar (citadel_hud_top_bar.vcss): the HUD's slanted card at the portrait's
                  edge, filled from the bottom. */}
              <Show when={hp() != null}>
                <div class="tb-health" data-testid="tb-health" data-health={hp()!} aria-label={`${label()} health ${hp()}%`}>
                  <i class="tb-health-back" />
                  <i class="tb-health-fill" style={{ height: `${hp()}%` }} />
                  <i class="tb-health-border" />
                </div>
              </Show>
              {/* #CriticalIndicator: shown in .healthLow. */}
              <Show when={low()}>
                <span class="tb-critical" data-testid="tb-critical">
                  <span>Critical</span>
                </span>
              </Show>
              <Ult left={x()?.ult ?? null} label={label()} />
              <Show when={nameOf()}>
                <span class="pl-tb-name" data-testid="tb-name">
                  {nameOf()}
                </span>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
  const score = (t: "Amber" | "Sapphire", right: boolean) => (
    <div class={cx("tb-score", t.toLowerCase(), right && "right")} data-testid={`total-${t}`} data-souls={known(t) ? total(t) : "untracked"}>
      <i class="tb-score-bg" />
      <div class="tb-score-row">
        <Show when={right}>
          <i class="tb-team-icon" />
        </Show>
        <span class="tb-score-label">
          <Show when={shown[t]() != null} fallback={"–"}>
            <Souls n={Math.round(shown[t]()!)} />
          </Show>
        </span>
        <Show when={!right}>
          <i class="tb-team-icon" />
        </Show>
      </div>
    </div>
  );

  /** Any player names to show: the bar then keeps room for them under it (QA 2026-11-08). */
  const named = () => p.host.showNames() && !!p.host.tl()?.players.some((q) => q.name);
  return (
    <div
      ref={el}
      class={cx("tb-host", "pl-topbar", p.art.images.has("tb-mask") && "pack-art", p.compact && "compact", named() && "named")}
      style={{ "--u": `${unit()}px` }}
      data-testid="topbar"
      data-mode="player"
    >
      <div class="tb-bar">
        {column(friend(), "friend")}
        {column(enemy(), "enemy")}
        <div class="tb-center">
          <div class="tb-clock">
            <span class="tb-clock-label" data-testid="tb-clock">
              {clockLabel(p.host.t())}
            </span>
          </div>
          <div class="tb-scores">
            {score(friend(), false)}
            {score(enemy(), true)}
          </div>
        </div>
      </div>
    </div>
  );
}
