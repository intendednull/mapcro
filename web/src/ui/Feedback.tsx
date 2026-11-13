// The feedback form (spec §11a): a title and a description become a public GitHub issue. The
// button shows only when the server has the form on (core/feedback.ts).

import { Show, createSignal, onMount } from "solid-js";
import { type FeedbackMatch, MAX_DESCRIPTION, MAX_TITLE, feedbackEnabled, matchLine, sendFeedback } from "../core/feedback";
import { dialogKeys } from "./modal";
import { ModalScrim } from "./ModalScrim";

const X = '<path d="M6 6l12 12M18 6L6 18"/>';
export const BUBBLE = '<path d="M5 5h14a1 1 0 011 1v9a1 1 0 01-1 1h-7l-4 3v-3H5a1 1 0 01-1-1V6a1 1 0 011-1z"/>';
const Ico = (p: { d: string }) => <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" innerHTML={p.d} />;

/** Counts show from this share of a limit. */
const NEAR = 0.8;

/** `match`: the match open when the dialog opened (a snapshot: the line doesn't tick on). */
export function FeedbackDialog(p: { onClose: () => void; match?: FeedbackMatch | undefined }) {
  const [title, setTitle] = createSignal("");
  const [withMatch, setWithMatch] = createSignal(true);
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<{ field?: "title" | "description"; message: string }>();
  const [sent, setSent] = createSignal<string>();
  let titleInput!: HTMLInputElement;
  let textInput!: HTMLTextAreaElement;
  let done!: HTMLButtonElement;
  onMount(() => titleInput.focus());

  const send = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    if (!title().trim()) {
      setProblem({ field: "title", message: "Add a title." });
      return titleInput.focus();
    }
    if (!text().trim()) {
      setProblem({ field: "description", message: "Add a description." });
      return textInput.focus();
    }
    setProblem(undefined);
    setBusy(true);
    const r = await sendFeedback(title(), text(), withMatch() ? p.match : undefined);
    setBusy(false);
    if (r.ok) {
      setSent(r.url);
      queueMicrotask(() => done?.focus());
    } else setProblem({ message: r.message });
  };
  const count = (n: number, max: number) => n >= max * NEAR;

  return (
    <ModalScrim class="feedback-scrim" testid="feedback-dialog" onClose={p.onClose}>
        <form
          class="dialog feedback-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="feedback-h"
          aria-describedby="feedback-notice"
          noValidate
          onSubmit={send}
          onKeyDown={dialogKeys(p.onClose)}
        >
          <header>
            <div>
              <h2 id="feedback-h">Feedback</h2>
              <p id="feedback-notice" data-testid="feedback-notice">
                This creates a public issue on GitHub (intendednull/mapcro). Don't include personal info or board links.
              </p>
            </div>
            <button class="x" type="button" aria-label="Close" onClick={() => p.onClose()}>
              <Ico d={X} />
            </button>
          </header>
          <Show
            when={!sent()}
            fallback={
              <>
                <div class="body feedback-done" data-testid="feedback-done" role="status">
                  <b>Thanks — sent.</b>
                  <a href={sent()} target="_blank" rel="noopener noreferrer" data-testid="feedback-link">
                    See the issue on GitHub
                  </a>
                </div>
                <footer>
                  <span />
                  <button ref={done} class="btn primary" type="button" data-testid="feedback-close" onClick={() => p.onClose()}>
                    Done
                  </button>
                </footer>
              </>
            }
          >
            <div class="body">
              <div class="field">
                <label for="feedback-title">Title</label>
                <input
                  ref={titleInput}
                  id="feedback-title"
                  class="input"
                  data-testid="feedback-title"
                  maxLength={MAX_TITLE}
                  required
                  aria-invalid={problem()?.field === "title"}
                  value={title()}
                  onInput={(e) => setTitle(e.currentTarget.value)}
                />
                <Show when={count(title().length, MAX_TITLE)}>
                  <span class="count" data-testid="feedback-title-count">
                    {title().length} / {MAX_TITLE}
                  </span>
                </Show>
              </div>
              <div class="field">
                <label for="feedback-description">Description</label>
                <textarea
                  ref={textInput}
                  id="feedback-description"
                  class="input"
                  data-testid="feedback-description"
                  maxLength={MAX_DESCRIPTION}
                  rows={8}
                  required
                  aria-invalid={problem()?.field === "description"}
                  placeholder="What happened, or what would help?"
                  value={text()}
                  onInput={(e) => setText(e.currentTarget.value)}
                />
                <Show when={count(text().length, MAX_DESCRIPTION)}>
                  <span class="count" data-testid="feedback-count">
                    {text().length.toLocaleString("en")} / {MAX_DESCRIPTION.toLocaleString("en")}
                  </span>
                </Show>
              </div>
              <Show when={p.match}>
                {(m) => (
                  <label class="feedback-match" data-testid="feedback-match">
                    <input type="checkbox" data-testid="feedback-match-check" checked={withMatch()} onChange={(e) => setWithMatch(e.currentTarget.checked)} />
                    <span>
                      Includes: <b data-testid="feedback-match-line">{matchLine(m())}</b>
                      <small>Helps find the moment. Untick to leave it out of the issue.</small>
                    </span>
                  </label>
                )}
              </Show>
              <Show when={problem()}>
                {(m) => (
                  <p class="error" data-testid="feedback-error" role="alert">
                    {m().message}
                  </p>
                )}
              </Show>
            </div>
            <footer>
              <span />
              <button class="btn ghost" type="button" data-testid="feedback-cancel" onClick={() => p.onClose()}>
                Cancel
              </button>
              <button class="btn primary" type="submit" data-testid="feedback-send" disabled={busy()}>
                {busy() ? "Sending…" : problem() && !problem()!.field ? "Try again" : "Send"}
              </button>
            </footer>
          </Show>
        </form>
    </ModalScrim>
  );
}

/** The "Feedback" opener: a top-bar button (`variant: "bar"`) or a quiet text link. Hidden while
 * the server has the form off. `match`, on a board: the match open in Player, read on opening. */
export function FeedbackButton(p: { variant: "bar" | "link"; match?: () => FeedbackMatch | undefined }) {
  const [open, setOpen] = createSignal<{ match?: FeedbackMatch | undefined }>();
  return (
    <Show when={feedbackEnabled()}>
      <button
        class={p.variant === "bar" ? "btn ghost" : "linkish"}
        type="button"
        data-testid="feedback-open"
        aria-haspopup="dialog"
        onClick={() => setOpen({ match: p.match?.() })}
      >
        <Show when={p.variant === "bar"}>
          <Ico d={BUBBLE} />
        </Show>
        Feedback
      </button>
      <Show when={open()}>
        {(o) => <FeedbackDialog match={o().match} onClose={() => setOpen(undefined)} />}
      </Show>
    </Show>
  );
}
