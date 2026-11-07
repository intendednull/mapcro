// Clone to a new board (design/v1-board/clone-flow.html): the current state, fresh links, you
// as its owner. Anyone with a link may clone (spec §11).

import { For, createSignal, onMount } from "solid-js";
import { Api, shareUrl } from "../core/api";
import { markJoined, rememberBoard } from "../core/device";

const KEEPS = ["Every scene, in order", "The roster and every position", "Ink, arrows, callouts and objectives", "Souls, clocks and ults"];
const DROPS = ["History and undo", "Links: nobody else can open it yet", "Who's here and who follows whom"];
const OK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
const NO = '<path d="M6 6l12 12M18 6L6 18"/>';
const Ico = (p: { d: string }) => <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" innerHTML={p.d} />;

export const JUST_CLONED = "mapcro.justCloned";

export function CloneDialog(p: { board: string; token: string; title: string; onClose: () => void }) {
  const [title, setTitle] = createSignal(`${p.title} (copy)`.slice(0, 80));
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
      setError(`Couldn't clone: ${String(err)}`);
      setBusy(false);
    }
  };
  return (
    <div class="scrim" data-testid="clone-dialog" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <form class="dialog clone-dialog" role="dialog" aria-labelledby="clone-h" style={{ width: "560px" }} onSubmit={go} onKeyDown={(e) => e.key === "Escape" && p.onClose()}>
        <header>
          <div>
            <h2 id="clone-h">Clone to a new board</h2>
            <p>You'll own the copy. Nobody else can open it until you share a link.</p>
          </div>
        </header>
        <div class="body">
          <div class="field">
            <label for="clone-title">Title</label>
            <input ref={input} id="clone-title" class="input" maxLength={80} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          </div>
          <div class="keepdrop">
            <div>
              <h3>Comes with it</h3>
              <ul>
                <For each={KEEPS}>
                  {(k) => (
                    <li class="keep">
                      <Ico d={OK} />
                      <span>{k}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
            <div>
              <h3>Stays behind</h3>
              <ul>
                <For each={DROPS}>
                  {(k) => (
                    <li class="drop">
                      <Ico d={NO} />
                      <span>{k}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </div>
          {error() && <p class="error">{error()}</p>}
        </div>
        <footer>
          <span />
          <button class="btn ghost" type="button" onClick={() => p.onClose()}>
            Cancel
          </button>
          <button class="btn primary" type="submit" data-testid="clone-go" disabled={busy()}>
            {busy() ? "Cloning…" : "Clone and open it"}
          </button>
        </footer>
      </form>
    </div>
  );
}
