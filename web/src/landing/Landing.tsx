// The front page (spec §6b): open a match (a board with it attached, landing in Player), make a
// sandbox board (you get its owner link, kept on this device), or reopen one.

import { For, Show, createSignal } from "solid-js";
import { Api, shareUrl } from "../core/api";
import { knownBoards, rememberBoard } from "../core/device";
import { Wordmark } from "../ui/Wordmark";
import { FRESH_BOARD } from "../board/roster";
import { Api as PlayerApi } from "../player/api";

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
  // ---- Open match: a match id, or a replay (its file is named after the match) ----
  const [matchId, setMatchId] = createSignal("");
  const [file, setFile] = createSignal<File>();
  const [opening, setOpening] = createSignal("");
  // A board made by an attempt that failed later (an upload refused) is reused on retry.
  let made: { board: string; token: string; id: string } | undefined;
  const openMatch = async (e: Event) => {
    e.preventDefault();
    const fromFile = /^(\d+)/.exec(file()?.name ?? "")?.[1]?.replace(/^0+/, "");
    const typed = matchId().trim().replace(/^0+/, "");
    if (typed && fromFile && typed !== fromFile) return setError("Id and replay differ");
    const id = typed || fromFile || "";
    if (!/^[1-9]\d{0,11}$/.test(id)) return setError("Invalid id");
    setError("");
    setOpening("Opening");
    try {
      if (made?.id !== id) {
        const t = `Match ${id}`;
        const { board, owner_token } = await new Api("").createBoard(t);
        rememberBoard({ board, token: owner_token, title: t });
        made = { board, token: owner_token, id };
      }
      const api = new PlayerApi(made.board, made.token);
      if (!(await api.attach(id))) throw new Error("attach");
      const f = file();
      if (f) {
        const err = await api.upload(id, f, (pct) => setOpening(`Uploading ${pct}%`));
        if (err) {
          setOpening("");
          return setError(err);
        }
      }
      location.assign(shareUrl(location.origin, made.board, made.token));
    } catch {
      setOpening("");
      setError("Failed");
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
        <form class="new-board open-match" onSubmit={openMatch} data-testid="open-match">
          <input
            class="input big"
            data-testid="open-match-id"
            inputMode="numeric"
            placeholder="Match id"
            value={matchId()}
            onInput={(e) => setMatchId(e.currentTarget.value)}
            aria-label="Match id"
          />
          <label class="btn ghost" title="A .dem from your replays folder">
            {file() ? file()!.name : "Replay…"}
            <input type="file" accept=".dem" hidden data-testid="open-match-file" onChange={(e) => setFile(e.currentTarget.files?.[0])} />
          </label>
          <button class="btn primary" type="submit" data-testid="open-match-go" disabled={!!opening()}>
            {opening() || "Open match"}
          </button>
        </form>
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
