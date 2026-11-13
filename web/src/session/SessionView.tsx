// `/s/<session>?tab=<tab>#<token>` (sessions.md §4.1, §7, §8): the session's own connection, its
// tab strip, and the open tab's board, mounted afresh for each tab (keyed by board and
// credential: nothing of one board's mount reaches another's). No pool yet (phase 3): a switch
// is a cold open, from IndexedDB where the board is stored.

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { newRecordId } from "../wasm/mapcro_wasm.js";
import { Board, type InSession } from "../board/Board";
import { ShareDialog } from "../board/ShareDialog";
import { addGrant, sessionUrl, withdrawGrant } from "../core/api";
import { knownBoards, rememberBoard } from "../core/device";
import { replace } from "../core/nav";
import { LIMITS } from "../gen/limits";
import type { RecordId } from "../gen/RecordId";
import type { Art } from "../map/pack";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { DeadLink } from "../ui/DeadLink";
import { InlineEdit } from "../ui/InlineEdit";
import { Wordmark } from "../ui/Wordmark";
import { type AddChoice, AddMenu, refusal, takeAddOnOpen } from "./AddGame";
import { UndoHistory } from "./history";
import { createSessionState } from "./state";
import { type TabRow, addTabOps, credentialFor, moveOps, neighbourOf, pickTab, removeOps, renameOps } from "./tabs";

const editable = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

export function SessionView(p: { session: string; token: string; tab: string | undefined; art: Art }) {
  const history = new UndoHistory();
  const s = createSessionState(p.session, p.token, history);
  onMount(() => void s.start());
  onCleanup(() => s.stop());
  const loaded = () => s.settled();
  const [active, setActive] = createSignal<RecordId | undefined>(p.tab);
  const [adding, setAdding] = createSignal(takeAddOnOpen(p.session));
  const [sharing, setSharing] = createSignal(false);
  const [menu, setMenu] = createSignal<{ at: { x: number; y: number }; tab: TabRow }>();
  const [renaming, setRenaming] = createSignal<RecordId>();
  const opens = new Map<RecordId, () => void>();
  const [dragging, setDragging] = createSignal<RecordId>();

  // The open tab: the one asked for while it's live; once it goes (removed here or by a peer),
  // its left neighbour as the strip stood (§7.2); with none asked or live, the first.
  let before: RecordId[] = [];
  createEffect(() => {
    const tabs = s.tabs();
    if (!loaded()) return;
    const cur = active();
    const live = cur !== undefined && tabs.some((t) => t.id === cur);
    const next = live ? cur : cur !== undefined && before.includes(cur) ? neighbourOf(before, cur, tabs) : pickTab(tabs, cur);
    before = tabs.map((t) => t.id);
    if (next !== cur) setActive(next);
  });
  // The address names the tab being looked at, without adding history (§7.1).
  createEffect(() => {
    if (!loaded()) return;
    const want = sessionUrl(location.origin, p.session, p.token, active());
    if (location.href !== want) replace(want);
  });
  // Your boards keeps this session (§7.3): its title and how many games.
  createEffect(() => {
    const t = s.title();
    const r = s.role();
    if (t && r) rememberBoard({ board: p.session, token: p.token, title: t, kind: "session", games: s.tabs().length, edit: s.canEdit() });
  });
  createEffect(() => {
    const t = s.title();
    if (t && !active()) document.title = `${t} · mapcro`;
  });

  const tab = createMemo(() => s.tabs().find((t) => t.id === active()));
  // What the board mounts with. Another board or another credential is a new mount; a rename or
  // reorder of the open tab is not.
  const mount = createMemo(
    () => {
      const t = tab();
      return t ? { board: t.board, ...credentialFor(t, p.session, p.token, knownBoards()) } : undefined;
    },
    undefined,
    { equals: (a, b) => a?.board === b?.board && a?.token === b?.token && a?.via?.grant === b?.via?.grant },
  );

  // ---- the toast (§7.2: "Removed <name>", Undo) ----
  const [toast, setToast] = createSignal<{ text: string; undo: boolean }>();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (text: string, undo = false) => {
    setToast({ text, undo });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(undefined), 6000);
  };
  onCleanup(() => clearTimeout(toastTimer));

  // ---- strip edits: each one step in the page's one undo (§7.2) ----
  // A switch waits for the pointer gesture in progress to end (§4.1): a drag released during it
  // lands on the board it began on, which unmounts after.
  let pressed = false;
  let queued: RecordId | undefined;
  onMount(() => {
    const down = () => (pressed = true);
    const up = () => {
      pressed = false;
      const q = queued;
      queued = undefined;
      // After the board's own pointerup handlers have run.
      if (q !== undefined) setTimeout(() => setActive(q), 0);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    onCleanup(() => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    });
  });
  const pick = (id: RecordId) => {
    setMenu(undefined);
    if (pressed) queued = id;
    else setActive(id);
  };
  const remove = (t: TabRow, revoke = false) => {
    setMenu(undefined);
    if (!s.edit(removeOps(t.id))) return;
    if (!revoke) return say(`Removed ${t.name}`, true);
    // Remove and revoke (§3.7): the grant is withdrawn too, which undo can't bring back.
    say(`Removed ${t.name}`);
    withdrawGrant(p.session, p.token, t.grant).catch((e) => say(refusal(e)));
  };
  const rename = (t: TabRow, name: string) => void s.edit(renameOps(t, name));
  const move = (t: TabRow, by: number) => {
    setMenu(undefined);
    const i = s.tabs().findIndex((x) => x.id === t.id);
    s.edit(moveOps(s.tabs(), t.id, i + by));
  };
  const dropOn = (target: TabRow) => {
    const id = dragging();
    setDragging(undefined);
    if (!id || id === target.id) return;
    const tabs = s.tabs();
    const from = tabs.findIndex((x) => x.id === id);
    const at = tabs.filter((x) => x.id !== id).findIndex((x) => x.id === target.id);
    s.edit(moveOps(tabs, id, from < tabs.findIndex((x) => x.id === target.id) ? at + 1 : at));
  };
  const add = async (c: AddChoice): Promise<string | undefined> => {
    try {
      const g = await addGrant(p.session, p.token, c.board, c.token, c.view ? "view" : undefined);
      const id = newRecordId();
      if (!s.edit(addTabOps(id, s.tabs(), g.board, g.grant_id, c.title ?? `Game ${s.tabs().length + 1}`))) return "Failed";
      setActive(id);
      return undefined;
    } catch (e) {
      return refusal(e);
    }
  };
  const menuItems = (t: TabRow): MenuItem[] => {
    const i = s.tabs().findIndex((x) => x.id === t.id);
    const items: MenuItem[] = [{ label: "Rename", testid: "tab-rename", run: () => (setMenu(undefined), setRenaming(t.id), opens.get(t.id)?.()) }];
    if (i > 0) items.push({ label: "Move left", testid: "tab-move-left", run: () => move(t, -1) });
    if (i < s.tabs().length - 1) items.push({ label: "Move right", testid: "tab-move-right", run: () => move(t, 1) });
    items.push({ label: "Remove", testid: "tab-remove-menu", run: () => remove(t) });
    items.push({ label: "Remove and revoke", testid: "tab-revoke", run: () => remove(t, true) });
    return items;
  };

  // Ctrl+PageUp / Ctrl+PageDown switch tabs, outside fields (§8).
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || (e.key !== "PageUp" && e.key !== "PageDown") || editable(e.target)) return;
      const tabs = s.tabs();
      const i = tabs.findIndex((t) => t.id === active());
      const next = tabs[i + (e.key === "PageDown" ? 1 : -1)];
      e.preventDefault();
      if (next) pick(next.id);
    };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });

  const title = () => (
    <div class="board-title session-title">
      <b>
        <InlineEdit
          class="title"
          label="Session title"
          testid="session-title"
          editable={s.canEdit() && !!s.metaId()}
          value={s.title()}
          placeholder="…"
          maxLength={LIMITS.max_title}
          onCommit={(text) => {
            const t = text.trim();
            const id = s.metaId();
            if (t && id && t !== s.title()) s.edit([{ Set: { id, value: { SessionTitle: t } } }]);
          }}
        />
      </b>
      <span data-testid="session-games">
        {s.tabs().length} game{s.tabs().length === 1 ? "" : "s"}
      </span>
    </div>
  );
  const share = () => (
    <Show when={s.canEdit()}>
      <button class="btn primary" data-testid="session-share" onClick={() => setSharing(true)}>
        Share
      </button>
    </Show>
  );
  const strip = () => (
    <nav class="game-strip" data-testid="game-strip" aria-label="Games" data-can-edit={String(s.canEdit())}>
      <div class="game-tabs" role="tablist">
        <For each={s.tabs()}>
          {(t) => (
            <div
              class="game-tab"
              classList={{ on: t.id === active(), dragging: dragging() === t.id }}
              role="tab"
              tabIndex={0}
              aria-selected={t.id === active()}
              aria-label={`Game tab, ${t.name}`}
              title={t.name}
              data-testid="game-tab"
              data-tab={t.id}
              data-board={t.board}
              draggable={s.canEdit() && renaming() !== t.id}
              onClick={() => renaming() !== t.id && pick(t.id)}
              onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && pick(t.id)}
              onDblClick={() => {
                if (!s.canEdit()) return;
                setRenaming(t.id);
                opens.get(t.id)?.();
              }}
              onContextMenu={(e) => {
                if (!s.canEdit()) return;
                e.preventDefault();
                setMenu({ at: { x: e.clientX, y: e.clientY }, tab: t });
              }}
              onDragStart={(e) => {
                setDragging(t.id);
                e.dataTransfer?.setData("text/plain", t.id);
              }}
              onDragEnd={() => setDragging(undefined)}
              onDragOver={(e) => dragging() && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                dropOn(t);
              }}
            >
              <InlineEdit
                class="game-name"
                label="Tab name"
                testid="tab-name"
                editable={renaming() === t.id}
                value={t.name}
                maxLength={LIMITS.max_name}
                bindOpen={(o) => opens.set(t.id, o)}
                onEditing={(on) => !on && setRenaming(undefined)}
                onCommit={(text) => rename(t, text)}
              />
              <Show when={s.canEdit()}>
                <button
                  class="game-x"
                  data-testid="tab-remove"
                  aria-label="Remove"
                  title="Remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(t);
                  }}
                >
                  ×
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={s.canEdit()}>
        <button class="btn ghost small add-game" data-testid="add-game" onClick={() => setAdding(true)}>
          + Add game
        </button>
      </Show>
    </nav>
  );
  const inSession = (): Omit<InSession, "via"> => ({ history, joinKey: p.session, title, share, strip });
  const closed = () => s.connection().kind === "closed";

  return (
    <>
      <Show
        when={!closed() && mount()}
        keyed
        fallback={
          <div class="app board-app session-app" data-testid="session" data-session={p.session}>
            <header class="top">
              <Wordmark />
              {title()}
              <div class="spacer" />
              {share()}
            </header>
            {strip()}
            <Show when={loaded() && !s.tabs().length}>
              <div class="session-empty muted" data-testid="session-empty">
                No games
              </div>
            </Show>
          </div>
        }
      >
        {(m) => (
          <div class="session-board" data-testid="session" data-session={p.session}>
            <Board board={m.board} token={m.token} art={p.art} session={{ ...inSession(), ...(m.via ? { via: m.via } : {}) }} />
          </div>
        )}
      </Show>
      <Show when={closed()}>
        <DeadLink />
      </Show>
      <Show when={adding() && s.canEdit()}>
        <AddMenu onAdd={add} onClose={() => setAdding(false)} />
      </Show>
      <Show when={sharing() && s.canEdit()}>
        <ShareDialog board={p.session} token={p.token} role={s.role() === "owner" ? "owner" : "edit"} session onClose={() => setSharing(false)} />
      </Show>
      <Show when={menu()}>
        {(m) => <ContextMenu at={m().at} label={`Game tab, ${m().tab.name}`} testid="tab-menu" items={menuItems(m().tab)} onClose={() => setMenu(undefined)} />}
      </Show>
      <Show when={toast()}>
        {(t) => (
          <div class="toast session-toast" role="status" data-testid="session-toast">
            {t().text}
            <Show when={t().undo}>
              <button
                class="link"
                data-testid="session-toast-undo"
                onClick={() => {
                  history.undo();
                  setToast(undefined);
                }}
              >
                Undo
              </button>
            </Show>
          </div>
        )}
      </Show>
    </>
  );
}

