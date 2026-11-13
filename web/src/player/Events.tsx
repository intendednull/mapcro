// Player's events list (spec §6b): search, filter chips, jump with a lead, and multi-select to
// save one scene per event. Labels only.

import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { Art } from "../map/pack";
import { DeathRecap } from "./DeathRecap";
import { GameTip, Hover, useTooltips } from "./GameTooltip";
import { recapFor } from "./recap";
import type { Death } from "./layers";
import { slotKey } from "../match/save";
import { cx } from "../ui/cx";
import { type MatchEvent, type Timeline, clockLabel } from "../match/timeline";
import { VIEW_STATE } from "../gen/viewState";
import { type EventGroup, GROUPS, type Named, eventKey, eventStart, groupOf, labelParts, search, majorPurchases } from "./events";

export function EventsList(p: {
  tl: Timeline;
  art: Art;
  names: Named;
  tier: string;
  canSave: boolean;
  onJump: (e: MatchEvent, lead: number) => void;
  lead: () => number;
  setLead: (n: number) => void;
  /** Playback time and state: the list follows them (operator, 2026-11-08). */
  t: () => number;
  playing: () => boolean;
  /** Saves the events' scenes; resolves to the keys of the events whose scenes were made. */
  onSave: (events: MatchEvent[], lead: number) => Set<string>;
  /** The event last jumped to: marked as the current one until playback passes the next. */
  pinned?: () => MatchEvent | undefined;
  /** The events shown under the filters and search, as they change (the map pings these). */
  onShown?: (events: MatchEvent[] | undefined) => void;
  /** Whether a death's recap is open, and its toggle (the host's: followers mirror it). */
  recapOpen?: (d: Death) => boolean;
  onRecap?: (d: Death, open: boolean) => void;
  /** The filter chips on and the search (the host's: followers get the presenter's, spec §8). */
  filters: () => Set<EventGroup>;
  setFilter: (g: EventGroup, on: boolean) => void;
  query: () => string;
  setQuery: (q: string) => void;
  /** The search is a presenter's and Names is off here: the box shows none of it (spec §8). */
  queryHidden?: () => boolean;
  /** Names the search finds by, when not `names` (a presenter's: as its Names says). */
  searchNames?: Named | undefined;
}) {
  // A purchase's item, or an ult's ability, shows its tooltip on hover (GameTooltip.tsx).
  const tips = useTooltips(() => p.art, () => p.tl.build);
  const tipId = (e: MatchEvent): number | undefined => {
    const id = e.kind === "item_buy" ? Number(e.key) : e.kind === "ult" && e.hero_id != null ? p.art.heroes.get(e.hero_id)?.abilities?.[3] : undefined;
    return id && Number.isFinite(id) && tips()?.tip(id) ? id : undefined;
  };
  const query = () => p.query();
  const on = () => p.filters();
  const lead = () => p.lead();
  const setLead = (n: number) => p.setLead(n);
  // Ticked events by a stable key, not a position: a replay arriving reorders the list.
  const [picked, setPicked] = createSignal(new Set<string>());
  const all = createMemo(() => [...(p.tl.events ?? []), ...majorPurchases(p.tl, p.art.buildCatalog)].sort((a, b) => a.t - b.t));
  const shown = createMemo(() => search(all().filter(e => e.kind !== "item_buy" || on().has("purchase")), p.searchNames ?? p.names, query(), on()));
  createEffect(() => p.onShown?.(shown()));
  onCleanup(() => p.onShown?.(undefined));
  const present = createMemo(() => GROUPS.filter((g) => all().some((e) => groupOf(e) === g.id)));
  const toggle = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set);
    if (!n.delete(v)) n.add(v);
    return n;
  };
  const chosen = () => all().filter((e) => picked().has(eventKey(e)));
  // The current event: the latest shown at or before t. The list keeps it in view while it
  // follows; scrolling it yourself stops that until you press Play again, or "↓ Now".
  // After a jump, the event jumped to, even though the lead lands before it (and maybe after
  // the one before): until playback passes the next listed event (operator bug, 2026-11-08).
  const current = createMemo(() => {
    const t = p.t();
    const list = shown();
    const pin = p.pinned?.();
    if (pin) {
      const k = eventKey(pin);
      const j = list.findIndex((e) => eventKey(e) === k);
      if (j >= 0) {
        // Playback passes it once a listed event after it is before t.
        let passed = false;
        for (let i = j + 1; i < list.length && !passed; i++) passed = list[i]!.t < t;
        if (!passed) return k;
      }
    }
    // The list is sorted by t, so the latest event at or before t is a halving search: a frame of
    // playback reads a handful of rows, not all of them.
    let at: string | undefined;
    for (let lo = 0, hi = list.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      const e = list[mid]!;
      if (e.t <= t) {
        at = eventKey(e);
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return at;
  });
  const [follow, setFollow] = createSignal(true);
  let list!: HTMLOListElement;
  createEffect(() => {
    const k = current();
    if (!follow() || !k) return;
    const row = list?.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: untrack(p.playing) ? "smooth" : "auto" });
  });
  createEffect(() => {
    if (p.playing()) setFollow(true);
  });
  const userScrolled = () => setFollow(false);
  // A ticked event the new timeline doesn't have is dropped.
  createEffect(() => {
    const keys = new Set(all().map(eventKey));
    const kept = [...untrack(picked)].filter((k) => keys.has(k));
    if (kept.length !== untrack(picked).size) setPicked(new Set(kept));
  });

  /** The search keeps at most its bytes (`maxLength` counts UTF-16 units): the box shows what
   * was kept, so typing stops at the limit and what a follower sees is what you see. */
  const typed = (el: HTMLInputElement) => {
    p.setQuery(el.value);
    const kept = untrack(query);
    if (el.value !== kept) el.value = kept;
  };

  return (
    <div class="pl-events" data-testid="events">
      <div class="pl-events-head">
        <input class="input" data-testid="events-search" placeholder={p.queryHidden?.() ? "Filtered" : "Search"} aria-label="Search events" maxLength={VIEW_STATE["events.search"].max} value={p.queryHidden?.() ? "" : query()} onInput={(e) => typed(e.currentTarget)} />
        <Show when={p.queryHidden?.()}>
          <button type="button" class="btn ghost small" data-testid="events-search-clear" title="Clear" aria-label="Clear" onClick={() => p.setQuery("")}>
            ×
          </button>
        </Show>
        <label class="pl-lead" title="Lead">
          −
          <input type="number" min="0" max="60" data-testid="events-lead" aria-label="Lead seconds" value={lead()} onInput={(e) => setLead(Math.max(0, Math.min(60, Number(e.currentTarget.value) || 0)))} />s
        </label>
      </div>
      <div class="pl-chips">
        <For each={present()}>
          {(g) => (
            <button type="button" class={cx("pl-chip", on().has(g.id) && "on")} data-testid={`chip-${g.id}`} aria-pressed={on().has(g.id)} onClick={() => p.setFilter(g.id, !on().has(g.id))}>
              {g.label}
            </button>
          )}
        </For>
      </div>
      <Show when={!follow() && current()}>
        <button type="button" class="pl-chip on pl-now" data-testid="events-now" onClick={() => setFollow(true)}>
          ↓ Now
        </button>
      </Show>
      {/* ↑ ↓ aren't a scroll here: they step through the events (Player.tsx). */}
      <ol class="pl-list" ref={list} onWheel={userScrolled} onTouchMove={userScrolled} onKeyDown={(e) => ["PageUp", "PageDown", "Home", "End"].includes(e.key) && userScrolled()}>
        <For each={shown()} fallback={<li class="pl-empty">No events</li>}>
          {(e) => {
            const i = eventKey(e);
            const start = eventStart(p.tl, e);
            return (
              <li class={cx("pl-ev", groupOf(e), e.team ?? "", current() === i && "now")} data-testid="event" data-kind={e.kind} data-t={e.t} data-start={start < e.t ? start : undefined} data-key={i} data-current={current() === i ? "true" : undefined} aria-current={current() === i ? "true" : undefined}>
                <Show when={p.canSave}>
                  <input type="checkbox" aria-label="Select" data-testid="event-pick" checked={picked().has(i)} onChange={() => setPicked(toggle(picked(), i))} />
                </Show>
                <Hover tip={() => tipId(e) != null && <GameTip id={tipId(e)!} art={p.art} tips={tips()!} />}>
                <button type="button" class="pl-ev-go" data-testid="event-jump" onClick={() => p.onJump(e, lead())}>
                  <span class="pl-ev-t">{clockLabel(e.t)}</span>
                  <span class="pl-ev-label">
                    <For each={labelParts(e, p.names)}>{(x) => (x.muted ? <span class="pl-ev-name">{x.text}</span> : x.text)}</For>
                  </span>
                </button>
                </Hover>
                <Show when={recapFor(p.tl, e)}>{recap => {
                  // Open or closed with the host, so a follower opens the one its presenter does.
                  const death = { slot: slotKey(e.team ?? "", e.slot ?? 0), t: e.t };
                  // A death has no start (its recap has no per-hit times), so its jump is its own
                  // second and this lead is measured from `e.t`.
                  return <DeathRecap recap={recap()} timeline={p.tl} art={p.art} open={p.recapOpen?.(death)} onToggle={(o) => p.onRecap?.(death, o)} onSeek={t => p.onJump(e, e.t - t)} />;
                }}</Show>
              </li>
            );
          }}
        </For>
      </ol>
      <Show when={p.canSave && picked().size > 0}>
        <div class="pl-events-foot">
          <button
            class="btn primary small"
            type="button"
            data-testid="events-save"
            onClick={() => {
              // Only what was saved is unticked; anything refused stays ticked to retry.
              const saved = p.onSave(chosen(), lead());
              setPicked(new Set([...picked()].filter((k) => !saved.has(k))));
            }}
          >
            Save scenes ({picked().size})
          </button>
          <button class="btn ghost small" type="button" onClick={() => setPicked(new Set<string>())}>
            Clear
          </button>
        </div>
      </Show>
    </div>
  );
}
