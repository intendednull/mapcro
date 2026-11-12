// Player's top bar (spec §6b): the in-game bar drawn from the match at playback time t, read-only.
// Built from the same parts as the scene's (board/TopBarParts.tsx), so the two look the same:
// portraits, souls with team totals, ult rings,
// the dead greyed out with their respawn countdown (when the tier has it), the clock at t, and
// under a team's souls the Rejuvenator it holds: a mark per revive left, and its timer.
// Only what the match's tier has is shown: no ult data (the metadata tier) reads as untracked,
// never as ready.

import { hasVision, seenAt } from "./vision";
import { killsAt } from "../match/builds";
import { BuildColumn } from "./BuildColumn";
import { GameTip, Hover, TagTip, useTooltips } from "./GameTooltip";
import { rejuvTip } from "./Camps";
import { buildAt } from "../match/builds";
import { rosterTeamShort } from "../map/model";
import { For, Show, batch, createMemo, createResource, onCleanup, onMount } from "solid-js";
import { ladderKeyFor, loadStatTable, tableKeyFor, type LoadedTable } from "../match/stats";
import { cx } from "../ui/cx";
import { boardKeys } from "../core/keys";
import { modalOpen } from "../ui/modal";
import { teamTotal } from "../core/souls";
import { clockLabel, playersAt, scoreboardValueAt, rejuvAt, type PlayerAt, type RejuvNow } from "../match/timeline";
import { slotKey } from "../match/save";
import type { Art } from "../map/pack";
import { rosterTeamName } from "../map/model";
import type { Viewpoint } from "../map/transform";
import type { BoardState } from "../board/state";
import { BarClock, EyeIcon, PortraitSlot, Souls, TeamColumn, TeamScore, TopBarFrame, UltDial, portraitTitle } from "../board/TopBarParts";
import { slotName } from "../board/roster";
import { easedNumber } from "../board/smooth";
import type { PlayerHost } from "./host";

/**
 * Health at or under this percent puts a portrait in the HUD's `.healthLow` state. The game sets
 * that class from code, so its threshold isn't in the panorama files; 30 is ours, the same as
 * the map tokens' red arc (board/Tokens.tsx).
 */
export const LOW_HEALTH = 30;

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
      aria-label={left() ? `${rosterTeamName(p.team)} Rejuvenator, ${left()} revive${left() === 1 ? "" : "s"}` : undefined}
      title={left() ? `${rosterTeamName(p.team)} Rejuvenator` : undefined}
    >
      {Array.from({ length: REJUV_MAX }, (_, i) => (
        <img class={cx("pl-rejuv-icons", left() === i + 1 && "on")} data-n={i + 1} src={p.art.images.get(`rejuv-${i + 1}`) ?? wingsFb(i + 1)} alt="" />
      ))}
    </div>
  );
}

/**
 * The buff's natural end, as the game's #RejuvenatorTimer shows it: the winged mark on a dark disc,
 * ringed by an arc that drains from pickup to 180 s later. No text on it; its hover says the time
 * left ("Archmother Rejuvenator ends in 1:40", feedback #44), at once like the panel's tags. Gone
 * when the buff is (expired, or its revives spent), and with it the hover. Beside the other's when
 * both hold one.
 */
function RejuvTimer(p: { held: () => RejuvNow | undefined; taken: () => number | undefined; both: () => boolean; t: () => number; team: "Amber" | "Sapphire"; side: "friend" | "enemy"; art: Art }) {
  const on = () => (p.held()?.left ?? 0) > 0 && p.taken() != null;
  const frac = () => (on() ? Math.max(0, Math.min(1, (p.taken()! + REJUV_S - p.t()) / REJUV_S)) : 0);
  const img = () => p.art.images.get("rejuv-timer");
  const tip = () => (on() ? rejuvTip(p.held()!, p.t()) : undefined);
  return (
    <Hover tip={() => tip() && <TagTip text={tip()!} />}>
      <div class={cx("pl-rejuv-timer", p.side, p.team.toLowerCase(), on() && "on", p.both() && "both")} data-testid="tb-rejuv-timer" data-team={p.team.toLowerCase()} data-frac={frac().toFixed(3)} role={tip() ? "img" : undefined} aria-label={tip()} aria-hidden={tip() ? undefined : "true"}>
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
    </Hover>
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
  /** A build-order row: seek the replay there. */
  onSeek?: (t: number) => void;
}) {
  let el!: HTMLDivElement;
  // The host's, so a follower opens the builds its presenter opens (spec §8).
  const { openBuild, setOpenBuild, allBuilds, setAllBuilds, tabHeld, setTabHeld } = p.host;
  const popover = { open: p.host.buildPopover, set: p.host.setBuildPopover };
  const expanded = (key: string) => tabHeld() || allBuilds() || openBuild() === key;
  // A build opens with neither popover open, as a fresh one did when the popovers were the DOM's.
  const closeBuilds = () => batch(() => { setOpenBuild(undefined); setAllBuilds(false); p.host.setBuildPopover("none"); });
  const toggleAll = () => batch(() => { setOpenBuild(undefined); setAllBuilds(v => !v); p.host.setBuildPopover("none"); });
  const toggleBuild = (key: string) => {
    const wasOpen = expanded(key);
    batch(() => {
      setAllBuilds(false);
      setOpenBuild(wasOpen ? undefined : key);
      p.host.setBuildPopover("none");
    });
  };
  // The replay build's stat table (calculated stats) and the investment ladder's (match/stats.ts).
  const build = () => p.host.tl()?.build;
  const [statTable] = createResource(() => tableKeyFor(p.art.stats, build()) ?? false, key => loadStatTable(p.art.stats, key || null));
  // A resource keeps its last value while the next key loads: never show another patch's numbers.
  const current = (t: LoadedTable | undefined, key: string | null) => t && key && p.art.stats?.tables.get(key)?.clientVersion === t.data.client_version ? t : undefined;
  // The ult indicator's hover: the hero's ultimate's tooltip (feedback #9), its tiers at t.
  const tips = useTooltips(() => p.art, build);
  const [ladderTable] = createResource(() => ladderKeyFor(p.art.stats, build()) ?? false, key => loadStatTable(p.art.stats, key || null));
  onMount(() => {
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
    };
    // Like the game's scoreboard: holding Tab reveals every build, wherever the focus is (#24, as
    // Space in Player.tsx): a focused button, list or the scrubber doesn't move focus on. A text
    // field, an open dialog or menu keeps its Tab. Shift+Tab still moves focus back, so the
    // keyboard can reach the controls. Captured, so no control's own handler sees it first.
    const tabDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      if (modalOpen() || !boardKeys(event.target as Element | null)) return;
      event.preventDefault();
      setTabHeld(true);
    };
    const release = (event: KeyboardEvent) => { if (event.key === "Tab") setTabHeld(false); };
    const blur = () => setTabHeld(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key);
    window.addEventListener("keydown", tabDown, true);
    onCleanup(() => {
      window.removeEventListener("keydown", tabDown, true);
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
    <TeamColumn team={t} side={side}>
      <For each={team(t)}>
        {(s) => {
          const x = () => at().get(slotKey(t, s.slot.slot));
          const hero = () => (x() ? p.art.heroes.get(x()!.hero_id) : undefined);
          const nameOf = () => p.host.playerName(t.toLowerCase(), s.slot.slot);
          // As the scene's bar and the tokens: the match's name, else the one typed into the slot.
          const label = () => slotName(nameOf() ?? "", s.slot.name) || `${rosterTeamShort(t)} ${s.slot.slot + 1}`;
          const dead = () => !!x() && x()!.pos === null;
          const unseen = () => {
            const tl = p.host.tl(), view = p.host.vision();
            if (!tl || view === "all" || view === t.toLowerCase() || !hasVision(tl)) return false;
            const player = tl.players.find(q => q.team === t.toLowerCase() && q.slot === s.slot.slot);
            return !!player && !seenAt(player, p.host.t())?.seen;
          };
          /** Health to draw: replay tier, Health on, alive (.Dead #HealthBar collapses). */
          const hp = () => (p.host.showHealth() && !dead() && x()?.health != null ? Math.max(0, Math.min(100, x()!.health!)) : null);
          const low = () => hp() != null && hp()! <= LOW_HEALTH;
          const key = slotKey(t, s.slot.slot);
          const player = () => p.host.tl()?.players.find(q => q.team === t.toLowerCase() && q.slot === s.slot.slot);
          // Changing values ease (spec §4a): souls count to each new value, and the respawn
          // countdown runs down through the seconds a scrub skips. Shown rounded from the eased
          // value; the data attributes keep the exact one.
          const souls = easedNumber(() => x()?.souls ?? null);
          const respawn = easedNumber(() => (dead() ? (x()?.respawn ?? null) : null));
          return (
            <PortraitSlot
              team={t}
              side={side}
              roster={s.slot}
              art={p.art}
              hero={hero()}
              dead={dead()}
              unseen={unseen()}
              // Low health swaps in the critical card (m_strIconHeroCardCritical), as the HUD does.
              low={low()}
              class={expanded(key) && "build-open"}
              data-hero={x()?.hero_id ?? ""}
              data-alive={x() ? String(!dead()) : "unknown"}
              data-seen={String(!unseen())}
              title={portraitTitle(label(), hero())}
              souls={
                <button type="button" class="tb-souls tb-build-trigger" data-testid="souls-banner"
                  aria-label={`${hero()?.name ?? label()} build`} aria-expanded={expanded(key)}
                  aria-controls={`build-${t}-${s.slot.slot}`} onClick={() => toggleBuild(key)}>
                  <span class="tb-souls-value" data-testid="souls" data-souls={x()?.souls ?? "untracked"}>
                    <Show when={souls() != null} fallback={"–"}>
                      <Souls n={Math.round(souls()!)} />
                    </Show>
                  </span>
                </button>
              }
            >
              <Show when={unseen()}><span class="tb-vis off" data-testid="tb-vision" title="Not seen" role="img" aria-label="Not seen">
                <EyeIcon off />
              </span></Show>
              <Show when={x()}>
                <button class="tb-focus" data-testid="focus-hero" title={`Inspect ${hero()?.name ?? label()}`} aria-label={`Inspect ${label()}${hero() ? `, ${hero()!.name}` : ""}`} aria-expanded={expanded(key)} aria-controls={`build-${t}-${s.slot.slot}`} onClick={() => { toggleBuild(key); p.onFocus?.(t, s.slot.slot); }} />
              </Show>
              <Show when={dead() && x()?.respawn != null && respawn() != null}>
                <span class="tb-respawn" data-testid="tb-respawn" data-respawn={Math.ceil(x()!.respawn!)} aria-label={`${label()} respawn, ${Math.ceil(x()!.respawn!)} s`}>
                  {Math.ceil(respawn()!)}
                </span>
              </Show>
              {/* #HealthBar (citadel_hud_top_bar.vcss): the HUD's slanted card at the portrait's
                  edge, filled from the bottom. */}
              <Show when={hp() != null}>
                <div class="tb-health" data-testid="tb-health" data-health={hp()!} aria-label={`${label()} health, ${hp()}%`}>
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
              <Show when={expanded(key) && scoreboardValueAt(player()?.level, p.host.t())}>
                {lv => <span class="tb-level" data-testid="tb-level" title="Hero level">{lv()}</span>}
              </Show>
              {(() => {
                const ult = () => hero()?.abilities?.[3] || undefined;
                const has = () => ult() != null && !!tips()?.tip(ult()!);
                const tiers = () => {
                  const pl = player();
                  const a = pl && ult() != null ? buildAt(pl, p.host.t()).abilities?.find((e) => e.id === ult()) : undefined;
                  return a ? Math.max(0, a.level - 1) : null;
                };
                return (
                  <Hover testid="ult-hover" tip={() => has() && <GameTip id={ult()!} art={p.art} tips={tips()!} ctx={{ tiers: tiers() }} />}>
                    <UltDial left={x()?.ult ?? null} label={label()} untitled={has()} />
                  </Hover>
                );
              })()}
              <Show when={expanded(key) && player()}>
                {pl => <BuildColumn inspect={!allBuilds() && !tabHeld()} popover={popover} onSeek={p.onSeek} player={pl()} timeline={p.host.tl()} t={p.host.t()} art={p.art} hero={hero()} name={nameOf()} id={`build-${t}-${s.slot.slot}`} stats={current(statTable(), tableKeyFor(p.art.stats, build()))} ladder={current(ladderTable(), ladderKeyFor(p.art.stats, build()))} />}
              </Show>
              {/* Never under the bar (styles/topbar.css): the name is the portrait's hover label's,
                  and the expanded column's. */}
              <Show when={nameOf()}>
                <span class="pl-tb-name" data-testid="tb-name">
                  {nameOf()}
                </span>
              </Show>
            </PortraitSlot>
          );
        }}
      </For>
    </TeamColumn>
  );
  const score = (t: "Amber" | "Sapphire", right: boolean) => (
    <TeamScore
      team={t}
      right={right}
      data-souls={known(t) ? total(t) : "untracked"}
      label={
        <span class="tb-score-label">
          <Show when={shown[t]() != null} fallback={"–"}>
            <Souls n={Math.round(shown[t]()!)} />
          </Show>
        </span>
      }
    />
  );

  return (
    <TopBarFrame
      ref={(e) => (el = e)}
      art={p.art}
      compact={p.compact}
      class={cx("pl-topbar", (allBuilds() || tabHeld()) && "all-builds")}
      mode="player"
      friend={column(friend(), "friend")}
      enemy={column(enemy(), "enemy")}
    >
      <BarClock>
        <span class="tb-clock-label" data-testid="tb-clock">
          {clockLabel(p.host.t())}
        </span>
      </BarClock>
      <button type="button" class="tb-all-builds" aria-expanded={allBuilds() || tabHeld()} onClick={toggleAll} title="All builds">
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
    </TopBarFrame>
  );
}
