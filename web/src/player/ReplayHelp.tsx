// Getting a replay file to mapcro (operator, 2026-11-08: people can't find theirs): "Where's my
// replay?" beside every upload, steps through the game and Steam rather than a path (a browser
// can't open its file dialog anywhere in particular), and dropping a `.dem` on the page.
// Labels from the game's and Steam's own English strings: Deadlock's `Citadel_Profile_MatchHistory`
// "Match History" and `Citadel_Replay_Download` "Replay"; Steam's "Properties...",
// `AppProperties_LocalFilesPage` "Installed Files" and `AppProperties_LocalFilesBrowse` "Browse...".

import { Show, createSignal, onCleanup } from "solid-js";
import { cx } from "../ui/cx";
import { isDem } from "./notice";
import { REPLAYS_PATH, supported } from "./folder";
import { bridge, desktopAppLinks } from "./desktop";
import { AppDownload } from "./AppDownload";

export function ReplayHelp(p: { id?: string | undefined; class?: string }) {
  let el!: HTMLDetailsElement;
  // Closes on a press anywhere else, like a menu.
  const away = (e: PointerEvent) => {
    if (el.open && !el.contains(e.target as Node)) el.open = false;
  };
  document.addEventListener("pointerdown", away);
  onCleanup(() => document.removeEventListener("pointerdown", away));
  return (
    <details ref={el} class={cx("replay-help", p.class)} data-testid="replay-help">
      <summary data-testid="replay-help-open">Where's my replay?</summary>
      <ol class="replay-help-steps" data-testid="replay-help-steps">
        <li>
          <b>Download it in Deadlock</b>
          <span>Match History → the match → Replay</span>
        </li>
        <li>
          <b>Open the game's files</b>
          <span>Steam: right-click Deadlock → Properties… → Installed Files → Browse…</span>
        </li>
        <li>
          <b>Pick the file</b>
          <span>
            game → citadel → replays → <code data-testid="replay-help-file">{p.id ?? "<match id>"}.dem</code>
          </span>
        </li>
        <li class="replay-help-drop">Or drag it onto this page.</li>
        <Show when={supported() && !bridge()}>
          <li class="replay-help-link" data-testid="replay-help-link">
            Or, for a Steam library outside the default folder, link its replays folder once and Player
            finds new replays: <code>{REPLAYS_PATH}</code>
          </li>
        </Show>
        <Show when={desktopAppLinks()}>
          {(l) => (
            <li class="replay-help-app" data-testid="replay-help-app">
              Or get the {l().title}: it finds the replays folder on its own. <AppDownload links={l()} where="help" />
            </li>
          )}
        </Show>
      </ol>
    </details>
  );
}

/**
 * Files dragged over the page: while `enabled`, an overlay says where it goes, and a dropped
 * `.dem` goes to `onFile`; anything else is refused with a short line. A file dropped while not
 * enabled is still caught, so the browser doesn't leave the page to open it.
 */
export function createDemDrop(o: { enabled: () => boolean; onFile: (f: File) => void; onRefuse: (text: string) => void }) {
  const [over, setOver] = createSignal(false);
  let depth = 0;
  const files = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  const enter = (e: DragEvent) => {
    if (!files(e)) return;
    e.preventDefault();
    depth++;
    setOver(o.enabled());
  };
  const move = (e: DragEvent) => {
    if (!files(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = o.enabled() ? "copy" : "none";
  };
  const leave = (e: DragEvent) => {
    if (!files(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) setOver(false);
  };
  const drop = (e: DragEvent) => {
    if (!files(e)) return;
    e.preventDefault();
    depth = 0;
    setOver(false);
    if (!o.enabled()) return;
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    if (!isDem(f.name)) return o.onRefuse(NOT_DEM);
    o.onFile(f);
  };
  const end = () => {
    depth = 0;
    setOver(false);
  };
  addEventListener("dragenter", enter);
  addEventListener("dragover", move);
  addEventListener("dragleave", leave);
  addEventListener("drop", drop);
  addEventListener("dragend", end);
  onCleanup(() => {
    removeEventListener("dragenter", enter);
    removeEventListener("dragover", move);
    removeEventListener("dragleave", leave);
    removeEventListener("drop", drop);
    removeEventListener("dragend", end);
  });
  return over;
}

export const NOT_DEM = "Not a .dem file. Pick the match's replay.";

/** The overlay while a file is dragged over the page. */
export function DropOverlay(p: { over: boolean; id?: string | undefined }) {
  return (
    <Show when={p.over}>
      <div class="drop-overlay" data-testid="drop-overlay">
        <div class="drop-card">
          <b>Drop the replay to upload it</b>
          <span>{p.id ? `${p.id}.dem` : "<match id>.dem"}</span>
        </div>
      </div>
    </Show>
  );
}
