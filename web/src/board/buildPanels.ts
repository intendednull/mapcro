// The top bar's builds, in Player and in a scene alike (map-state spec §6): one hero's build
// open under its portrait, or all twelve (the All builds button, or Tab held, as the game's
// scoreboard). What is open is the host's view state (`builds.inspect`, `builds.all`,
// `builds.popover`), so a follower opens what its presenter opens (spec §8); this is the keys
// and clicks that change it, the same for both bars.

import { batch, onCleanup, onMount } from "solid-js";
import { boardKeys } from "../core/keys";
import { modalOpen } from "../ui/modal";
import type { PlayerHost } from "../player/host";

/**
 * `bar`: the bar's element (a press outside it closes the builds). `enabled`: whether the bar
 * has builds to show (a scene without a snapshot doesn't: nothing is open there, and Tab stays
 * the browser's). Call inside the bar's component.
 */
export function buildPanels(host: PlayerHost, bar: () => HTMLElement | undefined, enabled: () => boolean = () => true) {
  const { openBuild, setOpenBuild, allBuilds, setAllBuilds, tabHeld, setTabHeld } = host;
  const popover = { open: host.buildPopover, set: host.setBuildPopover };
  /** Every build open: the button, or Tab held. */
  const all = () => enabled() && (allBuilds() || tabHeld());
  const expanded = (key: string) => enabled() && (tabHeld() || allBuilds() || openBuild() === key);
  // A build opens with neither popover open, as a fresh one did when the popovers were the DOM's.
  const close = () => batch(() => { setOpenBuild(undefined); setAllBuilds(false); host.setBuildPopover("none"); });
  const toggleAll = () => batch(() => { setOpenBuild(undefined); setAllBuilds(v => !v); host.setBuildPopover("none"); });
  const toggle = (key: string) => {
    const wasOpen = expanded(key);
    batch(() => {
      setAllBuilds(false);
      setOpenBuild(wasOpen ? undefined : key);
      host.setBuildPopover("none");
    });
  };
  /** One hero's build alone, from the list of all (the phone's sheet). */
  const only = (key: string) => batch(() => { setAllBuilds(false); setOpenBuild(key); host.setBuildPopover("none"); });
  onMount(() => {
    const outside = (event: PointerEvent) => {
      if (!enabled()) return;
      const el = bar();
      if (el && !el.contains(event.target as Node) && !(event.target as Element).closest(".pl-bar")) close();
    };
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!enabled() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')) return;
      if (event.key === "Escape" && (allBuilds() || openBuild())) {
        close();
        event.preventDefault();
      }
    };
    // Like the game's scoreboard: holding Tab reveals every build, wherever the focus is (#24, as
    // Space in Player.tsx): a focused button, list or the scrubber doesn't move focus on. A text
    // field, an open dialog or menu keeps its Tab. Shift+Tab still moves focus back, so the
    // keyboard can reach the controls. Captured, so no control's own handler sees it first.
    const tabDown = (event: KeyboardEvent) => {
      if (!enabled() || event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      if (modalOpen() || !boardKeys(event.target as Element | null)) return;
      event.preventDefault();
      setTabHeld(true);
    };
    const release = (event: KeyboardEvent) => { if (event.key === "Tab") setTabHeld(false); };
    const blur = () => setTabHeld(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key);
    window.addEventListener("keydown", tabDown, true);
    onCleanup(() => {
      window.removeEventListener("keydown", tabDown, true);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", blur);
      // Tab held as the bar went (a flip to a scene, or to Player): its keyup may never come here.
      setTabHeld(false);
    });
  });
  return { popover, all, expanded, close, toggleAll, toggle, only };
}
