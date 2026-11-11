// A modal's keyboard contract: everything outside it is inert, Tab and Shift+Tab wrap inside it,
// and focus goes back to what opened it when it closes. Escape and the board's keys are the
// dialog's (`dialogKeys`); `ModalScrim` (ui/ModalScrim.tsx) puts the two together.
//
// Mount the modal through a <Portal> (a direct child of <body>), so "outside" is every other
// child of <body>. Modals stack: one opened from another (Share's Clone) holds the keyboard
// while it's open, and focus goes back to the first one's opener if its own is gone.

import { onCleanup, onMount } from "solid-js";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => !e.closest("[inert]") && e.getClientRects().length > 0);
}

interface Open { root: () => HTMLElement | undefined; opener: HTMLElement | undefined }
const open: Open[] = [];
/** The body children this module made inert (and only those are given back). */
const made = new Set<HTMLElement>();

/** Inert everything but the top modal's host; with none open, give everything back. */
function settle() {
  const el = open[open.length - 1]?.root();
  const host = el && [...document.body.children].find((c) => c.contains(el));
  for (const c of made) if (c === host || !c.isConnected) { c.inert = false; made.delete(c); }
  if (!el) {
    for (const c of made) c.inert = false;
    made.clear();
    return;
  }
  for (const c of document.body.children) {
    if (c !== host && c instanceof HTMLElement && !c.inert && c.tagName !== "SCRIPT") {
      c.inert = true;
      made.add(c);
    }
  }
}

const tab = (e: KeyboardEvent) => {
  const el = open[open.length - 1]?.root();
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

/** Make `root()` modal while it's mounted. */
export function useModal(root: () => HTMLElement | undefined) {
  const at = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  // Opened from inside another modal: if that control goes, focus goes where that modal's would.
  const parent = at && open.find((o) => o.root()?.contains(at));
  const me: Open = { root, opener: at && at !== document.body ? at : undefined };
  const fallback = parent?.opener;
  onMount(() => {
    if (open.length === 0) document.addEventListener("keydown", tab, true);
    open.push(me);
    settle();
  });
  onCleanup(() => {
    const i = open.indexOf(me);
    if (i >= 0) open.splice(i, 1);
    if (open.length === 0) document.removeEventListener("keydown", tab, true);
    settle();
    const back = me.opener?.isConnected ? me.opener : fallback?.isConnected ? fallback : undefined;
    back?.focus();
  });
}

/**
 * A dialog's own keys: Escape closes it (when it can be closed), and no key reaches the board's
 * window listeners (Escape's leaveControl, Space, the tool keys). `more` handles the rest.
 */
export const dialogKeys = (onClose: (() => void) | undefined, more?: (e: KeyboardEvent) => void) => (e: KeyboardEvent) => {
  e.stopPropagation();
  if (e.key === "Escape" && onClose) {
    e.preventDefault();
    onClose();
    return;
  }
  more?.(e);
};
