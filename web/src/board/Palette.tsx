// The colour palette, its own control (operator, 2026-11-07): a swatch showing the current
// colour, which opens the palette in place. The colour applies to Draw, Arrow, Comment and
// Laser, and is remembered per person per board.

import { For, Show, createSignal } from "solid-js";
import { PALETTE, colorOf } from "../core/device";
import { cx } from "../ui/cx";

export function Palette(p: { value: number; set: (i: number) => void; class?: string }) {
  const [open, setOpen] = createSignal(false);
  const name = () => PALETTE[((p.value % PALETTE.length) + PALETTE.length) % PALETTE.length]!.name;
  return (
    <span class={cx("palette", open() && "open", p.class)}>
      <button
        class={cx("tb icon swatch", open() && "on")}
        data-testid="palette"
        title={`Colour: ${name()}`}
        aria-label={`Colour: ${name()}`}
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <i class="ink-dot" style={{ background: colorOf(p.value) }} />
      </button>
      <Show when={open()}>
        <span class="ink-palette" role="radiogroup" aria-label="Colour" data-testid="palette-pop">
          <For each={PALETTE}>
            {(c, i) => (
              <button
                class={cx("sw-btn", p.value === i() && "on")}
                style={{ "--c": c.hex }}
                title={c.name}
                role="radio"
                aria-checked={p.value === i()}
                aria-label={`Colour: ${c.name}`}
                onClick={() => {
                  p.set(i());
                  setOpen(false);
                }}
              />
            )}
          </For>
        </span>
      </Show>
    </span>
  );
}
