//! The parse child on its own, for the tests and a manual check (the app is its own child:
//! `desktop/app/src/main.rs`). `mapcro-desktop-parse --mapcro-parse-replay <demo> <out> <id>`.

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    std::process::exit(mapcro_desktop_core::parse::child_main(&args).unwrap_or(2));
}
