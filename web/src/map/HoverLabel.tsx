// The map's hover label (operator, 2026-11-08: "a label should pop up with the info, just like
// how a label instantly pops up when a neutral camp is hovered"): one look and one behaviour for
// every hovered map thing, hero tokens and markers alike, shown at once and gone on leave.
//
// What's hovered is a reference (a marker's key, or a token's roster slot), never a position or
// a text: each thing registers how to find itself and what to say, from this browser's own
// state. So a follower can show the presenter's hover (spec §8) from the key alone, worded by
// its own playback time and its own Names toggle.

import { Show, createMemo, createSignal } from "solid-js";
import { cx } from "../ui/cx";

/** A hovered thing: a marker by key, or a token by roster slot ("Amber-2"), with an optional
 * part of it (a token's vision eye, `vis`, or its kill toggle, `life`). */
export interface HoverRef {
  kind: "marker" | "token";
  id: string;
  part?: string | undefined;
}

/** Where a label goes (view units, the overlay's) and what it says. `gap`: from the thing's
 * centre to the label's baseline, above it. */
export interface HoverSpot {
  x: number;
  y: number;
  gap: number;
  text: string;
}

type Resolver = (part: string | undefined) => HoverSpot | undefined;

const resolvers = new Map<string, Resolver>();
const [version, setVersion] = createSignal(0);
const refKey = (kind: HoverRef["kind"], id: string) => `${kind}:${id}`;

/** Make a thing hoverable; the returned function forgets it. */
export function registerHover(kind: HoverRef["kind"], id: string, r: Resolver): () => void {
  const k = refKey(kind, id);
  resolvers.set(k, r);
  setVersion((v) => v + 1);
  return () => {
    if (resolvers.get(k) !== r) return;
    resolvers.delete(k);
    setVersion((v) => v + 1);
  };
}

function resolve(r: HoverRef): HoverSpot | undefined {
  version();
  return resolvers.get(refKey(r.kind, r.id))?.(r.part);
}

const same = (a: HoverRef | undefined, b: HoverRef | undefined) => a?.kind === b?.kind && a?.id === b?.id && a?.part === b?.part;
// A token is drawn over the markers, so its hover wins.
const [token, setToken] = createSignal<HoverRef | undefined>(undefined, { equals: same });
const [marker, setMarker] = createSignal<HoverRef | undefined>(undefined, { equals: same });
// A unit moving on the map (a rift trooper): its own channel, so the markers' hit test, which
// clears theirs off a marker, never clears it.
const [unit, setUnit] = createSignal<HoverRef | undefined>(undefined, { equals: same });
// Last: a handle drawn over the map, the wave's, which sits on the lane where a rift can be.
const [handle, setHandle] = createSignal<HoverRef | undefined>(undefined, { equals: same });
export const hoverToken = (r: HoverRef | undefined) => setToken(r);
export const hoverMarker = (r: HoverRef | undefined) => setMarker(r);
export const hoverHandle = (r: HoverRef | undefined) => setHandle(r);
/** A unit's hover, sent as a marker (`marker:<key>`), so a follower resolves it by its key. */
export const hoverUnit = (r: HoverRef | undefined) => setUnit(r);
/** The token hovered, resolved or not (a token clears its own). */
export const hoveredToken = token;
/** The handle hovered, resolved or not (a handle clears its own). */
export const hoveredHandle = handle;
/** What this browser hovers now, if anything: the first hovered thing that's on the map, so one
 * that's gone (a dead hero's token) never hides the marker under the pointer. */
export const localHover = () => [token(), marker(), unit(), handle()].find((r) => r && resolve(r));

/** The presenter's hover a follower mirrors, tagged with who it is. */
export interface RemoteHover {
  ref: HoverRef;
  name: string;
  color: string;
}
const [remote, setRemote] = createSignal<RemoteHover | undefined>(undefined, { equals: (a, b) => same(a?.ref, b?.ref) && a?.name === b?.name && a?.color === b?.color });
export const setRemoteHover = (r: RemoteHover | undefined) => setRemote(r);

/** For presence: `marker:<key>` or `token:<slot>[:part]`. */
export function hoverWire(r: HoverRef | undefined): string | null {
  return r ? [r.kind, r.id, ...(r.part ? [r.part] : [])].join(":").slice(0, 96) : null;
}

export function hoverFromWire(s: string | null | undefined): HoverRef | undefined {
  if (!s) return undefined;
  const i = s.indexOf(":");
  const kind = s.slice(0, i);
  const rest = s.slice(i + 1);
  if (kind === "marker" && rest) return { kind, id: rest };
  if (kind !== "token" || !rest) return undefined;
  const [id = "", part] = rest.split(":");
  return id ? { kind, id, part: part === "vis" || part === "life" ? part : undefined } : undefined;
}

/** The label itself, drawn over everything on the map. `k`: the markers' scale for zoom. */
export function HoverLabels(p: { k: number }) {
  const shown = createMemo(() => {
    const l = localHover();
    const ls = l && resolve(l);
    // An empty text: the thing is there, with nothing to say (a camp that's up): no label.
    if (l && ls) return ls.text ? { ref: l, spot: ls, by: undefined } : undefined;
    const r = remote();
    const rs = r && resolve(r.ref);
    return r && rs?.text ? { ref: r.ref, spot: rs, by: r } : undefined;
  });
  return (
    <g class="hover-labels">
      <Show when={shown()}>
        {(x) => {
          const size = () => 24 * p.k;
          const y = () => Math.max(size() * 1.1, x().spot.y - x().spot.gap);
          // A pill behind the text, sized by its length (no layout read); room for the chip.
          const chip = () => (x().by ? size() * 0.9 : 0);
          const w = () => x().spot.text.length * size() * 0.56 + size() + chip();
          // Kept inside the map's box, which clips what's drawn past it.
          const left = () => Math.max(0, Math.min(1000 - w(), x().spot.x - w() / 2));
          return (
            <g
              class={cx("hover-label", x().by && "theirs")}
              data-testid="hover-label"
              data-kind={x().ref.kind}
              data-key={x().ref.id}
              data-part={x().ref.part}
              data-by={x().by?.name}
              role="tooltip"
              style={x().by ? { "--by": x().by!.color } : undefined}
            >
              <rect x={left()} y={y() - size() * 1.05} width={w()} height={size() * 1.45} rx={size() * 0.4} />
              <Show when={x().by}>
                <circle class="hover-by" cx={left() + size() * 0.75} cy={y() - size() * 0.33} r={size() * 0.26} />
              </Show>
              <text x={left() + w() / 2 + chip() / 2} y={y()} font-size={String(size())}>
                {x().spot.text}
              </text>
            </g>
          );
        }}
      </Show>
    </g>
  );
}
