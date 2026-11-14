// The scenes sidebar (operator, 2026-11-07): scenes as a tree down the left, replacing the strip.
// A row: name, clock, who is there, the current one marked; a lite minimap on hover. Drag a row
// above or below another to reorder among its siblings, or onto its middle to nest it; one
// transaction per drop. Collapse is yours (remembered per board). ← → walk the tree in order; T adds
// a scene after this one.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { colorOf } from "../core/device";
import { formatClock } from "../core/clock";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { Scene } from "../gen/Scene";
import { MapView } from "../map/MapView";
import type { Art } from "../map/pack";
import { type Viewpoint, worldToView } from "../map/transform";
import { InlineEdit } from "../ui/InlineEdit";
import { boardKeys } from "../core/keys";
import { cx } from "../ui/cx";
import { addSceneOps, deleteSceneOps, isUnnamed, moveSceneOps } from "./scenes";
import type { BoardState } from "./state";
import { visibleRows } from "./tree";
import { LIMITS } from "../gen/limits";

function Mini(p: { state: BoardState; art: Art; vp: Viewpoint; scene: RecordId }) {
  const slots = () => new Map(p.state.roster().map((s) => [s.id, s.slot.team]));
  return (
    <MapView art={p.art} viewpoint={p.vp} lite>
      <For each={p.state.playersIn(p.scene).filter((pl) => pl.state.placed)}>
        {(pl) => {
          const at = () => worldToView(pl.state.pos, p.vp);
          return <circle class={`d ${slots().get(pl.state.slot) === "Sapphire" ? "sapphire" : "amber"}`} cx={at().x} cy={at().y} r="30" />;
        }}
      </For>
    </MapView>
  );
}

const collapsedKey = (board: string) => `mapcro:collapsed:${board}`;
function loadCollapsed(board: string): Set<RecordId> {
  try {
    return new Set(JSON.parse(localStorage.getItem(collapsedKey(board)) ?? "[]") as RecordId[]);
  } catch {
    return new Set();
  }
}

type Drop = { id: RecordId; where: "before" | "after" | "into" };

export function SceneTree(p: {
  state: BoardState;
  art: Art;
  vp: Viewpoint;
  board: string;
  current: RecordId | undefined;
  onFlip: (id: RecordId) => void;
  /** The phone shows it as a drawer: closed after a flip. */
  drawer?: boolean;
  /** Player (spec §6b): a scene saved from the open match gets a "▶ m:ss" chip that jumps there. */
  chip?: (id: RecordId) => { label: string; go: () => void } | undefined;
  /** Whether ← → step scenes (Player takes them for events while watching the match). */
  keys?: () => boolean;
  onClose?: () => void;
  replay?: { active: boolean; label: string; go: () => void } | undefined;
}) {
  const [folded, setFolded] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(loadCollapsed(p.board));
  const toggle = (id: RecordId) => {
    const next = new Set(collapsed());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem(collapsedKey(p.board), JSON.stringify([...next]));
    } catch {}
  };
  const rows = createMemo(() => p.state.sceneTree());
  const shown = createMemo(() => visibleRows(rows(), collapsed()));
  const rowOf = createMemo(() => new Map(rows().map((r) => [r.scene.id, r])));
  const order = () => p.state.scenes(); // depth-first: the flip order
  const index = () => order().findIndex((s) => s.id === p.current);
  const flip = (id: RecordId) => {
    p.onFlip(id);
    if (p.drawer) p.onClose?.();
  };
  const flipBy = (d: number) => {
    const s = order()[index() + d];
    if (s) p.onFlip(s.id);
  };
  /** An editor may add a scene: one slot stays free for Player's live layer (max_scenes 64). */
  const canAdd = () => p.state.canEdit() && order().length < 63;
  /** A new scene's transactions, in order: one unless the copied snapshot is over a transaction
   * (then more than one undo step); a refused one stops the rest. */
  const send = (txs: Op[][]) => txs.every((tx) => p.state.edit(tx));
  const add = (asChild: boolean) => {
    const cur = order()[index()];
    const { id, txs } = addSceneOps(p.state, cur, asChild);
    send(txs);
    if (asChild && cur && collapsed().has(cur.id)) toggle(cur.id);
    p.onFlip(id);
  };
  /** A copy of `row`'s scene (its heroes, objectives and splits), right after it, as its sibling. */
  const clone = (row: { id: RecordId; scene: Scene }) => {
    const { id, txs } = addSceneOps(p.state, row, false, undefined, isUnnamed(row.scene.name) ? "" : `${row.scene.name} copy`);
    send(txs);
    p.onFlip(id);
  };
  const remove = (id: RecordId) => {
    const ops = deleteSceneOps(p.state, id);
    if (!ops.length) return;
    if (id === p.current) {
      const i = index();
      const next = order()[i + 1] ?? order()[i - 1];
      if (next) p.onFlip(next.id);
    }
    p.state.edit(ops);
  };

  onMount(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (p.keys && !p.keys()) return;
      // T: a new scene after this one, from where this one ends (#30), as the + does. Not in a
      // dialog or a menu, and once per press.
      if (e.key.toLowerCase() === "t") {
        if (e.repeat || e.defaultPrevented || !canAdd() || !boardKeys(t)) return;
        e.preventDefault();
        return add(false);
      }
      if (e.key === "ArrowLeft") flipBy(-1);
      else if (e.key === "ArrowRight") flipBy(1);
      else return;
      e.preventDefault();
    };
    if (!p.drawer) window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });

  const here = (id: RecordId) => p.state.peerList().filter((x) => x.state?.scene === id);
  const [dragging, setDragging] = createSignal<RecordId>();
  const [drop, setDrop] = createSignal<Drop>();
  const whereOf = (e: DragEvent): Drop["where"] => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    return f < 0.28 ? "before" : f > 0.72 ? "after" : "into";
  };
  const [peek, setPeek] = createSignal<{ id: RecordId; top: number }>();
  /** A row being renamed in place (double-click its name). */
  const [renaming, setRenaming] = createSignal<RecordId>();

  return (
    <nav class={cx("scenes", folded() && "folded", p.drawer && "drawer")} data-testid="scene-tree" aria-label="Scenes">
      <div class="scenes-head">
        <Show when={!folded()}>
          <span class="scenes-title">Scenes</span>
          <span class="scenes-keys">
            <kbd>←</kbd>
            <kbd>→</kbd>
          </span>
          <Show when={canAdd()}>
            {/* One way in: a scene after this one, copying it. Nesting is a drag onto a row.
                (One slot stays free for Player's live layer: max_scenes 64.) */}
            <button class="scenes-add" data-testid="scene-add" aria-label="Add scene" title="Add scene [T]" aria-keyshortcuts="T" onClick={() => add(false)}>
              <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </Show>
        </Show>
        <button
          class="scenes-fold"
          data-testid={p.drawer ? "scene-drawer-close" : "scene-tree-fold"}
          aria-label={p.drawer ? "Close" : folded() ? "Show scenes" : "Hide scenes"}
          title={p.drawer ? "Close" : folded() ? "Show scenes" : "Hide scenes"}
          onClick={() => (p.drawer ? p.onClose?.() : setFolded(!folded()))}
        >
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d={p.drawer ? "M6 6l12 12M18 6L6 18" : folded() ? "M9 5l7 7-7 7" : "M15 5l-7 7 7 7"} />
          </svg>
        </button>
      </div>
      <Show when={!folded()}>
        <Show when={p.replay}>{replay => <button class="scene-replay" classList={{ on: replay().active }} aria-current={replay().active ? "page" : undefined} data-testid="replay-entry" onClick={() => replay().go()}><span>▶ Replay</span><small>{replay().label}</small></button>}</Show>
        <ol class="scene-rows" role="tree">
          <For each={shown().map((x) => x.scene.id)}>
            {(id) => {
              // Keyed by id: an edit elsewhere in the tree keeps this row (and its open editor).
              let last = rowOf().get(id)!;
              const row = () => (last = rowOf().get(id) ?? last);
              const s = () => row().scene;
              let openName: (() => void) | undefined;
              const isOpen = () => !collapsed().has(s().id);
              const no = () => order().findIndex((x) => x.id === s().id) + 1;
              return (
                <li
                  class={cx(
                    "scene-row",
                    s().id === p.current && "on",
                    dragging() === s().id && "dragging",
                    drop()?.id === s().id && dragging() !== s().id && `drop-${drop()!.where}`,
                  )}
                  role="treeitem"
                  aria-level={row().depth + 1}
                  aria-expanded={row().hasChildren ? isOpen() : undefined}
                  aria-current={s().id === p.current ? "true" : undefined}
                  data-testid="scene-card"
                  aria-label={`Scene ${no()}: ${formatClock(s().scene.clock)} ${isUnnamed(s().scene.name) ? "" : s().scene.name}`.replace(/\s+/g, " ").trim()}
                  data-scene={s().id}
                  data-depth={row().depth}
                  style={{ "--depth": String(row().depth) }}
                  draggable={p.state.canEdit()}
                  onClick={() => flip(s().id)}
                  onMouseEnter={(e) => setPeek({ id: s().id, top: (e.currentTarget as HTMLElement).offsetTop })}
                  onMouseLeave={() => peek()?.id === s().id && setPeek(undefined)}
                  onDragStart={(e) => {
                    setPeek(undefined);
                    setDragging(s().id);
                    e.dataTransfer?.setData("text/x-mapcro-scene", s().id);
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    setDragging(undefined);
                    setDrop(undefined);
                  }}
                  onDragOver={(e) => {
                    const moved = dragging();
                    if (!moved || moved === s().id) return;
                    e.preventDefault();
                    setDrop({ id: s().id, where: whereOf(e) });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const moved = dragging();
                    const d = { id: s().id, where: whereOf(e) };
                    setDragging(undefined);
                    setDrop(undefined);
                    if (!moved || moved === d.id) return;
                    const ops: Op[] = moveSceneOps(p.state, moved, d.id, d.where);
                    if (ops.length) p.state.edit(ops);
                    if (d.where === "into" && collapsed().has(d.id)) toggle(d.id);
                  }}
                >
                  <span class="caret-slot">
                    <Show when={row().hasChildren}>
                      <button
                        class={cx("caret", isOpen() && "open")}
                        data-testid="scene-caret"
                        aria-label={isOpen() ? "Collapse" : "Expand"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(s().id);
                        }}
                      >
                        <svg viewBox="0 0 12 12" aria-hidden="true">
                          <path d="M4 2.5l4 3.5-4 3.5" />
                        </svg>
                      </button>
                    </Show>
                  </span>
                  <span class="no">{no()}</span>
                  <span
                    class="name"
                    onDblClick={(e) => {
                      if (!p.state.canEdit()) return;
                      e.stopPropagation();
                      setRenaming(s().id);
                      openName?.();
                    }}
                    onClick={(e) => renaming() === s().id && e.stopPropagation()}
                  >
                    <InlineEdit
                      value={isUnnamed(s().scene.name) ? "" : s().scene.name}
                      placeholder={`Scene ${no()}`}
                      editable={p.state.canEdit() && renaming() === s().id}
                      maxLength={LIMITS.max_name}
                      label="Scene name"
                      testid="scene-row-name"
                      bindOpen={(o) => (openName = o)}
                      onEditing={(on) => !on && setRenaming(undefined)}
                      onCommit={(t) => {
                        if (t.trim() !== (isUnnamed(s().scene.name) ? "" : s().scene.name)) p.state.edit([{ Set: { id: s().id, value: { SceneName: t.trim() } } }]);
                      }}
                    />
                  </span>
                  <span class="clock">{formatClock(s().scene.clock)}</span>
                  <Show when={p.chip?.(s().id)}>
                    {(c) => (
                      <button
                        class="scene-chip"
                        data-testid="scene-chip"
                        title="Play from here"
                        onClick={(e) => {
                          e.stopPropagation();
                          c().go();
                        }}
                      >
                        {c().label}
                      </button>
                    )}
                  </Show>
                  <span class="here">
                    <For each={here(s().id)}>
                      {(x) => (
                        <span class="av sm" style={{ background: colorOf(x.state!.color) }} title={x.state!.name}>
                          {(x.state!.name.trim()[0] ?? "?").toUpperCase()}
                        </span>
                      )}
                    </For>
                  </span>
                  {/* Clone and delete: always in the same last column, so they line up on every
                      row, nested or not (shown on hover or focus, always on the active row and on
                      the phone). */}
                  <span class="row-acts">
                    <Show when={canAdd()}>
                      <button
                        class="row-act"
                        data-testid="scene-clone"
                        aria-label="Duplicate scene"
                        title="Duplicate scene"
                        onClick={(e) => {
                          e.stopPropagation();
                          clone(s());
                        }}
                      >
                        <svg viewBox="0 0 12 12" aria-hidden="true">
                          <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
                          <path d="M2.5 7.5v-5h5" />
                        </svg>
                      </button>
                    </Show>
                    <Show when={p.state.canEdit() && order().length > 1}>
                      <button
                        class="row-act row-del"
                        data-testid="scene-delete"
                        aria-label="Delete scene"
                        title="Delete scene"
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(s().id);
                        }}
                      >
                        <svg viewBox="0 0 12 12" aria-hidden="true">
                          <path d="M3 3l6 6M9 3L3 9" />
                        </svg>
                      </button>
                    </Show>
                  </span>
                </li>
              );
            }}
          </For>
        </ol>
        <Show when={peek() && !p.drawer}>
          <div class="scene-peek" data-testid="scene-peek" style={{ top: `${peek()!.top}px` }}>
            <Mini state={p.state} art={p.art} vp={p.vp} scene={peek()!.id} />
          </div>
        </Show>
        {/* One scene slot stays free for Player's live layer (spec §6b; max_scenes 64). */}
      </Show>
    </nav>
  );
}
