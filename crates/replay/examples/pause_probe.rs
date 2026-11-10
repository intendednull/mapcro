//! Pause probe: how a replay's clocks behave across an in-game pause. Read-only exploration
//! (the pause fix, 2026-11-09).
//!
//! `cargo run -p mapcro-replay --release --example pause_probe -- <replay.dem>`
//!
//! Prints, for every tick where a pause field changes and every 32nd tick while paused or within
//! 10 s of a pause, the tick, the rules' pause fields, the parser's match clock, and one pawn's
//! simulation time and position (a `GameTime_t` that tracks the server's `curtime`). No controller
//! is read, so no Steam id is.

use boon::Parser;
use std::collections::HashSet;

const RULES: &str = "CCitadelGameRulesProxy";
const PAWN: &str = "CCitadelPlayerPawn";

fn main() {
    let dem = std::path::PathBuf::from(std::env::args().nth(1).expect("usage: pause_probe <replay.dem>"));
    let (_, server_start) = mapcro_replay::parse::header(&dem).expect("a Deadlock replay");
    let parser = Parser::from_file(&dem).expect("opens");
    let classes: HashSet<&str> = [RULES, PAWN].into_iter().collect();
    let mut last: Option<(bool, i64, i64, f32)> = None;
    let mut pause_tick: Option<i32> = None;
    let mut unpause_tick: Option<i32> = None;
    println!("tick\tpaused\tpause_start\ttotal_paused\tunpause_raw\tparser_game\tsim_time-start\tpawn_respawn-start\tpawn_x");
    parser
        .run_to_end_with_events_filtered(&classes, |ctx, _| {
            let sers = ctx.serializers();
            let rk = |p: &str| sers.get(RULES).and_then(|s| s.resolve_field_key(p));
            let pk = |p: &str| sers.get(PAWN).and_then(|s| s.resolve_field_key(p));
            let ents = ctx.entities();
            let Some(rules) = ents.iter().find(|(_, e)| e.class_name.as_ref() == RULES).map(|(_, e)| e) else { return };
            let start = f64::from(rules.get_f32(rk("m_pGameRules.m_flGameStartTime")));
            if start <= 0.0 {
                return;
            }
            let paused = rules.get_bool(rk("m_pGameRules.m_bGamePaused"));
            let pause_start = rules.get_i64(rk("m_pGameRules.m_nPauseStartTick"));
            let total = rules.get_i64(rk("m_pGameRules.m_nTotalPausedTicks"));
            let unpause = rules.get_f32(rk("m_pGameRules.m_fUnpauseRawTime"));
            let interval = f64::from(ctx.tick_interval());
            let game = (f64::from(ctx.tick() + server_start) - total as f64) * interval - start;
            let tick = ctx.tick();
            let now = (paused, pause_start, total, unpause);
            let changed = last != Some(now);
            if paused && pause_tick.is_none() {
                pause_tick = Some(tick);
            }
            if !paused && pause_tick.is_some() && unpause_tick.is_none() && last.is_some_and(|l| l.0) {
                unpause_tick = Some(tick);
            }
            last = Some(now);
            let near = paused || pause_tick.is_some_and(|p| tick >= p - 640 && unpause_tick.is_none_or(|u| tick <= u + 640));
            if !(changed || (near && tick % 32 == 0)) {
                return;
            }
            let pawn = ents.iter().find(|(_, e)| e.class_name.as_ref() == PAWN && e.active).map(|(_, e)| e);
            let sim = pawn.map_or(f64::NAN, |p| f64::from(p.get_f32(pk("m_flSimulationTime"))) - start);
            let resp = pawn.map_or(f64::NAN, |p| f64::from(p.get_f32(pk("m_flRespawnTime"))) - start);
            let o = "CBodyComponent.m_skeletonInstance.m_vecOrigin";
            let x = pawn.map_or(f32::NAN, |p| {
                boon::world_position(p, [pk(&format!("{o}.m_cellX")), pk(&format!("{o}.m_cellY")), pk(&format!("{o}.m_cellZ"))], [pk(&format!("{o}.m_vecX")), pk(&format!("{o}.m_vecY")), pk(&format!("{o}.m_vecZ"))])[0]
            });
            println!("{tick}\t{paused}\t{pause_start}\t{total}\t{unpause:.2}\t{game:.3}\t{sim:.3}\t{resp:.3}\t{x:.1}");
        })
        .expect("parses");
}
