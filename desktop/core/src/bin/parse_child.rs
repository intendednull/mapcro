//! The parse child on its own, for the tests and a manual check (the app is its own child:
//! `desktop/app/src/main.rs`). `mapcro-desktop-parse --mapcro-parse-replay <demo> <out> <id>`, or
//! `--mapcro-preview-replay <demo> <id>` (preview.rs).

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    let code = mapcro_desktop_core::parse::child_main(&args).or_else(|| mapcro_desktop_core::preview::child_main(&args));
    std::process::exit(code.unwrap_or(2));
}
