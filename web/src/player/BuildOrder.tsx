// The inspected hero's build order (single-hero dropdown, beside Effects): every buy, sale and
// upgrade from the timeline's `items` series, with the game's item icons; a row seeks the replay
// to its moment.
import { For, Show, createMemo } from "solid-js";
import type { Art } from "../map/pack";
import { buildOrder, type BuildOrderEntry } from "../match/builds";
import { clockLabel, type TimelinePlayer } from "../match/timeline";
import { cx } from "../ui/cx";

const VERB: Record<BuildOrderEntry["kind"], string> = { bought: "Bought", sold: "Sold", merged: "Upgraded", removed: "Lost" };

export function BuildOrder(p: { player: TimelinePlayer; t: number; art: Art; onSeek?: ((t: number) => void) | undefined }) {
  const record = (id: number) => p.art.buildCatalog?.records.get(id);
  const order = createMemo(() => buildOrder(p.player, p.art.buildCatalog ? (id) => record(id)?.components ?? [] : undefined));
  const name = (id: number) => record(id)?.label ?? "Unknown item";
  /** Tags (spec §4b): what, from what, when. */
  const label = (e: BuildOrderEntry) => `${VERB[e.kind]} ${name(e.id)}${e.from.length ? `, from ${e.from.map(name).join(", ")}` : ""}, ${clockLabel(e.t)}`;
  return <details class="tb-effects tb-order" name="tb-build-popover" data-testid="build-order">
    <summary>Build order · {order()?.filter(e => e.kind === "bought").length ?? "—"}</summary>
    <div class="tb-effects-body">
      <Show when={order() !== null} fallback={<p>Build order unavailable in this replay.</p>}>
        <For each={order() ?? []} fallback={<p>No items bought.</p>}>{e =>
          <button type="button" class={cx("tb-order-row", e.kind, e.t > p.t && "later")} data-testid="build-order-row" data-t={e.t} data-kind={e.kind} data-item-id={e.id}
            aria-label={label(e)} title={name(e.id)} onClick={() => p.onSeek?.(e.t)}>
            <Show when={record(e.id)?.icon} fallback={<span class="tb-build-fallback">?</span>}>{src => <img src={src()} alt="" />}</Show>
            <span>{e.kind === "bought" ? "" : <small>{VERB[e.kind]} </small>}{name(e.id)}</span>
            <b>{clockLabel(e.t)}</b>
          </button>
        }</For>
      </Show>
    </div>
  </details>;
}
