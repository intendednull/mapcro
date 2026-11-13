// "+ Add game" (sessions.md §7.2, §7.3). On a board on its own, it makes a session of it: the
// board is its first tab, the owner token is kept on this device, and the session opens with the
// add menu up. In a session, it opens the menu: Your boards or Paste link (phase 2; Load a game
// and New board are phase 5).

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { ApiError, createSession, sessionUrl } from "../core/api";
import { parseBoardLink } from "../core/applink";
import { type KnownBoard, hasJoined, knownBoards, markJoined, rememberBoard } from "../core/device";
import { navigate } from "../core/nav";
import { LIMITS } from "../gen/limits";
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

/** The add menu: one of this device's boards, or a pasted board link. */
export function AddMenu(p: { onAdd: (c: AddChoice) => Promise<string | undefined>; onClose: () => void }) {
  const boards = knownBoards().filter((k) => k.kind !== "session");
  const [text, setText] = createSignal("");
  const [view, setView] = createSignal(false);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  const add = async (board: string, token: string, title: string | undefined) => {
    setBusy(true);
    setError("");
    const why = await p.onAdd({ board, token, title, view: view() });
    setBusy(false);
    if (why) setError(why);
    else p.onClose();
  };
  const paste = (e: Event) => {
    e.preventDefault();
    const l = parseBoardLink(text());
    if (!l) return setError("Not a board link");
    void add(l.board, l.token, boards.find((k) => k.board === l.board)?.title);
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
          <h3>Paste link</h3>
          <form class="mint" onSubmit={paste}>
            <input
              ref={input}
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
      </div>
    </ModalScrim>
  );
}
