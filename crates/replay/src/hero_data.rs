//! Format 7's per-hero data (docs/research/abilities-and-items.md, status-effects.md,
//! elevation.md): what the parser saw, to each [`Player`]'s `items` through `zipline`. Pure: the
//! parser fills [`HeroData`], tests build it by hand. Stored, not shown yet (operator
//! 2026-11-09).
//!
//! Players are the controller's entity index ([`crate::derive::HeroObs::id`]), as everywhere in
//! the observations; the timeline keeps only the index into `players`.

use crate::modifiers::CC_MODIFIERS;
use crate::timeline::{CC_STATES, HOLD_S, ITEM_BOUGHT, ITEM_MERGED, ITEM_REMOVED, ITEM_SOLD, MAX_CHARGE_COUNT, MAX_COOLDOWN_DS, MAX_RECAP_DAMAGE, MAX_RECAP_ROWS, MAX_STACKS, NO_HERO, NPC_SRC, Player, RECAP_S, Recap};
use std::collections::{BTreeMap, HashMap};

/// `CCitadelUserMsg_AbilitiesChanged` (msg 309): a shop event.
#[derive(Clone, Debug, PartialEq)]
pub struct ItemObs {
    pub game: f32,
    pub player: i32,
    pub id: u32,
    /// The message's `Change`: [`PURCHASED`], [`SOLD`], or another we skip.
    pub change: i32,
}
pub const PURCHASED: i32 = 0;
pub const SOLD: i32 = 2;

/// `ItemPurchaseNotification` (msg 360) with `sell` set: what tells a real sell from a component
/// an upgrade used up (both are 309 `ESold`).
#[derive(Clone, Debug, PartialEq)]
pub struct SellObs {
    pub game: f32,
    pub id: u32,
}

/// An entry of the controller's `m_vecAbilityUpgradeState` where it changes.
#[derive(Clone, Debug, PartialEq)]
pub struct LevelObs {
    pub game: f32,
    pub player: i32,
    pub id: u32,
    /// `m_nUpgradeInfo`: bit 16 unlocked, bits 17–19 tiers 1–3.
    pub info: u32,
}

/// An ability or active item cast (msg 365), with its cooldown end once the ability entity
/// showed it (match clock).
#[derive(Clone, Debug, PartialEq)]
pub struct CastObs {
    pub game: f32,
    pub player: i32,
    pub id: u32,
    pub cd_end: Option<f32>,
}

/// An ability's `m_iRemainingCharges` where it changes.
#[derive(Clone, Debug, PartialEq)]
pub struct ChargeObs {
    pub game: f32,
    pub player: i32,
    pub id: u32,
    pub charges: u32,
}

/// The pawn's hard-CC bits where they change: bit i = [`CC_STATES`]`[i]`.
#[derive(Clone, Debug, PartialEq)]
pub struct CcObs {
    pub game: f32,
    pub player: i32,
    pub bits: u16,
}

/// One icon-shown modifier on a hero, applied to removed (or the recording's end).
#[derive(Clone, Debug, PartialEq)]
pub struct EffectObs {
    pub start: f32,
    pub end: f32,
    pub player: i32,
    /// The caster, when a hero.
    pub caster: Option<i32>,
    pub id: u32,
    pub ability: u32,
    pub stacks: u32,
}

/// A modifier an enemy hero applied to a hero: what a CC interval's source is inferred from.
#[derive(Clone, Debug, PartialEq)]
pub struct ApplyObs {
    pub game: f32,
    pub player: i32,
    pub caster: i32,
    pub id: u32,
    pub ability: u32,
}

/// A damage instance on a hero (msg 300).
#[derive(Clone, Debug, PartialEq)]
pub struct DamageObs {
    pub game: f32,
    pub victim: i32,
    /// The attacker, when a hero.
    pub attacker: Option<i32>,
    pub ability: u32,
    pub damage: u32,
    /// `victim_health_new` 0.
    pub lethal: bool,
    /// Not a hero: the attacker's [`crate::timeline::NPC_KINDS`] index, from the message's `attacker_class`.
    pub npc: Option<u32>,
}

/// A small per-hero state where it changes: the height level, or riding a zipline (1).
#[derive(Clone, Debug, PartialEq)]
pub struct StateObs {
    pub game: f32,
    pub player: i32,
    pub value: u8,
}

/// Everything format 7 reads, each list in order.
#[derive(Clone, Debug, Default)]
pub struct HeroData {
    pub items: Vec<ItemObs>,
    pub sells: Vec<SellObs>,
    pub levels: Vec<LevelObs>,
    pub casts: Vec<CastObs>,
    pub charges: Vec<ChargeObs>,
    pub cc: Vec<CcObs>,
    pub effects: Vec<EffectObs>,
    pub applied: Vec<ApplyObs>,
    pub damage: Vec<DamageObs>,
    pub height: Vec<StateObs>,
    pub zip: Vec<StateObs>,
    /// The last match-clock second read: where open intervals end.
    pub end: f32,
}

/// A 309 sell this close to a 360 sell of the same item is that sell (seconds).
const SELL_MATCH_S: f32 = 0.25;
/// A component sold this close to a buy by the same hero went into it (89 of 96 on 129738985,
/// within 0.1 s).
const MERGE_S: f32 = 0.1;
/// A modifier applied this close to a CC state turning on caused it (status-effects.md §2: ≤ 0.07 s).
const CC_MATCH_S: f32 = 0.1;
/// Lethal hits this close after a death are the same death.
const SAME_DEATH_S: f32 = 3.0;

/// Tenths of a second, never past `end_ds`.
fn ds(game: f32, end_ds: u32) -> u32 {
    ((game.max(0.0) * 10.0).round() as u32).min(end_ds)
}

/// Fill each player's format-7 fields. `ids[i]` is `players[i]`'s controller index.
pub fn fill(players: &mut [Player], ids: &[i32], d: &HeroData, duration_s: u32) {
    let end_ds = duration_s * 10;
    let index: HashMap<i32, u32> = ids.iter().enumerate().map(|(i, id)| (*id, i as u32)).collect();
    let src = |p: Option<i32>| p.and_then(|p| index.get(&p).copied()).unwrap_or(NO_HERO);
    let kinds = item_kinds(&d.items, &d.sells);
    for (p, &id) in players.iter_mut().zip(ids) {
        p.items = d.items.iter().zip(&kinds).filter(|(i, k)| i.player == id && k.is_some()).map(|(i, k)| [ds(i.game, end_ds), i.id, k.unwrap_or(ITEM_BOUGHT)]).collect();
        p.abilities = levels(d.levels.iter().filter(|l| l.player == id), duration_s);
        p.casts = d
            .casts
            .iter()
            .filter(|c| c.player == id && c.id != 0)
            .map(|c| {
                let t = ds(c.game, end_ds);
                let cd = c.cd_end.map_or(0, |e| (e.max(0.0) * 10.0).round() as u32);
                [t, c.id, if t < cd && cd <= t + MAX_COOLDOWN_DS { cd } else { 0 }]
            })
            .collect();
        p.charges = d.charges.iter().filter(|c| c.player == id && c.id != 0).map(|c| [ds(c.game, end_ds), c.id, c.charges.min(MAX_CHARGE_COUNT)]).collect();
        p.cc = cc(d, id, &src, end_ds);
        let mut effects: Vec<[u32; 6]> = d
            .effects
            .iter()
            .filter(|e| e.player == id && e.id != 0)
            .map(|e| {
                let a = ds(e.start, end_ds);
                [a, ds(e.end, end_ds).max(a), e.id, src(e.caster), e.ability, e.stacks.min(MAX_STACKS)]
            })
            .collect();
        effects.sort_by_key(|e| e[0]);
        p.effects = effects;
        p.recaps = recaps(d, id, &p.cc, &src, end_ds);
        let height = per_second(d.height.iter().filter(|h| h.player == id), duration_s);
        p.height = changes(&held(&height, HOLD_S));
        let zip = per_second(d.zip.iter().filter(|z| z.player == id), duration_s);
        p.zipline = on_runs(&held(&zip, HOLD_S));
    }
}

/// Each 309 event's `items` kind, `None` to skip. A sell is real if a 360 sell of the item
/// matches it (each used once); else a component that went into a buy in the same instant; else
/// something else took it.
fn item_kinds(items: &[ItemObs], sells: &[SellObs]) -> Vec<Option<u32>> {
    let mut used = vec![false; sells.len()];
    items
        .iter()
        .map(|i| match i.change {
            _ if i.id == 0 => None,
            PURCHASED => Some(ITEM_BOUGHT),
            SOLD => {
                if let Some(j) = (0..sells.len()).find(|&j| !used[j] && sells[j].id == i.id && (sells[j].game - i.game).abs() <= SELL_MATCH_S) {
                    used[j] = true;
                    Some(ITEM_SOLD)
                } else if items.iter().any(|o| o.player == i.player && o.change == PURCHASED && (o.game - i.game).abs() <= MERGE_S) {
                    Some(ITEM_MERGED)
                } else {
                    Some(ITEM_REMOVED)
                }
            }
            _ => None,
        })
        .collect()
}

/// An `m_nUpgradeInfo`'s level: 0 locked, 1 unlocked, 2–4 tiers 1–3.
pub fn level_of(info: u32) -> u32 {
    ((info >> 16) & 0xF).count_ones()
}

/// `[second, id, level]` where an ability's level changes.
fn levels<'a>(obs: impl Iterator<Item = &'a LevelObs>, duration_s: u32) -> Vec<[u32; 3]> {
    let mut last: HashMap<u32, u32> = HashMap::new();
    let mut out = Vec::new();
    for l in obs.filter(|l| l.id != 0) {
        let level = level_of(l.info);
        if last.insert(l.id, level).unwrap_or(0) != level {
            out.push([(l.game.max(0.0) as u32).min(duration_s), l.id, level]);
        }
    }
    out
}

/// A hero's hard-CC intervals, each with the enemy application that best explains its start.
fn cc(d: &HeroData, id: i32, src: &dyn Fn(Option<i32>) -> u32, end_ds: u32) -> Vec<[u32; 5]> {
    let mut on: [Option<f32>; 9] = [None; 9];
    let mut spans: Vec<(f32, f32, usize)> = Vec::new();
    for c in d.cc.iter().filter(|c| c.player == id) {
        for (i, start) in on.iter_mut().enumerate() {
            match (c.bits >> i & 1 == 1, *start) {
                (true, None) => *start = Some(c.game),
                (false, Some(s)) => {
                    spans.push((s, c.game, i));
                    *start = None;
                }
                _ => {}
            }
        }
    }
    for (i, s) in on.iter().enumerate() {
        if let Some(s) = s {
            spans.push((*s, d.end, i));
        }
    }
    spans.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.2.cmp(&b.2)));
    spans
        .into_iter()
        .filter_map(|(a, b, i)| {
            let (a, b) = (ds(a, end_ds), ds(b, end_ds));
            if a >= b {
                return None;
            }
            let cause = cc_cause(&d.applied, id, a, i);
            Some([a, b, CC_STATES[i], cause.map_or(NO_HERO, |c| src(Some(c.caster))), cause.map_or(0, |c| c.ability)])
        })
        .collect()
}

/// The enemy application that caused state `i` starting at `start_ds`: one in the same instant,
/// preferring a modifier whose definition sets that state, then one with an ability.
fn cc_cause(applied: &[ApplyObs], id: i32, start_ds: u32, i: usize) -> Option<&ApplyObs> {
    let start = start_ds as f32 / 10.0;
    let near: Vec<&ApplyObs> = applied.iter().filter(|a| a.player == id && (a.game - start).abs() <= CC_MATCH_S + 0.05).collect();
    let sets = |a: &ApplyObs| CC_MODIFIERS.binary_search_by_key(&a.id, |m| m.0).is_ok_and(|k| CC_MODIFIERS[k].1 >> i & 1 == 1);
    near.iter().find(|a| sets(a)).or_else(|| near.iter().find(|a| a.ability != 0)).or_else(|| near.first()).copied()
}

/// One recap per death (a lethal hit; those within [`SAME_DEATH_S`] after it are the same).
fn recaps(d: &HeroData, id: i32, cc: &[[u32; 5]], src: &dyn Fn(Option<i32>) -> u32, end_ds: u32) -> Vec<Recap> {
    let mut out: Vec<Recap> = Vec::new();
    let mut last: Option<f32> = None;
    let hits: Vec<&DamageObs> = d.damage.iter().filter(|h| h.victim == id).collect();
    for death in hits.iter().filter(|h| h.lethal) {
        if last.is_some_and(|l| death.game - l <= SAME_DEATH_S) {
            continue;
        }
        last = Some(death.game);
        let t = ds(death.game, end_ds);
        if out.last().is_some_and(|r| r.t >= t) {
            continue;
        }
        let mut by: BTreeMap<(u32, u32), u64> = BTreeMap::new();
        for h in hits.iter().filter(|h| h.game <= death.game && death.game - h.game <= RECAP_S as f32 && h.damage > 0) {
            let who = match (src(h.attacker), h.npc) {
                (NO_HERO, Some(k)) => NPC_SRC + k,
                (s, _) => s,
            };
            *by.entry((who, h.ability)).or_default() += u64::from(h.damage);
        }
        let mut damage: Vec<[u32; 3]> = by.into_iter().map(|((s, a), n)| [s, a, n.min(u64::from(MAX_RECAP_DAMAGE)) as u32]).collect();
        damage.sort_by(|a, b| b[2].cmp(&a[2]).then(a[0].cmp(&b[0])).then(a[1].cmp(&b[1])));
        damage.truncate(MAX_RECAP_ROWS);
        let from = t.saturating_sub(RECAP_S * 10);
        let cc: Vec<[u32; 5]> = cc.iter().filter(|c| c[0] <= t && c[1] >= from).take(MAX_RECAP_ROWS).copied().collect();
        out.push(Recap { t, damage, cc });
    }
    out
}

/// The state at each second `0..=duration_s`: the last change at or before it (0 before any).
fn per_second<'a>(obs: impl Iterator<Item = &'a StateObs>, duration_s: u32) -> Vec<u8> {
    let mut out = vec![0u8; duration_s as usize + 1];
    let mut cur = 0u8;
    let mut obs = obs.peekable();
    for (s, v) in out.iter_mut().enumerate() {
        while let Some(o) = obs.next_if(|o| o.game <= s as f32) {
            cur = o.value;
        }
        *v = cur;
    }
    out
}

/// A state counts once it holds for `hold` samples in a row; until then the last one holds.
pub fn held(samples: &[u8], hold: usize) -> Vec<u8> {
    let mut cur = 0u8;
    (0..samples.len())
        .map(|i| {
            let v = samples[i];
            if v != cur && i + hold <= samples.len() && samples[i..i + hold].iter().all(|x| *x == v) {
                cur = v;
            }
            cur
        })
        .collect()
}

/// `[second, value]` where it changes (from 0).
fn changes(v: &[u8]) -> Vec<[u32; 2]> {
    let mut last = 0u8;
    let mut out = Vec::new();
    for (s, &x) in v.iter().enumerate() {
        if x != last {
            out.push([s as u32, u32::from(x)]);
            last = x;
        }
    }
    out
}

/// `[from, to)` runs of non-zero.
fn on_runs(v: &[u8]) -> Vec<[u32; 2]> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, &x) in v.iter().chain(std::iter::once(&0)).enumerate() {
        match (x != 0, start) {
            (true, None) => start = Some(i as u32),
            (false, Some(s)) => {
                out.push([s, i as u32]);
                start = None;
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::{ITEM_BOUGHT as B, ITEM_MERGED as M, ITEM_REMOVED as R, ITEM_SOLD as S};

    fn players(n: usize) -> Vec<Player> {
        (0..n).map(|i| Player { team: if i < 6 { "amber" } else { "sapphire" }.into(), slot: i as u32 % 6, ..Player::default() }).collect()
    }

    fn filled(d: &HeroData, n: usize, duration_s: u32) -> Vec<Player> {
        let mut p = players(n);
        let ids: Vec<i32> = (1..=n as i32).collect();
        fill(&mut p, &ids, d, duration_s);
        p
    }

    fn item(game: f32, player: i32, id: u32, change: i32) -> ItemObs {
        ItemObs { game, player, id, change }
    }

    #[test]
    fn a_sell_is_real_only_when_the_shop_says_so_and_a_component_goes_into_its_upgrade() {
        let d = HeroData {
            items: vec![
                item(10.0, 1, 100, PURCHASED),
                item(20.0, 1, 101, PURCHASED),
                // 100 goes into 200, bought in the same instant.
                item(30.0, 1, 100, SOLD),
                item(30.0, 1, 200, PURCHASED),
                // 101 sold for real, with the shop's notice, while buying 300 at once.
                item(40.0, 1, 101, SOLD),
                item(40.0, 1, 300, PURCHASED),
                // Another hero's sale of 101 in that instant doesn't take player 1's notice too.
                item(40.0, 2, 101, SOLD),
                // Gone with no buy and no notice; an upgrade (change 1) and id 0 are skipped.
                item(50.0, 1, 300, SOLD),
                item(51.0, 1, 300, 1),
                item(52.0, 1, 0, PURCHASED),
                // Another hero's buy in the same instant as player 1's sale isn't a merge.
                item(60.0, 1, 200, SOLD),
                item(60.0, 2, 400, PURCHASED),
            ],
            // One notice for 101 (once only, so a second sale of 101 wouldn't take it), one far
            // from any sale.
            sells: vec![SellObs { game: 40.0, id: 101 }, SellObs { game: 45.0, id: 300 }],
            ..HeroData::default()
        };
        let p = filled(&d, 2, 100);
        assert_eq!(p[0].items, [[100, 100, B], [200, 101, B], [300, 100, M], [300, 200, B], [400, 101, S], [400, 300, B], [500, 300, R], [600, 200, R]]);
        assert_eq!(p[1].items, [[400, 101, R], [600, 400, B]]);
        // The build at t: bought minus the rest.
        let at = |t: u32| {
            let mut have: Vec<u32> = Vec::new();
            for [s, id, k] in p[0].items.iter().filter(|i| i[0] <= t) {
                let _ = s;
                if *k == B { have.push(*id) } else { have.retain(|h| h != id) }
            }
            have
        };
        assert_eq!(at(350), [101, 200]);
        assert_eq!(at(450), [200, 300]);
    }

    #[test]
    fn ability_levels_are_the_upgrade_bits() {
        assert_eq!([0, 65536, 196_608, 458_752, 983_040].map(level_of), [0, 1, 2, 3, 4]);
        let l = |game: f32, id: u32, info: u32| LevelObs { game, player: 1, id, info };
        let d = HeroData { levels: vec![l(0.0, 7, 0), l(5.5, 7, 65536), l(6.0, 8, 65536), l(90.0, 7, 196_608), l(91.0, 7, 196_608), l(99.0, 0, 65536)], ..HeroData::default() };
        assert_eq!(filled(&d, 1, 100)[0].abilities, [[5, 7, 1], [6, 8, 1], [90, 7, 2]]);
    }

    #[test]
    fn casts_keep_their_cooldown_end_only_when_it_is_after_them_and_not_absurd() {
        let c = |game: f32, id: u32, cd_end: Option<f32>| CastObs { game, player: 1, id, cd_end };
        let d = HeroData { casts: vec![c(10.0, 5, Some(22.5)), c(11.0, 6, None), c(12.0, 7, Some(11.0)), c(13.0, 8, Some(13.0 + 1201.0)), c(14.0, 0, Some(20.0))], ..HeroData::default() };
        assert_eq!(filled(&d, 1, 100)[0].casts, [[100, 5, 225], [110, 6, 0], [120, 7, 0], [130, 8, 0]]);
    }

    #[test]
    fn cc_intervals_take_the_enemy_application_that_sets_their_state() {
        // Stunned (bit 4 = state 20) 10.0–11.5, silenced (bit 3 = 17) 10.0–14.0, then stunned
        // again from 50 to the end.
        let cc = |game: f32, bits: u16| CcObs { game, player: 1, bits };
        let a = |game: f32, caster: i32, id: u32, ability: u32| ApplyObs { game, player: 1, caster, id, ability };
        // A modifier the catalog says stuns, from player 3; the same instant, player 2's with an
        // ability but no stun; a silence with no CC modifier, only an ability.
        let (stun_mod, stun_bits) = CC_MODIFIERS.iter().copied().find(|(_, b)| *b >> 4 & 1 == 1).expect("a stun modifier");
        assert_eq!(stun_bits >> 3 & 1, 0, "and not a silence, for this test");
        let d = HeroData {
            cc: vec![cc(10.0, 0b11000), cc(11.5, 0b01000), cc(14.0, 0), cc(50.0, 0b10000)],
            applied: vec![a(10.0, 3, 9, 0), a(10.0, 2, 9, 77), a(10.05, 3, stun_mod, 88), a(49.0, 2, stun_mod, 99), a(10.0, 1, 9, 66)],
            end: 60.0,
            ..HeroData::default()
        };
        let p = filled(&d, 3, 100);
        // Player 2 is index 1 and player 3 index 2. The last stun has no application in its
        // instant: no source. Player 1's own application (index 0) is filtered by the parser
        // (only enemy applications are kept), so here it's a candidate after the ability ones.
        assert_eq!(p[0].cc, [[100, 140, 17, 1, 77], [100, 115, 20, 2, 88], [500, 600, 20, NO_HERO, 0]]);
    }

    #[test]
    fn effects_are_in_order_with_their_sources() {
        let e = |start: f32, end: f32, caster: Option<i32>, id: u32| EffectObs { start, end, player: 1, caster, id, ability: 4, stacks: 2000 };
        let d = HeroData { effects: vec![e(20.0, 25.0, Some(2), 9), e(5.0, 6.0, None, 8), e(7.0, 7.0, Some(99), 7), e(8.0, 9.0, None, 0)], ..HeroData::default() };
        assert_eq!(filled(&d, 2, 100)[0].effects, [[50, 60, 8, NO_HERO, 4, MAX_STACKS], [70, 70, 7, NO_HERO, 4, MAX_STACKS], [200, 250, 9, 1, 4, MAX_STACKS]]);
    }

    #[test]
    fn a_recap_sums_the_ten_seconds_before_a_death_by_source_and_ability() {
        let h = |game: f32, attacker: Option<i32>, ability: u32, damage: u32, lethal: bool| DamageObs { game, victim: 1, attacker, ability, damage, lethal, npc: None };
        let d = HeroData {
            damage: vec![
                h(85.0, Some(2), 5, 999, false), // 15 s before: out of the window
                h(90.0, Some(2), 5, 100, false),
                h(95.0, Some(2), 5, 50, false),
                h(96.0, None, 0, 30, false),
                h(97.0, Some(2), 6, 0, false), // absorbed
                h(100.0, Some(3), 7, 200, true),
                h(101.0, Some(3), 7, 10, true), // the same death
                h(200.0, Some(2), 5, 40, true),
                DamageObs { game: 199.0, victim: 2, attacker: Some(1), ability: 1, damage: 5, lethal: false, npc: None },
            ],
            cc: vec![CcObs { game: 80.0, player: 1, bits: 0b10000 }, CcObs { game: 89.0, player: 1, bits: 0 }, CcObs { game: 95.0, player: 1, bits: 0b10000 }, CcObs { game: 96.0, player: 1, bits: 0 }],
            ..HeroData::default()
        };
        let p = filled(&d, 3, 300);
        assert_eq!(p[0].recaps.len(), 2);
        assert_eq!(p[0].recaps[0], Recap { t: 1000, damage: vec![[2, 7, 200], [1, 5, 150], [NO_HERO, 0, 30]], cc: vec![[950, 960, 20, NO_HERO, 0]] });
        assert_eq!(p[0].recaps[1], Recap { t: 2000, damage: vec![[1, 5, 40]], cc: vec![] });
        assert!(p[1].recaps.is_empty());
    }

    #[test]
    fn a_recap_names_a_non_hero_attacker_by_its_kind() {
        let h = |game: f32, attacker: Option<i32>, npc: Option<u32>, damage: u32, lethal: bool| DamageObs { game, victim: 1, attacker, ability: 0, damage, lethal, npc };
        // A walker (kind 6) twice, a trooper (0), an unknown non-hero, and a hero whose npc is ignored.
        let d = HeroData { damage: vec![h(95.0, None, Some(6), 300, false), h(96.0, None, Some(0), 40, false), h(97.0, None, None, 20, false), h(98.0, Some(2), Some(6), 10, false), h(100.0, None, Some(6), 100, true)], ..HeroData::default() };
        let p = filled(&d, 2, 300);
        assert_eq!(p[0].recaps[0].damage, [[NPC_SRC + 6, 0, 400], [NPC_SRC, 0, 40], [NO_HERO, 0, 20], [1, 0, 10]]);
        assert!(crate::timeline::extras_ok(&p[0], 300, 2));
    }

    #[test]
    fn height_and_zip_count_once_they_hold_two_seconds() {
        assert_eq!(held(&[0, 1, 0, 1, 1, 1, 2, 2, 0, 0, 1], 2), [0, 0, 0, 1, 1, 1, 2, 2, 0, 0, 0]);
        let s = |game: f32, value: u8| StateObs { game, player: 1, value };
        // Above for one second at 3 (a jump), below from 10.5 (counted from 11) to 20.
        let d = HeroData { height: vec![s(3.0, 1), s(3.9, 0), s(10.5, 2), s(20.0, 0)], zip: vec![s(5.0, 1), s(9.0, 0), s(30.0, 1), s(31.0, 0)], ..HeroData::default() };
        let p = filled(&d, 1, 40);
        assert_eq!(p[0].height, [[11, 2], [20, 0]]);
        assert_eq!(p[0].zipline, [[5, 9]]);
        assert!(crate::timeline::extras_ok(&p[0], 40, 1));
    }

    /// The timeline keys a hero by its place in `players`: Amber's slots, then Sapphire's, each
    /// in controller order, whatever the controllers' indices.
    #[test]
    fn derive_gives_each_player_their_own_reads_and_sources_by_index() {
        use crate::derive::{HeroObs, Obs, Sample, derive};
        let hero = |id: i32, team: i64| HeroObs { id, team, hero_id: 10 + id as u32, alive: true, pos: Some([0.0, 0.0]), health: 500, max_health: 1000, ..Default::default() };
        let mut seconds: Vec<Sample> = (0..20).map(|i| Sample { now: 100.0 + i as f32, ..Default::default() }).collect();
        // Sapphire's controller comes first by index; Amber's two come after it.
        seconds[0].heroes = vec![hero(3, 3), hero(7, 2), hero(5, 2)];
        let hero_data = HeroData {
            items: vec![item(1.0, 7, 70, PURCHASED), item(2.0, 3, 30, PURCHASED)],
            damage: vec![DamageObs { game: 5.0, victim: 5, attacker: Some(3), ability: 9, damage: 300, lethal: true, npc: None }],
            ..HeroData::default()
        };
        let t = derive(&Obs { match_id: 1, build: 6813, game_mode: 1, seconds, hero_data, ..Default::default() }, crate::map::current()).expect("timeline");
        let who: Vec<(&str, u32, Vec<[u32; 3]>)> = t.players.iter().map(|p| (p.team.as_str(), p.hero_id, p.items.clone())).collect();
        assert_eq!(who, [("amber", 15, vec![]), ("amber", 17, vec![[10, 70, ITEM_BOUGHT]]), ("sapphire", 13, vec![[20, 30, ITEM_BOUGHT]])]);
        assert_eq!(t.players[0].recaps, [Recap { t: 50, damage: vec![[2, 9, 300]], cc: vec![] }]);
        assert!(crate::timeline::validate(&serde_json::to_vec(&t).expect("json")).is_ok());
    }
}
