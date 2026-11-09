// A small custom right-click menu at the pointer (the browser's own is off site-wide, see
// core/contextmenu.ts). Keyboard: it opens with focus on its first item; Up/Down (and Home/End)
// move, Enter or Space runs an item, Escape or Tab closes and gives focus back. A press
// anywhere outside it, a resize or the window losing focus closes it too.

import { For, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

export interface MenuItem {
  label: string;
  testid: string;
  run: () => void;
}

export function ContextMenu(p: {
  /** Where it opens, in client pixels; it is kept inside the window. */
  at: { x: number; y: number };
  label: string;
  items: MenuItem[];
  onClose: () => void;
  testid?: string;
}) {
  let el!: HTMLDivElement;
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const buttons = () => [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const close = (refocus: boolean) => {
    p.onClose();
    if (refocus) back?.focus({ preventScroll: true });
  };

  onMount(() => {
    // Inside the window: flip left or up when it would spill over the edge.
    const r = el.getBoundingClientRect();
    const x = p.at.x + r.width > innerWidth - 4 ? Math.max(4, p.at.x - r.width) : p.at.x;
    const y = p.at.y + r.height > innerHeight - 4 ? Math.max(4, p.at.y - r.height) : p.at.y;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.visibility = "visible";
    buttons()[0]?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) close(false);
    };
    const gone = () => close(false);
    // Capture: a press elsewhere closes it even where that press is handled and stopped.
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", gone);
    window.addEventListener("blur", gone);
    onCleanup(() => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", gone);
      window.removeEventListener("blur", gone);
    });
  });

  const key = (e: KeyboardEvent) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => list[(n + list.length) % list.length]?.focus();
    // The board's own keys (tools, K, undo…) don't see what the menu handles.
    e.stopPropagation();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape" || e.key === "Tab") close(true);
    else if (e.key === "Enter" || e.key === " ") {
      if (i >= 0) run(p.items[i]!);
    } else return;
    e.preventDefault();
  };
  const run = (item: MenuItem) => {
    close(true);
    item.run();
  };

  return (
    <Portal>
      <div
        ref={el}
        class="ctx-menu"
        role="menu"
        aria-label={p.label}
        data-testid={p.testid ?? "ctx-menu"}
        style={{ left: `${p.at.x}px`, top: `${p.at.y}px`, visibility: "hidden" }}
        onKeyDown={key}
        onContextMenu={(e) => e.preventDefault()}
      >
        <For each={p.items}>
          {(item) => (
            <button role="menuitem" tabindex="-1" data-testid={item.testid} onClick={() => run(item)}>
              {item.label}
            </button>
          )}
        </For>
      </div>
    </Portal>
  );
}
