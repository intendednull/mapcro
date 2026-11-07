use serde::{Deserialize, Serialize};
use std::fmt;

/// A record id. Random 128-bit, so clients create records offline without coordination.
/// Serialized as 32 hex digits: JSON numbers can't carry 128 bits into JavaScript.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, type = "string"))]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RecordId(pub u128);

/// A client (one browser tab's replica). Random 128-bit, persisted with the tab's pending queue.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, type = "string"))]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ClientId(pub u128);

macro_rules! hex_id {
    ($t:ident) => {
        impl Serialize for $t {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(&format!("{:032x}", self.0))
            }
        }
        impl<'de> Deserialize<'de> for $t {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = <std::borrow::Cow<'de, str>>::deserialize(d)?;
                if s.len() != 32 {
                    return Err(serde::de::Error::custom("id must be 32 hex digits"));
                }
                u128::from_str_radix(&s, 16).map($t).map_err(serde::de::Error::custom)
            }
        }
    };
}
hex_id!(RecordId);
hex_id!(ClientId);

impl fmt::Debug for RecordId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "r{:04x}", self.0 & 0xffff)
    }
}
impl fmt::Debug for ClientId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "c{:04x}", self.0 & 0xffff)
    }
}

/// The game's own hero id (`m_HeroID` in `heroes.vdata`), stable across builds.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct HeroId(pub u32);

/// A semantic objective key, e.g. `walker:amber:lane2`. Survives map updates better than raw
/// entity ids (spec §12). Validated: 1–48 chars of `[a-z0-9_:]`.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ObjectiveKey(pub String);

impl ObjectiveKey {
    pub fn is_valid(&self) -> bool {
        (1..=48).contains(&self.0.len())
            && self.0.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b':')
    }
}

/// A fractional-index key ordering scenes: concurrent inserts between the same two scenes get
/// distinct keys, so reorders never collide. Validated: 1–32 chars of `[0-9a-z]`, not ending in
/// `0`, so there is always room on both sides.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct OrderKey(pub String);

const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

impl OrderKey {
    pub fn first() -> Self {
        OrderKey("i".into())
    }

    pub fn is_valid(&self) -> bool {
        (1..=32).contains(&self.0.len())
            && self.0.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
            && !self.0.ends_with('0')
    }

    /// A key strictly between `lo` and `hi` (either may be open). Requires `lo < hi`.
    /// The classic base-N midpoint used by fractional indexing.
    pub fn between(lo: Option<&OrderKey>, hi: Option<&OrderKey>) -> OrderKey {
        let to_digits = |k: &OrderKey| -> Vec<usize> {
            k.0.bytes().map(|b| DIGITS.iter().position(|d| *d == b).unwrap_or(0)).collect()
        };
        let lo = lo.map(to_digits).unwrap_or_default();
        let hi = hi.map(to_digits);
        let digits = midpoint(&lo, hi.as_deref());
        OrderKey(digits.into_iter().map(|d| DIGITS[d] as char).collect())
    }
}

const BASE: usize = 36;

fn midpoint(lo: &[usize], hi: Option<&[usize]>) -> Vec<usize> {
    let lo_at = |i: usize| lo.get(i).copied().unwrap_or(0);
    if let Some(hi) = hi {
        // Shared prefix (lo padded with zeros): keep it and recurse on the rest.
        let mut n = 0;
        while n < hi.len() && lo_at(n) == hi[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = hi[..n].to_vec();
            out.extend(midpoint(lo.get(n..).unwrap_or(&[]), Some(&hi[n..])));
            return out;
        }
    }
    let dl = lo_at(0);
    let dh = hi.and_then(|h| h.first().copied()).unwrap_or(BASE);
    // `checked_sub`: a caller passing `lo >= hi` gets some key rather than a panic (security
    // review 2026-11-07, L3).
    if dh.checked_sub(dl).is_some_and(|d| d > 1) {
        return vec![(dl + dh) / 2];
    }
    if let Some(hi) = hi
        && hi.len() > 1
    {
        return vec![hi[0]];
    }
    let mut out = vec![dl];
    out.extend(midpoint(lo.get(1..).unwrap_or(&[]), None));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(s: &str) -> OrderKey {
        OrderKey(s.into())
    }

    #[test]
    fn between_is_strictly_between_and_valid() {
        let cases: &[(Option<&str>, Option<&str>)] = &[
            (None, None),
            (Some("i"), None),
            (None, Some("i")),
            (Some("i"), Some("j")),
            (Some("i"), Some("i1")),
            (Some("a"), Some("b")),
            (Some("zz"), None),
            (None, Some("01")),
            (Some("i"), Some("ii")),
        ];
        for (lo, hi) in cases {
            let (lo, hi) = (lo.map(k), hi.map(k));
            let m = OrderKey::between(lo.as_ref(), hi.as_ref());
            assert!(m.is_valid(), "{m:?} invalid for {lo:?}..{hi:?}");
            if let Some(lo) = &lo {
                assert!(&m > lo, "{m:?} not above {lo:?}");
            }
            if let Some(hi) = &hi {
                assert!(&m < hi, "{m:?} not below {hi:?}");
            }
        }
    }

    #[test]
    fn misordered_bounds_do_not_panic() {
        for (lo, hi) in [("j", "i"), ("i", "i"), ("z", "0"), ("i1", "i")] {
            let m = OrderKey::between(Some(&k(lo)), Some(&k(hi)));
            assert!(!m.0.is_empty(), "{lo}..{hi}");
        }
    }

    #[test]
    fn repeated_inserts_stay_ordered() {
        let mut lo = OrderKey::first();
        let hi = k("j");
        for _ in 0..40 {
            let m = OrderKey::between(Some(&lo), Some(&hi));
            assert!(m > lo && m < hi && m.is_valid(), "{m:?}");
            lo = m;
        }
    }
}
