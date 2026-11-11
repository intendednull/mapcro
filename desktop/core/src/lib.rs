//! mapcro desktop's native logic, without Tauri (desktop/README.md; research
//! docs/research/desktop-app.md, Phase 2). Everything here builds and tests on Linux; the Tauri
//! shell in `desktop/app` wires it to the window, the tray and the IPC.
//!
//! - [`steam`]: where Deadlock's replays folder is. It reads the Steam root (the registry key on
//!   Windows, fixed candidate paths on Linux), `libraryfolders.vdf` and one app manifest.
//! - [`replays`]: the folder's `<match id>.dem` files, and nothing else in it.
//! - [`settle`]: when a file has stopped growing (a download in progress isn't parsed).
//! - [`parse`]: a demo to a gzip timeline, in a child process.
//!
//! Privacy: nothing here logs a path, a player name or an account id. A replay leaves this crate
//! only as its match id, its size, its time and its timeline (which the server shows on the board
//! anyway).

pub mod parse;
pub mod replays;
pub mod settle;
pub mod steam;
mod vdf;
