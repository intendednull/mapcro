// The view-state store (spec §8 "Follow mode"): one value per key of the registry
// (crates/engine/src/view_state.rs, generated into gen/viewState.ts), with what following does
// to it read from the key's row, not written per feature. A key has your own value and, while
// you follow, maybe the presenter's; `get` is what the screen shows.
//
// To add view state: add a row to the registry, run `just ts`, give it a first value where the
// store is made (host.ts), and read and write it with `get` and `set`. Presence, the follower's
// mirror, the restore on stopping and the tests (test/view-state.test.ts) come from the row.

import { type Accessor, type Setter, batch, createSignal, untrack } from "solid-js";
import { VIEW_STATE, type ViewKey } from "../gen/viewState";

export const VIEW_KEYS = Object.keys(VIEW_STATE) as ViewKey[];
/** The presence fields the registry's keys travel in. */
export type ViewField = NonNullable<(typeof VIEW_STATE)[ViewKey]["field"]>;
/** The integer fields, one bit per key. */
export type BitField = Extract<(typeof VIEW_STATE)[ViewKey], { mask: number }>["field"];
/** The keys sent as a boolean field of their own. */
export type FlagKey = { [K in ViewKey]: (typeof VIEW_STATE)[K] extends { sync: "shared"; mask: null } ? K : never }[ViewKey];

const inField = (field: ViewField) => VIEW_KEYS.filter((k) => VIEW_STATE[k].field === field);

export interface ViewState {
  /** What the screen shows: the presenter's while you follow one who sends it, else your own. */
  get(k: ViewKey): boolean;
  /**
   * Your own choice. A `stop` key is a change to what you see: its wire field's keys keep what
   * the screen shows now (a presenter's) with this one change, and the caller stops the follow
   * (`stops(k)`). A `local` key is yours until the presenter's next change.
   */
  set(k: ViewKey, on: boolean): void;
  /** Whether your own change to `k` stops a follow (spec §8: "a change to what you see"). */
  stops(k: ViewKey): boolean;
  /** What presence's integer `field` says: the shown value of each of its keys, a bit each. */
  bits(field: BitField): number;
  /** A followed presenter's `field` (absent: an older client, and yours stay). Unknown bits are ignored. */
  mirrorBits(field: BitField, n: number | null | undefined): void;
  /** A followed presenter's value for a key that is a field of its own. */
  mirrorFlag(k: FlagKey, on: boolean): void;
  /** Following stopped: `restore` keys show your own again; `keep` keys stay. */
  forget(): void;
}

/**
 * `first`: each key's value to start with (a default, or what this browser remembers).
 * `onOwn`: your own value of a key changed (to remember it); not called for a presenter's.
 */
export function createViewState(first: Record<ViewKey, boolean>, onOwn?: (k: ViewKey, on: boolean) => void): ViewState {
  const cells = {} as Record<ViewKey, { own: Accessor<boolean>; setOwn: Setter<boolean>; theirs: Accessor<boolean | undefined>; setTheirs: Setter<boolean | undefined> }>;
  for (const k of VIEW_KEYS) {
    const [own, setOwn] = createSignal(first[k]);
    const [theirs, setTheirs] = createSignal<boolean | undefined>();
    cells[k] = { own, setOwn, theirs, setTheirs };
  }
  const get = (k: ViewKey) => cells[k].theirs() ?? cells[k].own();
  const setOwn = (k: ViewKey, on: boolean) => {
    cells[k].setOwn(on);
    onOwn?.(k, on);
  };
  /** A presenter's value: beside your own if it comes back on stopping, else in its place. */
  const mirror = (k: ViewKey, on: boolean | undefined) => {
    const d = VIEW_STATE[k];
    if (d.sync !== "shared") return;
    if (d.unfollow === "restore") cells[k].setTheirs(on);
    else if (on !== undefined) cells[k].setOwn(on);
  };
  return {
    get,
    set: (k, on) =>
      batch(() => {
        const d = VIEW_STATE[k];
        if (d.override !== "stop" || !d.field) return setOwn(k, on);
        for (const j of inField(d.field)) if (VIEW_STATE[j].override === "stop") setOwn(j, j === k ? on : untrack(() => get(j)));
      }),
    stops: (k) => VIEW_STATE[k].override === "stop",
    bits: (field) => inField(field).reduce((n, k) => (get(k) ? n | (VIEW_STATE[k].mask ?? 0) : n), 0),
    mirrorBits: (field, n) => batch(() => inField(field).forEach((k) => mirror(k, n == null ? undefined : (n & (VIEW_STATE[k].mask ?? 0)) !== 0))),
    mirrorFlag: (k, on) => mirror(k, on),
    forget: () => batch(() => VIEW_KEYS.forEach((k) => cells[k].setTheirs(undefined))),
  };
}
