//! Stack probe (feedback #38): which modifiers carry a stack count on heroes, or on the targets
//! of heroes, over a whole recording. Prints one JSON line per (side, hero id, modifier token):
//! `side` "on" (the modifier's parent is that hero's pawn) or "by" (that hero cast it on another
//! hero), applications, the most `stack_count` and `max_stack_count` seen, the ability token,
//! and for "on" the stack at each whole minute (the last value held). Aggregates keyed by hero id
//! only: no player data is read. Name the tokens with a pack's `data/abilities.json`.
//! `cargo run -p mapcro-replay --release --example stack_probe -- <replay.dem> > /tmp/stacks.jsonl`
use boon::{ModifierChangeKind, ModifierState, Parser};
use std::collections::{BTreeMap, HashMap, HashSet};

const PAWN: &str = "CCitadelPlayerPawn";

#[derive(Default)]
struct Agg {
    applied: u32,
    max_stack: i32,
    max_max: i32,
    ability: u32,
    /// Minute → the stack held then (the "on" side, the latest live entry).
    minutes: BTreeMap<i32, i32>,
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let classes: HashSet<&str> = [PAWN].into_iter().collect();
    let mut mods = ModifierState::default();
    let mut agg: BTreeMap<(&'static str, u32, u32), Agg> = BTreeMap::new();
    // Serial → (side key, current stack) for the live "on" entries.
    let mut live: HashMap<u32, ((&'static str, u32, u32), i32)> = HashMap::new();
    Parser::from_file(std::path::Path::new(&a[1]))
        .expect("opens")
        .run_to_end_filtered(&classes, |ctx| {
            let tick = ctx.tick();
            let ents = ctx.entities();
            let Some(ps) = ctx.serializers().get(PAWN) else { return };
            let hk = ps.resolve_field_key("m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID");
            let hero = |h: Option<u32>| {
                h.and_then(|h| ents.get_by_handle(h)).filter(|e| e.class_name.as_ref() == PAWN).map(|e| e.get_i64(hk) as u32).filter(|id| *id != 0)
            };
            for ch in mods.update(ctx) {
                let serial = ch.entry.serial_number.unwrap_or(0);
                if ch.kind == ModifierChangeKind::Removed {
                    live.remove(&serial);
                    continue;
                }
                let e = &ch.entry;
                let id = e.modifier_subclass.unwrap_or(0);
                let stack = e.stack_count.unwrap_or(0);
                let on = hero(e.parent);
                let by = hero(e.caster);
                let mut note = |k: (&'static str, u32, u32)| {
                    let g = agg.entry(k).or_default();
                    if ch.kind == ModifierChangeKind::Applied {
                        g.applied += 1;
                    }
                    g.max_stack = g.max_stack.max(stack);
                    g.max_max = g.max_max.max(e.max_stack_count.unwrap_or(0));
                    if g.ability == 0 {
                        g.ability = e.ability_subclass.unwrap_or(0);
                    }
                };
                if let Some(h) = on {
                    note(("on", h, id));
                    live.insert(serial, (("on", h, id), stack));
                }
                if let (Some(h), Some(_)) = (by, on)
                    && by != on
                {
                    note(("by", h, id));
                }
            }
            if tick % 3840 == 0 {
                let m = tick / 3840;
                for (k, s) in live.values() {
                    if let Some(g) = agg.get_mut(k) {
                        let v = g.minutes.entry(m).or_insert(0);
                        *v = (*v).max(*s);
                    }
                }
            }
        })
        .expect("parses");
    for ((side, hero, id), g) in agg {
        if g.max_stack <= 0 {
            continue;
        }
        let minutes: Vec<(i32, i32)> = g.minutes.into_iter().filter(|(_, s)| *s > 0).collect();
        println!("{}", serde_json::json!({"side": side, "hero": hero, "id": id, "ability": g.ability, "applied": g.applied, "max_stack": g.max_stack, "max_max": g.max_max, "minutes": minutes}));
    }
}
