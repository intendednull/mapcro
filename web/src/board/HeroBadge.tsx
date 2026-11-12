// A top-bar portrait, shared by the board's bar (TopBar.tsx) and Player's (PlayerTopBar.tsx).
// With the pack's hero card it is the HUD's hero badge (CitadelHeroBadge.TopBar,
// hero_badge.vcss): the card (heroes.vdata m_strIconHeroCard, 280×380) under hero_image_mask on
// a team-coloured disc, and at low health the critical card in the same frame. A pack without
// cards keeps the older vertical bust (m_strTopBarVertical). Styles: styles/topbar.css.

import { Show, createMemo } from "solid-js";
import { cx } from "../ui/cx";
import type { Art, Hero } from "../map/pack";
import type { Slot } from "./state";
import { initials } from "./Tokens";

/**
 * The badge takes the hero badge's frame: the hero has a card, or (no hero yet) the pack has
 * cards, so an empty slot lines up with its neighbours. The `.tb-player` takes `card-art` too, so
 * its siblings (the respawn countdown, the pick button) follow the badge's disc.
 */
export function hasCard(art: Art, hero: Hero | undefined): boolean {
  if (hero) return !!hero.card;
  for (const h of art.heroes.values()) if (h.card) return true;
  return false;
}

export function HeroBadge(p: { art: Art; slot: Slot["slot"]; hero: Hero | undefined; low?: boolean }) {
  const url = (src: string) => ({ "background-image": `url(${JSON.stringify(src)})` });
  /** The critical card at low health, when the pack has it. */
  const critical = () => (p.low ? p.hero?.critical : undefined);
  // Written only when it changes. A lone dynamic `class` sets the attribute every time its
  // inputs re-run (each sample of playback), and each write, same value or not, restyles the
  // disc and re-checks the stage's `:has()` rules (#39).
  const cls = createMemo(() => cx("tb-badge", hasCard(p.art, p.hero) && "card-badge", !!p.hero?.card && "has-card"));
  return (
    <div class={cls()}>
      <i class="tb-disc">{initials(p.slot, p.hero?.name)}</i>
      <Show
        when={p.hero?.card}
        fallback={
          <Show when={critical()} fallback={<Show when={p.hero?.topbar}>{(src) => <i class="tb-img hero-vertical" data-art="topbar" style={url(src())} />}</Show>}>
            {(src) => <i class="tb-img hero-critical" data-art="critical" style={url(src())} />}
          </Show>
        }
      >
        {/* One element in one frame: low health only swaps the image. */}
        <i class="tb-img hero-card" data-art={critical() ? "critical" : "card"} style={url(critical() ?? p.hero?.card ?? "")} />
      </Show>
    </div>
  );
}
