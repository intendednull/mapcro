// The compact tool picker under the map (design/v1-board, "Tools"). Keys: V D A C L E;
// Ctrl+Z undo, Ctrl+Shift+Z or Ctrl+Y redo. A view link gets Look and Laser only.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Palette } from "./Palette";
import { cx } from "../ui/cx";
import { ICON_CLEAR, ICON_COMMENTS, ICON_REDO, ICON_UNDO, TOOLS, type Tool, VIEWER_TOOLS } from "./tools";

const Ico = (p: { d: string }) => <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" innerHTML={p.d} />;

export type ClearKind = "ink" | "arrows" | "comments" | "all";
const CLEARS: Array<{ kind: ClearKind; label: string }> = [
  { kind: "ink", label: "Ink" },
  { kind: "arrows", label: "Arrows" },
  { kind: "comments", label: "Comments" },
  { kind: "all", label: "All" },
];

export function Toolbar(p: {
  tool: Tool;
  setTool: (t: Tool) => void;
  editor: boolean;
  ink: number;
  setInk: (i: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** Clear one kind of placed thing on the scene (or all of them), as one undoable step. */
  clear: (what: ClearKind) => void;
  counts: Record<ClearKind, number>;
  commentsOpen: boolean;
  toggleComments: () => void;
}) {
  const tools = () => (p.editor ? TOOLS : TOOLS.filter((t) => VIEWER_TOOLS.includes(t.tool)));
  const [clearOpen, setClearOpen] = createSignal(false);
  let clearBox: HTMLSpanElement | undefined;
  onMount(() => {
    const away = (e: PointerEvent) => clearOpen() && !clearBox?.contains(e.target as Node) && setClearOpen(false);
    window.addEventListener("pointerdown", away, true);
    onCleanup(() => window.removeEventListener("pointerdown", away, true));
  });
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (!p.editor) return;
        if (e.shiftKey) p.redo();
        else p.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        if (p.editor) p.redo();
        return;
      }
      if (mod || e.altKey) return;
      const hit = tools().find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (hit) p.setTool(hit.tool);
    };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });
  return (
    <>
      <div class={cx("toolbar", !p.editor && "viewer")} role="toolbar" aria-label="Tools" data-testid="toolbar">
        <For each={tools()}>
          {(t) => (
            <>
              <button
                class={cx("tb", p.tool === t.tool && "on")}
                data-testid={`tool-${t.tool}`}
                aria-pressed={p.tool === t.tool}
                onClick={() => p.setTool(t.tool)}
              >
                <Ico d={t.icon} />
                <span>{!p.editor && t.tool === "move" ? "Look" : t.label}</span>
                <i class="k">{t.key}</i>
              </button>
            </>
          )}
        </For>
        <Palette value={p.ink} set={p.setInk} />
        <button
          class={cx("tb icon", p.commentsOpen && "on")}
          data-testid="comments-toggle"
          title="Comments"
          aria-label="Comments"
          aria-pressed={p.commentsOpen}
          onClick={() => p.toggleComments()}
        >
          <Ico d={ICON_COMMENTS} />
        </button>
        <Show when={p.editor}>
          <span class="clear-menu" ref={clearBox}>
            <button
              class={cx("tb icon", clearOpen() && "on")}
              data-testid="clear-menu"
              title="Clear"
              aria-label="Clear"
              aria-haspopup="menu"
              aria-expanded={clearOpen()}
              disabled={p.counts.all === 0}
              onClick={() => setClearOpen(!clearOpen())}
            >
              <Ico d={ICON_CLEAR} />
            </button>
            <Show when={clearOpen()}>
              <div class="clear-pop" role="menu" data-testid="clear-pop">
                <For each={CLEARS}>
                  {(c) => (
                    <button
                      role="menuitem"
                      data-testid={`clear-${c.kind}`}
                      disabled={p.counts[c.kind] === 0}
                      onClick={() => {
                        setClearOpen(false);
                        p.clear(c.kind);
                      }}
                    >
                      {c.label}
                      <span class="n">{p.counts[c.kind]}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </span>
          <span class="tb-sep" />
          <button class="tb icon" data-testid="undo" title="Undo" aria-label="Undo" disabled={!p.canUndo} onClick={() => p.undo()}>
            <Ico d={ICON_UNDO} />
          </button>
          <button class="tb icon" data-testid="redo" title="Redo" aria-label="Redo" disabled={!p.canRedo} onClick={() => p.redo()}>
            <Ico d={ICON_REDO} />
          </button>
        </Show>
      </div>

    </>
  );
}
