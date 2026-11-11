import { For, Show, createMemo } from "solid-js";
import type { Art } from "../map/pack";
import type { TimelinePlayer } from "../match/timeline";
import { effectsAt } from "./effects";

export function ActiveEffects(p: { player: TimelinePlayer; t: number; art: Art; endDs?: number | undefined }) {
  const effects = createMemo(() => effectsAt(p.player, p.t, p.art.buildCatalog, p.endDs));
  return <details class="tb-effects" data-testid="active-effects">
    <summary>Effects · {effects()?.length ?? "—"}</summary>
    <div class="tb-effects-body">
      <Show when={effects() !== null} fallback={<p>Effects unavailable in this replay.</p>}>
        <For each={effects() ?? []} fallback={<p>No active effects recorded.</p>}>{effect =>
          <div class="tb-effect" data-testid="active-effect">
            <Show when={effect.icon}>{icon => <img src={icon()} alt="" />}</Show>
            <span>{effect.label}<Show when={effect.stacks > 1}><small> ×{effect.stacks}</small></Show></span>
            <Show when={effect.remaining !== null} fallback={<b class="tb-effect-perm">∞</b>}><b>{effect.remaining!.toFixed(1)}s</b></Show>
          </div>
        }</For>
      </Show>
    </div>
  </details>;
}
