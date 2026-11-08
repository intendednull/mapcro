// Player's top bar (spec §6b): the in-game bar drawn from the match at playback time t, read-only.
// The same look as the scene's (board/TopBar.tsx): portraits, souls with team totals, ult rings,
// the dead greyed out, and the clock at t. Only what the match's tier has is shown: no ult data
// (the metadata tier) reads as untracked, never as ready.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { cx } from "../ui/cx";
import { formatSouls, teamTotal } from "../core/souls";
import { clockLabel, playersAt, type PlayerAt } from "../match/timeline";
import { slotKey } from "../match/save";
import type { Art } from "../map/pack";
import type { Viewpoint } from "../map/transform";
import type { BoardState } from "../board/state";
import { initials } from "../board/Tokens";
import type { PlayerHost } from "./host";

const BAR = 1260;
/** Health at or under this percent reads as low (red). */
export const LOW = 30;

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

  const column = (t: "Amber" | "Sapphire", side: "friend" | "enemy") => (
    <div class={`tb-team ${side} ${t.toLowerCase()}`}>
      <For each={team(t)}>
        {(s) => {
          const x = () => at().get(slotKey(t, s.slot.slot));
          const hero = () => (x() ? p.art.heroes.get(x()!.hero_id) : undefined);
          const label = () => s.slot.name || `${t} ${s.slot.slot + 1}`;
          const dead = () => !!x() && x()!.pos === null;
          const nameOf = () => p.host.tl()?.players.find((q) => q.team === t.toLowerCase() && q.slot === s.slot.slot)?.name ?? undefined;
          return (
            <div
              class={cx("tb-player", t.toLowerCase(), side, dead() && "dead")}
              data-slot={`${t}-${s.slot.slot}`}
              data-hero={x()?.hero_id ?? ""}
              data-alive={x() ? String(!dead()) : "unknown"}
              title={`${label()}${hero() ? `, ${hero()!.name}` : ""}`}
            >
              <div class="tb-souls" data-testid="souls-banner">
                <span class="tb-souls-value" data-testid="souls" data-souls={x()?.souls ?? "untracked"}>
                  <Show when={x()?.souls != null} fallback={"–"}>
                    <Souls n={x()!.souls} />
                  </Show>
                </span>
              </div>
              <div class="tb-badge">
                <i class="tb-disc">{initials(s.slot, hero()?.name)}</i>
                <Show when={hero()?.topbar}>{(src) => <i class="tb-img hero-vertical" style={{ "background-image": `url(${JSON.stringify(src())})` }} />}</Show>
              </div>
              <Show when={p.host.showHealth() && x()?.health != null}>
                <div class={cx("pl-hp", (x()!.health ?? 0) <= LOW && "low")} data-testid="tb-health" data-health={x()!.health} aria-label={`${label()} health ${x()!.health}%`}>
                  <i style={{ width: `${x()!.health}%` }} />
                </div>
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
          <Show when={known(t)} fallback={"–"}>
            <Souls n={total(t)} />
          </Show>
        </span>
        <Show when={!right}>
          <i class="tb-team-icon" />
        </Show>
      </div>
    </div>
  );

  return (
    <div
      ref={el}
      class={cx("tb-host", "pl-topbar", p.art.images.has("tb-mask") && "pack-art", p.compact && "compact")}
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
