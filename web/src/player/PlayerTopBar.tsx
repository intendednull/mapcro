// Player's top bar (spec §6b): the in-game bar drawn from the match at playback time t, read-only.
// Built from the same parts as the scene's (board/TopBarParts.tsx), so the two look the same:
// portraits, souls with team totals, ult rings,
// the dead greyed out with their respawn countdown (when the tier has it), the clock at t, and
// under a team's souls the Rejuvenator it holds: a mark per revive left, and its timer.
// Only what the match's tier has is shown: no ult data (the metadata tier) reads as untracked,
// never as ready.


import { killsAt } from "../match/builds";
import { HeroBadge } from "../board/HeroBadge";
import { BuildColumn } from "./BuildColumn";
import { GameTip, Hover, useTooltips } from "./GameTooltip";
import { centreTimer } from "./Camps";
import { buildAt } from "../match/builds";
import { tenthOf } from "./buildState";

import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { ladderKeyFor, loadStatTable, tableKeyFor, type LoadedTable } from "../match/stats";
import { cx } from "../ui/cx";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { LIMITS } from "../gen/limits";
import type { RecordId } from "../gen/RecordId";
import type { WorldPos } from "../gen/WorldPos";
import { buildPanels } from "../board/buildPanels";
import { playerBuildView } from "../mapstate/buildView";
import { parseSouls, teamTotal } from "../core/souls";
import type { MapState } from "../mapstate/state";
import {
  pauseKillOps,
  pauseRenameOps,
  pauseReviveOps,
  pauseSoulsOps,
  pauseToggleSightOps,
  pauseUltOps,
  prepareLivePauseEdit,
} from "../mapstate/paused";
import { clockLabel, scoreboardValueAt } from "../match/timeline";
import { slotKey } from "../match/save";
import type { Art } from "../map/pack";
import { type Viewpoint, clampToDisc, viewToWorld } from "../map/transform";
import type { BoardState, Player, Slot } from "../board/state";
import { BarClock, EyeIcon, PortraitSlot, RejuvBadge, RejuvTimer, RespawnTimer, Souls, TeamColumn, TeamScore, TopBarFrame, UltRing, portraitTitle } from "../board/TopBarParts";
import { svgPoint } from "../board/Tokens";
import { slotName, slotPlaceholder } from "../board/roster";
import { easedNumber } from "../board/smooth";
import { DOORMAN_HERO_ID } from "./Doors";
import type { PlayerHost } from "./host";
import { pauseClock } from "./live";
import { barSlot } from "./barSlot";

/**
 * Health at or under this percent puts a portrait in the HUD's `.healthLow` state. The game sets
 * that class from code, so its threshold isn't in the panorama files; 30 is ours, the same as
 * the map tokens' red arc (board/Tokens.tsx).
 */
export const LOW_HEALTH = 30;

export function PlayerTopBar(p: {
  host: PlayerHost;
  state: BoardState;
  /** The match's state at t (mapstate/state.ts). */
  ms: MapState;
  art: Art;
  vp: Viewpoint;
  compact?: boolean;
  /** A click on a hero's portrait focuses it on the map at t (Board's focusHero). */
  onFocus?: (team: string, slot: number) => void;
  /** Currently camera-tracked hero slot key ("amber-0"). */
  trackedHero?: () => string | undefined;
  /** Double-click / double-tap on a hero's portrait toggles camera tracking. */
  onTrackHero?: (slotKey: string) => void;
  /** A build-order row: seek the replay there. */
  onSeek?: (t: number) => void;
  /** Paused Player full scene editing (spec #61 §3.2). */
  pausedEdit?: () => boolean;
  liveScene?: () => RecordId | undefined;
  svg?: () => SVGSVGElement | undefined;
  onPickHero?: (slot: RecordId) => void;
  bindMenu?: (open: ((player: RecordId, at: { x: number; y: number }, fromToken?: boolean) => void) | undefined) => void;
  onPlaceDoorway?: (team: "amber" | "sapphire", fromPos?: WorldPos) => void;
  onClearDoorways?: (team: "amber" | "sapphire") => void;
  onDropPortrait?: (slot: Slot, pos: WorldPos) => void;
}) {
  let el!: HTMLDivElement;
  const canPauseEdit = () => !p.compact && !!p.pausedEdit?.() && !!p.liveScene?.();
  const livePlayers = createMemo(() => new Map(p.state.playersIn(p.liveScene?.()).map((pl) => [pl.state.slot, pl])));
  const livePlayer = (slotId: RecordId) => livePlayers().get(slotId);
  const pauseEdit = (build: (liveId: RecordId, clock: number) => import("../gen/Op").Op[]) => {
    const liveId = p.liveScene?.();
    if (!canPauseEdit() || !liveId) return;
    const clock = pauseClock(p.host.t());
    prepareLivePauseEdit(p.state, liveId, clock);
    const ops = build(liveId, clock);
    if (ops.length) p.state.edit(ops);
  };
  const [menu, setMenu] = createSignal<{ slot: Slot; player: Player; label: string; at: { x: number; y: number }; fromToken?: boolean }>();
  const [renaming, setRenaming] = createSignal<RecordId>();
  const [soulsEdit, setSoulsEdit] = createSignal<RecordId>();
  let suppressClickSlot: RecordId | undefined;

  // Bind hero menu so right-clicking a map token or skull opens the same menu while paused.
  if (p.bindMenu) {
    const bind = p.bindMenu;
    bind((id, at, fromToken) => {
      if (!canPauseEdit()) return;
      const pl = [...livePlayers().values()].find((x) => x.id === id);
      const slot = pl && p.state.roster().find((s) => s.id === pl.state.slot);
      if (!pl || !slot) return;
      const h = p.ms.hero(slotKey(slot.slot.team, slot.slot.slot));
      const heroId = h.hero();
      const hero = heroId != null ? p.art.heroes.get(heroId) : undefined;
      const nm = (typeof pl.state.more?.name === "string" && pl.state.more.name) || (p.host.showNames() && h.name()) || undefined;
      const label = portraitTitle(slotName(nm ?? "", slot.slot.name) || slotPlaceholder(slot.slot.team, slot.slot.slot), hero);
      setMenu({ slot, player: pl, label, at, ...(fromToken ? { fromToken: true } : {}) });
    });
    onCleanup(() => bind(undefined));
  }
  const menuPlayer = () => {
    const m = menu();
    const pl = m && livePlayers().get(m.slot.id);
    return pl && pl.id === m.player.id ? pl : undefined;
  };
  createEffect(() => {
    if (!canPauseEdit()) {
      setMenu(undefined);
      setRenaming(undefined);
      setSoulsEdit(undefined);
    } else if (menu() && !menuPlayer()) {
      setMenu(undefined);
    }
  });

  const openMenu = (e: MouseEvent, slot: Slot, label: string) => {
    const t = e.target as HTMLElement;
    if (!canPauseEdit() || t.closest("input, textarea, [contenteditable]")) return;
    const pl = livePlayer(slot.id);
    if (!pl) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = e.clientX === 0 && e.clientY === 0 ? { x: r.left + 4, y: r.bottom - 4 } : { x: e.clientX, y: e.clientY };
    setMenu({ slot, player: pl, label, at });
  };

  /** Dragging a dead portrait >= 6 px onto the minimap revives that hero at the drop spot. */
  const startPortraitDrag = (e: PointerEvent, slot: Slot, isDead: boolean) => {
    if (!canPauseEdit() || !isDead || e.button !== 0 || !p.onDropPortrait) return;
    const svg = p.svg?.();
    if (!svg) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      if (!moved) {
        moved = true;
        document.body.style.cursor = "grabbing";
      }
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      document.body.style.cursor = "";
      if (ev.type === "pointerup" && moved) {
        suppressClickSlot = slot.id;
        setTimeout(() => {
          if (suppressClickSlot === slot.id) suppressClickSlot = undefined;
        }, 0);
        const rect = svg.getBoundingClientRect();
        if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          const pos = clampToDisc(viewToWorld(svgPoint(svg, ev), p.vp));
          p.onDropPortrait?.(slot, pos);
        }
      }
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  };
  // The host's, so a follower opens the builds its presenter opens (spec §8); the keys and
  // clicks are the scene bar's too (board/buildPanels.ts).
  const { openBuild, allBuilds, tabHeld } = p.host;
  const { popover, expanded, close: closeBuilds, toggleAll, toggle: toggleBuild, only: onlyBuild } = buildPanels(p.host, () => el);
  // Double-click / double-tap portrait toggles camera tracking, suppresses duplicate 2nd ping,
  // and closes BuildColumn if click 1 just opened it (spec §2.1).
  let lastPortraitTap: { key: string; t: number; wasBuildOpen: boolean } | undefined;
  const clickPortrait = (e: MouseEvent, team: "Amber" | "Sapphire", slotNum: number) => {
    const key = slotKey(team, slotNum);
    const now = performance.now();
    const isDouble =
      !e.shiftKey &&
      lastPortraitTap?.key === key &&
      now - lastPortraitTap.t < 350;
    if (isDouble) {
      const openedOnFirst = !lastPortraitTap!.wasBuildOpen && expanded(key);
      lastPortraitTap = undefined;
      if (openedOnFirst) closeBuilds();
      p.onTrackHero?.(key);
      return;
    }
    const wasBuildOpen = expanded(key);
    lastPortraitTap = e.shiftKey ? undefined : { key, t: now, wasBuildOpen };
    toggleBuild(key);
    p.onFocus?.(team, slotNum);
  };
  // The replay build's stat table (calculated stats) and the investment ladder's (match/stats.ts).
  const build = () => p.host.tl()?.build;
  const [statTable] = createResource(() => tableKeyFor(p.art.stats, build()) ?? false, key => loadStatTable(p.art.stats, key || null));
  // A resource keeps its last value while the next key loads: never show another patch's numbers.
  const current = (t: LoadedTable | undefined, key: string | null) => t && key && p.art.stats?.tables.get(key)?.clientVersion === t.data.client_version ? t : undefined;
  // The ult indicator's hover: the hero's ultimate's tooltip (feedback #9), its tiers at t.
  const tips = useTooltips(() => p.art, build);
  const [ladderTable] = createResource(() => ladderKeyFor(p.art.stats, build()) ?? false, key => loadStatTable(p.art.stats, key || null));
  const friend = () => (p.vp === "sapphire" ? "Sapphire" : "Amber");
  const enemy = () => (friend() === "Amber" ? "Sapphire" : "Amber");
  // Rows by the roster's slots, so the order and names are the board's; the hero is the match's.
  const team = (t: "Amber" | "Sapphire") => p.state.roster().filter((s) => s.slot.team === t);
  /** The match's hero in a roster slot (the frame's facts: mapstate/state.ts). */
  const heroOf = (t: "Amber" | "Sapphire", slot: number) => p.ms.hero(slotKey(t, slot));
  const total = (t: "Amber" | "Sapphire") => teamTotal(team(t).map((s) => heroOf(t, s.slot.slot).souls()));
  const known = (t: "Amber" | "Sapphire") => team(t).some((s) => heroOf(t, s.slot.slot).souls() != null);
  const rejuv = createMemo(() => p.ms.scene().rejuv() ?? []);
  const held = (t: "Amber" | "Sapphire") => rejuv().find((r) => r.team === t.toLowerCase());
  // The centre timer when no Rejuvenator is held: the Mid-Boss's respawn while it's dead (TD-141:
  // read from MapState's scene().bossCamp() so it works even if the pack lacks a midboss marker).
  const centre = createMemo(() => centreTimer(rejuv(), p.ms.scene().bossCamp()));
  const respawnAt = () => { const c = centre(); return c.kind === "respawn" ? c.at : undefined; };
  // Changing values ease (spec §4a): the totals count to each new value.
  // Memos: the totals change with a sample, not every frame (#39).
  const totalShown = (t: "Amber" | "Sapphire") => createMemo(() => (known(t) ? total(t) : null));
  const shown = { Amber: easedNumber(totalShown("Amber")), Sapphire: easedNumber(totalShown("Sapphire")) };

  const column = (t: "Amber" | "Sapphire", side: "friend" | "enemy") => (
    <TeamColumn team={t} side={side}>
      <For each={team(t)}>
        {(s) => {
          // Only what the bar draws, changing when a sample does, not every frame (#39).
          const h = heroOf(t, s.slot.slot);
          const x = barSlot(h);
          const hero = () => (x() ? p.art.heroes.get(x()!.hero_id) : undefined);
          // Explicit pause rename shows immediately; otherwise the match's name under Names (spec §6b).
          const pausedName = () => {
            const n = livePlayer(s.id)?.state.more?.name;
            return typeof n === "string" && n ? n : undefined;
          };
          const nameOf = () => pausedName() ?? ((p.host.showNames() && h.name()) || undefined);
          // As the scene's bar and the tokens: the match's name, else the one typed into the slot.
          const label = () => slotName(nameOf() ?? "", s.slot.name) || slotPlaceholder(t, s.slot.slot);
          const dead = () => !!x()?.dead;
          // In one team's view, an enemy out of its sight: the hero's own field, the tenth's.
          const unseen = createMemo(() => {
            const view = p.host.vision();
            return view !== "all" && view !== t.toLowerCase() && !h.inSight();
          });
          /** Health to draw: replay tier, Health on, alive (.Dead #HealthBar collapses). */
          const hp = () => (p.host.showHealth() && !dead() && x()?.health != null ? Math.max(0, Math.min(100, x()!.health!)) : null);
          const low = () => hp() != null && hp()! <= LOW_HEALTH;
          const key = slotKey(t, s.slot.slot);
          const player = () => p.host.tl()?.players.find(q => q.team === t.toLowerCase() && q.slot === s.slot.slot);
          // Tab and All builds mount the twelve once: after that they stay, hidden, and a press
          // only toggles a class (BuildColumn's `visible`: a hidden column reads nothing per frame).
          const allShown = createMemo((was: boolean) => was || allBuilds() || tabHeld(), false);
          // Changing values ease (spec §4a): souls count to each new value, and the respawn
          // countdown runs down through the seconds a scrub skips. Shown rounded from the eased
          // value; the data attributes keep the exact one.
          const souls = easedNumber(() => x()?.souls ?? null);
          const respawn = easedNumber(() => (dead() ? (x()?.respawn ?? null) : null));
          const commitSouls = (text: string) => {
            setSoulsEdit(undefined);
            const v = parseSouls(text);
            if (v === undefined || v === (x()?.souls ?? null)) return;
            pauseEdit((liveId, clock) => {
              const pl = livePlayer(s.id);
              return pl ? pauseSoulsOps(p.state.records as never, liveId, clock, pl, v) : [];
            });
          };
          const commitRename = (text: string) => {
            setRenaming(undefined);
            const next = text.trim() || null;
            if (next === (pausedName() ?? null)) return;
            if (pausedName() == null && next === (h.name() ?? null)) return;
            pauseEdit((liveId, clock) => {
              const pl = livePlayer(s.id);
              return pl ? pauseRenameOps(p.state.records as never, liveId, clock, pl, text) : [];
            });
          };
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
              tracked={p.trackedHero?.() === key}
              class={expanded(key) && "build-open"}
              data-hero={x()?.hero_id ?? ""}
              data-alive={x() ? String(!dead()) : "unknown"}
              data-seen={String(!unseen())}
              title={portraitTitle(label(), hero())}
              onContextMenu={(e) => openMenu(e, s, portraitTitle(label(), hero()))}
              souls={
                <Show
                  when={canPauseEdit() && soulsEdit() === s.id}
                  fallback={
                    <button
                      type="button"
                      class="tb-souls tb-build-trigger"
                      data-testid="souls-banner"
                      aria-label={`${hero()?.name ?? label()} build`}
                      aria-expanded={expanded(key)}
                      aria-controls={`build-${t}-${s.slot.slot}`}
                      onClick={() => toggleBuild(key)}
                      onDblClick={(e) => {
                        if (!canPauseEdit()) return;
                        e.stopPropagation();
                        setSoulsEdit(s.id);
                      }}
                    >
                      <span class="tb-souls-value" data-testid="souls" data-souls={x()?.souls ?? "untracked"}>
                        <Show when={souls() != null} fallback={"–"}>
                          <Souls n={Math.round(souls()!)} />
                        </Show>
                      </span>
                    </button>
                  }
                >
                  <div class="tb-souls" data-testid="souls-banner">
                    <input
                      class="ie-input tb-souls-value"
                      data-testid="souls-input"
                      aria-label={`${label()} souls`}
                      value={x()?.souls == null ? "" : String(x()!.souls)}
                      maxLength={9}
                      ref={(input) => queueMicrotask(() => { input.focus(); input.select(); })}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitSouls(e.currentTarget.value);
                        if (e.key === "Escape") setSoulsEdit(undefined);
                      }}
                      onBlur={(e) => soulsEdit() === s.id && commitSouls(e.currentTarget.value)}
                    />
                  </div>
                </Show>
              }
            >
              <Show
                when={canPauseEdit()}
                fallback={
                  <Show when={unseen()}>
                    <span class="tb-vis off" data-testid="tb-vision" title="Not seen" role="img" aria-label="Not seen">
                      <EyeIcon off />
                    </span>
                  </Show>
                }
              >
                <button
                  type="button"
                  class={cx("tb-vis", !h.inSight() && "off")}
                  data-testid="tb-vision"
                  title={h.inSight() ? "In vision" : "Not seen"}
                  aria-label={h.inSight() ? `${label()}, In vision` : `${label()}, Not seen`}
                  aria-pressed={!h.inSight()}
                  onClick={() =>
                    pauseEdit((liveId, clock) => {
                      const pl = livePlayer(s.id);
                      return pl ? pauseToggleSightOps(p.state.records as never, liveId, clock, pl, h.inSight()) : [];
                    })
                  }
                >
                  <EyeIcon off={!h.inSight()} />
                </button>
              </Show>
              <Show when={x()}>
                <button
                  class="tb-focus"
                  data-testid="focus-hero"
                  title={`Inspect ${hero()?.name ?? label()}`}
                  aria-label={`Inspect ${label()}${hero() ? `, ${hero()!.name}` : ""}`}
                  aria-expanded={expanded(key)}
                  aria-controls={`build-${t}-${s.slot.slot}`}
                  onPointerDown={(e) => startPortraitDrag(e, s, dead())}
                  onClick={(e) => {
                    if (suppressClickSlot === s.id) {
                      suppressClickSlot = undefined;
                      return;
                    }
                    clickPortrait(e, t, s.slot.slot);
                  }}
                />
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
              <Show when={expanded(key) && scoreboardValueAt(player()?.level, p.host.second())}>
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
                    <UltRing
                      left={x()?.ult ?? null}
                      editable={canPauseEdit()}
                      label={label()}
                      untitled={has()}
                      onFocus={(on) => {
                        const pl = livePlayer(s.id);
                        if (pl) p.state.presence({ focus: on ? pl.id : null });
                      }}
                      onCommit={(v) => {
                        if (v === (x()?.ult ?? null)) return;
                        pauseEdit((liveId, clock) => {
                          const pl = livePlayer(s.id);
                          return pl ? pauseUltOps(p.state.records as never, liveId, clock, pl, v) : [];
                        });
                      }}
                    />
                  </Hover>
                );
              })()}
              <Show when={(allShown() || expanded(key)) && player()}>
                {pl => {
                  // Player's producer of the build interface: computed at t, held still while hidden.
                  const view = playerBuildView(pl, p.host.tl, p.host.t, () => expanded(key));
                  return <BuildColumn visible={() => expanded(key)} inspect={expanded(key) && !allBuilds() && !tabHeld()} popover={popover} onSeek={p.onSeek} view={view} art={p.art} hero={hero()} name={nameOf()} id={`build-${t}-${s.slot.slot}`} stats={current(statTable(), tableKeyFor(p.art.stats, build()))} ladder={current(ladderTable(), ladderKeyFor(p.art.stats, build()))} />;
                }}
              </Show>
              {/* Never under the bar (styles/topbar.css): the name is the portrait's hover label's,
                  and the expanded column's. Inline editor opens in place when renaming while paused. */}
              <Show
                when={canPauseEdit() && renaming() === s.id}
                fallback={
                  <Show when={nameOf()}>
                    <span class="pl-tb-name" data-testid="tb-name">
                      {nameOf()}
                    </span>
                  </Show>
                }
              >
                <input
                  class="ie-input pl-tb-name"
                  data-testid="tb-name-input"
                  aria-label={`${slotPlaceholder(t, s.slot.slot)} name`}
                  value={pausedName() ?? h.name() ?? ""}
                  maxLength={LIMITS.max_name}
                  ref={(input) => queueMicrotask(() => { input.focus(); input.select(); })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") commitRename(e.currentTarget.value);
                    if (e.key === "Escape") setRenaming(undefined);
                  }}
                  onBlur={(e) => renaming() === s.id && commitRename(e.currentTarget.value)}
                />
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

  const shownBuilds = () => p.host.tl()?.players.filter(q => expanded(slotKey(q.team, q.slot))) ?? [];
  if (p.compact) return (
    <div class={cx("phone-roster", p.art.images.has("tb-mask") && "pack-art")} data-testid="topbar" data-mode="player" ref={e => el = e}>
      <For each={[friend(), enemy()] as const}>{t =>
        <div class="phone-team">
          <For each={team(t)}>{s => {
            const key = slotKey(t, s.slot.slot);
            const h = heroOf(t, s.slot.slot);
            const hero = () => p.art.heroes.get(h.hero() ?? 0);
            // The bar's readout: souls under the portrait; the dead greyed with their respawn.
            const x = barSlot(h);
            const dead = () => !!x()?.dead;
            const respawn = () => (dead() && x()?.respawn != null ? Math.ceil(x()!.respawn!) : null);
            const tracked = () => p.trackedHero?.() === key;
            return <div class={cx(`tb-player ${t.toLowerCase()}`, dead() && "dead", tracked() && "tracked")} data-slot={`${t}-${s.slot.slot}`}>
              <HeroBadge art={p.art} slot={s.slot} hero={hero()} />
              <span class="phone-souls" data-testid="souls" data-souls={x()?.souls ?? "untracked"}>
                <Show when={x()?.souls != null} fallback={"–"}><Souls n={x()!.souls!} /></Show>
              </span>
              <Show when={respawn() != null}>
                <span class="phone-respawn" data-testid="tb-respawn" data-respawn={respawn()!}>{respawn()}</span>
              </Show>
              <button class={cx("phone-hero", tracked() && "tracked")} data-slot={`${t}-${s.slot.slot}`} data-testid="focus-hero" aria-label={`${hero()?.name ?? "Hero"} build`} aria-expanded={expanded(key)}
                onClick={(e) => clickPortrait(e, t, s.slot.slot)} />
            </div>;
          }}</For>
          <span class={`phone-total ${t.toLowerCase()}`} data-testid="team-souls" data-souls={known(t) ? total(t) : "untracked"}>
            <Show when={known(t)} fallback={"–"}><Souls n={total(t)} /></Show>
          </span>
        </div>
      }</For>
      {/* Tab's stand-in on a touch screen: the same all-builds state, so followers get it. */}
      <button class="btn ghost phone-all" data-testid="phone-all-builds" aria-pressed={allBuilds() || tabHeld()} onClick={toggleAll}>All builds</button>
      <Show when={openBuild() || allBuilds() || tabHeld()}>
        <section class="phone-build-sheet" aria-label="Builds">
          <header class="p-sheet-head">
            <b>{allBuilds() || tabHeld() ? "All builds" : p.art.heroes.get(shownBuilds()[0]?.hero_id ?? 0)?.name ?? "Hero"}</b>
            <button class="btn ghost p-build-close" aria-label="Close" onClick={closeBuilds}>×</button>
          </header>
          <Show when={allBuilds() || tabHeld()} fallback={<div class="phone-build-content"><For each={shownBuilds()}>{pl => {
            const view = playerBuildView(() => pl, p.host.tl, p.host.t);
            return <BuildColumn inspect={!allBuilds() && !tabHeld()} popover={popover} onSeek={p.onSeek}
              view={view} art={p.art} hero={p.art.heroes.get(pl.hero_id)}
              name={p.host.playerName(pl.team, pl.slot)} id={`phone-build-${slotKey(pl.team, pl.slot)}`}
              stats={current(statTable(), tableKeyFor(p.art.stats, build()))}
              ladder={current(ladderTable(), ladderKeyFor(p.art.stats, build()))} />;
          }}</For></div>}>
            {/* Twelve rows: portrait, K/D/A, souls, items. A row opens that hero's build. */}
            <div class="phone-build-content phone-build-list" data-testid="all-builds-list">
              <div class="phone-build-row phone-build-head" data-testid="all-builds-head"><span /><span>K / D / A</span><span>Souls</span><span /></div>
              <For each={[friend(), enemy()] as const}>{t =>
                <For each={team(t)}>{s => {
                  const key = slotKey(t, s.slot.slot);
                  const pl = () => p.host.tl()?.players.find(q => slotKey(q.team, q.slot) === key);
                  const hero = () => p.art.heroes.get(pl()?.hero_id ?? 0);
                  const now = () => p.host.t();
                  const kda = () => {
                    const q = pl();
                    if (!q) return "—";
                    const k = q.kills != null ? scoreboardValueAt(q.kills, now()) : killsAt(p.host.tl(), now(), q.team, q.slot);
                    const a = scoreboardValueAt(q.assists, now());
                    return `${k ?? "—"} / ${q.deaths.filter(d => d <= now()).length} / ${a ?? "—"}`;
                  };
                  // Items move on tenths: asked once a tenth, not each frame (TD-50).
                  const tenth = createMemo(() => tenthOf(now()));
                  const items = createMemo(() => { const q = pl(); return q ? buildAt(q, tenth()).items ?? [] : []; });
                  const souls = heroOf(t, s.slot.slot).souls;
                  return <button class={`phone-build-row ${t.toLowerCase()}`} data-testid="all-builds-row" aria-label={`${hero()?.name ?? "Hero"} build`} onClick={() => { onlyBuild(key); p.onFocus?.(t, s.slot.slot); }}>
                    <span class="tb-player"><HeroBadge art={p.art} slot={s.slot} hero={hero()} /></span>
                    <span class="phone-row-kda">{kda()}</span>
                    <span class="phone-row-souls">{souls() != null ? souls()!.toLocaleString("en-US") : "—"}</span>
                    <span class="phone-row-items"><For each={items()}>{it => {
                      const icon = () => p.art.buildCatalog?.records.get(it.id)?.icon;
                      return <Show when={icon()}>{src => <img src={src()} alt="" />}</Show>;
                    }}</For></span>
                  </button>;
                }}</For>
              }</For>
            </div>
          </Show>
        </section>
      </Show>
    </div>
  );

  const menuView = (m: NonNullable<ReturnType<typeof menu>>) => {
    const pl = () => menuPlayer() ?? m.player;
    const h = () => p.ms.hero(slotKey(m.slot.slot.team, m.slot.slot.slot));
    const items: MenuItem[] = [
      {
        get label() {
          return h().alive() ? "Kill" : "Revive";
        },
        testid: "hero-menu-life",
        run: () =>
          pauseEdit((liveId, clock) => {
            const cur = pl();
            const pos = h().pos() ?? h().last() ?? { x: 0, y: 0 };
            return h().alive()
              ? pauseKillOps(p.state.records as never, liveId, clock, cur, pos)
              : pauseReviveOps(p.state.records as never, liveId, clock, cur, pos);
          }),
      },
      {
        get label() {
          return h().inSight() ? "Mark not seen" : "Mark in vision";
        },
        testid: "hero-menu-vision",
        run: () =>
          pauseEdit((liveId, clock) =>
            pauseToggleSightOps(p.state.records as never, liveId, clock, pl(), h().inSight()),
          ),
      },
      {
        label: "Set souls…",
        testid: "hero-menu-souls",
        run: () => setSoulsEdit(m.slot.id),
      },
    ];
    if (p.onTrackHero) {
      const slotK = slotKey(m.slot.slot.team, m.slot.slot.slot);
      items.push({
        get label() {
          return p.trackedHero?.() === slotK ? "Stop tracking" : "Track hero";
        },
        testid: "hero-menu-track",
        run: () => p.onTrackHero!(slotK),
      });
    }
    items.push({ label: "Rename…", testid: "hero-menu-rename", run: () => setRenaming(m.slot.id) });
    if (p.onPickHero) items.push({ label: "Change hero…", testid: "hero-menu-hero", run: () => p.onPickHero!(m.slot.id) });
    if (h().hero() === DOORMAN_HERO_ID) {
      const doorTeam = m.slot.slot.team === "Amber" ? "amber" : "sapphire";
      if (p.onPlaceDoorway) {
        items.push({
          label: "Place doorway",
          testid: "hero-menu-doorway",
          run: () => p.onPlaceDoorway!(doorTeam, m.fromToken ? (h().pos() ?? h().last() ?? undefined) : undefined),
        });
      }
      if (p.onClearDoorways && p.ms.scene().doors().some((d) => d.team === doorTeam)) {
        items.push({
          label: "Clear doorways",
          testid: "hero-menu-clear-doors",
          run: () => p.onClearDoorways!(doorTeam),
        });
      }
    }
    return <ContextMenu at={m.at} label={m.label} testid="hero-menu" onClose={() => setMenu(undefined)} items={items} />;
  };

  return (
    <TopBarFrame
      ref={(e) => (el = e)}
      art={p.art}
      compact={p.compact}
      class={cx("pl-topbar", canPauseEdit() && "editable", (allBuilds() || tabHeld()) && "all-builds")}
      mode="player"
      overlay={
        <Show when={menu()} keyed>
          {menuView}
        </Show>
      }
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
      <RejuvTimer held={() => held(friend())} both={() => !!held(enemy())} t={p.host.t} team={friend()} side="friend" art={p.art} />
      <RejuvTimer held={() => held(enemy())} both={() => !!held(friend())} t={p.host.t} team={enemy()} side="enemy" art={p.art} />
      <RespawnTimer at={respawnAt} t={p.host.t} art={p.art} />
    </TopBarFrame>
  );
}
