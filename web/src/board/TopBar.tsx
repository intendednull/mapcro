// The in-game top bar (design/shared/topbar.js, ported; spec in design/parity/README.md): hero
// portraits, souls with team totals, the scene clock and each player's ult ring. Everything is
// edited in place: click souls or the clock to type; drag around a ring or scroll on it to set
// the cooldown, click it for ready. No health: the board doesn't track it. An editor's right
// click on a portrait opens its hero's menu: kill or revive, vision, change hero, rename. The
// player's name (the one typed into the slot, else the open match's in-game name; spec §6b
// "Names") leads the portrait's hover label, as in Player; never under the bar (TopBarParts.tsx).
// "Rename…" opens its editor in place, under the portrait, while it is open.

import { rosterTeamName, rosterTeamShort } from "../map/model";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
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
import { slotName } from "./roster";
import { LIMITS } from "../gen/limits";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";

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
  art: Art;
  vp: Viewpoint;
  scene: RecordId | undefined;
  compact?: boolean;
  /** A click on a portrait: pick that slot's hero. */
  onPickHero?: (slot: RecordId) => void;
  /** A click on a hero's portrait focuses it on the map (Board's focusHero). */
  onFocus?: (team: string, slot: number) => void;
  /** The open match's in-game name for a slot, if any (Board's `sceneMatchName`). */
  matchName?: (team: string, slot: number) => string | undefined;
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
  const editable = () => p.state.canEdit();
  const sceneRow = () => p.state.scenes().find((s) => s.id === p.scene);
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
          const label = () => nameOf(slot) || `${rosterTeamShort(t)} ${slot.slot.slot + 1}`;
          let openSouls: (() => void) | undefined;
          return (
            <PortraitSlot
              team={t}
              side={side}
              roster={slot.slot}
              art={p.art}
              hero={hero()}
              dead={!player.state.alive}
              unseen={!player.state.visible}
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
                <button class="tb-focus" data-testid="focus-hero" title={`Show ${hero()?.name ?? label()}`} aria-label={`Show ${label()}${hero() ? `, ${hero()!.name},` : ""} on the map`} onClick={() => p.onFocus?.(t, slot.slot.slot)} />
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
                aria-label={player.state.visible ? `${label()}: in vision` : `${label()}: not seen`}
                aria-pressed={!player.state.visible}
                onClick={() => p.state.edit([{ Set: { id: player.id, value: { PlayerVisible: !player.state.visible } } }])}
              >
                <EyeIcon off={!player.state.visible} />
              </button>
              <UltRing state={p.state} player={player} editable={editable()} label={label()} />
              {/* Never under the bar (styles/topbar.css); its editor, opened by "Rename…", shows
                  in place while it is open. */}
              <Show when={nameOf(slot) || renaming() === slot.id}>
                <InlineEdit
                  bindOpen={(o) => (openName.set(slot.id, o), onCleanup(() => openName.delete(slot.id)))}
                  class="pl-tb-name"
                  label={`${rosterTeamShort(t)} ${slot.slot.slot + 1} name`}
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
      art={p.art}
      compact={p.compact}
      class={editable() && "editable"}
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
      <div class="tb-scores">
        {score(friend(), false)}
        {score(enemy(), true)}
      </div>
    </TopBarFrame>
  );
}
