// The one-field join card (design/v1-board/join.html): a display name and a colour, remembered
// on this device. Presence only; the server never stores it (spec §8).

import { For, createSignal, onMount } from "solid-js";
import { type Me, PALETTE } from "../core/device";
import { Wordmark } from "../ui/Wordmark";

export const MAX_NAME = 24;

export function JoinCard(p: { title: string; others: string[]; initial: Me | undefined; onJoin: (m: Me) => void }) {
  const [name, setName] = createSignal(p.initial?.name ?? "");
  const [color, setColor] = createSignal(p.initial?.color ?? Math.floor(Math.random() * PALETTE.length));
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  const who = () => {
    const o = p.others;
    if (o.length === 0) return "Nobody else is here yet.";
    if (o.length === 1) return `${o[0]} is here.`;
    return `${o.slice(0, -1).join(", ")} and ${o[o.length - 1]} are here.`;
  };
  return (
    <div class="scrim join-scrim" data-testid="join-card">
      <form
        class="join"
        aria-labelledby="join-h"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name().trim();
          if (n) p.onJoin({ name: n.slice(0, MAX_NAME), color: color() });
        }}
      >
        <Wordmark />
        <h2 id="join-h">Joining “{p.title || "this board"}”</h2>
        <p>{who()}</p>
        <label for="join-name">Your name</label>
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
        <small>Others see this on your cursor and beside whatever you touch. It's remembered on this device.</small>
      </form>
    </div>
  );
}
