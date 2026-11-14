// The in-game top bar (design/shared/topbar.js, ported; spec in design/parity/README.md): hero
// portraits, souls with team totals, the scene clock and each player's ult ring. Everything is
// edited in place: click souls or the clock to type; drag around a ring or scroll on it to set
// the cooldown, click it for ready. No health: the board doesn't track it. An editor's right
// click on a portrait (or its token on the map, feedback #53) opens its hero's menu: kill or
// revive, vision, change hero, rename. The player's name (the one typed into the slot, else the
// open match's in-game name; spec §6b "Names") leads the portrait's hover label, as in Player;
// never under the bar (TopBarParts.tsx).
// "Rename…" opens its editor in place, under the portrait, while it is open.
//
// A scene that holds a snapshot of its frame's builds (docs/specs/map-state.md, phase 2) shows
// them as Player does: a click on a portrait opens that hero's build, All builds and holding Tab
// open the twelve, with the same view state, so followers see them (board/buildPanels.ts). The
// column reads the snapshot through the build interface (mapstate/buildView.ts). A scene saved
// from the open match before it could hold one offers Retake. Not on the phone's compact bar yet.

import { rosterTeamName } from "../map/model";
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { capture } from "../ui/capture";
import { cx } from "../ui/cx";
import { formatClock, parseClock } from "../core/clock";
import { parseSouls, splitTotal, teamTotal, ultFromVector, ultStep } from "../core/souls";
import { colorOf } from "../core/device";
import type { RecordId } from "../gen/RecordId";
import type { Art } from "../map/pack";
import type { Viewpoint } from "../map/transform";
import { InlineEdit } from "../ui/InlineEdit";
import type { BoardState, Player, Slot } from "./state";
import { BarClock, EyeIcon, PortraitSlot, Souls, TeamColumn, TeamScore, TopBarFrame, UltDial, portraitTitle } from "./TopBarParts";
import { aliveOps } from "./Tokens";
import { slotName, slotPlaceholder } from "./roster";
import { LIMITS } from "../gen/limits";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import type { SceneState } from "../gen/SceneState";
import { captured } from "../mapstate/build";
import { holdsBuild, sceneBuildView } from "../mapstate/buildView";
import { canRetake, retakeOps, slotKey } from "../match/save";
import { ladderKeyFor, loadStatTable, tableKeyFor, type LoadedTable } from "../match/stats";
import { BuildColumn } from "../player/BuildColumn";
import type { PlayerHost } from "../player/host";
import { newRecordId } from "../wasm/mapcro_wasm.js";
import { buildPanels } from "./buildPanels";

function UltRing(p: { state: BoardState; player: Player; editable: boolean; label: string }) {
  const [preview, setPreview] = createSignal<number | null | undefined>();
  const value = () => (preview() !== undefined ? preview()! : p.player.state.ult_cooldown);
  const commit = (v: number | null) => {
    if (v !== p.player.state.ult_cooldown) p.state.edit([{ Set: { id: p.player.id, value: { PlayerUltCooldown: v } } }]);
  };
  let el!: HTMLDivElement;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(wheelTimer));

  const down = (e: PointerEvent) => {
    if (!p.editable || e.button !== 0) return;
    e.preventDefault();
    capture(el, e.pointerId);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let moved = false;
    p.state.presence({ focus: p.player.id });
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - cx;
      const dy = ev.clientY - cy;
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
      moved = true;
      setPreview(ultFromVector(dx, dy));
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (ev.type === "pointerup") commit(moved ? (preview() ?? 0) : 0); // a click marks it ready
      setPreview(undefined);
      p.state.presence({ focus: null });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const wheel = (e: WheelEvent) => {
    if (!p.editable) return;
    e.preventDefault();
    setPreview(ultStep(value(), e.deltaY > 0));
    clearTimeout(wheelTimer);
    // A burst of scroll ticks is one edit (one undo step).
    wheelTimer = setTimeout(() => {
      const v = preview();
      setPreview(undefined);
      if (v !== undefined) commit(v);
    }, 350);
  };

  const u = () => value();
  return (
    <UltDial ref={(e) => (el = e)} left={u()} label={p.label} editable={p.editable} adjusting={preview() !== undefined} onPointerDown={down} onWheel={wheel}>
      <Show when={preview() !== undefined}>
        <i class="tb-ult-handle" style={{ transform: `translate(-50%, -50%) rotate(${(u() ?? 0) * 3.6}deg) translateY(calc(-14 * var(--u)))` }} />
        <b class="tb-ult-pct">{u() == null ? "untracked" : u()! <= 0 ? "ready" : `${Math.round(u()!)}% left`}</b>
      </Show>
    </UltDial>
  );
}

export function TopBar(p: {
  state: BoardState;
  /** The Player host: its view state holds which builds are open, and its match is Retake's. */
  host: PlayerHost;
  art: Art;
  vp: Viewpoint;
  scene: RecordId | undefined;
  compact?: boolean;
  readOnly?: boolean;
  /** A click on a portrait: pick that slot's hero. */
  onPickHero?: (slot: RecordId) => void;
  /** A click on a hero's portrait focuses it on the map (Board's focusHero). */
  onFocus?: (team: string, slot: number) => void;
  /** The open match's in-game name for a slot, if any (Board's `sceneMatchName`). */
  matchName?: (team: string, slot: number) => string | undefined;
  /** Hands the board the hero menu, to open from a token's right click on the map (feedback
   * #53); `undefined` once this bar is gone. */
  bindMenu?: (open: ((player: RecordId, at: { x: number; y: number }) => void) | undefined) => void;
}) {
  const friend = () => (p.vp === "sapphire" ? "Sapphire" : "Amber");
  const enemy = () => (friend() === "Amber" ? "Sapphire" : "Amber");
  const players = createMemo(() => new Map(p.state.playersIn(p.scene).map((pl) => [pl.state.slot, pl])));
  // One object per (slot, player) pair, so the columns keep their DOM across edits.
  const pairs = new Map<string, { slot: Slot; player: Player }>();
  const team = (t: "Amber" | "Sapphire") =>
    p.state
      .roster()
      .filter((s) => s.slot.team === t)
      .flatMap((s) => {
        const pl = players().get(s.id);
        if (!pl) return [];
        const k = `${s.id}:${pl.id}`;
        let pair = pairs.get(k);
        if (!pair) pairs.set(k, (pair = { slot: s, player: pl }));
        return [pair];
      });
  const total = (t: "Amber" | "Sapphire") => teamTotal(team(t).map((x) => x.player.state.souls));
  const editable = () => !p.readOnly && p.state.canEdit();
  const sceneRow = () => p.state.scenes().find((s) => s.id === p.scene);
  // The scene's snapshot (map-state spec §4.5): what it says it holds. None: a scene from before.
  const stateRow = createMemo(() => p.state.rowsIn<SceneState>("SceneState", p.scene)[0]);
  const snap = createMemo(() => captured(stateRow()?.r?.more), undefined, { equals: (a, b) => a.builds === b.builds && a.rows === b.rows && a.patch === b.patch });
  const hasBuilds = () => !p.compact && snap().builds;
  let el: HTMLDivElement | undefined;
  const panels = buildPanels(p.host, () => el, hasBuilds);
  // The snapshot's patch: its stat table (calculated stats) and investment ladder, as Player's.
  const patch = () => snap().patch;
  const [statTable] = createResource(() => (hasBuilds() && tableKeyFor(p.art.stats, patch())) || false, (key) => loadStatTable(p.art.stats, key || null));
  const [ladderTable] = createResource(() => (hasBuilds() && ladderKeyFor(p.art.stats, patch())) || false, (key) => loadStatTable(p.art.stats, key || null));
  // A resource keeps its last value while the next key loads: never show another patch's numbers.
  const current = (t: LoadedTable | undefined, key: string | null) => (t && key && p.art.stats?.tables.get(key)?.clientVersion === t.data.client_version ? t : undefined);
  /** The frame's match second: where the snapshot was taken. */
  const frameT = () => sceneRow()?.scene.source?.t ?? sceneRow()?.scene.clock ?? 0;
  // Retake (spec D10): what this scene didn't capture, from its own moment of the open match.
  const retakable = () => {
    const sc = sceneRow();
    return editable() && !p.compact && !!sc && canRetake(sc.scene, stateRow()?.r?.more, p.host.tl());
  };
  const retake = () => {
    const sc = sceneRow();
    const tl = p.host.tl();
    if (!sc || !tl) return;
    const st = stateRow();
    const txs = retakeOps(sc, st ? { id: st.id, more: st.r?.more } : undefined, p.state.playersIn(p.scene), p.state.roster(), tl, newRecordId);
    // In order, stopping at a refusal: the scene's state is last, so it never claims builds
    // that weren't written.
    for (const tx of txs) if (!p.state.edit(tx)) break;
  };
  /** A team's kills at the frame, if every hero's were captured. */
  const teamKills = (t: "Amber" | "Sapphire") => {
    const each = team(t).map((x) => (holdsBuild(x.player.state.more, snap().rows, x.slot.slot.hero) ? x.player.state.more?.kills : undefined));
    return each.length && each.every((k) => typeof k === "number") ? (each as number[]).reduce((a, b) => a + b, 0) : null;
  };
  const focus = (id: RecordId) => (on: boolean) => p.state.presence({ focus: on ? id : null });
  const nameOf = (s: Slot) => slotName(s.slot.name, p.matchName?.(s.slot.team, s.slot.slot));
  // "Rename…" in the menu: opens the slot's name editor, in place under its portrait.
  const [renaming, setRenaming] = createSignal<RecordId>();
  const openName = new Map<RecordId, () => void>();
  const rename = (id: RecordId) => {
    setRenaming(id);
    openName.get(id)?.();
  };
  // The portrait menu: one at a time, for a (slot, player) pair, at the pointer.
  const [menu, setMenu] = createSignal<{ slot: Slot; player: Player; label: string; at: { x: number; y: number } }>();
  const openMenu = (e: MouseEvent, slot: Slot, player: Player, label: string) => {
    // Editors only; a text field (the souls being typed) keeps the browser's menu.
    const t = e.target as HTMLElement;
    if (!editable() || t.closest("input, textarea, [contenteditable]")) return;
    e.preventDefault();
    // From the keyboard (the menu key, Shift+F10) there is no pointer: under the portrait.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = e.clientX === 0 && e.clientY === 0 ? { x: r.left + 4, y: r.bottom - 4 } : { x: e.clientX, y: e.clientY };
    setMenu({ slot, player, label, at });
  };
  // The same menu from a hero's token on the map: its player in this scene, editors only.
  if (p.bindMenu) {
    const bind = p.bindMenu;
    bind((id, at) => {
      if (!editable()) return;
      const player = [...players().values()].find((pl) => pl.id === id);
      const slot = player && p.state.roster().find((s) => s.id === player.state.slot);
      if (!player || !slot) return;
      const hero = slot.slot.hero != null ? p.art.heroes.get(slot.slot.hero) : undefined;
      setMenu({ slot, player, label: portraitTitle(nameOf(slot) || slotPlaceholder(slot.slot.team, slot.slot.slot), hero), at });
    });
    onCleanup(() => bind(undefined));
  }
  // The hero the menu is for, as it is now; gone (a scene flip, a removed slot): the menu closes.
  const menuPlayer = () => {
    const m = menu();
    const pl = m && players().get(m.slot.id);
    return pl && pl.id === m.player.id ? pl : undefined;
  };
  createEffect(() => {
    if (menu() && (!menuPlayer() || !editable())) setMenu(undefined);
  });

  const column = (t: "Amber" | "Sapphire", side: "friend" | "enemy") => (
    <TeamColumn team={t} side={side}>
      <For each={team(t)}>
        {({ slot, player }) => {
          const hero = () => (slot.slot.hero != null ? p.art.heroes.get(slot.slot.hero) : undefined);
          const label = () => nameOf(slot) || slotPlaceholder(t, slot.slot.slot);
          let openSouls: (() => void) | undefined;
          // The hero's build, if the snapshot holds one that is still this slot's hero's.
          const key = slotKey(t, slot.slot.slot);
          const has = () => hasBuilds() && holdsBuild(player.state.more, snap().rows, slot.slot.hero);
          const open = () => has() && panels.expanded(key);
          // All builds and Tab mount the twelve once: after that they stay, hidden (as Player's).
          const allShown = createMemo((was: boolean) => was || (has() && panels.all()), false);
          const view = sceneBuildView({ more: () => player.state.more, rows: () => snap().rows, hero: () => slot.slot.hero ?? 0, alive: () => player.state.alive, patch, time: frameT });
          return (
            <PortraitSlot
              team={t}
              side={side}
              roster={slot.slot}
              art={p.art}
              hero={hero()}
              dead={!player.state.alive}
              unseen={!player.state.visible}
              class={open() && "build-open"}
              title={portraitTitle(label(), hero())}
              onContextMenu={(e) => openMenu(e, slot, player, portraitTitle(label(), hero()))}
              souls={
                <div class="tb-souls" data-testid="souls-banner" onClick={() => openSouls?.()}>
                  <InlineEdit
                    bindOpen={(o) => (openSouls = o)}
                    class="tb-souls-value"
                    label={`${label()} souls`}
                    testid="souls"
                    editable={editable()}
                    value={player.state.souls == null ? "" : String(player.state.souls)}
                    placeholder="–"
                    maxLength={9}
                    display={() => <Souls n={player.state.souls} />}
                    onEditing={focus(player.id)}
                    onCommit={(text) => {
                      const v = parseSouls(text);
                      if (v === undefined) return false;
                      p.state.edit([{ Set: { id: player.id, value: { PlayerSouls: v } } }]);
                    }}
                  />
                </div>
              }
            >
              {/* With a hero: the portrait focuses it, and an editor changes it from the corner's
                  swap button. Without one, the portrait is the picker. */}
              <Show when={!editable() || slot.slot.hero != null}>
                <button
                  class="tb-focus"
                  data-testid="focus-hero"
                  title={`${has() ? "Inspect" : "Show"} ${hero()?.name ?? label()}`}
                  aria-label={`${has() ? "Inspect" : "Show"} ${label()}${hero() ? `, ${hero()!.name}` : ""}`}
                  aria-expanded={has() ? open() : undefined}
                  aria-controls={has() ? `build-${t}-${slot.slot.slot}` : undefined}
                  onClick={() => {
                    // As Player's portrait: its build, and the hero shown on the map.
                    if (has()) panels.toggle(key);
                    p.onFocus?.(t, slot.slot.slot);
                  }}
                />
              </Show>
              <Show when={editable()}>
                <button
                  class={cx("tb-pick", slot.slot.hero != null && "swap")}
                  data-testid="pick-hero"
                  title={slot.slot.hero != null ? "Change hero" : "Pick hero"}
                  aria-label={slot.slot.hero != null ? "Change hero" : "Pick hero"}
                  onClick={() => p.onPickHero?.(slot.id)}
                >
                  <Show when={slot.slot.hero != null}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3 6h9l-2.5-2.5M13 10H4l2.5 2.5" />
                    </svg>
                  </Show>
                </button>
              </Show>
              <button
                class={cx("tb-vis", !player.state.visible && "off")}
                data-testid="tb-vision"
                disabled={!editable()}
                hidden={!editable() && player.state.visible}
                title={player.state.visible ? "In vision" : "Not seen"}
                aria-label={player.state.visible ? `${label()}, In vision` : `${label()}, Not seen`}
                aria-pressed={!player.state.visible}
                onClick={() => p.state.edit([{ Set: { id: player.id, value: { PlayerVisible: !player.state.visible } } }])}
              >
                <EyeIcon off={!player.state.visible} />
              </button>
              <UltRing state={p.state} player={player} editable={editable()} label={label()} />
              {/* As Player's bar: the hero level on the portrait while its build is open. */}
              <Show when={open() && view.level()}>
                {(lv) => <span class="tb-level" data-testid="tb-level" title="Hero level">{lv()}</span>}
              </Show>
              <Show when={has() && (allShown() || open())}>
                <BuildColumn visible={open} inspect={open() && !panels.all()} popover={panels.popover} view={view} art={p.art} hero={hero()} name={nameOf(slot)} id={`build-${t}-${slot.slot.slot}`} stats={current(statTable(), tableKeyFor(p.art.stats, patch()))} ladder={current(ladderTable(), ladderKeyFor(p.art.stats, patch()))} />
              </Show>
              {/* Never under the bar (styles/topbar.css); its editor, opened by "Rename…", shows
                  in place while it is open. */}
              <Show when={nameOf(slot) || renaming() === slot.id}>
                <InlineEdit
                  bindOpen={(o) => (openName.set(slot.id, o), onCleanup(() => openName.delete(slot.id)))}
                  class="pl-tb-name"
                  label={`${slotPlaceholder(t, slot.slot.slot)} name`}
                  testid="tb-name"
                  editable={editable()}
                  value={slot.slot.name}
                  placeholder={p.matchName?.(t, slot.slot.slot) ?? ""}
                  maxLength={LIMITS.max_name}
                  onEditing={(on) => {
                    focus(slot.id)(on);
                    if (!on) setRenaming(undefined);
                  }}
                  onCommit={(text) => {
                    const v = text.trim();
                    if (v !== slot.slot.name) p.state.edit([{ Set: { id: slot.id, value: { RosterName: v } } }]);
                  }}
                />
              </Show>
            </PortraitSlot>
          );
        }}
      </For>
    </TeamColumn>
  );

  // Setting a team's total shares it out evenly over its heroes, in one transaction. While
  // someone edits it, presence `focus` names the team's first roster slot, so others can see who.
  const firstSlot = (t: "Amber" | "Sapphire") => p.state.roster().find((x) => x.slot.team === t)?.id;
  const editingTotal = (t: "Amber" | "Sapphire") => {
    const id = firstSlot(t);
    return id ? p.state.peerList().filter((x) => x.state?.focus === id && x.state.scene === p.scene) : [];
  };
  const setTotal = (t: "Amber" | "Sapphire", text: string) => {
    const v = parseSouls(text);
    if (v === undefined) return false;
    const members = team(t);
    const parts = v === null ? members.map(() => null) : splitTotal(v, members.length);
    const ops = members.map((m, i) => ({ Set: { id: m.player.id, value: { PlayerSouls: parts[i] ?? null } } }));
    if (ops.length) p.state.edit(ops);
  };
  const score = (t: "Amber" | "Sapphire", right: boolean) => {
    let openTotal: (() => void) | undefined;
    return (
      <TeamScore
        team={t}
        right={right}
        class={editingTotal(t).length > 0 && "touched"}
        onClick={() => openTotal?.()}
        label={
          <InlineEdit
            class="tb-score-label"
            label={`${rosterTeamName(t)} total souls`}
            testid={`total-edit-${t}`}
            editable={editable()}
            value={String(total(t))}
            maxLength={9}
            display={() => <Souls n={total(t)} />}
            bindOpen={(o) => (openTotal = o)}
            onEditing={(on) => p.state.presence({ focus: on ? (firstSlot(t) ?? null) : null })}
            onCommit={(text) => setTotal(t, text)}
          />
        }
      >
        <For each={editingTotal(t)}>
          {(x) => (
            <span class="tb-tag" data-tag={x.state!.name} style={{ background: colorOf(x.state!.color) }}>
              {x.state!.name || "Someone"} · editing
            </span>
          )}
        </For>
      </TeamScore>
    );
  };

  // Labels follow the hero's state live (another editor may kill it while the menu is open);
  // the items stay the same objects, so focus stays where it is.
  const menuView = (m: NonNullable<ReturnType<typeof menu>>) => {
    const pl = () => menuPlayer() ?? m.player;
    const items: MenuItem[] = [
      {
        get label() {
          return pl().state.alive ? "Kill" : "Revive";
        },
        testid: "hero-menu-life",
        run: () => p.state.edit(aliveOps(pl())),
      },
      {
        get label() {
          return pl().state.visible ? "Mark not seen" : "Mark in vision";
        },
        testid: "hero-menu-vision",
        run: () => p.state.edit([{ Set: { id: pl().id, value: { PlayerVisible: !pl().state.visible } } }]),
      },
    ];
    if (m.slot.slot.hero == null && p.onFocus) items.push({ label: "Show on the map", testid: "hero-menu-focus", run: () => p.onFocus!(m.slot.slot.team, m.slot.slot.slot) });
    items.push({ label: "Rename…", testid: "hero-menu-rename", run: () => rename(m.slot.id) });
    if (p.onPickHero) items.push({ label: m.slot.slot.hero != null ? "Change hero…" : "Pick hero…", testid: "hero-menu-hero", run: () => p.onPickHero!(m.slot.id) });
    return <ContextMenu at={m.at} label={m.label} testid="hero-menu" onClose={() => setMenu(undefined)} items={items} />;
  };

  return (
    <TopBarFrame
      ref={(e) => (el = e)}
      art={p.art}
      compact={p.compact}
      class={cx(editable() && "editable", panels.all() && "all-builds")}
      overlay={
        <Show when={menu()} keyed>
          {menuView}
        </Show>
      }
      friend={column(friend(), "friend")}
      enemy={column(enemy(), "enemy")}
    >
      <BarClock>
        <InlineEdit
          class="tb-clock-label"
          label="scene clock"
          testid="tb-clock"
          editable={editable()}
          value={formatClock(sceneRow()?.scene.clock)}
          placeholder="0:00"
          maxLength={8}
          onEditing={(on) => p.state.presence({ focus: on ? (p.scene ?? null) : null })}
          onCommit={(t) => {
            const c = parseClock(t);
            if (c === undefined || !p.scene) return false;
            p.state.edit([{ Set: { id: p.scene, value: { SceneClock: c } } }]);
          }}
        />
      </BarClock>
      <Show when={hasBuilds()}>
        <button type="button" class="tb-all-builds" data-testid="all-builds" aria-expanded={panels.all()} onClick={panels.toggleAll} title="All builds">
          {panels.all() ? "▴" : "▾"} All builds <kbd>Hold Tab</kbd>
        </button>
      </Show>
      <Show when={panels.all()}>
        <div class="tb-build-team-kills"><b>{teamKills(friend()) ?? "—"}</b><span>Kills</span><b>{teamKills(enemy()) ?? "—"}</b></div>
      </Show>
      {/* Under All builds when the scene has both (rows a later build writes); gone while the twelve are open. */}
      <Show when={retakable() && !panels.all()}>
        <button type="button" class={cx("tb-all-builds", "tb-retake", hasBuilds() && "second")} data-testid="retake" onClick={retake} title="Retake">
          Retake
        </button>
      </Show>
      <div class="tb-scores">
        {score(friend(), false)}
        {score(enemy(), true)}
      </div>
    </TopBarFrame>
  );
}
