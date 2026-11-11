import { For, Show } from "solid-js";
import type { Art } from "../map/pack";
import { clockLabel, type Timeline, type TimelinePlayer } from "../match/timeline";
import { CC_LABELS, NPC_SRC, recapAbility, recapSource } from "./recap";

type Recap = NonNullable<TimelinePlayer["recaps"]>[number];
export function DeathRecap(p: { recap: Recap; timeline: Timeline; art: Art; onSeek: (t: number) => void; open?: boolean }) {
  const total = () => p.recap.damage.reduce((sum, d) => sum + d[2], 0);
  const start = () => Math.max(0, p.recap.t - 100);
  const span = () => Math.max(1, p.recap.t - start());
  const source = (src: number) => recapSource(src, p.timeline, (id) => p.art.heroes.get(id)?.name);
  const record = (id: number) => p.art.buildCatalog?.records.get(id);
  const ability = (src: number, id: number) => recapAbility(id, record, src >= NPC_SRC);
  return <details class="death-recap" data-testid="death-recap" open={p.open}>
    <summary>Death recap · {total().toLocaleString()} damage</summary>
    <div class="death-recap-body">
      <div class="recap-window"><span>Last {span() / 10}s · {clockLabel(p.recap.t / 10)}</span>
        <button class="btn small" onClick={() => p.onSeek(start() / 10)}>Watch lead-up</button></div>
      <Show when={p.recap.damage.length} fallback={<p>No damage recorded.</p>}>
        <div class="recap-damage"><For each={p.recap.damage}>{([src, id, damage]) =>
          <div class="recap-hit" data-testid="recap-hit" data-src={src} title={[source(src), ability(src, id)].filter(Boolean).join(" · ")}>
            <Show when={record(id)?.icon}>{icon => <img src={icon()} alt="" />}</Show>
            <span>{source(src)}<Show when={ability(src, id)}>{a => <small>{a()}</small>}</Show></span>
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
