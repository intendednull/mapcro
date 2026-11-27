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
import { rosterTeamName } from "../map/model";
import type { Art, Hero } from "../map/pack";
import { type RejuvNow, clockLabel } from "../match/timeline";
import { rejuvTip, respawnTip } from "../player/Camps";
import { Hover, TagTip } from "../player/GameTooltip";
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
    /** Camera is currently tracking this hero. */
    tracked?: boolean | undefined;
    class?: string | false;
    /** The souls tab (`.tb-souls`): a button in Player, an editor in a scene. */
    souls: JSX.Element;
    children?: JSX.Element;
  } & Omit<JSX.HTMLAttributes<HTMLDivElement>, "class" | "children">,
) {
  const [p, rest] = splitProps(props, ["team", "side", "roster", "art", "hero", "dead", "unseen", "low", "tracked", "class", "souls", "children"]);
  return (
    <div
      {...rest}
      class={cx("tb-player", p.team.toLowerCase(), p.side, hasCard(p.art, p.hero) && "card-art", p.dead && "dead", p.unseen && "unseen", p.low && "health-low", p.tracked && "tracked", p.class)}
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

/** The Rejuvenator's natural length (crates/replay REJUV_S): its timer drains over it. */
const REJUV_S = 180;
/** The most revives the game draws (team_rejuv_1..4, .RejuvCount_1..4). */
const REJUV_MAX = 4;

/** Without the pack: a drawn stand-in for the game's winged mark (hud/icons/rejuvenator). */
const WING = "M10 0a2 2 0 1 1 0 4a2 2 0 1 1 0-4ZM0 5.5h5c1 2.2 3 3.4 5 3.4s4-1.2 5-3.4h5c0 1.6-1 2.6-3 2.6c-2 2.2-3.6 3.4-5 4l-1.4 8.4h-1.2L9 12.1c-1.4-.6-3-1.8-5-4c-2 0-3-1-3-2.6Z";
const wingsFb = (n: number) => {
  // The game's arrangement (team_rejuv_N): a shallow V, the inner marks lower.
  const xs = Array.from({ length: n }, (_, i) => 57.5 + (i - (n - 1) / 2) * 30);
  const marks = xs.map((x, i) => `<path transform="translate(${x - 14} ${Math.abs(i - (n - 1) / 2) < 1 ? 26 : 10}) scale(1.4)" d="${WING}" fill="#FFCC00"/>`);
  return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 115 65">${marks.join("")}</svg>`);
};

/**
 * A team's Rejuvenator under its souls, as the game draws it (#RejuvenatorFriendly / #RejuvenatorEnemy):
 * one gold winged mark per revive left, the game's image for that count, and no text. A change of
 * count crossfades (spec §4a); the data attributes and label keep the exact values.
 */
export function RejuvBadge(p: { held: () => RejuvNow | undefined; team: Team; side: Side; art: Art }) {
  const left = () => Math.min(REJUV_MAX, p.held()?.left ?? 0);
  return (
    <div
      class={cx("pl-rejuv", p.side, p.team.toLowerCase())}
      data-testid="tb-rejuv"
      data-team={p.team.toLowerCase()}
      data-left={left()}
      role={left() ? "img" : undefined}
      aria-label={left() ? `${rosterTeamName(p.team)} Rejuvenator, ${left()} revive${left() === 1 ? "" : "s"}` : undefined}
      title={left() ? `${rosterTeamName(p.team)} Rejuvenator` : undefined}
    >
      {Array.from({ length: REJUV_MAX }, (_, i) => (
        <img class={cx("pl-rejuv-icons", left() === i + 1 && "on")} data-n={i + 1} src={p.art.images.get(`rejuv-${i + 1}`) ?? wingsFb(i + 1)} alt="" />
      ))}
    </div>
  );
}

/**
 * The buff's natural end, as the game's #RejuvenatorTimer shows it: the winged mark on a dark disc,
 * ringed by an arc that drains from pickup (`held().taken`) to 180 s later. No text on it; its
 * hover says the time left ("Archmother Rejuvenator ends in 1:40", feedback #44), at once like the
 * panel's tags. Gone when the buff is (expired, or its revives spent), and with it the hover.
 * Beside the other's when both hold one.
 */
export function RejuvTimer(p: { held: () => RejuvNow | undefined; both: () => boolean; t: () => number; team: Team; side: Side; art: Art }) {
  const on = () => (p.held()?.left ?? 0) > 0;
  const frac = () => (on() ? Math.max(0, Math.min(1, (p.held()!.taken + REJUV_S - p.t()) / REJUV_S)) : 0);
  const img = () => p.art.images.get("rejuv-timer");
  const tip = () => (on() ? rejuvTip(p.held()!, p.t()) : undefined);
  return (
    <Hover tip={() => tip() && <TagTip text={tip()!} />}>
      <div class={cx("pl-rejuv-timer", p.side, p.team.toLowerCase(), on() && "on", p.both() && "both")} data-testid="tb-rejuv-timer" data-team={p.team.toLowerCase()} data-frac={frac().toFixed(3)} role={tip() ? "img" : undefined} aria-label={tip()} aria-hidden={tip() ? undefined : "true"}>
        <svg viewBox="0 0 30 30">
          <circle class="pl-rejuv-disc" cx="15" cy="15" r="13.5" />
          <Show when={img()} fallback={<path class="pl-rejuv-mark" transform="translate(6 6.5) scale(0.9)" d={WING} />}>
            <image class="pl-rejuv-mark" href={img()} x="3" y="3" width="24" height="24" />
          </Show>
          <circle class="pl-rejuv-track" cx="15" cy="15" r="13.5" />
          {/* 0..100 so only time eases, as the ult rings do. */}
          <circle class="pl-rejuv-ring" cx="15" cy="15" r="13.5" transform="rotate(-90 15 15)" pathLength="100" style={{ "stroke-dasharray": `${(frac() * 100).toFixed(2)} 100` }} />
        </svg>
      </div>
    </Hover>
  );
}

/**
 * The same centre circle while no team holds a Rejuvenator and the Mid-Boss is dead, as the game's
 * `#RejuvenatorTimer.midboss_cooldown` draws it: the mark greyed (`saturation: 0`, opacity 0.3),
 * the border at 0.15, no sweep, and under it `.midbossTimerLabel`, the respawn's m:ss (10 px, bold,
 * offWhite at 0.3). Its hover says it: "Mid-Boss respawns in 4:40". Up, it's gone
 * (`.midboss_available`).
 */
export function RespawnTimer(p: { at: () => number | undefined; t: () => number; art: Art }) {
  const img = () => p.art.images.get("rejuv-timer");
  const left = () => (p.at() != null ? clockLabel(Math.max(0, Math.ceil(p.at()! - p.t()))) : "");
  const tip = () => (p.at() != null ? respawnTip(p.at()!, p.t()) : undefined);
  return (
    <Hover tip={() => tip() && <TagTip text={tip()!} />}>
      <div class={cx("pl-rejuv-timer", "pl-respawn-timer", p.at() != null && "on")} data-testid="tb-respawn-timer" role={tip() ? "img" : undefined} aria-label={tip()} aria-hidden={tip() ? undefined : "true"}>
        <svg viewBox="0 0 30 30">
          <circle class="pl-rejuv-disc" cx="15" cy="15" r="13.5" />
          <Show when={img()} fallback={<path class="pl-rejuv-mark" transform="translate(6 6.5) scale(0.9)" d={WING} />}>
            <image class="pl-rejuv-mark" href={img()} x="3" y="3" width="24" height="24" />
          </Show>
          <circle class="pl-rejuv-track" cx="15" cy="15" r="13.5" />
        </svg>
        <span class="pl-respawn-label" data-testid="tb-respawn-label">{left()}</span>
      </div>
    </Hover>
  );
}
