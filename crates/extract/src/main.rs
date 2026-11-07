//! `mapcro-extract --game <citadel dir> --out <dir>`

use std::path::Path;
use std::process::ExitCode;

use mapcro_extract::extract;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("mapcro-extract: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mut game = None;
    let mut out = None;

    while let Some(argument) = args.next() {
        match argument.as_str() {
            "-h" | "--help" => {
                print_help();
                return Ok(());
            }
            "--version" => {
                println!("mapcro-extract {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            "--game" => game = Some(next_value(&mut args, "--game")?),
            "--out" => out = Some(next_value(&mut args, "--out")?),
            other if other.starts_with("--game=") => {
                game = Some(other["--game=".len()..].to_owned());
            }
            other if other.starts_with("--out=") => {
                out = Some(other["--out=".len()..].to_owned());
            }
            other => {
                return Err(format!("unknown argument {other:?} (try --help)"));
            }
        }
    }

    let game = game.ok_or_else(|| "missing --game <citadel dir>".to_owned())?;
    let out = out.ok_or_else(|| "missing --out <dir>".to_owned())?;

    let report = extract(Path::new(&game), Path::new(&out)).map_err(|error| error.to_string())?;

    println!(
        "wrote {} PNGs and {} ({} sources, {} blobs)",
        report.files.len(),
        report.pack.display(),
        report.sources,
        report.blobs
    );
    for file in &report.files {
        println!("  {file}");
    }

    Ok(())
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next().ok_or_else(|| format!("{flag} needs a value"))
}

fn print_help() {
    println!(
        "mapcro-extract {}\n\
         \n\
         Usage: mapcro-extract --game <citadel dir> --out <dir>\n\
         \n\
         --game <dir>  Deadlock's game/citadel directory (read-only)\n\
         --out <dir>   Asset-pack output directory (must be outside the game and the repo)\n\
         --version     Print the extractor version\n\
         -h, --help    Print this help",
        env!("CARGO_PKG_VERSION")
    );
}
