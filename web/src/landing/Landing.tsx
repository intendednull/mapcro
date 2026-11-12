// The front page (spec §6b): open a match (a board with it attached, landing in Player), make a
// sandbox board (you get its owner link, kept on this device), or reopen one. In the Windows
// app, a replay comes from its replay picker (`ReplayPicker.tsx`), not a file dialog.

import { For, Show, createSignal, onCleanup } from "solid-js";
import { Api, shareUrl } from "../core/api";
import { type KnownBoard, askRename, forgetBoard, knownBoards, markOpened, rememberBoard, restoreBoard } from "../core/device";
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
import { bridge, windowsAppLink, windowsPortableLink } from "../player/desktop";
import { OpenLinkForm, UpdateLink } from "../ui/OpenLink";
import { type Picked, ReplayPicker, pickerSource } from "../player/ReplayPicker";

export function Landing() {
  const [title, setTitle] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [boards, setBoards] = createSignal(knownBoards());
  // The bin takes a board off this device's list only; the toast's Undo puts it back.
  const [toast, setToast] = createSignal<{ text: string; undo: KnownBoard }>();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  // The landing was left (back or forward onto a board, an opened link) while a board was being
  // made: an answer that comes after takes no one anywhere (sessions.md §4.1).
  let left = false;
  onCleanup(() => {
    left = true;
    clearTimeout(toastTimer);
  });
  const remove = (b: KnownBoard) => {
    const gone = forgetBoard(b.board);
    setBoards(knownBoards());
    if (!gone) return;
    setToast({ text: `Removed ${gone.title}`, undo: gone });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(undefined), 6000);
  };
  const undoRemove = (k: KnownBoard) => {
    restoreBoard(k);
    setBoards(knownBoards());
    setToast(undefined);
  };
  // Rename from the list: the board opens with its title's editor open (Board.tsx).
  const rename = (b: KnownBoard) => {
    askRename(b.board);
    location.assign(shareUrl(location.origin, b.board, b.token));
  };
  const create = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const t = title().trim() || "Untitled board";
      const { board, owner_token } = await new Api("").createBoard(t);
      if (left) return;
      rememberBoard({ board, token: owner_token, title: t, edit: true });
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
  const app = pickerSource();
  const [picking, setPicking] = createSignal(false);
  const fail = (text: string) => {
    setOpening("");
    setNotice(undefined);
    setMatchError(text);
  };
  const openMatch = async (e?: Event, picked?: Picked) => {
    e?.preventDefault();
    if (opening()) return;
    const f = picked ? undefined : file();
    if (f && !isDem(f.name)) return fail(NOT_DEM);
    const fromFile = picked?.id ?? (f ? idFromName(f.name) : undefined);
    const typed = picked ? "" : matchId().trim().replace(/^0+/, "");
    if (typed && fromFile && typed !== fromFile) return fail(`That file is match ${fromFile}, not ${typed}`);
    const id = typed || fromFile || "";
    if (!/^[1-9]\d{0,11}$/.test(id)) return fail("Invalid id");
    setMatchError("");
    setNotice(undefined);
    setOpening("Opening");
    try {
      if (f && !(await looksLikeDemo(f))) return fail(noticeFor("not_a_replay", "upload")!.text);
      if (left) return;
      // A Brawl (or other non-standard) match gets no board (2026-11-08).
      const code = await lookup(id);
      if (left) return;
      if (code && MODE_CODES.has(code)) return fail(noticeFor(code, "load")!.text);
      // Without its replay, a match needs deadlock-api's metadata to open: say why it can't. A
      // replay stands alone (spec §6a).
      if (code && !f && !picked) {
        setOpening("");
        return setNotice(noticeFor(code, "load"));
      }
      if (made?.id !== id) {
        const t = `Match ${id}`;
        const { board, owner_token } = await new Api("").createBoard(t);
        if (left) return;
        made = { board, token: owner_token, id };
      }
      const m = made;
      // Only a match that opened goes in "Your boards" (QA, item 8).
      const remember = () => rememberBoard({ board: m.board, token: m.token, title: `Match ${id}`, match: id, edit: true });
      if (f || picked) {
        // The board uploads it, with progress, while you use the board (player/handoff.ts); it
        // attaches the match once the upload is under way, so no fetch from Valve starts. A pick
        // in the app is parsed there and only its timeline sent.
        handOff({ board: m.board, id, file: f, local: picked, opened: remember });
        return navigate(shareUrl(location.origin, m.board, m.token));
      }
      const r = await fetch(`/api/boards/${m.board}/matches/${id}`, { method: "PUT", headers: { authorization: `Bearer ${m.token}` } });
      if (left) return;
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
          <Show
            when={app}
            fallback={
              <label class="btn ghost" title="Replay file (.dem)">
                {file() ? file()!.name : "Select replay file"}
                <input type="file" accept=".dem" hidden data-testid="open-match-file" onChange={(e) => setFile(e.currentTarget.files?.[0])} />
              </label>
            }
          >
            <button class="btn" type="button" data-testid="open-match-pick" onClick={() => setPicking(true)}>
              Select replay
            </button>
          </Show>
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
                  <button class="btn primary" type="button" data-testid="open-match-upload" onClick={() => (app ? setPicking(true) : pick.click())}>
                    {app ? "Upload replay" : "Upload replay file"}
                  </button>
                </Show>
              </div>
            </div>
          )}
        </Show>
        <ReplayHelp class="inline" id={/^[1-9]\d{0,11}$/.test(matchId().trim()) ? matchId().trim() : undefined} />
        <DropOverlay over={dragging()} id={matchId().trim() || undefined} />
        <Show when={app && picking()}>
          <ReplayPicker
            source={app!}
            current={/^[1-9]\d{0,11}$/.test(matchId().trim()) ? matchId().trim() : undefined}
            onClose={() => setPicking(false)}
            onPick={(r) => {
              setPicking(false);
              setFile(undefined);
              setMatchId(r.id);
              void openMatch(undefined, r);
            }}
          />
        </Show>
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
        {/* The app has no address bar: a shared board link is pasted here (or Ctrl+L). */}
        <Show when={bridge()}>
          <p class="entry-or">or</p>
          <p class="entry-label">Open link</p>
          <OpenLinkForm />
        </Show>
        <Show when={boards().length > 0}>
          <h2>Your boards</h2>
          <ul class="known" data-testid="known-boards">
            <For each={boards()}>
              {(b) => (
                <li data-testid="known-board" data-board={b.board}>
                  <a href={shareUrl(location.origin, b.board, b.token)} data-testid="known-title">
                    {b.title}
                  </a>
                  <Show when={b.match && b.title !== `Match ${b.match}`}>
                    <span class="muted known-match" data-testid="known-match">
                      {b.match}
                    </span>
                  </Show>
                  <span class="muted known-seen">{new Date(b.seen).toLocaleDateString()}</span>
                  <Show when={b.edit}>
                    <button class="known-act" type="button" data-testid="known-rename" title="Rename" aria-label="Rename" onClick={() => rename(b)}>
                      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
                      </svg>
                    </button>
                  </Show>
                  <button class="known-act" type="button" data-testid="known-remove" title="Remove" aria-label="Remove" onClick={() => remove(b)}>
                    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={toast()}>
          {(t) => (
            <div class="toast" role="status" data-testid="toast">
              {t().text}
              <button class="link" type="button" data-testid="toast-action" onClick={() => undoRemove(t().undo)}>
                Undo
              </button>
            </div>
          )}
        </Show>
        <footer class="legal muted">
          MIT · Not affiliated with Valve
          <Show when={windowsAppLink()}>
            {(href) => (
              <>
                {" · "}
                <a href={href()} target="_blank" rel="noopener" data-testid="windows-app-landing" title="Windows app">
                  Get the Windows app
                </a>{" "}
                <a href={windowsPortableLink()} class="muted" target="_blank" rel="noopener" data-testid="windows-portable-landing">
                  Portable
                </a>
              </>
            )}
          </Show>
          <Show when={feedbackEnabled()}>
            {" · "}
            <FeedbackButton variant="link" />
          </Show>
          <UpdateLink class="" sep=" · " />
        </footer>
      </main>
    </div>
  );
}
