//! Format 7's reads (docs/research/abilities-and-items.md, status-effects.md, elevation.md): shop
//! events, ability levels, casts with their cooldowns, charges, the pawn's hard-CC bits, the
//! modifiers the game shows an icon for, damage on heroes, and zipline rides. Height comes from
//! the minimap feed `parse::vision_tick` already walks. Steam ids are never read: every message
//! and field here names entities, slots or tokens.

use crate::hero_data::{ApplyObs, CastObs, CcObs, ChargeObs, DamageObs, EffectObs, HeroData, ItemObs, LevelObs, SellObs, StateObs};
use crate::modifiers::ICON_MODIFIERS;
use crate::timeline::{CC_STATES, token};
use boon::entity::field_path::FieldPath;
use boon::modifier_state::ModifierChangeKind;
use prost::Message;
use std::collections::{HashMap, HashSet};

const CONTROLLER: &str = "CCitadelPlayerController";
const PAWN: &str = "CCitadelPlayerPawn";
const ABILITIES_CHANGED: u32 = 309;
const ITEM_PURCHASE: u32 = 360;
const IMPORTANT_ABILITY_USED: u32 = 365;
const DAMAGE: u32 = 300;
/// The user messages [`HeroTracker::tick`] reads (the parse collects only those it needs).
pub const EVENT_TYPES: [u32; 4] = [ABILITIES_CHANGED, ITEM_PURCHASE, IMPORTANT_ABILITY_USED, DAMAGE];
/// The ability list's length cap (4 signature abilities plus a few granted ones on 129738985).
const MAX_UPGRADE_STATES: usize = 32;
/// Entity indices player controllers may take (slot + 1; 12 players use 1 to 12).
const MAX_SLOTS: i32 = 64;
/// How long after a cast its ability entity may take to show the new cooldown (seconds).
const CAST_WAIT_S: f64 = 1.5;
/// A cast's cooldown start may read this much before the cast message.
const CAST_EARLY_S: f32 = 0.3;

type K = Option<u64>;

/// The classes whose entities are abilities or items: each has a cooldown, a subclass and an
/// owner (568 of 892 classes on 129738985 match by name; this keeps exactly the ones that work).
pub fn ability_classes(parser: &boon::Parser) -> Vec<String> {
    let (Ok(info), Ok(sers)) = (parser.parse_class_info(), parser.parse_send_tables()) else { return Vec::new() };
    ability_classes_of(&info, &sers)
}

/// [`ability_classes`] from the signon's class info and send tables (a streamed parse).
pub fn ability_classes_of(info: &boon::ClassInfo, sers: &boon::SerializerContainer) -> Vec<String> {
    info.classes()
        .iter()
        .map(|c| c.network_name.to_string())
        .filter(|c| sers.get(c).is_some_and(|s| ["m_flCooldownEnd", "m_nSubclassID", "m_hOwnerEntity"].iter().all(|f| s.resolve_field_key(f).is_some())))
        .collect()
}

/// Keys of one fixed-size array's elements (the state masks are `uint32[8]`, which don't resolve
/// by `.N` paths).
fn array_keys(s: &boon::Serializer, path: &str, n: usize) -> Vec<K> {
    let Some(k) = s.resolve_field_key(path) else { return vec![None; n] };
    let base = FieldPath::unpack(k);
    (0..n)
        .map(|i| {
            let mut fp = base;
            let next = fp.last + 1;
            if next >= fp.data.len() {
                return None;
            }
            fp.data[next] = i as i16;
            fp.last = next;
            fp.try_pack()
        })
        .collect()
}

#[derive(Clone, Copy)]
struct AbilityKeys {
    owner: K,
    sub: K,
    cd_start: K,
    cd_end: K,
    charges: K,
}

struct Keys {
    ctrl_pawn: K,
    ctrl_team: K,
    upgrades: K,
    /// `m_vecAbilityUpgradeState.{i}`: `m_ItemID`, `m_nUpgradeInfo`.
    upgrade: Vec<[K; 2]>,
    /// The mask's 32-bit words: CC bit `b` is in word `b / 32`.
    mask: Vec<K>,
    zip: K,
}

impl Keys {
    fn resolve(ctx: &boon::Context) -> Keys {
        let sers = ctx.serializers();
        let c = |p: &str| sers.get(CONTROLLER).and_then(|s| s.resolve_field_key(p));
        let p = |f: &str| sers.get(PAWN).and_then(|s| s.resolve_field_key(f));
        let words = CC_STATES.iter().map(|b| *b as usize / 32).max().unwrap_or(0) + 1;
        Keys {
            ctrl_pawn: c("m_hPawn"),
            ctrl_team: c("m_iTeamNum"),
            upgrades: c("m_PlayerDataGlobal.m_vecAbilityUpgradeState"),
            upgrade: (0..MAX_UPGRADE_STATES).map(|i| [c(&format!("m_PlayerDataGlobal.m_vecAbilityUpgradeState.{i}.m_ItemID")), c(&format!("m_PlayerDataGlobal.m_vecAbilityUpgradeState.{i}.m_nUpgradeInfo"))]).collect(),
            mask: sers.get(PAWN).map_or_else(|| vec![None; words], |s| array_keys(s, "m_pModifierProp.m_bvEnabledStateMask", words)),
            zip: p("m_eZipLineLaneColor"),
        }
    }
}

/// The fields of a modifier-table entry the reads use (boon's `CModifierTableEntry` has ~25).
#[derive(Clone, Copy, Default)]
struct Entry {
    parent: Option<u32>,
    caster: Option<u32>,
    modifier_subclass: Option<u32>,
    ability_subclass: Option<u32>,
    stack_count: Option<i32>,
}

/// One modifier-table change, as boon's `ModifierState::update` reports it: an applied change
/// carries its delta, a changed or removed one the merged entry.
struct ModChange {
    kind: ModifierChangeKind,
    serial: u32,
    entry: Entry,
}

/// The live modifiers by serial: boon's `ModifierState` (modifier_state.rs `apply_delta`,
/// `merge_entry`) with only what the reads use kept between deltas. boon's keeps whole
/// `CModifierTableEntry`s (584 B each) and only drops one at an explicit removal, so it holds
/// every modifier ever applied that wasn't removed: 9,147 on 129738985, 8 MB of a ~48 MB peak
/// (docs/research/parser-memory.md). The changes are the same: an applied or removed change
/// is reported exactly when boon reports it, and a changed one when the parent or the stack
/// count changed (boon also reports other fields' changes, which nothing here reads).
#[derive(Default)]
struct Modifiers {
    /// Serial → (parent, stack count), merged.
    live: HashMap<u32, (Option<u32>, Option<i32>)>,
}

impl Modifiers {
    fn update(&mut self, ctx: &boon::Context, out: &mut Vec<ModChange>) {
        let Some(table) = ctx.string_tables().find_table("ActiveModifiers") else { return };
        for change in table.changes() {
            // Keyframe snapshots are table state, not new modifier events.
            if change.kind == boon::entity::StringTableChangeKind::Snapshot {
                continue;
            }
            let Some(data) = change.entry.user_data.as_deref().filter(|d| !d.is_empty()) else { continue };
            let Ok(d) = boon_proto::proto::CModifierTableEntry::decode(data) else { continue };
            let Some(serial) = d.serial_number else { continue };
            if d.entry_type.unwrap_or(1) == 2 {
                if let Some((parent, stack_count)) = self.live.remove(&serial) {
                    out.push(ModChange { kind: ModifierChangeKind::Removed, serial, entry: Entry { parent, stack_count, ..Entry::default() } });
                }
                continue;
            }
            match self.live.entry(serial) {
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert((d.parent, d.stack_count));
                    let entry = Entry { parent: d.parent, caster: d.caster, modifier_subclass: d.modifier_subclass, ability_subclass: d.ability_subclass, stack_count: d.stack_count };
                    out.push(ModChange { kind: ModifierChangeKind::Applied, serial, entry });
                }
                std::collections::hash_map::Entry::Occupied(mut slot) => {
                    let (parent, stacks) = slot.get_mut();
                    let changed = d.parent.is_some_and(|p| *parent != Some(p)) || d.stack_count.is_some_and(|c| *stacks != Some(c));
                    *parent = d.parent.or(*parent);
                    *stacks = d.stack_count.or(*stacks);
                    if changed {
                        out.push(ModChange { kind: ModifierChangeKind::Changed, serial, entry: Entry { parent: *parent, stack_count: *stacks, ..Entry::default() } });
                    }
                }
            }
        }
    }
}

/// A modifier being watched: an icon-shown one on a hero.
struct Open {
    start: f32,
    player: i32,
    caster: Option<i32>,
    id: u32,
    ability: u32,
    stacks: u32,
}

/// A cast waiting for its ability entity's cooldown.
struct Pending {
    cast: usize,
    game: f64,
}

/// Format 7's reads over the match. Call [`HeroTracker::modifiers`] on every tick (the modifier
/// table is a delta stream) and [`HeroTracker::tick`] on every tick of the match.
#[derive(Default)]
pub struct HeroTracker {
    keys: Option<Keys>,
    ability_keys: HashMap<String, Option<AbilityKeys>>,
    mods: Modifiers,
    changes: Vec<ModChange>,
    open: HashMap<u32, Open>,
    pending: Vec<Pending>,
    /// (player, token) → the ability entity's index and keys, refreshed once a second.
    entity_of: HashMap<(i32, u32), (i32, AbilityKeys)>,
    /// Tokens worth watching charges on, per player: bought, levelled or cast.
    tracked: HashSet<(i32, u32)>,
    charges: HashMap<i32, u32>,
    cc_bits: HashMap<i32, u16>,
    zip: HashMap<i32, u8>,
    upgrade_info: HashMap<(i32, u32), u32>,
    last_s: i64,
    last_ds: i64,
    pub data: HeroData,
}

impl HeroTracker {
    pub fn new() -> HeroTracker {
        HeroTracker { last_s: -1, last_ds: -1, ..Default::default() }
    }

    /// Merge this tick's modifier-table deltas, kept for the next [`HeroTracker::tick`] (those
    /// before the match starts open there, at 0).
    pub fn modifiers(&mut self, ctx: &boon::Context) {
        self.mods.update(ctx, &mut self.changes);
    }

    /// The reads, with the effects still on a hero ending where the recording does.
    pub fn finish(mut self) -> HeroData {
        let end = self.data.end;
        let mut open: Vec<(u32, Open)> = self.open.drain().collect();
        open.sort_by_key(|(serial, _)| *serial);
        for (_, o) in open {
            self.data.effects.push(EffectObs { start: o.start, end, player: o.player, caster: o.caster, id: o.id, ability: o.ability, stacks: o.stacks });
        }
        self.data
    }

    /// One tick of the match at match-clock `game`; `start` is the game rules' start time (the
    /// abilities' cooldowns are on the server's clock).
    pub fn tick(&mut self, ctx: &boon::Context, events: &[boon::GameEvent], game: f64, start: f64) {
        let k = self.keys.get_or_insert_with(|| Keys::resolve(ctx));
        let ents = ctx.entities();
        let g = game as f32;
        self.data.end = g;
        // Pawn index → (player, team).
        let mut by_pawn: HashMap<i32, (i32, i64)> = HashMap::new();
        // Controllers are the entities just past the world, one per player slot.
        let controllers: Vec<&boon::Entity> = (1..=MAX_SLOTS).filter_map(|i| ents.get(i)).filter(|e| e.class_name.as_ref() == CONTROLLER).collect();
        for e in &controllers {
            if let Some(p) = e.get_handle(k.ctrl_pawn).and_then(|h| ents.get_by_handle(h)).filter(|p| p.class_name.as_ref() == PAWN) {
                by_pawn.insert(p.index, (e.index, e.get_i64(k.ctrl_team)));
            }
        }
        let hero_at = |idx: i32| by_pawn.get(&idx).copied();
        let hero_of = |h: Option<u32>| h.and_then(|h| ents.get_by_handle(h)).and_then(|e| hero_at(e.index));

        for e in events {
            match e.msg_type {
                ABILITIES_CHANGED => {
                    let Ok(m) = boon_proto::proto::CCitadelUserMsgAbilitiesChanged::decode(&e.payload[..]) else { continue };
                    let (Some(slot), Some(id)) = (m.purchaser_player_slot.filter(|s| *s >= 0), m.ability_id) else { continue };
                    // A player slot's controller is the entity one past it.
                    let player = slot + 1;
                    self.tracked.insert((player, id));
                    self.data.items.push(ItemObs { game: g, player, id, change: m.change.unwrap_or(-1) });
                }
                ITEM_PURCHASE => {
                    let Ok(m) = boon_proto::proto::CCitadelUserMessageItemPurchaseNotification::decode(&e.payload[..]) else { continue };
                    if let (Some(true), Some(id)) = (m.sell, m.ability_id) {
                        self.data.sells.push(SellObs { game: g, id });
                    }
                }
                IMPORTANT_ABILITY_USED => {
                    let Ok(m) = boon_proto::proto::CCitadelUserMessageImportantAbilityUsed::decode(&e.payload[..]) else { continue };
                    let Some(name) = m.ability_name else { continue };
                    // The caster's pawn, else the player's controller.
                    let player = hero_of(m.caster).map(|h| h.0).or_else(|| m.player.and_then(|h| ents.get_by_handle(h)).filter(|c| c.class_name.as_ref() == CONTROLLER).map(|c| c.index));
                    let Some(player) = player else { continue };
                    let id = token(&name);
                    self.tracked.insert((player, id));
                    self.pending.push(Pending { cast: self.data.casts.len(), game });
                    self.data.casts.push(CastObs { game: g, player, id, cd_end: None });
                }
                DAMAGE => {
                    let Ok(m) = boon_proto::proto::CCitadelUserMessageDamage::decode(&e.payload[..]) else { continue };
                    let Some((victim, _)) = m.entindex_victim.and_then(hero_at) else { continue };
                    let damage = m.damage.unwrap_or(0).max(0) as u32;
                    let attacker = m.entindex_attacker.and_then(hero_at).map(|h| h.0);
                    self.data.damage.push(DamageObs { game: g, victim, attacker, ability: m.ability_id.unwrap_or(0), damage, lethal: damage > 0 && m.victim_health_new == Some(0), npc: if attacker.is_some() { None } else { crate::timeline::npc_kind(m.attacker_class, m.attacker_subclass) } });
                }
                _ => {}
            }
        }

        // The modifier table: icon-shown effects on heroes, and enemy applications for CC.
        for c in std::mem::take(&mut self.changes) {
            let Some((player, team)) = hero_of(c.entry.parent) else { continue };
            let id = c.entry.modifier_subclass.unwrap_or(0);
            match c.kind {
                ModifierChangeKind::Applied => {
                    let caster = hero_of(c.entry.caster);
                    let ability = c.entry.ability_subclass.unwrap_or(0);
                    if let Some((by, _)) = caster.filter(|(_, t)| *t != team) {
                        self.data.applied.push(ApplyObs { game: g, player, caster: by, id, ability });
                    }
                    if ICON_MODIFIERS.binary_search(&id).is_ok() {
                        let stacks = c.entry.stack_count.unwrap_or(0).max(0) as u32;
                        self.open.insert(c.serial, Open { start: g, player, caster: caster.map(|h| h.0), id, ability, stacks });
                    }
                }
                ModifierChangeKind::Changed => {
                    if let Some(o) = self.open.get_mut(&c.serial) {
                        o.stacks = o.stacks.max(c.entry.stack_count.unwrap_or(0).max(0) as u32);
                    }
                }
                ModifierChangeKind::Removed => {
                    if let Some(o) = self.open.remove(&c.serial) {
                        self.data.effects.push(EffectObs { start: o.start, end: g, player: o.player, caster: o.caster, id: o.id, ability: o.ability, stacks: o.stacks });
                    }
                }
            }
        }

        // The pawns: hard-CC bits and zipline rides, every tick.
        for (&pawn, &(player, _)) in &by_pawn {
            let Some(p) = ents.get(pawn) else { continue };
            let words: Vec<u64> = k.mask.iter().map(|w| p.get_i64(*w) as u64).collect();
            let mut bits = 0u16;
            for (i, b) in CC_STATES.iter().enumerate() {
                if words.get(*b as usize / 32).is_some_and(|w| w >> (b % 32) & 1 == 1) {
                    bits |= 1 << i;
                }
            }
            if self.cc_bits.get(&player).copied().unwrap_or(0) != bits {
                self.cc_bits.insert(player, bits);
                self.data.cc.push(CcObs { game: g, player, bits });
            }
            let zip = u8::from(p.get_i64(k.zip) != 0);
            if self.zip.get(&player).copied().unwrap_or(0) != zip {
                self.zip.insert(player, zip);
                self.data.zip.push(StateObs { game: g, player, value: zip });
            }
        }

        // Once a second: ability levels, and which entities are whose abilities and items.
        let s = game.floor() as i64;
        if s != self.last_s {
            self.last_s = s;
            for c in &controllers {
                let n = (c.get_i64(k.upgrades).max(0) as usize).min(k.upgrade.len());
                for [item, info] in &k.upgrade[..n] {
                    let (id, info) = (c.get_i64(*item) as u32, c.get_i64(*info) as u32);
                    if id != 0 && self.upgrade_info.insert((c.index, id), info) != Some(info) {
                        self.tracked.insert((c.index, id));
                        self.data.levels.push(LevelObs { game: g, player: c.index, id, info });
                    }
                }
            }
            self.entity_of.clear();
            for (_, e) in ents.iter() {
                let class = e.class_name.as_ref();
                let ak = match self.ability_keys.get(class) {
                    Some(ak) => *ak,
                    None => {
                        let ak = ctx.serializers().get(class).and_then(|s| {
                            let f = |p: &str| s.resolve_field_key(p);
                            Some(AbilityKeys { owner: Some(f("m_hOwnerEntity")?), sub: Some(f("m_nSubclassID")?), cd_start: f("m_flCooldownStart"), cd_end: f("m_flCooldownEnd"), charges: f("m_iRemainingCharges") })
                        });
                        self.ability_keys.insert(class.to_owned(), ak);
                        ak
                    }
                };
                let Some(ak) = ak else { continue };
                let Some((player, _)) = e.get_handle(ak.owner).and_then(|h| ents.get_by_handle(h)).and_then(|o| hero_at(o.index)) else { continue };
                self.entity_of.insert((player, e.get_i64(ak.sub) as u32), (e.index, ak));
            }
        }

        // Every tenth of a second: charges, and waiting casts' cooldowns.
        let d = (game * 10.0).floor() as i64;
        if d == self.last_ds {
            return;
        }
        self.last_ds = d;
        // In key order: the map's own order is random, which shuffled a player's same-tenth
        // charge reads from run to run (docs/tech-debt.md TD-24).
        let mut watched: Vec<_> = self.entity_of.iter().filter(|(k, _)| self.tracked.contains(k)).collect();
        watched.sort_unstable_by_key(|(k, _)| **k);
        for (&(player, id), &(index, ak)) in watched {
            let Some(e) = ents.get(index) else { continue };
            let n = e.get_i64(ak.charges).max(0) as u32;
            let last = self.charges.insert(index, n);
            if last.map_or(n > 0, |l| l != n) {
                self.data.charges.push(ChargeObs { game: g, player, id, charges: n });
            }
        }
        let casts = &mut self.data.casts;
        let entity_of = &self.entity_of;
        self.pending.retain(|p| {
            let c = &mut casts[p.cast];
            if let Some((e, ak)) = entity_of.get(&(c.player, c.id)).and_then(|(i, ak)| Some((ents.get(*i)?, ak))) {
                let (from, to) = (f64::from(e.get_f32(ak.cd_start)) - start, f64::from(e.get_f32(ak.cd_end)) - start);
                if from >= p.game - f64::from(CAST_EARLY_S) && to > from && to.is_finite() {
                    c.cd_end = Some(to as f32);
                    return false;
                }
            }
            game - p.game <= CAST_WAIT_S
        });
    }
}

/// The FOW entry's `m_eHeight` for a hero on its own team's feed, where it changes (called by
/// `parse::vision_tick`).
pub fn height(data: &mut HeroData, last: &mut HashMap<i32, u8>, game: f32, player: i32, level: i64) {
    let v = level.clamp(0, 2) as u8;
    if last.insert(player, v).unwrap_or(0) != v {
        data.height.push(StateObs { game, player, value: v });
    }
}

