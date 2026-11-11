// Board links and the app (core/applink.ts): "Open in app" on a board page in a browser, and in
// the app "Open link" (on the landing, and Ctrl+L anywhere) for a pasted share link. Also the
// portable app's "Update available" (desktop/README.md, Installer or portable).

import { Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { WINDOWS_APP_RELEASES, appUpdate, bridge, windowsAppLink } from "../player/desktop";
import { type BoardLink, openBoard, openInAppHref, parseBoardLink } from "../core/applink";
import { ModalScrim } from "./ModalScrim";
import { dialogKeys } from "./modal";

export const NOT_A_BOARD_LINK = "Not a board link";

/** A board page's "Open in app" (a Windows browser, once the app is released; never in the app),
 * and a quiet "Get the app" beside it for when it isn't installed (the browser drops an unknown
 * scheme silently). */
export function OpenInApp(p: BoardLink) {
  const href = () => openInAppHref({ board: p.board, token: p.token });
  return (
    <Show when={href()}>
      {(h) => (
        <>
          <a class="btn ghost" href={h()} data-testid="open-in-app">
            Open in app
          </a>
          <a class="btn ghost small muted" href={windowsAppLink()} target="_blank" rel="noopener" data-testid="open-in-app-get">
            Get the app
          </a>
        </>
      )}
    </Show>
  );
}

/** A field for a board link; a valid one opens its board here. */
export function OpenLinkForm(p: { class?: string; autofocus?: boolean; onOpen?: () => void }) {
  const [text, setText] = createSignal("");
  const [error, setError] = createSignal(false);
  let input!: HTMLInputElement;
  onMount(() => p.autofocus && input.focus());
  const go = (e: Event) => {
    e.preventDefault();
    const b = parseBoardLink(text());
    setError(!b);
    if (!b) return;
    p.onOpen?.();
    openBoard(b);
  };
  return (
    <>
      <form class={p.class ?? "new-board"} onSubmit={go} data-testid="open-link">
        <input
          ref={input}
          class="input big"
          data-testid="open-link-input"
          placeholder="Board link"
          aria-label="Board link"
          autocomplete="off"
          spellcheck={false}
          value={text()}
          onInput={(e) => (setText(e.currentTarget.value), setError(false))}
        />
        <button class="btn primary" type="submit" data-testid="open-link-go">
          Open
        </button>
      </form>
      <Show when={error()}>
        <p class="error" data-testid="open-link-error">
          {NOT_A_BOARD_LINK}
        </p>
      </Show>
    </>
  );
}

function OpenLinkDialog(p: { onClose: () => void }) {
  return (
    <ModalScrim testid="open-link-dialog" onClose={p.onClose}>
      <div class="dialog open-link-dialog" role="dialog" aria-modal="true" aria-labelledby="open-link-h" style={{ width: "560px" }} onKeyDown={dialogKeys(p.onClose)}>
        <header>
          <div>
            <h2 id="open-link-h">Open link</h2>
          </div>
        </header>
        <div class="body">
          <OpenLinkForm class="new-board open-link" autofocus onOpen={p.onClose} />
        </div>
      </div>
    </ModalScrim>
  );
}

/** In the app: Ctrl+L, anywhere, opens "Open link". In a browser, nothing (the address bar's). */
export function OpenLinkKeys() {
  const [open, setOpen] = createSignal(false);
  onMount(() => {
    if (!bridge()) return;
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "l") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    };
    window.addEventListener("keydown", key, true);
    onCleanup(() => window.removeEventListener("keydown", key, true));
  });
  return (
    <Show when={open()}>
      <OpenLinkDialog onClose={() => setOpen(false)} />
    </Show>
  );
}

/** The portable app's "Update available": the release page (it opens in the system browser). */
export function UpdateLink(p: { class?: string; sep?: string }) {
  const [version] = createResource(() => appUpdate());
  return (
    <Show when={version()}>
      {p.sep}
      <a class={p.class ?? "btn ghost"} href={WINDOWS_APP_RELEASES} data-testid="app-update">
        Update available
      </a>
    </Show>
  );
}
