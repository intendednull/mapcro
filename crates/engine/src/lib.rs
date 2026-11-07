//! The mapcro sync engine (spec §3–§7). Two halves that share one apply function:
//!
//! - [`Authority`] orders, validates and applies transactions. It runs on the server for shared
//!   boards and in the browser for local ones.
//! - [`Replica`] is a client's view: confirmed state + pending work, rebased on every entry.
//!
//! Both are pure state machines: messages in, messages out. Transport, clocks and storage belong
//! to the caller, which is what lets the simulation drive them deterministically.

mod authority;
mod protocol;
mod replica;
pub mod wire;

pub use authority::{Authority, ConnId, Effect, MAX_REJECTIONS_PER_CLIENT, Outbox, Role, secret_hash};
pub use protocol::{ClientMsg, Hello, ServerMsg};
pub use replica::{ProtocolError, Replica, ReplicaState, SaveStatus, UndoError};
