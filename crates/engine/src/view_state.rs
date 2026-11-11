//! The registry of view state (spec §8 "Follow mode"): every piece of "what you see" that isn't
//! the document, with what following does with it. One row per key says whether a follower
//! mirrors it, where presence carries it, what comes back when the follow stops, and what a
//! follower's own change does. The web client's store (`web/src/player/viewstate.ts`) is built
//! from the generated copy (`web/src/gen/viewState.ts`), so a new key is one row here and one
//! value in the store: the wire bits, the follower's apply and restore, and the tests come from
//! the row. Plan: docs/plans/2026-11-11-view-state-sync.md.

use crate::wire::{LAYER_CC, LAYER_CRATES, LAYER_HEALS, LAYER_HEALTH, LAYER_MOVEMENT, LAYER_PINGS, LAYER_TROOPERS, MAX_EVENT_SEARCH, MAX_HERO_PANELS, PLACE_SCALE};

/// Who sees a key's value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sync {
    /// A follower shows its presenter's value while following.
    Shared,
    /// Each browser's own on purpose, never on the wire (say why in `note`).
    Personal,
}

/// What a key's value is. Each kind has one codec in the client's store and one bound here
/// (`Presence::is_valid`). Keep the list short (plan §3): a kind that needs logic of its own to
/// apply, like the playback clock or the jump, stays outside the registry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// On or off.
    Bool,
    /// One of a few named values, the first the default: `(value, how presence carries it)`,
    /// `None` for the default (left out, or `null`).
    Choice(&'static [(&'static str, Option<&'static str>)]),
    /// A roster slot (`SlotRef`; `slot < MAX_SLOT`), or none.
    Slot,
    /// One hero's death (`DeathRef`; `slot < MAX_SLOT`, `t <= 86_400`), or none.
    Death,
    /// Deaths open together, presence carrying the last opened: a presenter's change closes
    /// the one it sent before and opens the new one; the follower's own others stay open.
    Deaths,
    /// Text a person typed: at most `max` bytes, no control characters (`wire::text_ok`).
    Text { max: usize },
    /// Where a panel sits in the board pane (`PanelPlace`: fractions of the pane from its
    /// nearer edges, each `<= PLACE_SCALE`), or none: where it opens.
    Place,
    /// The hero panels open, back to front, each with its place (`HeroPanel`; at most
    /// `MAX_HERO_PANELS`, each slot once).
    HeroPanels { max: usize },
}

/// Where presence carries a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wire {
    /// Not sent.
    None,
    /// One bit of an integer field of `Presence` (a dotted path from its root). Unknown bits
    /// are ignored, so a later key takes the next bit. `omit_zero`: the field is left out when
    /// no bit is set (else it is always sent, and its absence means an older client).
    Bit { field: &'static str, mask: u32, omit_zero: bool },
    /// A value at a dotted path, always sent while its parent is (a follower tells "the
    /// default" from "an older client" by the parent being there).
    Value { field: &'static str },
    /// A value at a dotted path, left out when it is the default (presence is resent whole on
    /// every cursor move, so a closed panel costs nothing).
    Optional { field: &'static str },
}

/// What a follower's value is once the follow stops (or the presenter leaves).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unfollow {
    /// Stop following (the button) or the presenter leaving: its own value from before comes
    /// back untouched. Its own change that stops the follow keeps what it saw (operator
    /// 2026-11-11: "they keep everything they were seeing, plus that one change").
    Restore,
    /// It stays as the presenter left it.
    Keep,
}

/// What a follower changing the value itself means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Override {
    /// A change to what you see: following stops (spec §8), and the follower keeps everything
    /// it was seeing with that one change. The store stops the follow itself.
    Stop,
    /// Yours until the presenter's next change to the key's group; following goes on.
    Local,
}

#[derive(Clone, Copy, Debug)]
pub struct ViewKey {
    pub key: &'static str,
    pub sync: Sync,
    pub kind: Kind,
    pub wire: Wire,
    pub unfollow: Unfollow,
    pub on_override: Override,
    /// `Local` keys only: the keys a presenter's change applies together. A follower applies a
    /// group only when the presenter's values for it change, so its own stays until then.
    pub group: Option<&'static str>,
    /// The value goes back to its first when another match opens (it names that match's
    /// deaths or slots).
    pub reset_on_match: bool,
    /// Why, for a reader of the table (the spec has the detail).
    pub note: &'static str,
}

const fn layer(key: &'static str, mask: u8) -> ViewKey {
    ViewKey {
        key,
        sync: Sync::Shared,
        kind: Kind::Bool,
        wire: Wire::Bit { field: "layers", mask: mask as u32, omit_zero: false },
        unfollow: Unfollow::Restore,
        on_override: Override::Stop,
        group: None,
        reset_on_match: false,
        note: "Map layers toggle",
    }
}

/// A panel (spec §8): open and closed with the presenter; a follower's own until the
/// presenter's next panel change; stopping leaves it; gone with the match.
const fn panel(key: &'static str, kind: Kind, field: &'static str, note: &'static str) -> ViewKey {
    ViewKey { key, sync: Sync::Shared, kind, wire: Wire::Optional { field }, unfollow: Unfollow::Keep, on_override: Override::Local, group: Some("panels"), reset_on_match: true, note }
}

/// The events list's filter chips, in the order of `events.ts` `GROUPS`; chip `i` is bit `i` of
/// `playback.event_filters`. Append only.
pub const EVENT_GROUPS: [&str; 9] = ["death", "ult", "objective", "mid_boss", "rift", "powerup", "urn", "souls", "purchase"];

const fn filter(key: &'static str, bit: u32) -> ViewKey {
    ViewKey {
        key,
        sync: Sync::Shared,
        kind: Kind::Bool,
        wire: Wire::Bit { field: "playback.event_filters", mask: 1 << bit, omit_zero: true },
        unfollow: Unfollow::Keep,
        on_override: Override::Local,
        group: Some("events"),
        reset_on_match: false,
        note: "Events filter chip (operator 2026-11-11: shared)",
    }
}

/// Vision's choices: presence carries the team as `Team` serialises, null for All.
pub const VISIONS: &[(&str, Option<&str>)] = &[("all", None), ("amber", Some("Amber")), ("sapphire", Some("Sapphire"))];
/// The hero build's popovers (`wire::BuildPopover`), none open by default.
pub const POPOVERS: &[(&str, Option<&str>)] = &[("none", None), ("effects", Some("effects")), ("order", Some("order"))];

/// Every registered key. Append; a key's name and bit never change once shipped.
pub const VIEW_STATE: &[ViewKey] = &[
    layer("layer.troopers", LAYER_TROOPERS),
    layer("layer.health", LAYER_HEALTH),
    layer("layer.pings", LAYER_PINGS),
    layer("layer.cc", LAYER_CC),
    layer("layer.movement", LAYER_MOVEMENT),
    layer("layer.heals", LAYER_HEALS),
    layer("layer.crates", LAYER_CRATES),
    panel("builds.all", Kind::Bool, "playback.all_builds", "All builds open (the button; Tab held is sent as the same flag)"),
    ViewKey {
        key: "names",
        sync: Sync::Personal,
        kind: Kind::Bool,
        wire: Wire::None,
        unfollow: Unfollow::Keep,
        on_override: Override::Local,
        group: None,
        reset_on_match: false,
        note: "Player names: off for recording without them, so never followed",
    },
    ViewKey {
        key: "vision.team",
        sync: Sync::Shared,
        kind: Kind::Choice(VISIONS),
        wire: Wire::Value { field: "playback.vision.team" },
        unfollow: Unfollow::Restore,
        on_override: Override::Stop,
        group: None,
        reset_on_match: false,
        note: "Whose vision the map draws (spec §6b \"Vision\")",
    },
    ViewKey {
        key: "vision.last_seen",
        sync: Sync::Shared,
        kind: Kind::Bool,
        wire: Wire::Value { field: "playback.vision.last_seen" },
        unfollow: Unfollow::Restore,
        on_override: Override::Stop,
        group: None,
        reset_on_match: false,
        note: "Show last seen location",
    },
    panel("recap.skull", Kind::Death, "playback.skull_recap", "The death recap open on the map (a skull's card)"),
    panel("recap.event", Kind::Deaths, "playback.event_recap", "The events list's open recaps (the last opened on the wire)"),
    panel("builds.inspect", Kind::Slot, "playback.inspect", "The hero whose build the top bar has open"),
    panel("builds.popover", Kind::Choice(POPOVERS), "playback.build_popover", "Effects or Build order open in that build (operator 2026-11-11: shared)"),
    panel("recap.skull.place", Kind::Place, "playback.skull_place", "Where the death recap on the map was moved to (#35)"),
    // Sent whenever playback is (`[]` for none): an older presenter leaves it out, and its
    // follower keeps its own hero panels.
    ViewKey {
        wire: Wire::Value { field: "playback.hero_panels" },
        ..panel("heroes.panels", Kind::HeroPanels { max: MAX_HERO_PANELS }, "playback.hero_panels", "The hero panels open from the map's tokens, and where (#37)")
    },
    filter("events.filter.death", 0),
    filter("events.filter.ult", 1),
    filter("events.filter.objective", 2),
    filter("events.filter.mid_boss", 3),
    filter("events.filter.rift", 4),
    filter("events.filter.powerup", 5),
    filter("events.filter.urn", 6),
    filter("events.filter.souls", 7),
    filter("events.filter.purchase", 8),
    ViewKey {
        key: "events.search",
        sync: Sync::Shared,
        kind: Kind::Text { max: MAX_EVENT_SEARCH },
        wire: Wire::Optional { field: "playback.event_search" },
        unfollow: Unfollow::Keep,
        on_override: Override::Local,
        group: Some("events"),
        reset_on_match: false,
        note: "The events list's search (operator 2026-11-11: shared)",
    },
];

/// The `Presence` fields (dotted paths in its JSON) that are not registry keys, each with why.
/// `Wired` ones are view state a follower mirrors through hand-written code in host.ts or
/// Board.tsx: the migration list. A new `Presence` or `Playback` field must be a registry row's
/// wire field or be listed here, or `every_presence_field_is_classified` fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outside {
    /// Who the person is, or what their hands are doing: drawn as theirs, never mirrored.
    Person,
    /// Follow's own plumbing, or state with apply logic of its own: the playback clock
    /// (`clock.ts`) and the jump (a ring and a pinned row, host.ts `mirror`).
    Core,
    /// The board's view state, mirrored by hand in Board.tsx and HoverLabel.tsx: the oldest and
    /// best-tested follow code, left there (operator 2026-11-11, plan step 5).
    Wired,
}

pub const OUTSIDE: &[(&str, Outside)] = &[
    ("name", Outside::Person),
    ("color", Outside::Person),
    ("cursor", Outside::Person),
    ("laser", Outside::Person),
    ("laser_starts", Outside::Person),
    ("laser_color", Outside::Person),
    ("drag", Outside::Person),
    ("drag_group", Outside::Person),
    ("picked", Outside::Person),
    ("focus", Outside::Person),
    ("ink", Outside::Person),
    ("ping", Outside::Person),
    ("following", Outside::Core),
    ("playback.player", Outside::Core),
    ("playback.match_id", Outside::Core),
    ("playback.t", Outside::Core),
    ("playback.playing", Outside::Core),
    ("playback.speed", Outside::Core),
    ("scene", Outside::Wired),
    ("floor", Outside::Wired),
    ("view", Outside::Wired),
    ("hover", Outside::Wired),
    ("playback.jump", Outside::Core),
];

/// The registry as a TypeScript module, `web/src/gen/viewState.ts` (`just ts` writes it): the
/// client's store reads its keys, kinds, wire places and policies from here, so they aren't
/// listed twice.
pub fn to_ts() -> String {
    let mut out = String::from(
        "// Generated from crates/engine/src/view_state.rs `VIEW_STATE` by `just ts`. Do not edit.\n\n\
         /** Every view-state key: who sees it, its kind (`options` and how presence `wires` each, for\n \
         * a choice), where presence carries it (`field`, with `mask` for one bit of an integer; `omit`:\n \
         * left out when the default), what stopping a follow does, what a follower's own change does,\n \
         * the group a presenter's change applies as, and whether another match resets it. */\n\
         export const VIEW_STATE = {\n",
    );
    let q = |s: &str| format!("\"{s}\"");
    for k in VIEW_STATE {
        let (field, mask, omit) = match k.wire {
            Wire::None => ("null".to_owned(), "null".to_owned(), false),
            Wire::Bit { field, mask, omit_zero } => (q(field), mask.to_string(), omit_zero),
            Wire::Value { field } => (q(field), "null".to_owned(), false),
            Wire::Optional { field } => (q(field), "null".to_owned(), true),
        };
        let kind = match k.kind {
            Kind::Bool => "kind: \"bool\"".to_owned(),
            Kind::Choice(opts) => format!(
                "kind: \"choice\", options: [{}], wires: [{}]",
                opts.iter().map(|(v, _)| q(v)).collect::<Vec<_>>().join(", "),
                opts.iter().map(|(_, w)| w.map_or("null".to_owned(), q)).collect::<Vec<_>>().join(", ")
            ),
            Kind::Slot => "kind: \"slot\"".to_owned(),
            Kind::Death => "kind: \"death\"".to_owned(),
            Kind::Deaths => "kind: \"deaths\"".to_owned(),
            Kind::Text { max } => format!("kind: \"text\", max: {max}"),
            Kind::Place => format!("kind: \"place\", scale: {PLACE_SCALE}"),
            Kind::HeroPanels { max } => format!("kind: \"heroes\", max: {max}, scale: {PLACE_SCALE}"),
        };
        let sync = match k.sync {
            Sync::Shared => "shared",
            Sync::Personal => "personal",
        };
        let unfollow = match k.unfollow {
            Unfollow::Restore => "restore",
            Unfollow::Keep => "keep",
        };
        let over = match k.on_override {
            Override::Stop => "stop",
            Override::Local => "local",
        };
        let group = k.group.map_or("null".to_owned(), q);
        out.push_str(&format!(
            "  \"{}\": {{ sync: \"{sync}\", {kind}, field: {field}, mask: {mask}, omit: {omit}, unfollow: \"{unfollow}\", override: \"{over}\", group: {group}, reset: {} }},\n",
            k.key, k.reset_on_match
        ));
    }
    out.push_str("} as const;\n\nexport type ViewKey = keyof typeof VIEW_STATE;\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{BuildPopover, DeathRef, DragPreview, Floor, HeroPanel, Jump, LiveInk, PanelPlace, Ping, Playback, PlayerVision, Presence, SlotRef, Viewport};
    use mapcro_schema::{Team, WorldPos};
    use std::collections::BTreeSet;

    const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/src/gen/viewState.ts");

    #[cfg(feature = "ts")]
    #[test]
    fn export_bindings_view_state() {
        std::fs::create_dir_all(std::path::Path::new(PATH).parent().expect("dir")).expect("gen dir");
        std::fs::write(PATH, to_ts()).expect("write viewState.ts");
    }

    #[cfg(not(feature = "ts"))]
    #[test]
    fn the_web_client_has_this_registry() {
        assert_eq!(std::fs::read_to_string(PATH).expect("web/src/gen/viewState.ts"), to_ts(), "stale: run `just ts`");
    }

    /// A presence with every field set. No `..Default::default()`, here or in the playback: a new
    /// field doesn't compile until it is set here, and then it must be classified below.
    fn full() -> Presence {
        let at = WorldPos { x: 1, y: 2 };
        let slot = SlotRef { team: Team::Amber, slot: 1 };
        let death = DeathRef { team: Team::Amber, slot: 1, t: 3 };
        Presence {
            name: "n".into(),
            color: 1,
            scene: Some(mapcro_schema::RecordId(7)),
            floor: Floor::Surface,
            view: Some(Viewport { center: at, zoom: 1000, side: Team::Amber }),
            cursor: Some(at),
            laser: vec![at, at],
            laser_starts: vec![1],
            drag: Some(DragPreview { id: mapcro_schema::RecordId(7), pos: at, end: None }),
            drag_group: vec![mapcro_schema::RecordId(8)],
            picked: Vec::new(),
            focus: Some(mapcro_schema::RecordId(7)),
            following: Some(1),
            ink: Some(LiveInk { color: 1, points: vec![at] }),
            ping: Some(Ping { at, n: 1 }),
            laser_color: Some(1),
            playback: Some(Playback {
                player: true,
                match_id: 1,
                t: 1.0,
                playing: true,
                speed: 1.0,
                jump: Some(Jump { key: "k".into(), at: 1.0 }),
                vision: Some(PlayerVision { team: None, last_seen: true }),
                skull_recap: Some(death),
                event_recap: Some(death),
                inspect: Some(slot),
                all_builds: true,
                build_popover: Some(BuildPopover::Order),
                event_filters: 1,
                event_search: Some("q".into()),
                skull_place: Some(PanelPlace { x: 1, y: 2, right: true, bottom: false }),
                hero_panels: Some(vec![HeroPanel { team: Team::Sapphire, slot: 2, at: None }]),
            }),
            hover: Some("marker:k".into()),
            layers: Some(0x7f),
        }
    }

    fn wire_field(k: &ViewKey) -> Option<&'static str> {
        match k.wire {
            Wire::None => None,
            Wire::Bit { field, .. } | Wire::Value { field } | Wire::Optional { field } => Some(field),
        }
    }

    /// The `Presence` field a key's path is in: `playback.vision.team` is in `playback.vision`.
    fn presence_field(path: &str) -> String {
        let parts: Vec<&str> = path.split('.').collect();
        let n = if parts[0] == "playback" { 2 } else { 1 };
        parts[..n.min(parts.len())].join(".")
    }

    #[test]
    fn every_presence_field_is_classified() {
        let json = serde_json::to_value(full()).expect("json");
        let mut fields = BTreeSet::new();
        for (k, v) in json.as_object().expect("object") {
            if k == "playback" {
                fields.extend(v.as_object().expect("playback").keys().map(|p| format!("playback.{p}")));
            } else {
                fields.insert(k.clone());
            }
        }
        let registered: BTreeSet<String> = VIEW_STATE.iter().filter_map(wire_field).map(presence_field).collect();
        let outside: BTreeSet<String> = OUTSIDE.iter().map(|(f, _)| (*f).to_owned()).collect();
        for f in &fields {
            assert!(
                registered.contains(f) != outside.contains(f),
                "presence field `{f}` must be exactly one of: a VIEW_STATE row's wire field (a follower mirrors it), or an OUTSIDE entry with why not (crates/engine/src/view_state.rs)"
            );
        }
        for f in registered.iter().chain(&outside) {
            assert!(fields.contains(f), "`{f}` is not a field of Presence");
        }
        // A nested path names a field of that object, as the client's codec reads it.
        for k in VIEW_STATE {
            let Some(path) = wire_field(k) else { continue };
            let mut at = &json;
            for part in path.split('.') {
                at = at.get(part).unwrap_or_else(|| panic!("{}: `{path}` is not in a full presence", k.key));
            }
        }
    }

    #[test]
    fn rows_are_well_formed() {
        let keys: BTreeSet<&str> = VIEW_STATE.iter().map(|k| k.key).collect();
        assert_eq!(keys.len(), VIEW_STATE.len(), "a key twice");
        let mut bits = BTreeSet::new();
        let mut values = BTreeSet::new();
        for k in VIEW_STATE {
            match (k.sync, k.wire) {
                (Sync::Personal, Wire::None) => assert!(!k.note.is_empty(), "{}: a personal key says why", k.key),
                (Sync::Shared, Wire::Bit { field, mask, .. }) => {
                    assert_eq!(k.kind, Kind::Bool, "{}: a bit is a boolean", k.key);
                    assert_eq!(mask.count_ones(), 1, "{}: one bit", k.key);
                    assert!(mask < 1 << field_width(field), "{}: bit {mask} doesn't fit {field}", k.key);
                    assert!(bits.insert((field, mask)), "{}: bit {mask} of {field} taken", k.key);
                }
                (Sync::Shared, Wire::Value { field } | Wire::Optional { field }) => assert!(values.insert(field), "{}: {field} taken", k.key),
                _ => panic!("{}: a shared key has a wire field and a personal one has none", k.key),
            }
            // A local key is applied as a group (so a follower's own stays until the presenter's
            // next change); a stop key needs none: a follower's change ends the follow.
            match k.on_override {
                Override::Local if k.sync == Sync::Shared => assert!(k.group.is_some(), "{}: a local key names its group", k.key),
                _ => assert!(k.group.is_none(), "{}: only a shared local key has a group", k.key),
            }
            if let Kind::Choice(opts) = k.kind {
                assert!(opts.len() >= 2 && opts[0].1.is_none() && opts[1..].iter().all(|(_, w)| w.is_some()), "{}: the first choice is the default, sent as none", k.key);
            }
        }
        assert!(bits.iter().all(|(f, _)| !values.contains(f)), "a field is bits or a value, not both");
        let omits: BTreeSet<(&str, bool)> = VIEW_STATE.iter().filter_map(|k| if let Wire::Bit { field, omit_zero, .. } = k.wire { Some((field, omit_zero)) } else { None }).collect();
        let fields: BTreeSet<&str> = omits.iter().map(|(f, _)| *f).collect();
        assert_eq!(omits.len(), fields.len(), "a bit field's keys agree on whether it is left out at zero");
    }

    /// The width of an integer field the registry puts bits in.
    fn field_width(field: &str) -> u32 {
        match field {
            "layers" => u8::BITS,
            "playback.event_filters" => u16::BITS,
            other => panic!("{other}: not a bit field of Presence"),
        }
    }

    #[test]
    fn the_layer_bits_are_the_ones_shipped() {
        let mask = |key: &str| match VIEW_STATE.iter().find(|k| k.key == key).map(|k| k.wire) {
            Some(Wire::Bit { field: "layers", mask, omit_zero: false }) => mask,
            other => panic!("{key}: {other:?}"),
        };
        let shipped = [("troopers", 1), ("health", 2), ("pings", 4), ("cc", 8), ("movement", 16), ("heals", 32), ("crates", 64)];
        for (name, bit) in shipped {
            assert_eq!(mask(&format!("layer.{name}")), bit);
        }
    }

    #[test]
    fn the_events_filters_are_a_bit_each_in_group_order() {
        for (i, g) in EVENT_GROUPS.iter().enumerate() {
            let k = VIEW_STATE.iter().find(|k| k.key == format!("events.filter.{g}")).unwrap_or_else(|| panic!("no key for {g}"));
            assert_eq!(k.wire, Wire::Bit { field: "playback.event_filters", mask: 1 << i, omit_zero: true }, "{g}");
        }
        assert_eq!(VIEW_STATE.iter().filter(|k| k.key.starts_with("events.filter.")).count(), EVENT_GROUPS.len());
    }

    #[test]
    fn choices_are_carried_as_presence_serialises_them() {
        use mapcro_schema::Team;
        let team = |t: Team| serde_json::to_value(t).expect("team");
        assert_eq!(VISIONS.iter().map(|(_, w)| w.map(|w| serde_json::json!(w))).collect::<Vec<_>>(), vec![None, Some(team(Team::Amber)), Some(team(Team::Sapphire))]);
        let pop = |p: BuildPopover| serde_json::to_value(p).expect("popover");
        assert_eq!(POPOVERS.iter().map(|(_, w)| w.map(|w| serde_json::json!(w))).collect::<Vec<_>>(), vec![None, Some(pop(BuildPopover::Effects)), Some(pop(BuildPopover::Order))]);
        // The text bound is the one `is_valid` checks.
        let search = VIEW_STATE.iter().find(|k| k.key == "events.search").expect("events.search");
        assert_eq!(search.kind, Kind::Text { max: crate::wire::MAX_EVENT_SEARCH });
        let heroes = VIEW_STATE.iter().find(|k| k.key == "heroes.panels").expect("heroes.panels");
        assert_eq!(heroes.kind, Kind::HeroPanels { max: MAX_HERO_PANELS });
    }
}
