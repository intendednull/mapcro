//! Token probe: every id a replay names an ability, item or modifier by, for checking an asset
//! pack's names table against (docs/research/status-effects.md §3). Read-only; prints to stdout.
//!
//! `cargo run -p mapcro-replay --release --example token_probe -- <replay.dem> [--any-parent]`
//!
//! Lines are `cast <name>` (the distinct `ImportantAbilityUsed` names), `ability <token>` (the
//! distinct `ability_subclass` of modifiers applied to, or changed on, a hero) and `modifier <token>` (their
//! `modifier_subclass`). No controller field is read, so no Steam id is.

use boon::Parser;
use boon::modifier_state::{ModifierChangeKind, ModifierState};
use prost::Message;
use std::collections::{BTreeSet, HashSet};

const PAWN: &str = "CCitadelPlayerPawn";
const IMPORTANT_ABILITY_USED: u32 = 365;

fn main() {
    let dem = std::env::args()
        .nth(1)
        .expect("usage: token_probe <replay.dem> [--any-parent]");
    let any_parent = std::env::args().nth(2).as_deref() == Some("--any-parent");
    let parser = Parser::from_file(std::path::Path::new(&dem)).expect("opens");
    let classes: HashSet<&str> = [PAWN].into_iter().collect();
    let mut state = ModifierState::default();
    let (mut casts, mut abilities, mut modifiers) =
        (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    parser
        .run_to_end_with_events_filtered(&classes, |ctx, events| {
            for e in events
                .iter()
                .filter(|e| e.msg_type == IMPORTANT_ABILITY_USED)
            {
                if let Ok(m) = boon_proto::proto::CCitadelUserMessageImportantAbilityUsed::decode(
                    &e.payload[..],
                ) && let Some(name) = m.ability_name
                {
                    casts.insert(name);
                }
            }
            let ents = ctx.entities();
            for c in state.update(ctx) {
                if c.kind == ModifierChangeKind::Removed {
                    continue;
                }
                let on_hero = c
                    .entry
                    .parent
                    .and_then(|h| ents.get_by_handle(h))
                    .is_some_and(|e| e.class_name.as_ref() == PAWN);
                if !on_hero && !any_parent {
                    continue;
                }
                if let Some(a) = c.entry.ability_subclass.filter(|a| *a != 0) {
                    abilities.insert(a);
                }
                if let Some(m) = c.entry.modifier_subclass.filter(|m| *m != 0) {
                    modifiers.insert(m);
                }
            }
        })
        .expect("parses");
    for n in &casts {
        println!("cast {n}");
    }
    for a in &abilities {
        println!("ability {a}");
    }
    for m in &modifiers {
        println!("modifier {m}");
    }
    eprintln!(
        "{} casts, {} abilities, {} modifiers",
        casts.len(),
        abilities.len(),
        modifiers.len()
    );
}
