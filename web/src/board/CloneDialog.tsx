// Clone to a new board (design/v1-board/clone-flow.html): the current state, fresh links, you
// as its owner. Anyone with a link may clone (spec §11).

import { createSignal, onMount } from "solid-js";
import { Api, shareUrl } from "../core/api";
import { markJoined, rememberBoard } from "../core/device";
import { LIMITS } from "../gen/limits";
import { ModalScrim } from "../ui/ModalScrim";
import { dialogKeys } from "../ui/modal";

const Ico = (p: { d: string }) => <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" innerHTML={p.d} />;

export const JUST_CLONED = "mapcro.justCloned";

export function CloneDialog(p: { board: string; token: string; title: string; onClose: () => void }) {
  const [title, setTitle] = createSignal(`${p.title} (copy)`.slice(0, LIMITS.max_title));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let input!: HTMLInputElement;
  onMount(() => (input.focus(), input.select()));
  const go = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const t = title().trim() || `${p.title} (copy)`;
      const { board, owner_token } = await new Api("").cloneBoard(p.board, p.token, t);
      rememberBoard({ board, token: owner_token, title: t });
      markJoined(board); // you already said who you are
      sessionStorage.setItem(JUST_CLONED, board);
      location.assign(shareUrl(location.origin, board, owner_token));
    } catch (err) {
      setError("Failed");
      setBusy(false);
    }
  };
  return (
    <ModalScrim testid="clone-dialog" onClose={p.onClose}>
      <form class="dialog clone-dialog" role="dialog" aria-modal="true" aria-labelledby="clone-h" style={{ width: "560px" }} onSubmit={go} onKeyDown={dialogKeys(p.onClose)}>
        <header>
          <div>
            <h2 id="clone-h">Clone</h2>
          </div>
        </header>
        <div class="body">
          <div class="field">
            <label for="clone-title">Title</label>
            <input ref={input} id="clone-title" class="input" maxLength={LIMITS.max_title} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          </div>
          {error() && <p class="error">{error()}</p>}
        </div>
        <footer>
          <span />
          <button class="btn ghost" type="button" onClick={() => p.onClose()}>
            Cancel
          </button>
          <button class="btn primary" type="submit" data-testid="clone-go" disabled={busy()}>
            {busy() ? "Cloning…" : "Clone"}
          </button>
        </footer>
      </form>
    </ModalScrim>
  );
}
