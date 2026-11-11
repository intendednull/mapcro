//! The registry of view state (spec §8 "Follow mode"): every piece of "what you see" that isn't
//! the document, with what following does with it. One row per key says whether a follower
//! mirrors it, where presence carries it, what comes back when the follow stops, and what a
//! follower's own change does. The web client's store (`web/src/player/viewstate.ts`) is built
//! from the generated copy (`web/src/gen/viewState.ts`), so a new key is one row here and one
//! value in the store: the wire bits, the follower's apply and restore, and the tests come from
//! the row. Plan: docs/plans/2026-11-11-view-state-sync.md.

use crate::wire::{LAYER_CC, LAYER_CRATES, LAYER_HEALS, LAYER_HEALTH, LAYER_MOVEMENT, LAYER_PINGS, LAYER_TROOPERS};

/// Who sees a key's value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sync {
    /// A follower shows its presenter's value while following.
    Shared,
    /// Each browser's own on purpose, never on the wire (say why in `note`).
    Personal,
}

/// Where presence carries a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wire {
    /// Not sent.
    None,
    /// One bit of an integer field of `Presence` (a dotted path from its root).
    Bit { field: &'static str, mask: u8 },
    /// A boolean field, left out when false.
    Flag { field: &'static str },
}

/// What a follower's value is once the follow stops (or the presenter leaves).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unfollow {
    /// Its own value from before comes back untouched.
    Restore,
    /// It stays as the presenter left it.
    Keep,
}

/// What a follower changing the value itself means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Override {
    /// A change to what you see: following stops (spec §8), and every `Stop` key in the same
    /// wire field keeps the presenter's value with that one change.
    Stop,
    /// Yours until the presenter's next change; following goes on.
    Local,
}

#[derive(Clone, Copy, Debug)]
pub struct ViewKey {
    pub key: &'static str,
    pub sync: Sync,
    pub wire: Wire,
    pub unfollow: Unfollow,
    pub on_override: Override,
    /// Why, for a reader of the table (the spec has the detail).
    pub note: &'static str,
}

const fn layer(key: &'static str, mask: u8) -> ViewKey {
    ViewKey { key, sync: Sync::Shared, wire: Wire::Bit { field: "layers", mask }, unfollow: Unfollow::Restore, on_override: Override::Stop, note: "Map layers toggle" }
}

/// Every registered key. Append; a key's name and bit never change once shipped.
pub const VIEW_STATE: &[ViewKey] = &[
    layer("layer.troopers", LAYER_TROOPERS),
    layer("layer.health", LAYER_HEALTH),
    layer("layer.pings", LAYER_PINGS),
    layer("layer.cc", LAYER_CC),
    layer("layer.movement", LAYER_MOVEMENT),
    layer("layer.heals", LAYER_HEALS),
    layer("layer.crates", LAYER_CRATES),
    ViewKey {
        key: "builds.all",
        sync: Sync::Shared,
        wire: Wire::Flag { field: "playback.all_builds" },
        unfollow: Unfollow::Keep,
        on_override: Override::Local,
        note: "All builds open (the button; Tab held is sent as the same flag)",
    },
    ViewKey {
        key: "names",
        sync: Sync::Personal,
        wire: Wire::None,
        unfollow: Unfollow::Keep,
        on_override: Override::Local,
        note: "Player names: off for recording without them, so never followed",
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
    /// Follow's own plumbing, or the playback clock (mirrored by `clock.ts`, not a view key).
    Core,
    /// View state mirrored by hand today; to be moved into `VIEW_STATE`.
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
    ("playback.jump", Outside::Wired),
    ("playback.vision", Outside::Wired),
    ("playback.skull_recap", Outside::Wired),
    ("playback.event_recap", Outside::Wired),
    ("playback.inspect", Outside::Wired),
];

/// The registry as a TypeScript module, `web/src/gen/viewState.ts` (`just ts` writes it): the
/// client's store reads its keys, bits and policies from here, so they aren't listed twice.
pub fn to_ts() -> String {
    let mut out = String::from(
        "// Generated from crates/engine/src/view_state.rs `VIEW_STATE` by `just ts`. Do not edit.\n\n\
         /** Every view-state key: who sees it, where presence carries it (`field`, with `mask` for\n \
         * one bit of an integer), what stopping a follow does, and what a follower's own change does. */\n\
         export const VIEW_STATE = {\n",
    );
    for k in VIEW_STATE {
        let (field, mask) = match k.wire {
            Wire::None => ("null".to_owned(), "null".to_owned()),
            Wire::Bit { field, mask } => (format!("\"{field}\""), mask.to_string()),
            Wire::Flag { field } => (format!("\"{field}\""), "null".to_owned()),
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
        out.push_str(&format!("  \"{}\": {{ sync: \"{sync}\", field: {field}, mask: {mask}, unfollow: \"{unfollow}\", override: \"{over}\" }},\n", k.key));
    }
    out.push_str("} as const;\n\nexport type ViewKey = keyof typeof VIEW_STATE;\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{DeathRef, DragPreview, Floor, Jump, LiveInk, Ping, Playback, PlayerVision, Presence, SlotRef, Viewport};
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
            }),
            hover: Some("marker:k".into()),
            layers: Some(0x7f),
        }
    }

    fn wire_field(k: &ViewKey) -> Option<&'static str> {
        match k.wire {
            Wire::None => None,
            Wire::Bit { field, .. } | Wire::Flag { field } => Some(field),
        }
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
        let registered: BTreeSet<String> = VIEW_STATE.iter().filter_map(wire_field).map(str::to_owned).collect();
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
    }

    #[test]
    fn rows_are_well_formed() {
        let keys: BTreeSet<&str> = VIEW_STATE.iter().map(|k| k.key).collect();
        assert_eq!(keys.len(), VIEW_STATE.len(), "a key twice");
        let mut bits = BTreeSet::new();
        let mut flags = BTreeSet::new();
        for k in VIEW_STATE {
            match (k.sync, k.wire) {
                (Sync::Personal, Wire::None) => assert!(!k.note.is_empty(), "{}: a personal key says why", k.key),
                (Sync::Shared, Wire::Bit { field, mask }) => {
                    assert_eq!(mask.count_ones(), 1, "{}: one bit", k.key);
                    assert!(bits.insert((field, mask)), "{}: bit {mask} of {field} taken", k.key);
                }
                (Sync::Shared, Wire::Flag { field }) => assert!(flags.insert(field), "{}: {field} taken", k.key),
                _ => panic!("{}: a shared key has a wire field and a personal one has none", k.key),
            }
        }
        assert!(bits.iter().all(|(f, _)| !flags.contains(f)), "a field is bits or a flag, not both");
    }

    #[test]
    fn the_layer_bits_are_the_ones_shipped() {
        let mask = |key: &str| match VIEW_STATE.iter().find(|k| k.key == key).map(|k| k.wire) {
            Some(Wire::Bit { field: "layers", mask }) => mask,
            other => panic!("{key}: {other:?}"),
        };
        let shipped = [("troopers", 1), ("health", 2), ("pings", 4), ("cc", 8), ("movement", 16), ("heals", 32), ("crates", 64)];
        for (name, bit) in shipped {
            assert_eq!(mask(&format!("layer.{name}")), bit);
        }
    }
}
