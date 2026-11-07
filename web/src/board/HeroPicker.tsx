// Hero select (operator, 2026-11-07): opened from a top-bar portrait. Every playable hero from
// the pack, as a grid of portraits and names, with a search box focused on open. Arrows move,
// Enter picks, Esc closes. Picking sets the slot's hero in one transaction.

import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { HeroId } from "../gen/HeroId";
import type { Hero } from "../map/pack";
import { cx } from "../ui/cx";
import { matchHeroes } from "./roster";
import type { Slot } from "./state";

const COLS = 6;


export function HeroPicker(p: { heroes: Hero[]; slot: Slot | undefined; onPick: (h: HeroId | null) => void; onClose: () => void }) {
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
    if (e.key === "Escape") return (e.preventDefault(), p.onClose());
    if (e.key === "Enter") {
      e.preventDefault();
      const h = shown()[at()];
      if (h) p.onPick(h.id);
      return;
    }
    const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS }[e.key];
    if (d !== undefined) {
      e.preventDefault();
      move(d);
    }
  };
  const who = () => (p.slot ? p.slot.slot.name || `${p.slot.slot.team} ${p.slot.slot.slot + 1}` : "");
  const initials = (name: string) =>
    name
      .split(/[\s&]+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  return (
    <div class="scrim" data-testid="hero-picker" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="dialog hero-picker" role="dialog" aria-labelledby="hp-h" onKeyDown={key}>
        <header>
          <div>
            <h2 id="hp-h">Pick a hero</h2>
            <p>For {who()}. Type to search; arrows and Enter pick, Esc closes.</p>
          </div>
        </header>
        <div class="body">
          <input
            ref={input}
            class="input"
            data-testid="hero-search"
            placeholder="Search heroes"
            aria-label="Search heroes"
            value={q()}
            onInput={(e) => {
              setQ(e.currentTarget.value);
              setAt(0);
            }}
          />
          <Show when={p.heroes.length > 0} fallback={<p class="muted">This server has no asset pack, so there's no hero list to pick from.</p>}>
            <div class="hero-grid" ref={grid} role="listbox" aria-label="Heroes">
              <For each={shown()}>
                {(h, i) => (
                  <button
                    class={cx("hero-cell", i() === at() && "on", p.slot?.slot.hero === h.id && "current")}
                    role="option"
                    aria-selected={i() === at()}
                    data-i={i()}
                    data-hero={h.name}
                    onPointerEnter={() => setAt(i())}
                    onClick={() => p.onPick(h.id)}
                  >
                    <span class="hero-face">
                      <Show when={h.topbar ?? h.portrait} fallback={<b>{initials(h.name)}</b>}>
                        {(src) => <img src={src()} alt="" draggable={false} />}
                      </Show>
                    </span>
                    <span class="hero-name">{h.name}</span>
                  </button>
                )}
              </For>
              <Show when={shown().length === 0}>
                <p class="muted">No hero matches “{q()}”.</p>
              </Show>
            </div>
          </Show>
        </div>
        <footer>
          <span />
          <Show when={p.slot?.slot.hero != null}>
            <button class="btn ghost small" onClick={() => p.onPick(null)}>
              Clear hero
            </button>
          </Show>
          <button class="btn small" onClick={() => p.onClose()}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
