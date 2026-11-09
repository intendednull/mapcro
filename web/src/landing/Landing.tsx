// The front page (spec §6b): open a match (a board with it attached, landing in Player), make a
// sandbox board (you get its owner link, kept on this device), or reopen one.

import { For, Show, createSignal } from "solid-js";
import { Api, shareUrl } from "../core/api";
import { knownBoards, markOpened, rememberBoard } from "../core/device";
import { Wordmark } from "../ui/Wordmark";
import { FRESH_BOARD } from "../board/roster";
import { MODE_CODES, lookup } from "../player/api";
import { type Notice, idFromName, isDem, looksLikeDemo, noticeFor } from "../player/notice";
import { DropOverlay, NOT_DEM, ReplayHelp, createDemDrop } from "../player/ReplayHelp";
import { handOff } from "../player/handoff";
import { navigate } from "../core/nav";
import { LIMITS } from "../gen/limits";
import { feedbackEnabled } from "../core/feedback";
import { FeedbackButton } from "../ui/Feedback";

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
  const [matchError, setMatchError] = createSignal("");
  /** Why the match didn't open, and what to do (spec §6b). */
  const [notice, setNotice] = createSignal<Notice>();
  let pick!: HTMLInputElement;
  // A board made by an attempt that failed later (a lookup refused) is reused on retry.
  let made: { board: string; token: string; id: string } | undefined;
  const fail = (text: string) => {
    setOpening("");
    setNotice(undefined);
    setMatchError(text);
  };
  const openMatch = async (e?: Event) => {
    e?.preventDefault();
    if (opening()) return;
    const f = file();
    if (f && !isDem(f.name)) return fail(NOT_DEM);
    const fromFile = f ? idFromName(f.name) : undefined;
    const typed = matchId().trim().replace(/^0+/, "");
    if (typed && fromFile && typed !== fromFile) return fail(`That file is match ${fromFile}, not ${typed}`);
    const id = typed || fromFile || "";
    if (!/^[1-9]\d{0,11}$/.test(id)) return fail("Invalid id");
    setMatchError("");
    setNotice(undefined);
    setOpening("Opening");
    try {
      if (f && !(await looksLikeDemo(f))) return fail(noticeFor("not_a_replay", "upload")!.text);
      // A Brawl (or other non-standard) match gets no board (2026-11-08).
      const code = await lookup(id);
      if (code && MODE_CODES.has(code)) return fail(noticeFor(code, "load")!.text);
      // Without its replay, a match needs deadlock-api's metadata to open: say why it can't. A
      // replay stands alone (spec §6a).
      if (code && !f) {
        setOpening("");
        return setNotice(noticeFor(code, "load"));
      }
      if (made?.id !== id) {
        const t = `Match ${id}`;
        const { board, owner_token } = await new Api("").createBoard(t);
        made = { board, token: owner_token, id };
      }
      const m = made;
      // Only a match that opened goes in "Your boards" (QA, item 8).
      const remember = () => rememberBoard({ board: m.board, token: m.token, title: `Match ${id}` });
      if (f) {
        // The board uploads it, with progress, while you use the board (player/handoff.ts); it
        // attaches the match once the upload is under way, so no fetch from Valve starts.
        handOff({ board: m.board, id, file: f, opened: remember });
        return navigate(shareUrl(location.origin, m.board, m.token));
      }
      const r = await fetch(`/api/boards/${m.board}/matches/${id}`, { method: "PUT", headers: { authorization: `Bearer ${m.token}` } });
      if (!r.ok) throw new Error("attach");
      remember();
      // This tab opened it: if the full replay can't come, the board asks it (spec §6b).
      markOpened(m.board, id);
      location.assign(shareUrl(location.origin, m.board, m.token));
    } catch {
      fail("Failed. Try again.");
    }
  };
  const dropped = (f: File) => {
    setFile(f);
    void openMatch();
  };
  const dragging = createDemDrop({ enabled: () => !opening(), onFile: dropped, onRefuse: fail });

  return (
    <div class="landing">
      <header class="top">
        <Wordmark />
        <div class="spacer" />
      </header>
      <main class="landing-body">
        <h1>A shared minimap for macro coaching.</h1>
        <p class="entry-label">Load a game</p>
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
            {file() ? file()!.name : "Select replay file"}
            <input type="file" accept=".dem" hidden data-testid="open-match-file" onChange={(e) => setFile(e.currentTarget.files?.[0])} />
          </label>
          <button class="btn primary" type="submit" data-testid="open-match-go" disabled={!!opening()}>
            {opening() || "Open match"}
          </button>
        </form>
        <input
          ref={pick}
          type="file"
          accept=".dem"
          hidden
          data-testid="open-match-upload-file"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (f) dropped(f);
          }}
        />
        <Show when={matchError()}>
          <p class="error" data-testid="open-match-error">
            {matchError()}
          </p>
        </Show>
        <Show when={notice()}>
          {(n) => (
            <div class="entry-notice" data-testid="open-match-notice" role="status">
              <b data-testid="open-match-notice-text">{n().text}</b>
              <Show when={n().line}>
                <span class="entry-notice-line" data-testid="open-match-notice-line">
                  {n().line}
                </span>
              </Show>
              <div class="entry-notice-actions">
                <Show when={n().actions.includes("retry")}>
                  <button class="btn" type="button" data-testid="open-match-retry" onClick={() => void openMatch()}>
                    Try again
                  </button>
                </Show>
                <Show when={n().actions.includes("upload")}>
                  <button class="btn primary" type="button" data-testid="open-match-upload" onClick={() => pick.click()}>
                    Upload replay file
                  </button>
                </Show>
              </div>
            </div>
          )}
        </Show>
        <ReplayHelp class="inline" id={/^[1-9]\d{0,11}$/.test(matchId().trim()) ? matchId().trim() : undefined} />
        <DropOverlay over={dragging()} id={matchId().trim() || undefined} />
        <p class="entry-or">or</p>
        <p class="entry-label">Start fresh</p>
        <form class="new-board" onSubmit={create} data-testid="new-board">
          <input
            class="input big"
            placeholder="Board title"
            maxLength={LIMITS.max_title}
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
        <footer class="legal muted">
          MIT · Not affiliated with Valve
          <Show when={feedbackEnabled()}>
            {" · "}
            <FeedbackButton variant="link" />
          </Show>
        </footer>
      </main>
    </div>
  );
}
