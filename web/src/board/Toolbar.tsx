// The compact tool picker under the map (design/v1-board, "Tools"). Keys: V D A C L E;
// Ctrl+Z undo, Ctrl+Shift+Z or Ctrl+Y redo. A view link gets Look and Laser only.

import { For, Show, onCleanup, onMount } from "solid-js";
import { PALETTE, colorOf } from "../core/device";
import { cx } from "../ui/cx";
import { ICON_CLEAR, ICON_COMMENTS, ICON_REDO, ICON_UNDO, TOOLS, type Tool, VIEWER_TOOLS } from "./tools";

const Ico = (p: { d: string }) => <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" innerHTML={p.d} />;

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
  clearInk: () => void;
  inkCount: number;
  commentsOpen: boolean;
  toggleComments: () => void;
}) {
  const tools = () => (p.editor ? TOOLS : TOOLS.filter((t) => VIEWER_TOOLS.includes(t.tool)));
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
                <Show when={t.tool === "draw"}>
                  <i class="ink-dot" style={{ background: colorOf(p.ink) }} />
                </Show>
                <i class="k">{t.key}</i>
              </button>
              <Show when={t.tool === "draw" && p.tool === "draw"}>
                <span class="ink-palette" role="radiogroup" aria-label="Ink colour" data-testid="ink-palette">
                  <For each={PALETTE}>
                    {(c, i) => (
                      <button
                        class={cx("sw-btn", p.ink === i() && "on")}
                        style={{ "--c": c.hex }}
                        title={c.name}
                        role="radio"
                        aria-checked={p.ink === i()}
                        aria-label={`Ink: ${c.name}`}
                        onClick={() => p.setInk(i())}
                      />
                    )}
                  </For>
                </span>
              </Show>
            </>
          )}
        </For>
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
          <button class="tb icon" data-testid="clear-ink" title="Clear ink" aria-label="Clear ink" disabled={p.inkCount === 0} onClick={() => p.clearInk()}>
            <Ico d={ICON_CLEAR} />
          </button>
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
