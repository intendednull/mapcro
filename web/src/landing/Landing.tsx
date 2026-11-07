// The front page: make a board (you get its owner link, kept on this device) or reopen one.

import { For, Show, createSignal } from "solid-js";
import { Api, shareUrl } from "../core/api";
import { knownBoards, rememberBoard } from "../core/device";
import { Wordmark } from "../ui/Wordmark";
import { FRESH_BOARD } from "../board/roster";

export function Landing() {
  const [title, setTitle] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const boards = knownBoards();
  const create = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const t = title().trim() || "Untitled board";
      const { board, owner_token } = await new Api("").createBoard(t);
      rememberBoard({ board, token: owner_token, title: t });
      sessionStorage.setItem(FRESH_BOARD, board); // its first load rolls twelve random heroes
      location.assign(shareUrl(location.origin, board, owner_token));
    } catch (err) {
      setError("Failed");
      setBusy(false);
    }
  };
  return (
    <div class="landing">
      <header class="top">
        <Wordmark />
        <div class="spacer" />
      </header>
      <main class="landing-body">
        <h1>A shared minimap for macro coaching.</h1>
        <form class="new-board" onSubmit={create} data-testid="new-board">
          <input
            class="input big"
            placeholder="Board title"
            maxLength={80}
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            aria-label="Board title"
          />
          <button class="btn primary" type="submit" disabled={busy()}>
            {busy() ? "Creating…" : "New board"}
          </button>
        </form>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <Show when={boards.length > 0}>
          <h2>Your boards</h2>
          <ul class="known">
            <For each={boards}>
              {(b) => (
                <li>
                  <a href={shareUrl(location.origin, b.board, b.token)}>{b.title}</a>
                  <span class="muted">{new Date(b.seen).toLocaleDateString()}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <footer class="legal muted">MIT · Not affiliated with Valve</footer>
      </main>
    </div>
  );
}
