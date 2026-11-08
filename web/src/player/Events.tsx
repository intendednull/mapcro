// Player's events list (spec §6b): search, filter chips, jump with a lead, and multi-select to
// save one scene per event. Labels only.

import { For, Show, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { cx } from "../ui/cx";
import { type MatchEvent, type Timeline, clockLabel } from "../match/timeline";
import { type EventGroup, GROUPS, type Named, eventKey, groupOf, label, search } from "./events";

export function EventsList(p: {
  tl: Timeline;
  names: Named;
  tier: string;
  canSave: boolean;
  onJump: (e: MatchEvent, lead: number) => void;
  /** Saves the events' scenes; resolves to the keys of the events whose scenes were made. */
  onSave: (events: MatchEvent[], lead: number) => Set<string>;
}) {
  const [query, setQuery] = createSignal("");
  const [on, setOn] = createSignal(new Set<EventGroup>());
  const [lead, setLead] = createSignal(5);
  // Ticked events by a stable key, not a position: a replay arriving reorders the list.
  const [picked, setPicked] = createSignal(new Set<string>());
  const all = createMemo(() => p.tl.events ?? []);
  const shown = createMemo(() => search(all(), p.names, query(), on()));
  const present = createMemo(() => GROUPS.filter((g) => all().some((e) => groupOf(e) === g.id)));
  const toggle = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set);
    if (!n.delete(v)) n.add(v);
    return n;
  };
  const chosen = () => all().filter((e) => picked().has(eventKey(e)));
  // A ticked event the new timeline doesn't have is dropped.
  createEffect(() => {
    const keys = new Set(all().map(eventKey));
    const kept = [...untrack(picked)].filter((k) => keys.has(k));
    if (kept.length !== untrack(picked).size) setPicked(new Set(kept));
  });

  return (
    <div class="pl-events" data-testid="events">
      <div class="pl-events-head">
        <input class="input" data-testid="events-search" placeholder="Search" aria-label="Search events" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        <label class="pl-lead" title="Jump this many seconds before the event">
          −
          <input type="number" min="0" max="60" data-testid="events-lead" aria-label="Lead seconds" value={lead()} onInput={(e) => setLead(Math.max(0, Math.min(60, Number(e.currentTarget.value) || 0)))} />s
        </label>
      </div>
      <div class="pl-chips">
        <For each={present()}>
          {(g) => (
            <button type="button" class={cx("pl-chip", on().has(g.id) && "on")} data-testid={`chip-${g.id}`} aria-pressed={on().has(g.id)} onClick={() => setOn(toggle(on(), g.id))}>
              {g.label}
            </button>
          )}
        </For>
      </div>
      <ol class="pl-list">
        <For each={shown()} fallback={<li class="pl-empty">No events</li>}>
          {(e) => {
            const i = eventKey(e);
            return (
              <li class={cx("pl-ev", groupOf(e), e.team ?? "")} data-testid="event" data-kind={e.kind} data-t={e.t}>
                <Show when={p.canSave}>
                  <input type="checkbox" aria-label="Select" data-testid="event-pick" checked={picked().has(i)} onChange={() => setPicked(toggle(picked(), i))} />
                </Show>
                <button type="button" class="pl-ev-go" data-testid="event-jump" onClick={() => p.onJump(e, lead())}>
                  <span class="pl-ev-t">{clockLabel(e.t)}</span>
                  <span class="pl-ev-label">{label(e, p.names)}</span>
                  <span class="pl-ev-tier">{p.tier}</span>
                </button>
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
