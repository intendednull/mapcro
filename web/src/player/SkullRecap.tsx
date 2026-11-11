// A death's recap opened from its skull on the map (Skulls.tsx): the hero, the moment, and the
// recap the events list shows (DeathRecap.tsx), open. It closes when the death leaves the view:
// another match, or a Vision whose team didn't see it (skulls.ts `deathShown`), so it never
// reveals a death the selected team couldn't see.
import { Show, createEffect, createMemo, onCleanup, onMount } from "solid-js";
import type { Art } from "../map/pack";
import { clockLabel, type Timeline } from "../match/timeline";
import { slotKey } from "../match/save";
import { DeathRecap } from "./DeathRecap";
import { recapOf } from "./recap";
import { deathShown } from "./skulls";
import { type Vision, hasVision } from "./vision";

export interface SkullDeath { slot: string; t: number }

export function SkullRecap(p: { death: SkullDeath; timeline: Timeline; vision: Vision; art: Art; name?: (team: string, slot: number) => string | undefined; onSeek: (t: number) => void; onClose: () => void }) {
  const player = createMemo(() => p.timeline.players.find(q => slotKey(q.team, q.slot) === p.death.slot));
  const recap = createMemo(() => recapOf(player(), p.death.t));
  const view = () => (p.vision !== "all" && hasVision(p.timeline) ? p.vision : null);
  const shown = () => !!player() && !!recap() && deathShown(player()!, p.death.t, view());
  createEffect(() => { if (!shown()) p.onClose(); });
  const hero = () => p.art.heroes.get(player()?.hero_id ?? -1);
  onMount(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });
  return <Show when={shown() && recap()}>{r =>
    <section class="skull-recap" data-testid="skull-recap" data-slot={p.death.slot} data-t={p.death.t} aria-label="Death recap">
      <div class="skull-recap-head">
        <Show when={hero()?.portrait}>{src => <img src={src()} alt="" />}</Show>
        <span><b>{hero()?.name ?? "Hero"}</b><Show when={player() && p.name?.(player()!.team, player()!.slot)}>{n => <> · {n()}</>}</Show>
          <small>Died at {clockLabel(p.death.t)}</small></span>
        <button type="button" class="btn small" data-testid="skull-recap-close" aria-label="Close death recap" title="Close (Esc)" onClick={() => p.onClose()}>×</button>
      </div>
      <DeathRecap recap={r()} timeline={p.timeline} art={p.art} open onSeek={p.onSeek} />
    </section>
  }</Show>;
}
