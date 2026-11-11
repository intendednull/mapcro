// The in-game top bar's parts, shared by the scene's bar (TopBar.tsx, edited in place) and
// Player's (player/PlayerTopBar.tsx, read from the match at t), so the two look the same and a
// change is made once. Each bar passes in its own bits: the scene its editors, the hero menu and
// the picker; Player its build columns, health, vision and death state. Styles: styles/topbar.css.
//
// Names follow the game's rule in both (operator, 2026-11-10): never under the bar. A slot's name
// leads its portrait's hover label (`title`); Player shows it again in the expanded (Tab)
// columns. The scene's name editor ("Rename…") opens in place under the portrait while it is open.

import { type JSX, Show, createSignal, onCleanup, onMount, splitProps } from "solid-js";
import { cx } from "../ui/cx";
import { formatSouls } from "../core/souls";
import type { Art, Hero } from "../map/pack";
import { HeroBadge, hasCard } from "./HeroBadge";
import type { Slot } from "./state";

/** The bar's width in Panorama px (citadel_hud_top_bar.vcss): `--u` is the host's width over it. */
export const BAR = 1260;

export type Team = "Amber" | "Sapphire";
export type Side = "friend" | "enemy";

/** Souls as the HUD writes them: "9.0k", the k demoted. */
export function Souls(p: { n: number | null }) {
  const f = () => formatSouls(p.n);
  return (
    <>
      {f().value}
      <Show when={f().k}>
        <span class="demote">k</span>
      </Show>
    </>
  );
}

/** A portrait's hover label: the slot's label (its name, else "King 1"), then the hero. */
export const portraitTitle = (label: string, hero: Hero | undefined) => `${label}${hero ? `, ${hero.name}` : ""}`;

/**
 * The bar's frame: the host that measures its unit, the two team columns and the centre (clock,
 * scores, and whatever the mode adds). `overlay` renders before the bar (the scene's hero menu).
 */
export function TopBarFrame(p: {
  ref?: (el: HTMLDivElement) => void;
  art: Art;
  compact?: boolean | undefined;
  class?: string | false;
  mode?: string;
  overlay?: JSX.Element;
  friend: JSX.Element;
  enemy: JSX.Element;
  children: JSX.Element;
}) {
  let host!: HTMLDivElement;
  const [unit, setUnit] = createSignal(1);
  onMount(() => {
    // Measure now, not only when the observer first fires: the bar's height follows its unit,
    // and a late first measurement moved the map under people's pointers by ~34 px (journal).
    setUnit(host.clientWidth / BAR || 1);
    const ro = new ResizeObserver(() => setUnit(host.clientWidth / BAR));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });
  return (
    <div
      ref={(el) => ((host = el), p.ref?.(el))}
      class={cx("tb-host", p.class, p.art.images.has("tb-mask") && "pack-art", p.compact && "compact")}
      style={{ "--u": `${unit()}px` }}
      data-testid="topbar"
      data-mode={p.mode}
    >
      {p.overlay}
      <div class="tb-bar">
        {p.friend}
        {p.enemy}
        <div class="tb-center">{p.children}</div>
      </div>
    </div>
  );
}

/** A team's six portraits, friendly on the left. */
export function TeamColumn(p: { team: Team; side: Side; children: JSX.Element }) {
  return <div class={`tb-team ${p.side} ${p.team.toLowerCase()}`}>{p.children}</div>;
}

/**
 * One portrait slot (CitadelHudTopBarPlayer): the souls tab, the hero badge, and the mode's own
 * parts after them (`children`). Other attributes (data-*, handlers) go on the slot's element.
 */
export function PortraitSlot(
  props: {
    team: Team;
    side: Side;
    roster: Slot["slot"];
    art: Art;
    hero: Hero | undefined;
    dead: boolean;
    unseen: boolean;
    /** Low health: the badge takes the critical card. */
    low?: boolean | undefined;
    class?: string | false;
    /** The souls tab (`.tb-souls`): a button in Player, an editor in a scene. */
    souls: JSX.Element;
    children?: JSX.Element;
  } & Omit<JSX.HTMLAttributes<HTMLDivElement>, "class" | "children">,
) {
  const [p, rest] = splitProps(props, ["team", "side", "roster", "art", "hero", "dead", "unseen", "low", "class", "souls", "children"]);
  return (
    <div
      {...rest}
      class={cx("tb-player", p.team.toLowerCase(), p.side, hasCard(p.art, p.hero) && "card-art", p.dead && "dead", p.unseen && "unseen", p.low && "health-low", p.class)}
      data-slot={`${p.team}-${p.roster.slot}`}
    >
      {p.souls}
      <HeroBadge art={p.art} slot={p.roster} hero={p.hero} low={!!p.low} />
      {p.children}
    </div>
  );
}

/** The vision mark's eye: struck through when the hero isn't seen. */
export function EyeIcon(p: { off: boolean }) {
  return (
    <svg viewBox="-8 -8 16 16" aria-hidden="true">
      <path d="M-6 0s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4z" />
      <Show when={p.off} fallback={<circle r="1.8" />}>
        <path d="M-6 6L6 -6" />
      </Show>
    </svg>
  );
}

/**
 * The ult ring (.UltimateStatus): `left` is the cooldown left in percent, 0 ready, null untracked.
 * Read-only as is; the scene's ring passes its pointer and wheel handlers and its handle.
 */
export function UltDial(p: {
  left: number | null;
  label: string;
  adjusting?: boolean;
  editable?: boolean;
  /** No native title: a richer hover (Player's ult tooltip) stands in. */
  untitled?: boolean;
  ref?: (el: HTMLDivElement) => void;
  onPointerDown?: (e: PointerEvent) => void;
  onWheel?: (e: WheelEvent) => void;
  children?: JSX.Element;
}) {
  const u = () => p.left;
  return (
    <div
      ref={p.ref}
      class={cx("tb-ult", u() == null && "untracked", u() != null && u()! <= 0 && "ready", u() != null && u()! > 0 && "cooldown", p.adjusting && "adjusting")}
      style={u() != null && u()! > 0 ? { "--left": `${Math.min(100, u()!)}%` } : {}}
      data-testid="ult"
      data-ult={u() == null ? "untracked" : String(u())}
      role={p.editable ? "slider" : undefined}
      aria-label={`${p.label} ult cooldown`}
      aria-valuemin={p.editable ? 0 : undefined}
      aria-valuemax={p.editable ? 100 : undefined}
      aria-valuenow={p.editable ? (u() ?? undefined) : undefined}
      title={p.untitled ? undefined : u() == null ? "Ult: untracked" : u()! <= 0 ? "Ult ready" : `Ult ${Math.round(u()!)}%`}
      onPointerDown={p.onPointerDown}
      onWheel={p.onWheel}
    >
      <i class="tb-ult-bg" />
      <i class="tb-ult-icon" />
      <i class="tb-ult-sweep" />
      <i class="tb-ult-fb" />
      {p.children}
    </div>
  );
}

/** The game clock (.GameClock); its label is the mode's: the time at t, or the scene's editor. */
export function BarClock(p: { children: JSX.Element }) {
  return <div class="tb-clock">{p.children}</div>;
}

/**
 * A team's souls total (.TeamScore), the team icon on the bar's centre side. `label` is the total
 * (`.tb-score-label`): a number in Player, an editor in a scene; `children` go after the row.
 */
export function TeamScore(
  props: { team: Team; right: boolean; class?: string | false; label: JSX.Element; children?: JSX.Element } & Omit<JSX.HTMLAttributes<HTMLDivElement>, "class" | "children">,
) {
  const [p, rest] = splitProps(props, ["team", "right", "class", "label", "children"]);
  return (
    <div {...rest} class={cx("tb-score", p.team.toLowerCase(), p.right && "right", p.class)} data-testid={`total-${p.team}`}>
      <i class="tb-score-bg" />
      <div class="tb-score-row">
        <Show when={p.right}>
          <i class="tb-team-icon" />
        </Show>
        {p.label}
        <Show when={!p.right}>
          <i class="tb-team-icon" />
        </Show>
      </div>
      {p.children}
    </div>
  );
}
