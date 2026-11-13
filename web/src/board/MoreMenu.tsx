// More, the desktop board header's "⋯" (spec §4b, The board header): the header's lesser actions
// as a menu under it, in groups with a rule between. Keys: Enter, Space or Down on More opens it
// on its first row; Up and Down move and wrap, Home and End jump; Enter or Space runs a row and
// closes it; Escape closes it with focus back on More, Tab closes it and moves on. A press outside,
// a resize or the window losing focus closes it. Running a row puts focus on More first, so a
// dialog it opens gives focus back to More (ui/modal.ts). The open flag is this browser's own
// (not view state: a follower doesn't get it).

import { For, type JSX, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

export interface MoreRow {
  label: string;
  testid: string;
  icon: () => JSX.Element;
  /** A link row (a download, the app's scheme); otherwise `run`. */
  href?: string | undefined;
  download?: boolean;
  /** Update available: brass. */
  brass?: boolean;
  run?: () => void;
}

export function MoreMenu(p: { groups: MoreRow[][]; dot: boolean }) {
  const [open, setOpen] = createSignal(false);
  let btn!: HTMLButtonElement;
  let panel: HTMLDivElement | undefined;
  const rows = () => [...(panel?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btn.focus({ preventScroll: true });
  };
  const show = () => {
    setOpen(true);
  };

  const outside = (e: PointerEvent) => {
    if (!panel?.contains(e.target as Node) && !btn.contains(e.target as Node)) close(false);
  };
  const gone = () => close(false);
  const watch = (on: boolean) => {
    const f = on ? "addEventListener" : "removeEventListener";
    window[f]("pointerdown", outside as EventListener, true);
    window[f]("resize", gone);
    window[f]("blur", gone);
  };
  onCleanup(() => watch(false));

  const place = (el: HTMLDivElement) => {
    panel = el;
    const r = btn.getBoundingClientRect();
    el.style.right = `${innerWidth - r.right}px`;
    el.style.top = `${r.bottom + 6}px`;
    watch(true);
    // The rows are in once the panel is: focus the first.
    queueMicrotask(() => rows()[0]?.focus({ preventScroll: true }));
    onCleanup(() => {
      watch(false);
      panel = undefined;
    });
  };

  const pick = (row: MoreRow, el: HTMLElement) => {
    if (row.href) {
      // The browser follows the link (or saves the file) as for a click; then the menu goes.
      el.click();
      return;
    }
    close(true);
    row.run?.();
  };

  const key = (e: KeyboardEvent) => {
    const list = rows();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => list[(n + list.length) % list.length]?.focus();
    // The board's own keys don't see what the menu handles.
    e.stopPropagation();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") {
      // Not prevented: the browser moves on from More, the menu's place in the tab order.
      close(true);
      return;
    } else if (e.key === "Enter" || e.key === " ") {
      const row = p.groups.flat()[i];
      if (row) pick(row, list[i]!);
    } else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={btn}
        class="btn ghost more"
        data-testid="more"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => (open() ? close(false) : show())}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown") return;
          e.preventDefault();
          e.stopPropagation();
          show();
        }}
      >
        ⋯
        <Show when={p.dot}>
          <span class="more-dot" data-testid="more-dot" />
        </Show>
      </button>
      <Show when={open()}>
        <Portal>
          <div ref={place} class="more-menu" role="menu" aria-label="More" data-testid="more-menu" onKeyDown={key} onContextMenu={(e) => e.preventDefault()}>
            <For each={p.groups}>
              {(group, g) => (
                <>
                  <Show when={g() > 0}>
                    <div class="more-rule" role="separator" />
                  </Show>
                  <For each={group}>
                    {(row) =>
                      row.href ? (
                        <a
                          role="menuitem"
                          tabindex="-1"
                          class="more-row"
                          classList={{ brass: !!row.brass }}
                          href={row.href}
                          {...(row.download ? { download: "" } : {})}
                          data-testid={row.testid}
                          onClick={() => queueMicrotask(() => close(true))}
                        >
                          {row.icon()}
                          {row.label}
                        </a>
                      ) : (
                        <button role="menuitem" tabindex="-1" class="more-row" data-testid={row.testid} onClick={(e) => pick(row, e.currentTarget)}>
                          {row.icon()}
                          {row.label}
                        </button>
                      )
                    }
                  </For>
                </>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  );
}
