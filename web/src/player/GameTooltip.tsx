// The game's item and ability tooltips (docs/plans/2026-11-10-game-tooltips.md, spec §6b
// "Tooltips"), ported from its own layouts and styles in the pack: an item's
// `citadel_tooltip_mod_details.vcss` (category backer, header, innate stats, Passive/Active
// sections with their cooldown, property cards, "Upgrades From/To"), an ability's
// `citadel_ability_details_panel.vcss` / `citadel_ability_property_panel.vcss` (header cooldown,
// description, property cards with the spirit scale, rows, the three upgrade tiers). The words
// and numbers are the game's (match/tooltips.ts); `Hover` shows one beside what it's about.

import { For, type JSX, Show, createEffect, createResource, createRoot, createSelector, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import type { Art, BuildRecord } from "../map/pack";
import { TIER_COSTS, type MarkupNode, type TipIcon, type TipProp, type TipValues, type Tooltips, blockShown, loadTooltips, parseMarkup, shown, substitute, upgraded, upgradesTo } from "../match/tooltips";
import { cx } from "../ui/cx";

/** The pack's tooltips for a replay build (its patch's values); undefined until loaded or
 * without them. */
export function useTooltips(art: () => Art, build: () => number | undefined) {
  const [tips] = createResource(() => ({ index: art().tooltips, stats: art().stats, build: build() }), ({ index, stats, build }) => loadTooltips(index, stats, build));
  return () => tips.latest;
}

/** What the replay knows about the hovered thing at t, for the values the game would show. */
export interface TipContext {
  /** An item the hero owns now ("Owned" instead of the cost). */
  owned?: boolean;
  /** An ability's upgrade tiers bought (0..3); null or absent: not known (base values). */
  tiers?: number | null;
  /** The hero's calculated spirit power: a property that scales with it shows "≈" its value. */
  spirit?: number | null;
  /** The stacks the hero holds on it now (Leech Therapy's leeches); null or absent: none. */
  stacks?: number | null | undefined;
}

const SLOT_CLASS = { weapon: "weapon", vitality: "vitality", spirit: "spirit" } as const;

export function GameTip(p: { id: number; art: Art; tips: Tooltips; ctx?: TipContext | undefined }) {
  const record = () => p.art.buildCatalog?.records.get(p.id);
  const entry = () => p.tips.tip(p.id);
  return (
    <Show when={record() && entry()}>
      <Show when={record()!.kind === "item"} fallback={<AbilityTip record={record()!} art={p.art} tips={p.tips} ctx={p.ctx} />}>
        <ItemTip record={record()!} art={p.art} tips={p.tips} ctx={p.ctx} />
      </Show>
    </Show>
  );
}

function Icon(p: { icon: TipIcon | undefined; tips: Tooltips; class?: string }) {
  const url = () => p.tips.blob(p.icon?.img);
  return (
    <Show when={url()}>
      {(u) => (
        <Show when={p.icon?.wash} fallback={<img class={cx("gt-icon", p.class)} src={u()} alt="" />}>
          {/* wash-color: the image's shape in the wash colour. */}
          <i class={cx("gt-icon gt-wash", p.class)} style={{ "background-color": p.icon!.wash, "-webkit-mask-image": `url(${JSON.stringify(u())})`, "mask-image": `url(${JSON.stringify(u())})` }} />
        </Show>
      )}
    </Show>
  );
}

/** The game's markup (match/tooltips.ts `parseMarkup`) as elements: never as HTML. */
export function Markup(p: { text: string; values: Record<string, string>; aliases?: Record<string, string> | undefined; tips: Tooltips }) {
  const nodes = () => parseMarkup(substitute(p.text, p.values, p.aliases));
  const render = (list: MarkupNode[]): JSX.Element[] =>
    list.map((n) => {
      switch (n.t) {
        case "text": return <>{n.s}</>;
        case "br": return <br />;
        case "b": return <b>{render(n.kids)}</b>;
        case "i": return <i>{render(n.kids)}</i>;
        case "span": return <span class={n.cls.map((c) => `gt-m-${c}`).join(" ")}>{render(n.kids)}</span>;
        case "icon": {
          const prop = n.cls.find((c) => c.startsWith("prop_"))?.slice(5);
          return <Icon icon={prop ? p.tips.data.icons[prop] : undefined} tips={p.tips} class="gt-inline-icon" />;
        }
        case "attr": {
          const name = p.tips.data.inline[`name:${n.name}`];
          return (
            <span class="gt-attr-inline" style={name?.color ? { color: name.color } : {}}>
              <Icon icon={p.tips.data.inline[`icon:${n.name}`]} tips={p.tips} class="gt-inline-icon" />
              {p.tips.str(`inlineattribute_${n.name.toLowerCase()}`, n.name)}
            </span>
          );
        }
        case "key": return <kbd class="gt-key">{n.name}</kbd>;
      }
    });
  return <>{render(nodes())}</>;
}

/** A value as the game writes it: prefix and postfix smaller, a calculated one with "≈". */
function Value(p: { prop: TipProp; values: TipValues; spirit?: number | null | undefined; scale?: number | undefined }) {
  const s = () => shown(p.prop, p.values, p.spirit, p.scale);
  return (
    <Show when={s()}>
      {(v) => (
        <span class={cx("gt-value", v().calc && "calc")}>
          <small>{v().prefix}</small>
          {v().value}
          <small>{v().postfix}</small>
        </span>
      )}
    </Show>
  );
}

function Card(p: { prop: TipProp; values: TipValues; tips: Tooltips; spirit?: number | null | undefined; scale?: number | undefined }) {
  const factor = () => p.scale ?? p.prop.scale?.[1];
  return (
    <Show when={shown(p.prop, p.values)}>
      <div class={cx("gt-card", p.prop.css && `prop_${p.prop.css}`, !!factor() && "scaling")} data-prop={p.prop.key}>
        <div class="gt-card-value">
          <Icon icon={p.prop.css ? p.tips.data.icons[p.prop.css] : undefined} tips={p.tips} />
          <Value prop={p.prop} values={p.values} spirit={p.spirit} scale={p.scale} />
        </div>
        <div class="gt-card-label">{p.prop.label}</div>
        <Show when={factor()}>{(f) => <span class="gt-scale" title="Spirit Power">×{String(Math.round(f() * 100) / 100)}</span>}</Show>
      </div>
    </Show>
  );
}

function Row(p: { prop: TipProp; values: TipValues; spirit?: number | null | undefined; scale?: number | undefined }) {
  return (
    <Show when={shown(p.prop, p.values)}>
      <div class={cx("gt-row", p.prop.negative && "negative")} data-prop={p.prop.key}>
        <b><Value prop={p.prop} values={p.values} spirit={p.spirit} scale={p.scale} /></b> <span>{p.prop.label}</span>
      </div>
    </Show>
  );
}

function ItemTip(p: { record: BuildRecord; art: Art; tips: Tooltips; ctx?: TipContext | undefined }) {
  const e = () => p.tips.tip(p.record.id)!;
  const slot = () => SLOT_CLASS[p.record.slot ?? "spirit"];
  const art = (name: string) => p.tips.blob(p.tips.data.art[name]);
  const backer = () => art(`tooltip_backer_${slot()}_psd`);
  const mask = () => art(`tooltip_backer_${slot()}_mask_psd`);
  const header = () => art(`catalog_tooltip_header_${slot()}_psd`);
  const name = (id: number) => p.art.buildCatalog?.records.get(id);
  const to = () => upgradesTo(p.record.id, p.art.buildCatalog?.records.values() ?? []);
  const label = (kind: string) => (kind === "active" ? p.tips.str("Citadel_Mod_Tooltip_Active", "Active") : p.tips.str("Citadel_Mod_Tooltip_Passive", "Passive"));
  return (
    <div class={cx("gt gt-item", slot())} data-testid="game-tooltip" data-tip-id={p.record.id} data-kind="item"
      style={{ ...(backer() ? { "background-image": `url(${JSON.stringify(backer())})` } : {}), ...(mask() ? { "-webkit-mask-image": `url(${JSON.stringify(mask())})`, "mask-image": `url(${JSON.stringify(mask())})` } : {}) }}>
      <div class="gt-head" style={header() ? { "background-image": `url(${JSON.stringify(header())})` } : {}}>
        <div class="gt-name" data-testid="game-tooltip-name">{p.record.label}</div>
        <Show when={p.ctx?.owned} fallback={
          <Show when={p.record.cost != null}>
            <div class="gt-cost" data-testid="game-tooltip-cost"><Icon icon={{ img: p.tips.data.art["icon_soul"], wash: "#99FFD6" }} tips={p.tips} />{p.record.cost!.toLocaleString("en-US")}</div>
          </Show>
        }>
          <div class="gt-owned" data-testid="game-tooltip-owned">{p.tips.str("Citadel_Shop_Purchased", "Owned")}<Show when={art("purchased_check_png")}>{(u) => <img src={u()} alt="" />}</Show></div>
        </Show>
      </div>
      <Show when={p.ctx?.stacks && e().tip.stack_label}>
        <div class="gt-stacks" data-testid="game-tooltip-stacks"><span>{e().tip.stack_label}</span><b>{p.ctx!.stacks}</b></div>
      </Show>
      <For each={e().tip.sections}>
        {(s) => (
          <section class={cx("gt-section", s.kind)} data-section={s.kind}>
            <Show when={s.kind === "passive" || s.kind === "active"}>
              <div class="gt-section-head">
                <span class="gt-section-label">{label(s.kind)}</span>
                <Show when={s.cooldown && shown(s.cooldown, e().values)}>
                  <span class="gt-cooldown" data-testid="game-tooltip-cooldown">
                    <Show when={art("property_cooldown_large_psd")}>{(u) => <img src={u()} alt="" />}</Show>
                    <Value prop={s.cooldown!} values={e().values} />
                  </span>
                </Show>
              </div>
            </Show>
            <For each={s.blocks}>
              {(b) => (
                <div class="gt-block">
                  <Show when={s.kind === "innate"}>
                    <For each={b.basic ?? []}>{(prop) => <Row prop={prop} values={e().values} />}</For>
                  </Show>
                  <Show when={b.text}>{(t) => <p class="gt-desc"><Markup text={t()} values={e().values.props} aliases={e().tip.aliases} tips={p.tips} /></p>}</Show>
                  <Show when={s.kind !== "innate" && ((b.important?.length ?? 0) > 0 || (b.basic?.length ?? 0) > 0)}>
                    <div class={cx("gt-props", (b.important?.length ?? 0) === 1 && "single")}>
                      <Show when={b.important?.length}>
                        <div class="gt-cards"><For each={b.important}>{(prop) => <Card prop={prop} values={e().values} tips={p.tips} spirit={p.ctx?.spirit} />}</For></div>
                      </Show>
                      <Show when={b.basic?.length}>
                        <div class="gt-rows"><For each={b.basic}>{(prop) => <Row prop={prop} values={e().values} spirit={p.ctx?.spirit} />}</For></div>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </section>
        )}
      </For>
      <Show when={p.record.components?.length}>
        <ComponentList label={p.tips.str("Citadel_ComponentRequired", "Upgrades From:")} ids={p.record.components!} name={name} testid="game-tooltip-from" />
      </Show>
      <Show when={to().length}>
        <ComponentList label={p.tips.str("Citadel_IsComponentOf", "Upgrades To:")} ids={to()} name={name} testid="game-tooltip-to" />
      </Show>
    </div>
  );
}

function ComponentList(p: { label: string; ids: number[]; name: (id: number) => BuildRecord | undefined; testid: string }) {
  return (
    <div class="gt-components" data-testid={p.testid}>
      <div class="gt-components-label">{p.label}</div>
      <div class="gt-components-list">
        <For each={p.ids}>
          {(id) => (
            <span class="gt-component" data-item-id={id}>
              <span class="gt-component-icon"><Show when={p.name(id)?.icon}>{(src) => <img src={src()} alt="" />}</Show></span>
              <span>{p.name(id)?.label ?? "—"}</span>
            </span>
          )}
        </For>
      </div>
    </div>
  );
}

function AbilityTip(p: { record: BuildRecord; art: Art; tips: Tooltips; ctx?: TipContext | undefined }) {
  const e = () => p.tips.tip(p.record.id)!;
  const up = () => upgraded(e().tip, e().values, p.ctx?.tiers);
  const bg = () => p.tips.blob(p.tips.data.art["ability_tooltip_bg_png"]);
  return (
    <div class="gt gt-ability" data-testid="game-tooltip" data-tip-id={p.record.id} data-kind="ability">
      <div class="gt-ability-body" style={bg() ? { "background-image": `url(${JSON.stringify(bg())})` } : {}}>
        <div class="gt-head">
          <div class="gt-name" data-testid="game-tooltip-name">{p.record.label}</div>
          <div class="gt-head-props">
            <For each={e().tip.header ?? []}>
              {(prop) => (
                <Show when={shown(prop, up().values)}>
                  <span class={cx("gt-pill", prop.css && `prop_${prop.css}`)} data-testid={prop.key === "AbilityCooldown" ? "game-tooltip-cooldown" : undefined}>
                    <Icon icon={prop.css ? p.tips.data.icons[prop.css] : undefined} tips={p.tips} />
                    <Value prop={prop} values={up().values} />
                  </span>
                </Show>
              )}
            </For>
          </div>
        </div>
        <For each={e().tip.sections}>
          {(s) => (
            <For each={s.blocks}>
              {(b) => (
                <Show when={blockShown(b, e().tip, p.ctx?.tiers)}>
                  <section class="gt-section info">
                    <Show when={b.text}>{(t) => <p class="gt-desc"><Markup text={t()} values={up().values.props} aliases={e().tip.aliases} tips={p.tips} /></p>}</Show>
                    <Show when={b.important?.length}>
                      <div class="gt-cards"><For each={b.important}>{(prop) => <Card prop={prop} values={up().values} tips={p.tips} spirit={p.ctx?.spirit} scale={up().scale[prop.key]} />}</For></div>
                    </Show>
                    <Show when={(b.basic ?? []).some((prop) => shown(prop, up().values))}>
                      <div class="gt-rows grid"><For each={b.basic}>{(prop) => <Row prop={prop} values={up().values} spirit={p.ctx?.spirit} scale={up().scale[prop.key]} />}</For></div>
                    </Show>
                  </section>
                </Show>
              )}
            </For>
          )}
        </For>
        <Show when={p.ctx?.stacks && e().tip.stack_label}>
          <div class="gt-bonus" data-testid="game-tooltip-stacks"><span>{e().tip.stack_label}</span><b>{p.ctx!.stacks}</b></div>
        </Show>
      </div>
      <Show when={e().tip.upgrades?.length}>
        <div class="gt-tiers">
          <For each={e().tip.upgrades}>
            {(u, i) => (
              <div class={cx("gt-tier", p.ctx?.tiers != null && i() < p.ctx.tiers && "bought")} data-testid="game-tooltip-tier" data-tier={i() + 1}>
                {/* The header is the tier's ability-point cost (TIER_COSTS). */}
                <div class="gt-tier-head" data-testid="game-tooltip-tier-cost">{TIER_COSTS[i()] ?? ""}</div>
                <div class="gt-tier-text">
                  <Show when={u.text}>{(t) => <span><Markup text={t()} values={e().values.upgrades?.[i()] ?? {}} aliases={e().tip.aliases} tips={p.tips} /></span>}</Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** A plain tag on hover (spec §4b), shown at once like the game's tooltips, where the browser's
 * own `title` waits half a second (#41). */
export function TagTip(p: { text: string }) {
  return <span class="gt-tag" data-testid="tag-tip">{p.text}</span>;
}

// ---- hover: one tooltip at a time, beside its anchor ----

const [openId, setOpenId] = createSignal<symbol | null>(null);
/** Whether the tooltip `id` is the one open. A selector: opening one wakes only the two whose
 * state changed, not every Hover on the page (#39: hundreds with the builds and events open). */
const isOpen = createRoot(() => createSelector(openId));
/** Whether the tooltip `id` (a `Hover`'s own) is open. */
export const tipIsOpen = (id: symbol) => isOpen(id);
/** Close whatever tooltip is open (a press elsewhere, Escape, a scroll; a board left). */
export const closeTips = () => setOpenId(null);
/** Open the tooltip `id` (a `Hover`'s own), closing any other. */
export const openTip = (id: symbol) => setOpenId(id);
/** Whether a tooltip is open, anywhere. */
export const tipOpen = () => openId() !== null;

/**
 * Shows `tip` beside its children while they're hovered (pointer), focused (keyboard) or tapped
 * (touch), as the game shows a tooltip on hover. The wrapper takes no layout (`display:
 * contents`). `tip` returning nothing shows nothing, so callers keep their plain `title` then.
 */
export function Hover(p: { tip: () => JSX.Element | false | null | undefined; children: JSX.Element; testid?: string }) {
  const me = Symbol("tip");
  let anchor: HTMLSpanElement | undefined;
  const open = () => tipIsOpen(me);
  // At once, as the game's do (feedback #41: an 80 ms wait read as lag). Moving across a row of
  // items needs no guard: leaving one closes it in the same event that opens the next.
  const show = () => {
    if (!open()) openTip(me);
  };
  const hide = () => {
    if (open()) setOpenId(null);
  };
  onCleanup(() => { if (untrack(open)) setOpenId(null); });
  // The float, its placing and its listeners exist only while open: a Hover costs little to make
  // (twelve build columns of them appear at once on Tab, #39).
  const content = () => (open() ? p.tip() : undefined);
  return (
    <span
      ref={anchor}
      class="gt-anchor"
      data-testid={p.testid}
      onPointerEnter={(e) => e.pointerType !== "touch" && show()}
      onPointerLeave={(e) => e.pointerType !== "touch" && hide()}
      onPointerDown={(e) => { if (e.pointerType === "touch") open() ? hide() : show(); }}
      onFocusIn={() => show()}
      onFocusOut={hide}
    >
      {p.children}
      <Show when={content()}>{(c) => <TipFloat anchor={() => anchor} hide={hide}>{c()}</TipFloat>}</Show>
    </span>
  );
}

/** An open tooltip beside its anchor. */
function TipFloat(p: { anchor: () => HTMLSpanElement | undefined; hide: () => void; children: JSX.Element }) {
  let float: HTMLDivElement | undefined;
  const [at, setAt] = createSignal<{ left: number; top: number } | null>(null);
  // Placed as soon as it's drawn (the effect runs after it renders), and again a frame later
  // for anything that changed its size since: right of the anchor if it fits, else left; kept
  // on screen.
  const place = () => {
    const anchor = p.anchor();
    const el = (anchor?.firstElementChild as HTMLElement | null) ?? anchor;
    if (!el || !float) return;
    const a = el.getBoundingClientRect();
    const f = float.getBoundingClientRect();
    const gap = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = a.right + gap;
    if (left + f.width > vw - gap) left = a.left - gap - f.width;
    if (left < gap) left = Math.max(gap, Math.min(vw - f.width - gap, a.left));
    let top = a.top;
    if (left === a.left || (left < a.right && left + f.width > a.left)) top = a.bottom + gap;
    top = Math.max(gap, Math.min(top, vh - f.height - gap));
    setAt({ left, top });
  };
  createEffect(() => {
    place();
    const frame = requestAnimationFrame(place);
    onCleanup(() => cancelAnimationFrame(frame));
  });
  // Escape closes the tooltip first, not the panel it's in (captured before their listeners).
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); p.hide(); } };
  const away = (e: PointerEvent) => { if (!p.anchor()?.contains(e.target as Node)) p.hide(); };
  const hide = () => p.hide();
  onMount(() => {
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", hide, true);
    onCleanup(() => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", hide, true);
    });
  });
  return (
    <Portal>
      <div ref={float} class="gt-float" role="tooltip" data-testid="game-tooltip-float" style={at() ? { left: `${at()!.left}px`, top: `${at()!.top}px` } : { left: "0px", top: "0px", visibility: "hidden" }}>
        {p.children}
      </div>
    </Portal>
  );
}
