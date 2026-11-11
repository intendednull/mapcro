// Player's top bar (spec §6b): the in-game bar drawn from the match at playback time t, read-only.
// The same look as the scene's (board/TopBar.tsx): portraits, souls with team totals, ult rings,
// the dead greyed out with their respawn countdown (when the tier has it), the clock at t, and
// under a team's souls the Rejuvenator it holds: a mark per revive left, and its timer.
// Only what the match's tier has is shown: no ult data (the metadata tier) reads as untracked,
// never as ready.

import { hasVision, seenAt } from "./vision";
import { killsAt } from "../match/builds";
import { BuildColumn } from "./BuildColumn";
import { rosterTeamShort } from "../map/model";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { cx } from "../ui/cx";
import { formatSouls, teamTotal } from "../core/souls";
import { clockLabel, playersAt, scoreboardValueAt, rejuvAt, type PlayerAt, type RejuvNow } from "../match/timeline";
import { slotKey } from "../match/save";
import type { Art } from "../map/pack";
import { rosterTeamName } from "../map/model";
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

/** The Rejuvenator's natural length (crates/replay REJUV_S): its timer drains over it. */
const REJUV_S = 180;
/** The most revives the game draws (team_rejuv_1..4, .RejuvCount_1..4). */
const REJUV_MAX = 4;

/** Without the pack: a drawn stand-in for the game's winged mark (hud/icons/rejuvenator). */
const WING = "M10 0a2 2 0 1 1 0 4a2 2 0 1 1 0-4ZM0 5.5h5c1 2.2 3 3.4 5 3.4s4-1.2 5-3.4h5c0 1.6-1 2.6-3 2.6c-2 2.2-3.6 3.4-5 4l-1.4 8.4h-1.2L9 12.1c-1.4-.6-3-1.8-5-4c-2 0-3-1-3-2.6Z";
const wingsFb = (n: number) => {
  // The game's arrangement (team_rejuv_N): a shallow V, the inner marks lower.
  const xs = Array.from({ length: n }, (_, i) => 57.5 + (i - (n - 1) / 2) * 30);
  const marks = xs.map((x, i) => `<path transform="translate(${x - 14} ${Math.abs(i - (n - 1) / 2) < 1 ? 26 : 10}) scale(1.4)" d="${WING}" fill="#FFCC00"/>`);
  return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 115 65">${marks.join("")}</svg>`);
};

/**
 * A team's Rejuvenator under its souls, as the game draws it (#RejuvenatorFriendly / #RejuvenatorEnemy):
 * one gold winged mark per revive left, the game's image for that count, and no text. A change of
 * count crossfades (spec §4a); the data attributes and label keep the exact values.
 */
function RejuvBadge(p: { held: () => RejuvNow | undefined; team: "Amber" | "Sapphire"; side: "friend" | "enemy"; art: Art }) {
  const left = () => Math.min(REJUV_MAX, p.held()?.left ?? 0);
  return (
    <div
      class={cx("pl-rejuv", p.side, p.team.toLowerCase())}
      data-testid="tb-rejuv"
      data-team={p.team.toLowerCase()}
      data-left={left()}
      role={left() ? "img" : undefined}
      aria-label={left() ? `${rosterTeamName(p.team)} Rejuvenator: ${left()} revive${left() === 1 ? "" : "s"} left` : undefined}
      title={left() ? `${rosterTeamName(p.team)} Rejuvenator: ${left()} revive${left() === 1 ? "" : "s"} left` : undefined}
    >
      {Array.from({ length: REJUV_MAX }, (_, i) => (
        <img class={cx("pl-rejuv-icons", left() === i + 1 && "on")} data-n={i + 1} src={p.art.images.get(`rejuv-${i + 1}`) ?? wingsFb(i + 1)} alt="" />
      ))}
    </div>
  );
}

/**
 * The buff's natural end, as the game's #RejuvenatorTimer shows it: the winged mark on a dark disc,
 * ringed by an arc that drains from pickup to 180 s later. No text: the mid boss's label says the
 * time. Gone when the buff is (expired, or its revives spent). Beside the other's when both hold one.
 */
function RejuvTimer(p: { held: () => RejuvNow | undefined; taken: () => number | undefined; both: () => boolean; t: () => number; team: "Amber" | "Sapphire"; side: "friend" | "enemy"; art: Art }) {
  const on = () => (p.held()?.left ?? 0) > 0 && p.taken() != null;
  const frac = () => (on() ? Math.max(0, Math.min(1, (p.taken()! + REJUV_S - p.t()) / REJUV_S)) : 0);
  const img = () => p.art.images.get("rejuv-timer");
  return (
    <div class={cx("pl-rejuv-timer", p.side, p.team.toLowerCase(), on() && "on", p.both() && "both")} data-testid="tb-rejuv-timer" data-team={p.team.toLowerCase()} data-frac={frac().toFixed(3)} aria-hidden="true">
      <svg viewBox="0 0 30 30">
        <circle class="pl-rejuv-disc" cx="15" cy="15" r="13.5" />
        <Show when={img()} fallback={<path class="pl-rejuv-mark" transform="translate(6 6.5) scale(0.9)" d={WING} />}>
          <image class="pl-rejuv-mark" href={img()} x="3" y="3" width="24" height="24" />
        </Show>
        <circle class="pl-rejuv-track" cx="15" cy="15" r="13.5" />
        {/* 0..100 so only time eases, as the ult rings do. */}
        <circle class="pl-rejuv-ring" cx="15" cy="15" r="13.5" transform="rotate(-90 15 15)" pathLength="100" style={{ "stroke-dasharray": `${(frac() * 100).toFixed(2)} 100` }} />
      </svg>
    </div>
  );
}

export function PlayerTopBar(p: {
  host: PlayerHost;
  state: BoardState;
  art: Art;
  vp: Viewpoint;
  compact?: boolean;
  /** A click on a hero's portrait focuses it on the map at t (Board's focusHero). */
  onFocus?: (team: string, slot: number) => void;
}) {
  let el!: HTMLDivElement;
  const [unit, setUnit] = createSignal(1);
  const [openBuild, setOpenBuild] = createSignal<string>();
  const [allBuilds, setAllBuilds] = createSignal(false);
  const [tabHeld, setTabHeld] = createSignal(false);
  const expanded = (key: string) => tabHeld() || allBuilds() || openBuild() === key;
  const closeBuilds = () => { setOpenBuild(undefined); setAllBuilds(false); };
  const toggleAll = () => { setOpenBuild(undefined); setAllBuilds(v => !v); };
  const toggleBuild = (key: string) => {
    const wasOpen = expanded(key);
    setAllBuilds(false);
    setOpenBuild(wasOpen ? undefined : key);
  };
  createEffect(() => { p.host.matchId(); closeBuilds(); });
  onMount(() => {
    setUnit(el.clientWidth / BAR || 1);
    const ro = new ResizeObserver(() => setUnit(el.clientWidth / BAR));
    ro.observe(el);
    const outside = (event: PointerEvent) => {
      if (!el.contains(event.target as Node) && !(event.target as Element).closest(".pl-bar")) closeBuilds();
    };
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')) return;
      if (event.key === "Escape" && (allBuilds() || openBuild())) {
        closeBuilds();
        event.preventDefault();
      }
      // Like the game's scoreboard: holding Tab temporarily reveals every build.
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        setTabHeld(true);
      }
    };
    const release = (event: KeyboardEvent) => { if (event.key === "Tab") setTabHeld(false); };
    const blur = () => setTabHeld(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key);
    onCleanup(() => {
      ro.disconnect();
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", blur);
    });
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
  const rejuv = createMemo(() => {
    const m = p.host.tl();
    return m ? rejuvAt(m, p.host.t()) : [];
  });
  const held = (t: "Amber" | "Sapphire") => rejuv().find((r) => r.team === t.toLowerCase());
  // When the held one was taken: its timer drains from there.
  const taken = (t: "Amber" | "Sapphire") => {
    const h = held(t);
    return h && p.host.tl()?.rejuv?.find((r) => r.team === h.team && r.ends_s === h.ends)?.taken_s;
  };
  // Changing values ease (spec §4a): the totals count to each new value.
  const shown = { Amber: easedNumber(() => (known("Amber") ? total("Amber") : null)), Sapphire: easedNumber(() => (known("Sapphire") ? total("Sapphire") : null)) };

  const column = (t: "Amber" | "Sapphire", side: "friend" | "enemy") => (
    <div class={`tb-team ${side} ${t.toLowerCase()}`}>
      <For each={team(t)}>
        {(s) => {
          const x = () => at().get(slotKey(t, s.slot.slot));
          const hero = () => (x() ? p.art.heroes.get(x()!.hero_id) : undefined);
          const label = () => s.slot.name || `${rosterTeamShort(t)} ${s.slot.slot + 1}`;
          const dead = () => !!x() && x()!.pos === null;
          const unseen = () => {
            const tl = p.host.tl(), view = p.host.vision();
            if (!tl || view === "all" || view === t.toLowerCase() || !hasVision(tl)) return false;
            const player = tl.players.find(q => q.team === t.toLowerCase() && q.slot === s.slot.slot);
            return !!player && !seenAt(player, p.host.t())?.seen;
          };
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
              class={cx("tb-player", t.toLowerCase(), side, hasCard(p.art, hero()) && "card-art", dead() && "dead", unseen() && "unseen", low() && "health-low", expanded(slotKey(t, s.slot.slot)) && "build-open")}
              data-slot={`${t}-${s.slot.slot}`}
              data-hero={x()?.hero_id ?? ""}
              data-alive={x() ? String(!dead()) : "unknown"}
              data-seen={String(!unseen())}
              title={`${label()}${hero() ? `, ${hero()!.name}` : ""}`}
            >
              <button type="button" class="tb-souls tb-build-trigger" data-testid="souls-banner"
                aria-label={`Build for ${hero()?.name ?? label()}`} aria-expanded={expanded(slotKey(t, s.slot.slot))}
                aria-controls={`build-${t}-${s.slot.slot}`} onClick={() => toggleBuild(slotKey(t, s.slot.slot))}>
                <span class="tb-souls-value" data-testid="souls" data-souls={x()?.souls ?? "untracked"}>
                  <Show when={souls() != null} fallback={"–"}>
                    <Souls n={Math.round(souls()!)} />
                  </Show>
                </span>
              </button>
              {/* The hero badge; low health swaps in the critical card (m_strIconHeroCardCritical), as the HUD does. */}
              <HeroBadge art={p.art} slot={s.slot} hero={hero()} low={low()} />
              <Show when={unseen()}><span class="tb-vis off" data-testid="tb-vision" title="Not seen by the selected team" role="img" aria-label="Not seen by the selected team">
                <svg viewBox="-8 -8 16 16" aria-hidden="true"><path d="M-6 0s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4z M-6 6L6 -6" /></svg>
              </span></Show>
              <Show when={x()}>
                <button class="tb-focus" data-testid="focus-hero" title={`Inspect ${hero()?.name ?? label()} build and show on map`} aria-label={`Inspect ${label()}${hero() ? `, ${hero()!.name},` : ""} build and show on the map`} aria-expanded={expanded(slotKey(t, s.slot.slot))} aria-controls={`build-${t}-${s.slot.slot}`} onClick={() => { toggleBuild(slotKey(t, s.slot.slot)); p.onFocus?.(t, s.slot.slot); }} />
              </Show>
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
              {/* As the Tab scoreboard: the hero level in a ringed disc on the portrait's lower edge. */}
              <Show when={expanded(slotKey(t, s.slot.slot)) && scoreboardValueAt(p.host.tl()?.players.find(q => q.team === t.toLowerCase() && q.slot === s.slot.slot)?.level, p.host.t())}>
                {lv => <span class="tb-level" data-testid="tb-level" title="Hero level">{lv()}</span>}
              </Show>
              <Ult left={x()?.ult ?? null} label={label()} />
              <Show when={expanded(slotKey(t, s.slot.slot)) && p.host.tl()?.players.find(q => q.team === t.toLowerCase() && q.slot === s.slot.slot)}>
                {player => <BuildColumn inspect={!allBuilds() && !tabHeld()} player={player()} timeline={p.host.tl()} t={p.host.t()} art={p.art} hero={hero()} name={nameOf()} id={`build-${t}-${s.slot.slot}`} />}
              </Show>
              <Show when={nameOf()}>
                <span class="pl-tb-name replay" data-testid="tb-name">
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
      class={cx("tb-host", "pl-topbar", p.art.images.has("tb-mask") && "pack-art", p.compact && "compact", named() && "named", (allBuilds() || tabHeld()) && "all-builds")}
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
          <button type="button" class="tb-all-builds" aria-expanded={allBuilds() || tabHeld()} onClick={toggleAll} title="Show all hero builds (or hold Tab)">
            {allBuilds() || tabHeld() ? "▴" : "▾"} All builds <kbd>Hold Tab</kbd>
          </button>
          <Show when={allBuilds() || tabHeld()}>
            <div class="tb-build-team-kills"><b>{killsAt(p.host.tl(), p.host.t(), friend().toLowerCase()) ?? "—"}</b><span>Kills</span><b>{killsAt(p.host.tl(), p.host.t(), enemy().toLowerCase()) ?? "—"}</b></div>
          </Show>
          <div class="tb-scores">
            {score(friend(), false)}
            {score(enemy(), true)}
          </div>
          <RejuvBadge held={() => held(friend())} team={friend()} side="friend" art={p.art} />
          <RejuvBadge held={() => held(enemy())} team={enemy()} side="enemy" art={p.art} />
          <RejuvTimer held={() => held(friend())} taken={() => taken(friend())} both={() => !!held(enemy())} t={p.host.t} team={friend()} side="friend" art={p.art} />
          <RejuvTimer held={() => held(enemy())} taken={() => taken(enemy())} both={() => !!held(friend())} t={p.host.t} team={enemy()} side="enemy" art={p.art} />
        </div>
      </div>
    </div>
  );
}
