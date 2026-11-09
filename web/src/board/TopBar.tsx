// The in-game top bar (design/shared/topbar.js, ported; spec in design/parity/README.md): hero
// portraits, souls with team totals, the scene clock and each player's ult ring. Everything is
// edited in place: click souls or the clock to type; drag around a ring or scroll on it to set
// the cooldown, click it for ready. No health: the board doesn't track it.

import { rosterTeamName, rosterTeamShort } from "../map/model";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { capture } from "../ui/capture";
import { cx } from "../ui/cx";
import { formatClock, parseClock } from "../core/clock";
import { formatSouls, parseSouls, splitTotal, teamTotal, ultFromVector, ultStep } from "../core/souls";
import { colorOf } from "../core/device";
import type { RecordId } from "../gen/RecordId";
import type { Art } from "../map/pack";
import type { Viewpoint } from "../map/transform";
import { InlineEdit } from "../ui/InlineEdit";
import type { BoardState, Player, Slot } from "./state";
import { HeroBadge, hasCard } from "./HeroBadge";

const BAR = 1260;

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
    <div
      ref={el}
      class={cx("tb-ult", u() == null && "untracked", u() != null && u()! <= 0 && "ready", u() != null && u()! > 0 && "cooldown", preview() !== undefined && "adjusting")}
      style={u() != null && u()! > 0 ? { "--left": `${Math.min(100, u()!)}%` } : {}}
      data-testid="ult"
      data-ult={u() == null ? "untracked" : String(u())}
      role={p.editable ? "slider" : undefined}
      aria-label={`${p.label} ult cooldown`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={u() ?? undefined}
      title={u() == null ? "Ult" : u()! <= 0 ? "Ult ready" : `Ult ${Math.round(u()!)}%`}
      onPointerDown={down}
      onWheel={wheel}
    >
      <i class="tb-ult-bg" />
      <i class="tb-ult-icon" />
      <i class="tb-ult-sweep" />
      <i class="tb-ult-fb" />
      <Show when={preview() !== undefined}>
        <i class="tb-ult-handle" style={{ transform: `translate(-50%, -50%) rotate(${(u() ?? 0) * 3.6}deg) translateY(calc(-14 * var(--u)))` }} />
        <b class="tb-ult-pct">{u() == null ? "untracked" : u()! <= 0 ? "ready" : `${Math.round(u()!)}% left`}</b>
      </Show>
    </div>
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
}) {
  let host!: HTMLDivElement;
  const [unit, setUnit] = createSignal(1);
  onMount(() => {
    // Measure now, not only when the observer first fires: the bar's height follows its unit,
    // and a late first measurement moved the map under people's pointers by ~34 px (journal).
    setUnit(host.clientWidth / BAR || 1);
    const ro = new ResizeObserver(() => setUnit(host.clientWidth / BAR));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });
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

  const column = (t: "Amber" | "Sapphire", side: "friend" | "enemy") => (
    <div class={`tb-team ${side} ${t.toLowerCase()}`}>
      <For each={team(t)}>
        {({ slot, player }) => {
          const hero = () => (slot.slot.hero != null ? p.art.heroes.get(slot.slot.hero) : undefined);
          const label = () => slot.slot.name || `${rosterTeamShort(t)} ${slot.slot.slot + 1}`;
          let openSouls: (() => void) | undefined;
          return (
            <div
              class={cx("tb-player", t.toLowerCase(), side, hasCard(p.art, hero()) && "card-art", !player.state.alive && "dead", !player.state.visible && "unseen")}
              data-slot={`${t}-${slot.slot.slot}`}
              title={`${label()}${hero() ? `, ${hero()!.name}` : ""}`}
            >
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
              <HeroBadge art={p.art} slot={slot.slot} hero={hero()} />
              <Show when={editable()}>
                <button
                  class="tb-pick"
                  data-testid="pick-hero"
                  title="Pick hero"
                  aria-label="Pick hero"
                  onClick={() => p.onPickHero?.(slot.id)}
                />
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
                <svg viewBox="-8 -8 16 16" aria-hidden="true">
                  <path d="M-6 0s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4z" />
                  <Show when={!player.state.visible} fallback={<circle r="1.8" />}>
                    <path d="M-6 6L6 -6" />
                  </Show>
                </svg>
              </button>
              <UltRing state={p.state} player={player} editable={editable()} label={label()} />
            </div>
          );
        }}
      </For>
    </div>
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
      <div
        class={cx("tb-score", t.toLowerCase(), right && "right", editingTotal(t).length > 0 && "touched")}
        data-testid={`total-${t}`}
        onClick={() => openTotal?.()}
      >
        <i class="tb-score-bg" />
        <div class="tb-score-row">
          <Show when={right}>
            <i class="tb-team-icon" />
          </Show>
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
          <Show when={!right}>
            <i class="tb-team-icon" />
          </Show>
        </div>
        <For each={editingTotal(t)}>
          {(x) => (
            <span class="tb-tag" data-tag={x.state!.name} style={{ background: colorOf(x.state!.color) }}>
              {x.state!.name || "Someone"} · editing
            </span>
          )}
        </For>
      </div>
    );
  };

  return (
    <div
      ref={host}
      class={cx("tb-host", editable() && "editable", p.art.images.has("tb-mask") && "pack-art", p.compact && "compact")}
      style={{ "--u": `${unit()}px` }}
      data-testid="topbar"
    >
      <div class="tb-bar">
        {column(friend(), "friend")}
        {column(enemy(), "enemy")}
        <div class="tb-center">
          <div class="tb-clock">
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
