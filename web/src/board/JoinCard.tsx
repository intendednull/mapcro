// The one-field join card (design/v1-board/join.html): a display name and a colour, remembered
// on this device. Presence only; the server never stores it (spec §8).

import { For, Show, createSignal, onMount } from "solid-js";
import { type Me, PALETTE } from "../core/device";
import { Wordmark } from "../ui/Wordmark";
import { LIMITS } from "../gen/limits";
import { ModalScrim } from "../ui/ModalScrim";
import { dialogKeys } from "../ui/modal";

export const MAX_NAME = LIMITS.max_name;

export function JoinCard(p: { title: string; others: string[]; initial: Me | undefined; onJoin: (m: Me) => void }) {
  const [name, setName] = createSignal(p.initial?.name ?? "");
  const [color, setColor] = createSignal(p.initial?.color ?? Math.floor(Math.random() * PALETTE.length));
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  return (
    <ModalScrim class="join-scrim" testid="join-card">
      <form
        class="join"
        role="dialog"
        aria-modal="true"
        aria-labelledby="join-h"
        // Joining is how you enter the board: no Escape out of it, but no key reaches the board.
        onKeyDown={dialogKeys(undefined)}
        onSubmit={(e) => {
          e.preventDefault();
          const n = name().trim();
          if (n) p.onJoin({ name: n.slice(0, MAX_NAME), color: color() });
        }}
      >
        <Wordmark />
        <h2 id="join-h">{p.title || "Board"}</h2>
        <Show when={p.others.length > 0}>
          <div class="avatars join-here" data-testid="join-here">
            <For each={p.others}>{(n) => <span class="av" title={n}>{(n.trim()[0] ?? "?").toUpperCase()}</span>}</For>
          </div>
        </Show>
        <label for="join-name">Name</label>
        <input
          ref={input}
          id="join-name"
          class="input big"
          autocomplete="nickname"
          maxLength={MAX_NAME}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <div class="join-colour">
          <span>Colour</span>
          <For each={PALETTE}>
            {(c, i) => (
              <button
                type="button"
                class="sw-btn"
                classList={{ on: color() === i() }}
                style={{ "--c": c.hex }}
                title={c.name}
                aria-label={`Colour: ${c.name}`}
                aria-pressed={color() === i()}
                onClick={() => setColor(i())}
              />
            )}
          </For>
        </div>
        <button class="btn primary join-go" type="submit" disabled={!name().trim()}>
          Join <kbd>Enter</kbd>
        </button>
      </form>
    </ModalScrim>
  );
}
