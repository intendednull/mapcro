// The linked replays folder in Player (spec §6b, Getting a replay in; `folder.ts` has the rules):
// a quiet "Link replays folder" once, then "Upload <match> from your replays folder" when the
// open match's file is there. Browsers can't link Steam's default folder (Chromium's blocklist:
// Program Files, ~/.local/share), so it serves a second Steam library; elsewhere the file picker
// and the drop are the way, as before. One store for the tab, shared by Player's bar, its notice
// and the prompt; it reads the source while any of them is shown: on focus, when the tab is shown
// again, and every POLL_MS while it's visible. The UI reads replays only through `ReplaySource`.
// In the Windows app (`desktop.ts`) the source is the app's own watch of the folder: nothing to
// link, and the open match's replay is parsed there and only its timeline uploaded.

import { For, Match, Show, Switch, createRoot, createSignal, onCleanup } from "solid-js";
import { cx } from "../ui/cx";
import {
  type DirHandleLike,
  NOT_LINKED,
  POLL_MS,
  REPLAYS_PATH,
  type Replay,
  type ReplaySource,
  access,
  folderSource,
  forgetFolder,
  found,
  loadFolder,
  lookFailed,
  recent,
  saveFolder,
  settleIn,
  supported,
} from "./folder";
import { DesktopError, type LocalSource, bridge, desktopSource, isLocal, windowsAppLink } from "./desktop";

/** The app found no replays folder (no Steam, or no Deadlock in it). */
export const APP_NOT_FOUND = "Deadlock's replays folder wasn't found. Upload the file instead.";

/** Where the source stands: none here, none linked, linked but needing a click to read it, or
 * read (its replays). */
export type FolderState = { kind: "unsupported" } | { kind: "unlinked" } | { kind: "prompt" } | { kind: "linked"; replays: Replay[] };

type PickerWindow = { showDirectoryPicker(o: { id?: string; mode?: "read" }): Promise<DirHandleLike> };

function createStore() {
  const app = bridge();
  const [state, setState] = createSignal<FolderState>(app ? { kind: "linked", replays: [] } : { kind: supported() ? "unlinked" : "unsupported" });
  const [now, setNow] = createSignal(Date.now());
  /** A short line: the picker gave no folder, it held no replays, or it's gone. */
  const [note, setNote] = createSignal("");
  let dir: DirHandleLike | undefined;
  let source: ReplaySource | undefined = app ? desktopSource(app) : undefined;
  let looking: Promise<void> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const look = (): Promise<void> => {
    if (!source || looking) return looking ?? Promise.resolve();
    const s = source;
    const p = (async () => {
      try {
        const replays = await s.list();
        if (source !== s) return;
        const t = Date.now();
        setNow(t);
        setState({ kind: "linked", replays });
        if (replays.length) setNote("");
        clearTimeout(settleTimer);
        const wait = settleIn(replays, t);
        if (wait !== undefined) settleTimer = setTimeout(() => void look(), wait);
      } catch (e) {
        if (source !== s) return;
        if (app) {
          // The app's watch: nothing to link again, only a line when it found no folder.
          setState({ kind: "linked", replays: [] });
          setNote(e instanceof DesktopError && e.code === "not_found" ? APP_NOT_FOUND : "");
          return;
        }
        if (lookFailed(e) === "prompt") {
          setState({ kind: "prompt" });
          return;
        }
        dir = source = undefined;
        void forgetFolder();
        setNote("Replays folder not found. Link it again.");
        setState({ kind: "unlinked" });
      }
    })().finally(() => {
      looking = undefined;
    });
    looking = p;
    return p;
  };

  /** Use `d`: read it if access is granted, else wait for a click. */
  const use = async (d: DirHandleLike, ask: boolean) => {
    dir = d;
    source = folderSource(d);
    const a = await access(d, ask);
    if (dir !== d) return;
    if (a === "granted") return look();
    if (a === "denied") {
      // Refused: linking again (the picker grants access) is the way back.
      dir = source = undefined;
      setState({ kind: "unlinked" });
    } else setState({ kind: "prompt" });
  };

  // The folder linked on an earlier visit.
  if (!app && supported())
    void loadFolder().then((d) => {
      if (d && !dir) void use(d, false);
    });

  /** Pick the folder (from a click: the browser requires one). */
  const link = async () => {
    let d: DirHandleLike;
    try {
      d = await (globalThis as unknown as PickerWindow).showDirectoryPicker({ id: "mapcro-replays", mode: "read" });
    } catch {
      // Cancelled, or refused: the page can't tell which, and Steam's default folder is refused.
      setNote(NOT_LINKED);
      return;
    }
    setNote("");
    void saveFolder(d);
    await use(d, true);
    const s = state();
    if (s.kind === "linked" && !s.replays.length) setNote(`No replays there. Pick ${REPLAYS_PATH}.`);
  };
  /** Ask for access again (from a click). */
  const allow = () => (dir ? use(dir, true) : Promise.resolve());
  /** The open match's file, from the source. */
  const read = (id: string) => (source ? source.read(id) : Promise.reject(new Error("no source")));
  /** The source that parses here (the app's), if this is one. */
  const local = (): LocalSource | undefined => (isLocal(source) ? source : undefined);

  // Looking while shown.
  let shown = 0;
  let stop: (() => void) | undefined;
  const start = () => {
    const again = () => document.visibilityState === "visible" && void look();
    const timer = setInterval(again, POLL_MS);
    addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    void look();
    return () => {
      clearInterval(timer);
      clearTimeout(settleTimer);
      removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  };
  const watch = () => {
    if (state().kind === "unsupported") return;
    if (!shown++) stop = start();
    onCleanup(() => {
      if (!--shown) {
        stop?.();
        stop = undefined;
      }
    });
  };

  return { state, now, note, link, allow, read, local, inApp: !!app, watch };
}

let store: ReturnType<typeof createStore> | undefined;
/** The tab's replays folder, watched while the calling component is shown. */
export function useReplaysFolder() {
  store ??= createRoot(() => createStore());
  store.watch();
  return store;
}
type Store = ReturnType<typeof useReplaysFolder>;

/** The open match's replay in the linked folder, if it's there (for the caller's own buttons). */
export const folderHas = (f: Store, id: string | undefined) => {
  const s = f.state();
  return s.kind === "linked" ? found(s.replays, id, f.now()) : undefined;
};

/**
 * "Upload <match> from your replays folder", when the open match's file is there. In the app,
 * `onLocal` gets the parse (the timeline, gzipped) and the file, for when the server takes no
 * timelines yet.
 */
export function FolderFound(p: {
  id: string | undefined;
  onFile: (f: File) => void;
  onLocal?: (id: string, timeline: () => Promise<Blob>, file: () => Promise<File>) => void;
  large?: boolean;
}) {
  const f = useReplaysFolder();
  const take = async (id: string) => {
    const local = f.local();
    if (local && p.onLocal) return p.onLocal(id, () => local.timeline(id), () => local.read(id));
    try {
      p.onFile(await f.read(id));
    } catch {
      void f.allow(); // Moved, or access lost: look again.
    }
  };
  return (
    <Show when={folderHas(f, p.id)}>
      {(r) => (
        <button class={cx("btn primary", !p.large && "small")} type="button" data-testid="folder-upload" data-match={r().id} onClick={() => void take(r().id)}>
          Upload {r().id} from your replays folder
        </button>
      )}
    </Show>
  );
}

/**
 * The folder's quiet secondary actions, after the upload: Link replays folder, Reconnect
 * replays folder, or (linked, no file for this match) a line and Change folder. Nothing where
 * the browser can't link a folder.
 */
export function FolderLink(p: { id: string | undefined }) {
  const f = useReplaysFolder();
  const note = () => (
    <Show when={f.note()}>
      <span class="pl-folder-note" data-testid="folder-note">
        {f.note()}
      </span>
    </Show>
  );
  return (
    <Switch>
      <Match when={f.state().kind === "unlinked"}>
        <button class="btn ghost small" type="button" data-testid="folder-link" title={`For a Steam library outside the default folder: ${REPLAYS_PATH}`} onClick={() => void f.link()}>
          Link replays folder
        </button>
        {note()}
        <WindowsApp />
      </Match>
      <Match when={f.state().kind === "prompt"}>
        <button class="btn ghost small" type="button" data-testid="folder-allow" title="Your browser asks before reading the folder again" onClick={() => void f.allow()}>
          Reconnect replays folder
        </button>
      </Match>
      <Match when={f.state().kind === "linked" && !folderHas(f, p.id)}>
        <Show when={p.id && !f.note()}>
          <span class="pl-folder-note" data-testid="folder-none" title={REPLAYS_PATH}>
            Not in your replays folder yet
          </span>
        </Show>
        {note()}
        <Show when={!f.inApp}>
          <button class="btn ghost small" type="button" data-testid="folder-change" title={REPLAYS_PATH} onClick={() => void f.link()}>
            Change folder
          </button>
        </Show>
      </Match>
    </Switch>
  );
}

/** With no match open: the folder's newest replays, to open one (or its quiet link). */
export function FolderRecent(p: { onOpen: (id: string) => void }) {
  const f = useReplaysFolder();
  const list = () => {
    const s = f.state();
    return s.kind === "linked" ? recent(s.replays, undefined, f.now()) : [];
  };
  return (
    <Show when={list().length} fallback={<FolderLink id={undefined} />}>
      <span class="pl-folder-note">Recent replays</span>
      <For each={list()}>
        {(r) => (
          <button class="btn ghost small" type="button" data-testid="folder-recent" data-match={r.id} onClick={() => p.onOpen(r.id)}>
            {r.id}
          </button>
        )}
      </For>
    </Show>
  );
}

/** "Get the Windows app", quiet: on a Windows browser only, never in the app, once released
 * (`desktop.ts` `WINDOWS_APP_RELEASED`). It finds the replays folder on its own. */
export function WindowsApp(p: { class?: string }) {
  const href = windowsAppLink();
  return (
    <Show when={href}>
      {(h) => (
        <a class={cx("btn ghost small", p.class)} data-testid="windows-app" href={h()} target="_blank" rel="noopener" title="Finds your replays folder on its own">
          Get the Windows app
        </a>
      )}
    </Show>
  );
}
