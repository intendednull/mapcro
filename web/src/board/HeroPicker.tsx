// Hero select (operator, 2026-11-07): opened from a top-bar portrait. Every playable hero from
// the pack, as a grid of portraits and names, with a search box focused on open. Arrows move,
// Enter picks, Esc closes. Picking sets the slot's hero in one transaction.


import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { HeroId } from "../gen/HeroId";
import type { Hero } from "../map/pack";
import { cx } from "../ui/cx";
import { matchHeroes, slotPlaceholder } from "./roster";
import type { Slot } from "./state";
import { ModalScrim } from "../ui/ModalScrim";
import { dialogKeys } from "../ui/modal";

const COLS = 6;


/**
 * A hero is unique in a match, across both teams: `takenBy` names who has each hero (other
 * slots only). A taken hero is shown, disabled, with its holder; picking it does nothing.
 */
export function HeroPicker(p: {
  heroes: Hero[];
  slot: Slot | undefined;
  takenBy: Map<HeroId, string>;
  onPick: (h: HeroId | null) => void;
  onClose: () => void;
}) {
  const pick = (h: Hero) => !p.takenBy.has(h.id) && p.onPick(h.id);
  const [q, setQ] = createSignal("");
  const [at, setAt] = createSignal(0);
  const shown = createMemo(() => matchHeroes(p.heroes, q()));
  let input!: HTMLInputElement;
  let grid!: HTMLDivElement;
  onMount(() => input.focus());
  const move = (d: number) => {
    const n = shown().length;
    if (!n) return;
    setAt(Math.max(0, Math.min(n - 1, at() + d)));
    grid.querySelector<HTMLElement>(`[data-i="${at()}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const h = shown()[at()];
      if (h) pick(h);
      return;
    }
    const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS }[e.key];
    if (d !== undefined) {
      e.preventDefault();
      move(d);
    }
  };
  const who = () => (p.slot ? p.slot.slot.name || slotPlaceholder(p.slot.slot.team, p.slot.slot.slot) : "");
  const initials = (name: string) =>
    name
      .split(/[\s&]+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  return (
    <ModalScrim testid="hero-picker" onClose={p.onClose}>
      <div class="dialog hero-picker" role="dialog" aria-modal="true" aria-labelledby="hp-h" onKeyDown={dialogKeys(p.onClose, key)}>
        <header>
          <div>
            <h2 id="hp-h">{who()}</h2>
          </div>
        </header>
        <div class="body">
          <input
            ref={input}
            class="input"
            data-testid="hero-search"
            placeholder="Search"
            aria-label="Search"
            value={q()}
            onInput={(e) => {
              setQ(e.currentTarget.value);
              setAt(0);
            }}
          />
          <Show when={p.heroes.length > 0} fallback={<p class="muted">No heroes</p>}>
            <div class="hero-grid" ref={grid} role="listbox" aria-label="Heroes">
              <For each={shown()}>
                {(h, i) => (
                  <button
                    class={cx("hero-cell", i() === at() && "on", p.slot?.slot.hero === h.id && "current", p.takenBy.has(h.id) && "taken")}
                    role="option"
                    aria-selected={i() === at()}
                    aria-disabled={p.takenBy.has(h.id)}
                    disabled={p.takenBy.has(h.id)}
                    title={p.takenBy.has(h.id) ? `${h.name}: ${p.takenBy.get(h.id)} has this hero` : h.name}
                    data-i={i()}
                    data-hero={h.name}
                    onPointerEnter={() => setAt(i())}
                    onClick={() => pick(h)}
                  >
                    <span class="hero-face">
                      <Show when={h.topbar ?? h.portrait} fallback={<b>{initials(h.name)}</b>}>
                        {(src) => <img src={src()} alt="" draggable={false} />}
                      </Show>
                    </span>
                    <span class="hero-name">{h.name}</span>
                    <Show when={p.takenBy.get(h.id)}>{(w) => <span class="hero-taken">{w()}</span>}</Show>
                  </button>
                )}
              </For>
              <Show when={shown().length === 0}>
                <p class="muted">No match</p>
              </Show>
            </div>
          </Show>
        </div>
        <footer>
          <span />
          <Show when={p.slot?.slot.hero != null}>
            <button class="btn ghost small" onClick={() => p.onPick(null)}>
              No hero
            </button>
          </Show>
          <button class="btn small" onClick={() => p.onClose()}>
            Cancel
          </button>
        </footer>
      </div>
    </ModalScrim>
  );
}
