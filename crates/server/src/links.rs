//! Capability tokens (spec §11). A token is 256 random bits; the server keeps only its SHA-256,
//! so a database leak yields no usable links. The public link id is a prefix of that hash.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

pub fn random_b64(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    // The OS RNG failing is unrecoverable for a server that mints secrets.
    getrandom::fill(&mut buf).expect("OS random number generator unavailable");
    URL_SAFE_NO_PAD.encode(buf)
}

pub fn new_token() -> String {
    random_b64(32)
}

pub fn new_board_id() -> String {
    random_b64(16)
}

pub fn hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// The non-secret id shown in link lists and used to revoke.
pub fn link_id(hash: &str) -> &str {
    &hash[..16.min(hash.len())]
}

/// Cheap shape check before touching the database: base64url, 43 chars for 32 bytes.
pub fn plausible_token(t: &str) -> bool {
    t.len() == 43 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn plausible_board_id(b: &str) -> bool {
    b.len() == 22 && b.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_plausible_and_hash_stably() {
        let a = new_token();
        let b = new_token();
        assert_ne!(a, b);
        assert!(plausible_token(&a), "{a}");
        assert_eq!(hash(&a), hash(&a));
        assert_ne!(hash(&a), hash(&b));
        assert_eq!(hash(&a).len(), 64);
        assert!(plausible_board_id(&new_board_id()));
    }
}
