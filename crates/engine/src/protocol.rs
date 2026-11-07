use mapcro_schema::{ClientId, Reject, Tx};
use serde::{Deserialize, Serialize};

/// First message on every connection.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub client: ClientId,
    /// Proves this connection speaks for `client`. Client ids are public (every entry carries
    /// one); the secret never leaves the client except in its own hello. The first hello
    /// registers it; later ones must match (security review 2026-11-06, H1).
    pub secret: String,
    /// Entries the client already has: the server sends everything after this.
    pub last_seq: u64,
    /// The client's oldest unacknowledged `cseq`. The server reports rejections from here on
    /// *before* the catch-up, so a rejection lost in a disconnect can't arrive after the acks of
    /// later transactions (journal 2026-11-06, engine entry).
    pub pending_from: u64,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientMsg {
    Hello(Hello),
    Submit(Tx),
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServerMsg {
    /// The transaction at log position `seq` (1-based). The sender's own entry is its ack.
    Entry { seq: u64, tx: Tx },
    /// The client's transaction `cseq` was refused and will never be applied.
    Rejected { cseq: u64, reason: Reject },
    /// The client's hello was inconsistent with the server (e.g. it claims entries the server
    /// never had). The connection is closed; the client must start again from a snapshot.
    Fatal(String),
}
