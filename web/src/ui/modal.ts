// A modal's keyboard contract: everything outside it is inert, Tab and Shift+Tab wrap inside it,
// and focus goes back to what opened it when it closes. The dialog itself handles Escape.
//
// Mount the modal through a <Portal> (a direct child of <body>), so "outside" is every other
// child of <body>.

import { onCleanup, onMount } from "solid-js";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => !e.closest("[inert]") && e.getClientRects().length > 0);
}

/** Make `root()` modal while it's mounted. */
export function useModal(root: () => HTMLElement | undefined) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const made: HTMLElement[] = [];
  const tab = (e: KeyboardEvent) => {
    const el = root();
    if (e.key !== "Tab" || !el) return;
    const all = focusables(el);
    if (all.length === 0) return e.preventDefault();
    const first = all[0]!;
    const last = all[all.length - 1]!;
    const at = document.activeElement;
    const inside = at instanceof Node && el.contains(at);
    if (e.shiftKey && (at === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };
  onMount(() => {
    const el = root();
    const host = el && [...document.body.children].find((c) => c.contains(el));
    for (const c of document.body.children) {
      if (c !== host && c instanceof HTMLElement && !c.inert && c.tagName !== "SCRIPT") {
        c.inert = true;
        made.push(c);
      }
    }
    document.addEventListener("keydown", tab, true);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", tab, true);
    for (const c of made) c.inert = false;
    if (opener?.isConnected) opener.focus();
  });
}
