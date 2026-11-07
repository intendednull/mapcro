// The in-game top bar (design/shared/topbar.js, ported; spec in design/parity/README.md): hero
// portraits, souls with team totals, the scene clock and each player's ult ring. Everything is
// edited in place: click souls or the clock to type; drag around a ring or scroll on it to set
// the cooldown, click it for ready. No health: the board doesn't track it.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { cx } from "../ui/cx";
import { formatClock, parseClock } from "../core/clock";
import { formatSouls, parseSouls, teamTotal, ultFromVector, ultStep } from "../core/souls";
import type { RecordId } from "../gen/RecordId";
import type { Art } from "../map/pack";
import type { Viewpoint } from "../map/transform";
import { InlineEdit } from "../ui/InlineEdit";
import type { BoardState, Player } from "./state";
import { initials } from "./Tokens";

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
    el.setPointerCapture(e.pointerId);
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
      title={
        u() == null
          ? "Ult not tracked. Drag around the ring or scroll to set it."
          : u()! <= 0
            ? "Ult ready"
            : `Ult cooldown ${Math.round(u()!)}% left. Drag or scroll to change; click for ready.`
      }
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

export function TopBar(p: { state: BoardState; art: Art; vp: Viewpoint; scene: RecordId | undefined; compact?: boolean }) {
  let host!: HTMLDivElement;
  const [unit, setUnit] = createSignal(1);
  onMount(() => {
    const ro = new ResizeObserver(() => setUnit(host.clientWidth / BAR));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });
  const friend = () => (p.vp === "sapphire" ? "Sapphire" : "Amber");
  const enemy = () => (friend() === "Amber" ? "Sapphire" : "Amber");
  const players = createMemo(() => new Map(p.state.playersIn(p.scene).map((pl) => [pl.state.slot, pl])));
  const team = (t: "Amber" | "Sapphire") =>
    p.state
      .roster()
      .filter((s) => s.slot.team === t)
      .flatMap((s) => {
        const pl = players().get(s.id);
        return pl ? [{ slot: s, player: pl }] : [];
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
          const label = () => slot.slot.name || `${t} ${slot.slot.slot + 1}`;
          return (
            <div
              class={cx("tb-player", t.toLowerCase(), side, !player.state.alive && "dead")}
              data-slot={`${t}-${slot.slot.slot}`}
              title={`${label()}${hero() ? `, ${hero()!.name}` : ""}`}
            >
              <div class="tb-souls">
                <InlineEdit
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
              <div class="tb-badge">
                <i class="tb-disc">{initials(slot.slot, hero()?.name)}</i>
                <Show when={hero()?.topbar}>
                  {(src) => <i class="tb-img hero-vertical" style={{ "background-image": `url(${JSON.stringify(src())})` }} />}
                </Show>
              </div>
              <UltRing state={p.state} player={player} editable={editable()} label={label()} />
            </div>
          );
        }}
      </For>
    </div>
  );

  const score = (t: "Amber" | "Sapphire", right: boolean) => (
    <div class={cx("tb-score", t.toLowerCase(), right && "right")} data-testid={`total-${t}`}>
      <i class="tb-score-bg" />
      <div class="tb-score-row">
        <Show when={right}>
          <i class="tb-team-icon" />
        </Show>
        <span class="tb-score-label">
          <Souls n={total(t)} />
        </span>
        <Show when={!right}>
          <i class="tb-team-icon" />
        </Show>
      </div>
    </div>
  );

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
