// The scene strip (design/v1-board, footer): flip with a click or ← →, add a scene after the
// current one, drag a card to reorder. Each card is a lite minimap of that scene.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { colorOf } from "../core/device";
import { formatClock } from "../core/clock";
import type { RecordId } from "../gen/RecordId";
import { MapView } from "../map/MapView";
import type { Art } from "../map/pack";
import { type Viewpoint, worldToView } from "../map/transform";
import { type SceneRow, addSceneOps, reorderOp } from "./scenes";
import type { BoardState } from "./state";

function Mini(p: { state: BoardState; art: Art; vp: Viewpoint; scene: RecordId }) {
  const slots = () => new Map(p.state.roster().map((s) => [s.id, s.slot.team]));
  return (
    <span class="mini">
      <MapView art={p.art} viewpoint={p.vp} lite>
        <For each={p.state.playersIn(p.scene).filter((pl) => pl.state.placed)}>
          {(pl) => {
            const at = () => worldToView(pl.state.pos, p.vp);
            return <circle class={`d ${slots().get(pl.state.slot) === "Sapphire" ? "sapphire" : "amber"}`} cx={at().x} cy={at().y} r="30" />;
          }}
        </For>
      </MapView>
    </span>
  );
}

export function SceneStrip(p: {
  state: BoardState;
  art: Art;
  vp: Viewpoint;
  current: RecordId | undefined;
  onFlip: (id: RecordId) => void;
  /** Editors: open the match import. */
  onMatch?: () => void;
}) {
  const scenes = () => p.state.scenes();
  const index = () => scenes().findIndex((s) => s.id === p.current);
  const flipBy = (d: number) => {
    const s = scenes()[index() + d];
    if (s) p.onFlip(s.id);
  };
  const add = () => {
    const cur = scenes()[index()];
    const { id, ops } = addSceneOps(p.state, scenes(), cur);
    p.state.edit(ops);
    p.onFlip(id);
  };
  const [dragging, setDragging] = createSignal<RecordId>();
  const [dropAt, setDropAt] = createSignal<number>();

  onMount(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowLeft") flipBy(-1);
      else if (e.key === "ArrowRight") flipBy(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });

  const here = (id: RecordId) => p.state.peerList().filter((x) => x.state?.scene === id);
  const slotOf = (e: DragEvent, i: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? i : i + 1;
  };

  return (
    <footer class="strip" data-testid="scene-strip">
      <div class="strip-hint">
        <kbd>←</kbd>
        <kbd>→</kbd>
      </div>
      <button class="nav" aria-label="Previous scene" disabled={index() <= 0} onClick={() => flipBy(-1)}>
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </button>
      <div class="cards">
        <For each={scenes()}>
          {(s: SceneRow, i) => (
            <button
              class="card"
              classList={{
                on: s.id === p.current,
                dragging: dragging() === s.id,
                "drop-before": dropAt() === i() && dragging() !== undefined,
                "drop-after": dropAt() === i() + 1 && i() === scenes().length - 1 && dragging() !== undefined,
              }}
              data-testid="scene-card"
              data-scene={s.id}
              aria-label={`Scene ${i() + 1}: ${formatClock(s.scene.clock)} ${s.scene.name}`.replace(/\s+/g, " ")}
              aria-current={s.id === p.current ? "true" : undefined}
              draggable={p.state.canEdit()}
              onClick={() => p.onFlip(s.id)}
              onDragStart={(e) => {
                setDragging(s.id);
                e.dataTransfer?.setData("text/x-mapcro-scene", s.id);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragging(undefined);
                setDropAt(undefined);
              }}
              onDragOver={(e) => {
                if (!dragging()) return;
                e.preventDefault();
                setDropAt(slotOf(e, i()));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const moved = dragging();
                const at = slotOf(e, i());
                setDragging(undefined);
                setDropAt(undefined);
                if (!moved) return;
                const from = scenes().findIndex((x) => x.id === moved);
                const op = reorderOp(scenes(), moved, at > from ? at - 1 : at);
                if (op) p.state.edit([op]);
              }}
            >
              <Mini state={p.state} art={p.art} vp={p.vp} scene={s.id} />
              <span class="txt">
                <span class="no">Scene {i() + 1}</span>
                <div class="clock">{formatClock(s.scene.clock) || "–:––"}</div>
                <div class="cap">{s.scene.name}</div>
              </span>
              <Show when={here(s.id).length > 0}>
                <span class="here">
                  <For each={here(s.id)}>
                    {(x) => (
                      <span class="av sm" style={{ background: colorOf(x.state!.color) }} title={x.state!.name}>
                        {(x.state!.name.trim()[0] ?? "?").toUpperCase()}
                      </span>
                    )}
                  </For>
                </span>
              </Show>
            </button>
          )}
        </For>
        <Show when={p.state.canEdit() && scenes().length < 64}>
          <button class="card add" data-testid="scene-add" onClick={add}>
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>Add scene</span>
          </button>
          <Show when={p.onMatch}>
            <button class="card add match" data-testid="scene-from-match" onClick={() => p.onMatch?.()}>
              <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 18h16M7 18V9M12 18V5M17 18v-6" />
              </svg>
              <span>From match</span>
            </button>
          </Show>
        </Show>
      </div>
      <button class="nav" aria-label="Next scene" disabled={index() >= scenes().length - 1} onClick={() => flipBy(1)}>
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </footer>
  );
}
