// "+ Add game" (sessions.md §7.2, §7.3). On a board on its own, it makes a session of it: the
// board is its first tab, the owner token is kept on this device, and the session opens with the
// add menu up. In a session, it opens the menu: Load a game (a match id or a replay, as the
// landing's form), New board, Paste link, or Your boards. A game loaded or a board made here is
// the adder's: its owner link is kept in Your boards, so the grant is edit.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Api, ApiError, createSession, sessionUrl } from "../core/api";
import { parseBoardLink } from "../core/applink";
import { type KnownBoard, hasJoined, knownBoards, markJoined, markOpened, rememberBoard } from "../core/device";
import { navigate } from "../core/nav";
import { LIMITS } from "../gen/limits";
import { FRESH_BOARD } from "../board/roster";
import { MODE_CODES, lookup } from "../player/api";
import { handOff } from "../player/handoff";
import { idFromName, isDem, looksLikeDemo, noticeFor } from "../player/notice";
import { NOT_DEM } from "../player/ReplayHelp";
import { type Picked, ReplayPicker, pickerSource } from "../player/ReplayPicker";
import { ModalScrim } from "../ui/ModalScrim";
import { dialogKeys } from "../ui/modal";

const ADD_ON_OPEN = "mapcro.addOnOpen";

/** The session was just made from a board: it opens with the add menu up (tab-local). */
export function takeAddOnOpen(session: string): boolean {
  try {
    if (sessionStorage.getItem(ADD_ON_OPEN) !== session) return false;
    sessionStorage.removeItem(ADD_ON_OPEN);
    return true;
  } catch {
    return false;
  }
}

/** A refusal's tag (§4b): the server's words where it has them. */
export function refusal(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.text === "session full") return "Session full";
    if (e.text === "board full") return "Board full";
    if (e.status === 429) return "Too many";
    if (e.status === 403 || e.status === 401 || e.status === 404) return "No access";
  }
  return "Failed";
}

/** On a board's header, beside its title: make this board a session's first tab. */
export function AddGameOnBoard(p: { board: string; token: string; title: string; ready: boolean }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  // The board was left while the session was being made: the answer takes no one anywhere.
  let left = false;
  onCleanup(() => (left = true));
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const title = [...(p.title.trim() || "Session")].slice(0, LIMITS.max_title).join("");
      const s = await createSession(title, { board: p.board, token: p.token });
      rememberBoard({ board: s.session, token: s.owner_token, title, kind: "session", games: 1, edit: true });
      if (hasJoined(p.board)) markJoined(s.session); // you already said who you are
      try {
        sessionStorage.setItem(ADD_ON_OPEN, s.session);
      } catch {}
      if (!left) navigate(sessionUrl(location.origin, s.session, s.owner_token, s.tab));
    } catch (e) {
      setError(refusal(e));
      setBusy(false);
    }
  };
  return (
    <>
      <button class="btn ghost small add-game" data-testid="add-game" title="Add game" aria-label="Add game" disabled={busy() || !p.ready} onClick={() => void go()}>
        +<span class="add-label"> Add game</span>
      </button>
      <Show when={error()}>
        <span class="error small" data-testid="add-game-error">
          {error()}
        </span>
      </Show>
    </>
  );
}

export interface AddChoice {
  board: string;
  token: string;
  /** The tab's name: the board's title where this device knows it. */
  title: string | undefined;
  view: boolean;
}

/** A board made here for a game: its owner link, kept in Your boards (§7.2). */
export interface Made {
  board: string;
  token: string;
  title: string;
}

/**
 * Load a game (§7.2), as the landing's form opens one (spec §6b): a match id, or a replay (a
 * `.dem` picked, or in the app one from its replay picker). A board is made with the match: by
 * id, the match is attached; with a replay, the board uploads it once it opens (`handOff`), as
 * the landing's board does. Answers the board, or why not (the landing's words).
 */
export async function loadGame(o: { id: string; file?: File | undefined; picked?: Picked | undefined }): Promise<Made | { error: string; upload?: boolean }> {
  const f = o.picked ? undefined : o.file;
  if (f && !isDem(f.name)) return { error: NOT_DEM };
  const fromFile = o.picked?.id ?? (f ? idFromName(f.name) : undefined);
  const typed = o.picked ? "" : o.id.trim().replace(/^0+/, "");
  if (typed && fromFile && typed !== fromFile) return { error: `That file is match ${fromFile}, not ${typed}` };
  const id = typed || fromFile || "";
  if (!/^[1-9]\d{0,11}$/.test(id)) return { error: "Invalid id" };
  try {
    if (f && !(await looksLikeDemo(f))) return { error: noticeFor("not_a_replay", "upload")!.text };
    // A Brawl (or other non-standard) match gets no board (2026-11-08).
    const code = await lookup(id);
    if (code && MODE_CODES.has(code)) return { error: noticeFor(code, "load")!.text };
    // Without its replay, a match needs deadlock-api's metadata to open; a replay stands alone.
    if (code && !f && !o.picked) {
      const n = noticeFor(code, "load");
      return { error: n?.text ?? "Failed", upload: !!n?.actions.includes("upload") };
    }
    const title = `Match ${id}`;
    const { board, owner_token: token } = await new Api("").createBoard(title);
    const remember = () => rememberBoard({ board, token, title, match: id, edit: true });
    if (f || o.picked) {
      // The board uploads it as it opens, with progress; it attaches the match once the upload
      // is under way, so no fetch from Valve starts.
      handOff({ board, id, file: f, local: o.picked, opened: remember });
      // The adder holds the board's owner link from now on, whether or not the upload goes.
      remember();
    } else {
      const r = await fetch(`/api/boards/${board}/matches/${id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) return { error: "Failed" };
      remember();
      // This page opened it: if the full replay can't come, the board asks it (spec §6b).
      markOpened(board, id);
    }
    return { board, token, title };
  } catch {
    return { error: "Failed" };
  }
}

/** New board (§7.2): an empty board, as the landing's New board makes one (its first load rolls
 * twelve random heroes), its owner link kept in Your boards. */
export async function newBoard(title: string): Promise<Made | { error: string }> {
  try {
    const t = [...(title.trim() || "Untitled board")].slice(0, LIMITS.max_title).join("");
    const { board, owner_token: token } = await new Api("").createBoard(t);
    rememberBoard({ board, token, title: t, edit: true });
    try {
      sessionStorage.setItem(FRESH_BOARD, board);
    } catch {}
    return { board, token, title: t };
  } catch {
    return { error: "Failed" };
  }
}

/** The add menu: Load a game, New board, a pasted board link, or one of this device's boards. */
export function AddMenu(p: { onAdd: (c: AddChoice) => Promise<string | undefined>; onClose: () => void }) {
  const boards = knownBoards().filter((k) => k.kind !== "session");
  const [text, setText] = createSignal("");
  const [view, setView] = createSignal(false);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  // ---- Load a game ----
  const [matchId, setMatchId] = createSignal("");
  const [file, setFile] = createSignal<File>();
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal<{ error: string; upload?: boolean }>();
  const [picking, setPicking] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const app = pickerSource();
  // The menu was closed while a board was being made: the answer adds nothing.
  let gone = false;
  onCleanup(() => (gone = true));
  let first!: HTMLInputElement;
  let pick!: HTMLInputElement;
  onMount(() => first.focus());
  const add = async (board: string, token: string, title: string | undefined, asView = view()) => {
    setBusy(true);
    setError("");
    const why = await p.onAdd({ board, token, title, view: asView });
    setBusy(false);
    if (why) setError(why);
    else p.onClose();
  };
  const made = async (m: Made | { error: string; upload?: boolean }, onError: (e: { error: string; upload?: boolean }) => void) => {
    if (gone) return;
    if ("error" in m) return onError(m);
    await add(m.board, m.token, m.title, false);
  };
  const load = async (e?: Event, picked?: Picked) => {
    e?.preventDefault();
    if (loading() || busy()) return;
    setLoading(true);
    setLoadError(undefined);
    const m = await loadGame({ id: matchId(), file: file(), picked });
    setLoading(false);
    await made(m, setLoadError);
  };
  const create = async (e: Event) => {
    e.preventDefault();
    // Not while Load a game is opening one: one tab per press.
    if (busy() || loading()) return;
    setBusy(true);
    const m = await newBoard(title());
    setBusy(false);
    await made(m, (x) => setError(x.error));
  };
  const paste = (e: Event) => {
    e.preventDefault();
    const l = parseBoardLink(text());
    if (!l) return setError("Not a board link");
    void add(l.board, l.token, boards.find((k) => k.board === l.board)?.title);
  };
  // A replay dropped on the form is the form's, not the board's under the menu.
  const dropped = (e: DragEvent) => {
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    setFile(f);
    void load();
  };
  return (
    <ModalScrim testid="add-menu" onClose={p.onClose}>
      <div class="dialog add-menu" role="dialog" aria-modal="true" aria-labelledby="add-h" onKeyDown={dialogKeys(p.onClose)}>
        <header>
          <div>
            <h2 id="add-h">Add game</h2>
          </div>
          <button class="x" aria-label="Close" onClick={() => p.onClose()}>
            ×
          </button>
        </header>
        <div class="body">
          <h3>Load a game</h3>
          <form
            class="mint add-load"
            data-testid="add-load"
            onSubmit={(e) => void load(e)}
            onDragOver={(e) => {
              if (e.dataTransfer?.types.includes("Files")) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onDrop={dropped}
          >
            <input
              ref={first}
              class="input"
              data-testid="add-match-id"
              inputMode="numeric"
              placeholder="Match id"
              aria-label="Match id"
              value={matchId()}
              onInput={(e) => setMatchId(e.currentTarget.value)}
            />
            <Show
              when={app}
              fallback={
                <label class="btn ghost" title="Replay file (.dem)">
                  {file() ? file()!.name : "Select replay file"}
                  <input ref={pick} type="file" accept=".dem" hidden data-testid="add-match-file" onChange={(e) => setFile(e.currentTarget.files?.[0])} />
                </label>
              }
            >
              <button class="btn" type="button" data-testid="add-match-pick" onClick={() => setPicking(true)}>
                Select replay
              </button>
            </Show>
            <button class="btn primary" type="submit" data-testid="add-match-go" disabled={loading() || busy()}>
              {loading() ? "Opening" : "Open match"}
            </button>
          </form>
          <Show when={loadError()}>
            {(x) => (
              <p class="error" data-testid="add-match-error">
                {x().error}
                <Show when={x().upload}>
                  {" "}
                  <button class="link" type="button" data-testid="add-match-upload" onClick={() => (app ? setPicking(true) : pick.click())}>
                    {app ? "Upload replay" : "Upload replay file"}
                  </button>
                </Show>
              </p>
            )}
          </Show>
          <h3>New board</h3>
          <form class="mint" onSubmit={(e) => void create(e)}>
            <input
              class="input"
              data-testid="add-new-title"
              placeholder="Board title"
              aria-label="Board title"
              maxLength={LIMITS.max_title}
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
            <button class="btn" type="submit" data-testid="add-new-go" disabled={busy() || loading()}>
              New board
            </button>
          </form>
          <h3>Paste link</h3>
          <form class="mint" onSubmit={paste}>
            <input
              class="input"
              data-testid="add-paste"
              aria-label="Paste link"
              placeholder="https://…/b/…"
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
            />
            <button class="btn primary" type="submit" data-testid="add-paste-go" disabled={busy()}>
              Add
            </button>
          </form>
          <label class="check">
            <input type="checkbox" data-testid="add-view" checked={view()} onChange={(e) => setView(e.currentTarget.checked)} />
            Can view
          </label>
          <p class="muted small">Session editors can edit the boards you add, unless you add them view only.</p>
          <Show when={error()}>
            <p class="error" data-testid="add-error">
              {error()}
            </p>
          </Show>
          <Show when={boards.length > 0}>
            <h3>Your boards</h3>
            <ul class="known add-known" data-testid="add-known">
              <For each={boards}>
                {(b: KnownBoard) => (
                  <li>
                    <button class="link" type="button" data-testid="add-known-board" data-board={b.board} disabled={busy()} onClick={() => void add(b.board, b.token, b.title)}>
                      {b.title}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
        <Show when={app && picking()}>
          <ReplayPicker
            source={app!}
            current={/^[1-9]\d{0,11}$/.test(matchId().trim()) ? matchId().trim() : undefined}
            onClose={() => setPicking(false)}
            onPick={(r) => {
              setPicking(false);
              setFile(undefined);
              setMatchId(r.id);
              void load(undefined, r);
            }}
          />
        </Show>
      </div>
    </ModalScrim>
  );
}
