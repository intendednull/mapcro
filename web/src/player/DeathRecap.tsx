import { For, Show } from "solid-js";
import type { Art } from "../map/pack";
import { clockLabel, type Timeline, type TimelinePlayer } from "../match/timeline";
import { CC_LABELS } from "./recap";

type Recap = NonNullable<TimelinePlayer["recaps"]>[number];
export function DeathRecap(p: { recap: Recap; timeline: Timeline; art: Art; onSeek: (t: number) => void; open?: boolean | undefined; onToggle?: ((open: boolean) => void) | undefined }) {
  const total = () => p.recap.damage.reduce((sum, d) => sum + d[2], 0);
  const start = () => Math.max(0, p.recap.t - 100);
  const span = () => Math.max(1, p.recap.t - start());
  const source = (index: number) => {
    const player = p.timeline.players[index];
    return player ? p.art.heroes.get(player.hero_id)?.name ?? "Hero" : "World / other";
  };
  const record = (id: number) => p.art.buildCatalog?.records.get(id);
  return <details class="death-recap" data-testid="death-recap" open={p.open} on:toggle={(e) => p.onToggle?.(e.currentTarget.open)}>
    <summary>Death recap · {total().toLocaleString()} damage</summary>
    <div class="death-recap-body">
      <div class="recap-window"><span>Last {span() / 10}s · {clockLabel(p.recap.t / 10)}</span>
        <button class="btn small" onClick={() => p.onSeek(start() / 10)}>Watch lead-up</button></div>
      <Show when={p.recap.damage.length} fallback={<p>No damage recorded.</p>}>
        <div class="recap-damage"><For each={p.recap.damage}>{([src, id, damage]) =>
          <div class="recap-hit" title={`${source(src)} · ${record(id)?.label ?? (id ? "Unknown ability" : "Other damage")}`}>
            <Show when={record(id)?.icon}>{icon => <img src={icon()} alt="" />}</Show>
            <span>{source(src)}<small>{record(id)?.label ?? (id ? "Unknown ability" : "Other damage")}</small></span>
            <b>{damage.toLocaleString()}</b>
            <i style={{ width: `${total() ? damage / total() * 100 : 0}%` }} />
          </div>
        }</For></div>
      </Show>
      <Show when={p.recap.cc?.length}>
        <h3>Crowd control</h3>
        <For each={p.recap.cc}>{([from, to, state]) => {
          const a = Math.max(start(), from), b = Math.min(p.recap.t, to);
          return <Show when={b > a}><div class="recap-cc">
            <span>{CC_LABELS[state] ?? "Crowd control"} · {((b - a) / 10).toFixed(1)}s</span>
            <div><i style={{ left: `${(a - start()) / span() * 100}%`, width: `${(b - a) / span() * 100}%` }} /></div>
          </div></Show>;
        }}</For>
      </Show>
    </div>
  </details>;
}
