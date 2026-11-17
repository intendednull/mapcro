// `/s/<session>?tab=<tab>#<token>` (sessions.md §4.1, §7, §8): the session's own connection, its
// tab strip, and the open tab's board, mounted afresh for each tab (keyed by board and
// credential: nothing of one board's mount reaches another's). A switch is a cold open, from
// IndexedDB where the board is stored (the pool of §5 was measured and not kept); what's kept
// across it is what the tab showed (§4.2) and the page's timeline cache (§4.3). The open tab is
// the session's view state (`session.tab`, session/follow.ts): a follower switches with its
// presenter (§6), and the session's room is told who is here and on which tab.
//
// The strip (§8): each tab's name, then its board's newest match (the winner, the length) and the
// tier chip, loaded only for tabs in view (session/details.ts); the dots of the people on it; an
// "All games (n)" list once the tabs don't fit. On a phone the strip gives way to the session
// title in the board's header, which opens the Games sheet: the tab list, Add game and the same
// tab menu.

import { ShareIcon } from "../ui/ShareIcon";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { newRecordId } from "../wasm/mapcro_wasm.js";
import { Board, type InSession } from "../board/Board";
import { resetVisit } from "../board/reset";
import { ShareDialog } from "../board/ShareDialog";
import { addGrant, canOpen, parseSessionUrl, sessionUrl, withdrawGrant } from "../core/api";
import { openSessionInAppHref } from "../core/applink";
import { authHeader } from "../core/cred";
import { type Me, colorOf, hasJoined, knownBoards, loadMe, rememberBoard } from "../core/device";
import { href, replace } from "../core/nav";
import { LIMITS } from "../gen/limits";
import type { RecordId } from "../gen/RecordId";
import type { Art } from "../map/pack";
import { Api as PlayerApi } from "../player/api";
import { previews } from "../player/picker";
import { timelines } from "../player/timelineCache";
import { ContextMenu, type MenuItem } from "../ui/ContextMenu";
import { DeadLink } from "../ui/DeadLink";
import { InlineEdit } from "../ui/InlineEdit";
import { Wordmark } from "../ui/Wordmark";
import { type AddChoice, AddMenu, refusal, takeAddOnOpen } from "./AddGame";
import { createTabDetails, subLine, tierChip } from "./details";
import { createSessionFollow, onTabs } from "./follow";
import { UndoHistory } from "./history";
import { SESSION_SIDE, createSessionState } from "./state";
import { type TabRow, addTabOps, credentialFor, linkDead, moveOps, neighbourOf, pickTab, removeOps, renameOps } from "./tabs";
import { loadUnsent, saveUnsent, withUnsent } from "./unsent";

const editable = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

export function SessionView(p: { session: string; token: string; tab: string | undefined; art: Art }) {
  const history = new UndoHistory();
  const s = createSessionState(p.session, p.token, history);
  onMount(() => void s.start());
  onCleanup(() => s.stop());
  // The session is left: its boards' visits are over (a tab switch alone keeps them).
  onCleanup(() => resetVisit());
  const loaded = () => s.settled();
  // ---- what this page may open (§6.3), as far as it knows: a tab's board answered when it
  // was opened here, or was asked about for a follow. By board and the credential it opens
  // through; a refusal is asked about again each time it matters. ----
  const [openable, setOpenable] = createSignal<ReadonlyMap<string, boolean>>(new Map());
  const credential = (t: TabRow) => credentialFor(t, p.session, p.token, knownBoards());
  const openKey = (board: string, grant: string | undefined) => `${board} ${grant ?? ""}`;
  const noteOpen = (key: string, ok: boolean) => setOpenable((m) => (m.get(key) === ok ? m : new Map(m).set(key, ok)));
  const asking = new Set<string>();
  const follow = createSessionFollow({
    first: p.tab,
    peers: s.peers,
    myPeer: s.myPeer,
    tabs: s.tabs,
    access: (t) => openable().get(openKey(t.board, credential(t).via?.grant)),
    ask: (t) => {
      const c = credential(t);
      const key = openKey(t.board, c.via?.grant);
      if (asking.has(key)) return;
      asking.add(key);
      // No answer (offline, a server error) is not a refusal: the board says when it opens.
      void canOpen(t.board, c.token, c.via).then((ok) => {
        asking.delete(key);
        noteOpen(key, ok ?? true);
      });
    },
    onPicked: (was, seat) => say(`Stopped following ${was?.state?.name || "them"}`, seat === undefined ? {} : { again: () => follow.again(seat, was) }),
  });
  const active = follow.tab;
  // ---- the strip's details (§8): asked for only for tabs in view, with the credential each
  // opens with; the open tab's from its board. ----
  const keyOf = (t: TabRow) => openKey(t.board, credential(t).via?.grant);
  const byKey = createMemo(() => new Map(s.tabs().map((t) => [keyOf(t), t] as const)));
  const details = createTabDetails({
    matches: async (key) => {
      const t = untrack(byKey).get(key);
      if (!t) return undefined;
      const c = credential(t);
      const r = await fetch(`/api/boards/${t.board}/matches`, { headers: { authorization: authHeader(c.token, c.via) } }).catch(() => undefined);
      if (r?.ok) return (((await r.json().catch(() => ({}))) as { matches?: number[] }).matches ?? []).filter((n) => Number.isSafeInteger(n));
      return r && (r.status === 401 || r.status === 403 || r.status === 404) ? "refused" : undefined;
    },
    job: async (key, match) => {
      const t = untrack(byKey).get(key);
      if (!t) return undefined;
      const c = credential(t);
      return new PlayerApi(t.board, c.token, c.via).job(match).catch(() => undefined);
    },
    preview: (match) => previews.ask(match),
    held: (key, match) => {
      const t = untrack(byKey).get(key);
      return t ? timelines.candidates(t.board, match)[0]?.tl.duration_s : undefined;
    },
    // What the strip learns, a follow knows too (§6.3): a tab whose board answered isn't asked
    // about again before a follow goes there.
    opened: noteOpen,
  });
  /** The tabs in view, by key, as the strip and the Games sheet see them. */
  const inView = new Map<Element, string>();
  const observer =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          for (const e of entries) {
            const key = (e.target as HTMLElement).dataset.key;
            if (!key) continue;
            if (e.isIntersecting) {
              inView.set(e.target, key);
              details.seen(key);
            } else inView.delete(e.target);
          }
        });
  /** Watch a tab's element (its key in `data-key`): its details load once it's in view. */
  const watch = (el: HTMLElement) => {
    if (observer) observer.observe(el);
    else if (el.dataset.key) details.seen(el.dataset.key);
    onCleanup(() => {
      observer?.unobserve(el);
      inView.delete(el);
    });
  };
  // A tab someone is on may change (they load a match there): asked again now and then.
  const occupied = () => new Set(s.tabs().filter((t) => people().has(t.id)).map(keyOf));
  const againTimer = setInterval(() => details.again(new Set(inView.values()), untrack(occupied)), 5000);
  onCleanup(() => {
    clearInterval(againTimer);
    observer?.disconnect();
  });
  /** A tab this page can't open (§8: dimmed, "No access" on hover). */
  const unavailable = (t: TabRow) => details.get(keyOf(t))?.kind === "refused" || openable().get(keyOf(t)) === false;
  /** Who is on each tab, by the session's presence (§8: the tabs' dots). */
  const people = createMemo(() => onTabs(s.peers(), s.myPeer()));
  // Who this person is, for the session's room (§6.1): the name and colour the boards show,
  // once given (the join card asks once per session).
  const [me, setMe] = createSignal<Me | undefined>(hasJoined(p.session) ? loadMe() : undefined);
  createEffect(() => {
    const m = me();
    s.presence({ name: m?.name ?? "", color: m?.color ?? 0, ...follow.wire(), following: follow.presenter()?.peer ?? null });
  });
  // ---- tabs left with changes not sent (TD-101): marked on the strip until that board is
  // opened here again and they go. Kept for this browser tab, as what a tab showed is. ----
  const [unsent, setUnsent] = createSignal<ReadonlySet<string>>(loadUnsent(sessionStorage, p.session));
  const left = (board: string, n: number | undefined) => {
    const next = withUnsent(unsent(), board, n);
    if (next === unsent()) return;
    setUnsent(next);
    saveUnsent(sessionStorage, p.session, next);
  };
  /** The open tab's board: its own save status says what it hasn't sent, on any tab of it. */
  const openBoard = () => s.tabs().find((t) => t.id === active())?.board;
  const [adding, setAdding] = createSignal(takeAddOnOpen(p.session));
  const [sharing, setSharing] = createSignal(false);
  const [menu, setMenu] = createSignal<{ at: { x: number; y: number }; tab: TabRow }>();
  const [games, setGames] = createSignal(false);
  const [overflow, setOverflow] = createSignal(false);
  const [allGames, setAllGames] = createSignal<{ x: number; y: number }>();
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
    // The session's doing, not the user's: a follow goes on (§6.3: both move left).
    if (next !== cur) follow.place(next);
  });
  // The address names the tab being looked at, without adding history (§7.1).
  createEffect(() => {
    if (!loaded()) return;
    const want = sessionUrl(location.origin, p.session, p.token, active());
    if (location.href !== want) replace(want);
  });
  // The address was changed to another tab of this session (a link opened in the page): the
  // user's pick, as from the strip (§6.2). One that isn't a tab leaves the address as it was.
  createEffect(
    on(
      href,
      (h) => {
        const u = parseSessionUrl(h);
        if (!loaded() || u?.session !== p.session || u.token !== p.token || u.tab === untrack(active)) return;
        if (u.tab !== undefined && s.tabs().some((t) => t.id === u.tab)) pick(u.tab);
        else replace(sessionUrl(location.origin, p.session, p.token, untrack(active)));
      },
      { defer: true },
    ),
  );
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
  // Its Undo is for the step it names: it keeps where the history was just after that step, and
  // goes once anything else is edited, undone or redone (review 2026-11-12, finding 3).
  // A follow that the user's own pick of a tab stopped offers the way back (`again`), as a
  // board's own toast does.
  const [toast, setToast] = createSignal<{ text: string; undo?: number; again?: () => void }>();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (text: string, more: { undo?: number; again?: () => void } = {}) => {
    setToast({ text, ...more });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(undefined), 6000);
  };
  onCleanup(() => clearTimeout(toastTimer));

  // ---- strip edits: each one step in the page's one undo (§7.2) ----
  // A switch waits for the pointer gesture in progress to end (§4.1): a drag released during it
  // lands on the board it began on, which unmounts after.
  // A pointerup can be lost (released outside the window, a focus change): the press then ends
  // when the window loses focus, or when the pointer moves with no button down, so a held switch
  // never waits for some later, unrelated pointerup (review 2026-11-12, finding 5).
  let pressed = false;
  let queued: RecordId | undefined;
  let queuedTimer: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    const down = (e: PointerEvent) => (pressed = e.buttons !== 0);
    const up = () => {
      pressed = false;
      const q = queued;
      queued = undefined;
      // After the board's own pointerup handlers have run.
      if (q !== undefined) queuedTimer = setTimeout(() => follow.pick(q), 0);
    };
    const move = (e: PointerEvent) => pressed && e.buttons === 0 && up();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("blur", up);
    onCleanup(() => {
      clearTimeout(queuedTimer);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("blur", up);
    });
  });
  const pick = (id: RecordId) => {
    setMenu(undefined);
    // Switching closes the Games sheet and returns to the map (§8).
    setGames(false);
    if (pressed) return void (queued = id);
    // A switch picked now wins over one held for a press that just ended.
    queued = undefined;
    clearTimeout(queuedTimer);
    follow.pick(id);
  };
  const remove = (t: TabRow) => {
    setMenu(undefined);
    if (s.edit(removeOps(t.id))) say(`Removed ${t.name}`, { undo: history.at() });
  };
  // Remove and revoke (§3.7): the grant is withdrawn first, and the tab removed only once that's
  // done (204). The removal is no step in the history: undo would bring back a tab whose grant is
  // gone. Refused, the tab stays and the toast says why (review 2026-11-12, finding 4).
  const revoke = (t: TabRow) => {
    setMenu(undefined);
    withdrawGrant(p.session, p.token, t.grant).then(
      () => {
        s.removeUnmarked(removeOps(t.id));
        say(`Removed ${t.name}`);
      },
      (e) => say(refusal(e)),
    );
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
      follow.pick(id);
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
    items.push({ label: "Remove and revoke", testid: "tab-revoke", run: () => revoke(t) });
    return items;
  };

  // Ctrl+PageUp / Ctrl+PageDown switch tabs, outside fields (§8). Ctrl+Z, Ctrl+Shift+Z and
  // Ctrl+Y walk the one history here, whatever the open tab can do or with none open (§7.2:
  // undo re-links a removed tab wherever focus is); the board leaves them to this.
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && (k === "z" || k === "y") && !editable(e.target) && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        if (k === "y" || e.shiftKey) history.redo();
        else history.undo();
        return;
      }
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
        <ShareIcon />
        Share
      </button>
    </Show>
  );
  /** Under a tab's name: its board's newest match and the tier chip (§8), or "Sandbox". */
  const sub = (t: TabRow) => {
    const d = () => details.get(keyOf(t));
    return (
      <Show when={subLine(d()) || tierChip(d())}>
        <span class="game-sub" data-testid="tab-sub">
          <Show when={subLine(d())}>
            {(l) => (
              <span class="game-line" data-testid="tab-line" data-winner={l().winner ?? ""}>
                <Show when={l().winner}>{(w) => <span class={`game-win ${w()}`} />}</Show>
                {l().text}
              </span>
            )}
          </Show>
          <Show when={tierChip(d())}>
            {(c) => (
              <span class="game-tier" classList={{ replay: c().tier === "replay", busy: c().busy }} data-testid="tab-tier" data-tier={c().tier}>
                {c().text}
              </span>
            )}
          </Show>
        </span>
      </Show>
    );
  };
  /** The dots of the people on a tab (§8), each in their colour, their name on hover. */
  const dots = (t: TabRow) => {
    const on = () => people().get(t.id) ?? [];
    return (
      <Show when={on().length > 0}>
        <span class="game-people" data-testid="tab-people" data-count={on().length}>
          <For each={on().slice(0, 3)}>{(x) => <span class="game-dot" style={{ background: colorOf(x.state!.color) }} title={x.state!.name || "Joining"} />}</For>
          <Show when={on().length > 3}>
            <span class="game-more">+{on().length - 3}</span>
          </Show>
        </span>
      </Show>
    );
  };
  /** A tab's hover text: its name, and "No access" when it can't be opened (§8). */
  const hover = (t: TabRow) => (unavailable(t) ? `${t.name} · No access` : t.name);
  const openMenu = (e: MouseEvent, t: TabRow) => {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ at: e.type === "contextmenu" ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom }, tab: t });
  };
  const nameEdit = (t: TabRow) => (
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
  );
  // The strip scrolls when its tabs don't fit; "All games (n)" then lists them all (§8).
  let tabsEl: HTMLDivElement | undefined;
  const measure = () => tabsEl && setOverflow(tabsEl.scrollWidth > tabsEl.clientWidth + 1);
  createEffect(() => {
    s.tabs();
    queueMicrotask(measure);
  });
  let allGamesClosed = -Infinity;
  const allGamesItems = (): MenuItem[] => s.tabs().map((t) => ({ label: t.name, testid: "all-games-tab", checked: t.id === active(), run: () => pick(t.id) }));
  const strip = () => (
    <nav class="game-strip" data-testid="game-strip" aria-label="Games" data-can-edit={String(s.canEdit())}>
      <div
        class="game-tabs"
        role="tablist"
        ref={(el) => {
          tabsEl = el;
          const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
          ro?.observe(el);
          onCleanup(() => ro?.disconnect());
        }}
      >
        <For each={s.tabs()}>
          {(t) => (
            <div
              class="game-tab"
              classList={{ on: t.id === active(), dragging: dragging() === t.id, unavailable: unavailable(t) }}
              role="tab"
              tabIndex={0}
              aria-selected={t.id === active()}
              aria-label={`Game tab, ${t.name}`}
              title={hover(t)}
              data-testid="game-tab"
              data-tab={t.id}
              data-board={t.board}
              data-key={keyOf(t)}
              ref={(el) => {
                watch(el);
                // The open tab is scrolled into view (a switch by key, by a follow, by the list).
                createEffect(() => t.id === active() && el.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
              }}
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
                openMenu(e, t);
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
              <span class="game-main">
                {nameEdit(t)}
                {sub(t)}
              </span>
              {dots(t)}
              <Show when={unsent().has(t.board) && t.board !== openBoard()}>
                <span class="game-unsent" role="img" data-testid="tab-unsent" title="Not sent" aria-label="Not sent" />
              </Show>
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
      <Show when={overflow()}>
        <button
          class="btn ghost small all-games"
          data-testid="all-games"
          aria-haspopup="menu"
          aria-expanded={!!allGames()}
          onClick={(e) => {
            // A press on the button while the list is open closed it (a press outside it).
            if (performance.now() - allGamesClosed < 400) return;
            const r = e.currentTarget.getBoundingClientRect();
            setAllGames({ x: r.left, y: r.bottom });
          }}
        >
          All games ({s.tabs().length})
        </button>
      </Show>
      <Show when={s.canEdit()}>
        <button class="btn ghost small add-game" data-testid="add-game" onClick={() => setAdding(true)}>
          + Add game
        </button>
      </Show>
    </nav>
  );
  /** On a phone, the header's session title (§8): it opens the Games sheet. */
  const gamesButton = () => (
    <button class="games-open" data-testid="games-open" aria-haspopup="dialog" aria-expanded={games()} onClick={() => setGames(!games())}>
      <span class="games-title">{s.title() || "Games"}</span>
      <span class="games-count">{s.tabs().length}</span>
    </button>
  );
  /** The phone's Games sheet (§8): the tab list, Add game, and each tab's menu. No gesture: a
   * tab is moved with Move left and Move right. */
  const gamesSheet = () => (
    <section class="games-sheet" data-testid="games-sheet" role="dialog" aria-label="Games" onKeyDown={(e) => e.key === "Escape" && !renaming() && setGames(false)}>
      <header class="games-sheet-head">
        <b>Games</b>
        <button class="btn ghost" data-testid="games-close" aria-label="Close" onClick={() => setGames(false)}>
          ×
        </button>
      </header>
      <ul class="games-list" role="tablist">
        <For each={s.tabs()}>
          {(t) => (
            <li
              class="games-row"
              classList={{ on: t.id === active(), unavailable: unavailable(t) }}
              data-testid="games-row"
              data-tab={t.id}
              data-key={keyOf(t)}
              ref={watch}
            >
              <div
                class="games-pick"
                role="tab"
                tabIndex={0}
                aria-selected={t.id === active()}
                aria-label={`Game tab, ${t.name}`}
                title={hover(t)}
                data-testid="games-pick"
                onClick={() => renaming() !== t.id && pick(t.id)}
                onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && pick(t.id)}
              >
                <span class="game-main">
                  {nameEdit(t)}
                  {sub(t)}
                </span>
                {dots(t)}
                <Show when={unsent().has(t.board) && t.board !== openBoard()}>
                  <span class="game-unsent" role="img" data-testid="tab-unsent" title="Not sent" aria-label="Not sent" />
                </Show>
              </div>
              <Show when={s.canEdit()}>
                <button class="btn ghost games-menu" data-testid="games-menu" aria-label="More" aria-haspopup="menu" onClick={(e) => openMenu(e, t)}>
                  ⋯
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={!s.tabs().length}>
        <div class="session-empty muted">No games</div>
      </Show>
      <Show when={s.canEdit()}>
        <button
          class="btn games-add"
          data-testid="games-add"
          onClick={() => {
            setGames(false);
            setAdding(true);
          }}
        >
          + Add game
        </button>
      </Show>
    </section>
  );
  const inSession = (): Omit<InSession, "via" | "opened" | "left" | "shown"> => ({
    id: p.session,
    history,
    joinKey: p.session,
    title,
    share,
    strip,
    games: gamesButton,
    canEdit: () => s.canEdit(),
    follow: follow.board,
    me: setMe,
    // The session's own link in the app, on the open tab (§7.1).
    appHref: () => openSessionInAppHref({ session: p.session, token: p.token, ...(active() ? { tab: active()! } : {}) }),
  });
  // A dead link, not an outdated build: that one reloads, or says Update available, as a board does.
  const closed = () => linkDead(s.connection());
  const outdated = () => {
    const c = s.connection();
    return c.kind === "closed" && c.reason === "outdated";
  };

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
            <Board
              board={m.board}
              token={m.token}
              art={p.art}
              session={{
                ...inSession(),
                ...(m.via ? { via: m.via } : {}),
                opened: (ok) => noteOpen(openKey(m.board, m.via?.grant), ok),
                // Left: the strip asks about it again (its match may have changed here).
                left: (board, n) => {
                  left(board, n);
                  details.left(openKey(m.board, m.via?.grant));
                },
                shown: (x) => details.shown(openKey(m.board, m.via?.grant), x),
              }}
            />
          </div>
        )}
      </Show>
      <Show when={closed()}>
        <DeadLink />
      </Show>
      <Show when={outdated()}>
        <div class="update-banner" role="alert" data-testid="update-available">
          Update available
          <button class="btn small" data-testid="update-reload" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
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
      <Show when={allGames()}>
        {(at) => <ContextMenu at={at()} label="All games" testid="all-games-list" items={allGamesItems()} onClose={() => ((allGamesClosed = performance.now()), setAllGames(undefined))} />}
      </Show>
      <Show when={games()}>{gamesSheet()}</Show>
      <Show when={toast()}>
        {(t) => (
          <div class="toast session-toast" role="status" data-testid="session-toast">
            {t().text}
            <Show when={t().undo !== undefined && history.live(t().undo!)}>
              <button
                class="link"
                data-testid="session-toast-undo"
                onClick={() => {
                  history.undoSince(t().undo!, SESSION_SIDE);
                  setToast(undefined);
                }}
              >
                Undo
              </button>
            </Show>
            <Show when={t().again}>
              {(again) => (
                <button
                  class="link"
                  data-testid="session-follow-again"
                  onClick={() => {
                    again()();
                    setToast(undefined);
                  }}
                >
                  Follow again
                </button>
              )}
            </Show>
          </div>
        )}
      </Show>
    </>
  );
}

