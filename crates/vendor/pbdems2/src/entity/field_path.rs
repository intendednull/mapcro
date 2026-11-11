//! Field paths: the addresses entity deltas use to name a field.
//!
//! A packet-entities update does not repeat field names. It encodes a short
//! sequence of Huffman-coded operations that mutate a running [`FieldPath`],
//! and each resulting path addresses one field in the class's serializer
//! hierarchy.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::sync::LazyLock;

use crate::error::{Error, Result};
use crate::io::BitReader;
use crate::limits::DecodeLimits;

/// Represents a path to a field within a serializer hierarchy.
///
/// Each component is an index into the serializer's fields array at that
/// nesting level. For example, `[3, 0, 2]` means "field 3 → sub-serializer
/// field 0 → sub-serializer field 2".
#[derive(Debug, Clone, Copy)]
pub struct FieldPath {
    /// Component indices (up to 7 levels of nesting).
    /// The signed representation retains the initial -1 root; checked bounds
    /// keep decoded values within 0..=4095.
    pub data: [i16; 7],
    /// Index of the deepest active component (0-based).
    pub last: usize,
    /// Set to `true` by the `field_path_encode_finish` op to signal end-of-list.
    pub finished: bool,
}

impl Default for FieldPath {
    fn default() -> Self {
        // The first operation increments the root from -1 to zero.
        Self {
            data: [-1, 0, 0, 0, 0, 0, 0],
            last: 0,
            finished: false,
        }
    }
}

impl FieldPath {
    #[inline]
    fn inc_at(&mut self, i: usize, delta: i64) -> Result<()> {
        let value = i64::from(self.data[i]) + delta;
        self.data[i] = Self::component(i, value)?;
        Ok(())
    }

    #[inline]
    fn inc_last(&mut self, delta: i64) -> Result<()> {
        self.inc_at(self.last, delta)
    }

    #[inline]
    fn component(depth: usize, value: i64) -> Result<i16> {
        if !(0..=i64::from(COMPONENT_MASKS[depth])).contains(&value) {
            return Err(Error::Parse {
                context: format!("field path component {value} exceeds depth {depth} bounds"),
            });
        }
        Ok(value as i16)
    }

    #[inline]
    fn push(&mut self, value: i64) -> Result<()> {
        if self.last >= self.data.len() - 1 {
            return Err(Error::Parse {
                context: format!("field path exceeds maximum depth of {}", self.data.len()),
            });
        }
        let next = self.last + 1;
        self.data[next] = Self::component(next, value)?;
        self.last = next;
        Ok(())
    }

    #[inline]
    fn pop(&mut self, n: usize) -> Result<()> {
        let last = self.last.checked_sub(n).ok_or_else(|| Error::Parse {
            context: format!(
                "cannot pop {n} levels from field path at depth {}",
                self.last + 1
            ),
        })?;
        self.data[last + 1..=self.last].fill(0);
        self.last = last;
        Ok(())
    }

    /// Component index at `index`.
    ///
    /// # Panics
    ///
    /// Panics if `index` is 7 or greater.
    pub fn get(&self, index: usize) -> usize {
        self.data[index] as usize
    }

    /// Pack a bounded field path into an opaque field key.
    ///
    /// # Panics
    ///
    /// Panics if a component or depth exceeds the packed representation.
    /// Use [`Self::try_pack`] for caller-provided paths. Keys must be resolved
    /// again after a parser upgrade; their numeric layout is not stable.
    #[inline]
    pub fn pack(&self) -> u64 {
        self.try_pack().expect("field path is representable")
    }

    /// Pack a path, or return `None` when its depth or components do not fit.
    #[inline]
    pub fn try_pack(&self) -> Option<u64> {
        if self.last >= self.data.len() {
            return None;
        }
        if self
            .data
            .iter()
            .zip(COMPONENT_MASKS)
            .any(|(&value, max)| value < 0 || value as u32 > max)
        {
            return None;
        }
        Some(self.pack_components())
    }

    // Entity decoding only packs paths from read_field_paths, which checks
    // every component mutation. Keep public, caller-built paths checked above.
    #[inline]
    pub(super) fn pack_decoded(&self) -> u64 {
        debug_assert!(self.try_pack().is_some());
        self.pack_components()
    }

    #[inline]
    fn pack_components(&self) -> u64 {
        self.data
            .iter()
            .zip(COMPONENT_SHIFTS)
            .fold((self.last as u64) << 61, |key, (&value, shift)| {
                key | ((value as u64) << shift)
            })
    }

    // Mask the components of a valid packed path, excluding depth and children.
    pub(super) fn prefix_mask(key: u64) -> u64 {
        let depth = (key >> 61) as usize;
        let shift = COMPONENT_SHIFTS.get(depth + 1).copied().unwrap_or(61);
        (1_u64 << shift) - 1
    }

    // Compare only the parent's packed prefix and its immediate child index.
    // This is equivalent to unpacking every stored path when a vector shrinks
    // or a pointer clears, but does not reconstruct seven components per field.
    pub(super) fn retain_after_shrink(parent: u64, cutoff: u64) -> impl Fn(u64) -> bool {
        let depth = (parent >> 61) as usize;
        let shift = COMPONENT_SHIFTS.get(depth + 1).copied().unwrap_or(61);
        let child_mask = u64::from(COMPONENT_MASKS.get(depth + 1).copied().unwrap_or(0));
        let prefix_mask = (1u64 << shift) - 1;
        let prefix = parent & prefix_mask;
        move |child| {
            child & prefix_mask != prefix
                || (child >> 61) as usize <= depth
                || ((child >> shift) & child_mask) < cutoff
        }
    }

    /// Unpack an opaque field key. A depth of seven denotes an invalid key.
    #[inline]
    pub fn unpack(key: u64) -> FieldPath {
        FieldPath {
            data: std::array::from_fn(|i| {
                ((key >> COMPONENT_SHIFTS[i]) & u64::from(COMPONENT_MASKS[i])) as i16
            }),
            last: (key >> 61) as usize,
            finished: false,
        }
    }
}

// Give the root and early array levels more space without enlarging map keys.
// Bounds match Clarity's compact Source 2 field-path representation.
const COMPONENT_MASKS: [u32; 7] = [2047, 4095, 2047, 255, 127, 15, 15];
const COMPONENT_SHIFTS: [u32; 7] = [0, 11, 23, 34, 42, 49, 53];

type FieldOp = fn(&mut FieldPath, &mut BitReader) -> Result<()>;

fn plus_one(fp: &mut FieldPath, _br: &mut BitReader) -> Result<()> {
    fp.inc_last(1)?;
    Ok(())
}

fn plus_two(fp: &mut FieldPath, _br: &mut BitReader) -> Result<()> {
    fp.inc_last(2)?;
    Ok(())
}

fn plus_three(fp: &mut FieldPath, _br: &mut BitReader) -> Result<()> {
    fp.inc_last(3)?;
    Ok(())
}

fn plus_four(fp: &mut FieldPath, _br: &mut BitReader) -> Result<()> {
    fp.inc_last(4)?;
    Ok(())
}

fn plus_n(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(br.read_ubitvarfp()? as i64 + 5)?;
    Ok(())
}

fn push_one_left_delta_zero_right_zero(fp: &mut FieldPath, _br: &mut BitReader) -> Result<()> {
    fp.push(0)?;
    Ok(())
}

fn push_one_left_delta_zero_right_non_zero(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.push(br.read_ubitvarfp()? as i64)?;
    Ok(())
}

fn push_one_left_delta_one_right_zero(fp: &mut FieldPath, _br: &mut BitReader) -> Result<()> {
    fp.inc_last(1)?;
    fp.push(0)?;
    Ok(())
}

fn push_one_left_delta_one_right_non_zero(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(1)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    Ok(())
}

fn push_one_left_delta_n_right_zero(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(br.read_ubitvarfp()? as i64)?;
    fp.push(0)?;
    Ok(())
}

fn push_one_left_delta_n_right_non_zero(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(br.read_ubitvarfp()? as i64 + 2)?;
    fp.push(br.read_ubitvarfp()? as i64 + 1)?;
    Ok(())
}

fn push_one_left_delta_n_right_non_zero_pack6_bits(
    fp: &mut FieldPath,
    br: &mut BitReader,
) -> Result<()> {
    fp.inc_last(br.read_bits(3)? as i64 + 2)?;
    fp.push(br.read_bits(3)? as i64 + 1)?;
    Ok(())
}

fn push_one_left_delta_n_right_non_zero_pack8_bits(
    fp: &mut FieldPath,
    br: &mut BitReader,
) -> Result<()> {
    fp.inc_last(br.read_bits(4)? as i64 + 2)?;
    fp.push(br.read_bits(4)? as i64 + 1)?;
    Ok(())
}

fn push_two_left_delta_zero(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.push(br.read_ubitvarfp()? as i64)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    Ok(())
}

fn push_two_left_delta_one(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(1)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    Ok(())
}

fn push_two_left_delta_n(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(br.read_ubitvar()? as i64 + 2)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    Ok(())
}

fn push_two_pack5_left_delta_zero(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.push(br.read_bits(5)? as i64)?;
    fp.push(br.read_bits(5)? as i64)?;
    Ok(())
}

fn push_two_pack5_left_delta_one(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(1)?;
    fp.push(br.read_bits(5)? as i64)?;
    fp.push(br.read_bits(5)? as i64)?;
    Ok(())
}

fn push_two_pack5_left_delta_n(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(br.read_ubitvar()? as i64 + 2)?;
    fp.push(br.read_bits(5)? as i64)?;
    fp.push(br.read_bits(5)? as i64)?;
    Ok(())
}

fn push_three_left_delta_zero(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.push(br.read_ubitvarfp()? as i64)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    Ok(())
}

fn push_three_left_delta_one(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(1)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    Ok(())
}

fn push_three_left_delta_n(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(br.read_ubitvar()? as i64 + 2)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    fp.push(br.read_ubitvarfp()? as i64)?;
    Ok(())
}

fn push_three_pack5_left_delta_zero(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.push(br.read_bits(5)? as i64)?;
    fp.push(br.read_bits(5)? as i64)?;
    fp.push(br.read_bits(5)? as i64)?;
    Ok(())
}

fn push_three_pack5_left_delta_one(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(1)?;
    fp.push(br.read_bits(5)? as i64)?;
    fp.push(br.read_bits(5)? as i64)?;
    fp.push(br.read_bits(5)? as i64)?;
    Ok(())
}

fn push_three_pack5_left_delta_n(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.inc_last(br.read_ubitvar()? as i64 + 2)?;
    fp.push(br.read_bits(5)? as i64)?;
    fp.push(br.read_bits(5)? as i64)?;
    fp.push(br.read_bits(5)? as i64)?;
    Ok(())
}

fn push_n(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    let n = br.read_ubitvar()? as usize;
    fp.inc_last(br.read_ubitvar()? as i64)?;
    for _ in 0..n {
        fp.push(br.read_ubitvarfp()? as i64)?;
    }
    Ok(())
}

fn push_n_and_non_topographical(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    for i in 0..=fp.last {
        if br.read_bool()? {
            fp.inc_at(i, i64::from(br.read_varint32()?) + 1)?;
        }
    }
    let n = br.read_ubitvar()? as usize;
    for _ in 0..n {
        fp.push(br.read_ubitvarfp()? as i64)?;
    }
    Ok(())
}

fn pop_one_plus_one(fp: &mut FieldPath, _br: &mut BitReader) -> Result<()> {
    fp.pop(1)?;
    fp.inc_last(1)?;
    Ok(())
}

fn pop_one_plus_n(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.pop(1)?;
    fp.inc_last(br.read_ubitvarfp()? as i64 + 1)?;
    Ok(())
}

fn pop_all_but_one_plus_one(fp: &mut FieldPath, _br: &mut BitReader) -> Result<()> {
    fp.pop(fp.last)?;
    fp.inc_last(1)?;
    Ok(())
}

fn pop_all_but_one_plus_n(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.pop(fp.last)?;
    fp.inc_last(br.read_ubitvarfp()? as i64 + 1)?;
    Ok(())
}

fn pop_all_but_one_plus_n_pack3_bits(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.pop(fp.last)?;
    fp.inc_last(br.read_bits(3)? as i64 + 1)?;
    Ok(())
}

fn pop_all_but_one_plus_n_pack6_bits(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.pop(fp.last)?;
    fp.inc_last(br.read_bits(6)? as i64 + 1)?;
    Ok(())
}

fn pop_n_plus_one(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.pop(br.read_ubitvarfp()? as usize)?;
    fp.inc_last(1)?;
    Ok(())
}

fn pop_n_plus_n(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.pop(br.read_ubitvarfp()? as usize)?;
    fp.inc_last(i64::from(br.read_varint32()?))?;
    Ok(())
}

fn pop_n_and_non_topographical(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    fp.pop(br.read_ubitvarfp()? as usize)?;
    for i in 0..=fp.last {
        if br.read_bool()? {
            fp.inc_at(i, i64::from(br.read_varint32()?))?;
        }
    }
    Ok(())
}

fn non_topo_complex(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    for i in 0..=fp.last {
        if br.read_bool()? {
            fp.inc_at(i, i64::from(br.read_varint32()?))?;
        }
    }
    Ok(())
}

fn non_topo_penultimate_plus_one(fp: &mut FieldPath, _br: &mut BitReader) -> Result<()> {
    let parent = fp.last.checked_sub(1).ok_or_else(|| Error::Parse {
        context: "field path has no parent component to increment".into(),
    })?;
    fp.inc_at(parent, 1)?;
    Ok(())
}

fn non_topo_complex_pack4_bits(fp: &mut FieldPath, br: &mut BitReader) -> Result<()> {
    for i in 0..=fp.last {
        if br.read_bool()? {
            fp.inc_at(i, br.read_bits(4)? as i64 - 7)?;
        }
    }
    Ok(())
}

fn field_path_encode_finish(fp: &mut FieldPath, _br: &mut BitReader) -> Result<()> {
    fp.finished = true;
    Ok(())
}

struct FieldOpDescriptor {
    weight: usize,
    op: FieldOp,
}

/// Valve-defined Huffman weights for field path delta operations.
///
/// Each entry pairs a weight (empirical frequency) with a field-path
/// mutation function. These are assembled into a Huffman tree at startup
/// (see [`build_fieldop_hierarchy`]) so that common operations like
/// `plus_one` use fewer bits on the wire.
const FIELDOP_DESCRIPTORS: &[FieldOpDescriptor] = &[
    FieldOpDescriptor {
        weight: 36271,
        op: plus_one,
    },
    FieldOpDescriptor {
        weight: 10334,
        op: plus_two,
    },
    FieldOpDescriptor {
        weight: 1375,
        op: plus_three,
    },
    FieldOpDescriptor {
        weight: 646,
        op: plus_four,
    },
    FieldOpDescriptor {
        weight: 4128,
        op: plus_n,
    },
    FieldOpDescriptor {
        weight: 35,
        op: push_one_left_delta_zero_right_zero,
    },
    FieldOpDescriptor {
        weight: 3,
        op: push_one_left_delta_zero_right_non_zero,
    },
    FieldOpDescriptor {
        weight: 521,
        op: push_one_left_delta_one_right_zero,
    },
    FieldOpDescriptor {
        weight: 2942,
        op: push_one_left_delta_one_right_non_zero,
    },
    FieldOpDescriptor {
        weight: 560,
        op: push_one_left_delta_n_right_zero,
    },
    FieldOpDescriptor {
        weight: 471,
        op: push_one_left_delta_n_right_non_zero,
    },
    FieldOpDescriptor {
        weight: 10530,
        op: push_one_left_delta_n_right_non_zero_pack6_bits,
    },
    FieldOpDescriptor {
        weight: 251,
        op: push_one_left_delta_n_right_non_zero_pack8_bits,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_two_left_delta_zero,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_two_pack5_left_delta_zero,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_three_left_delta_zero,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_three_pack5_left_delta_zero,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_two_left_delta_one,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_two_pack5_left_delta_one,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_three_left_delta_one,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_three_pack5_left_delta_one,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_two_left_delta_n,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_two_pack5_left_delta_n,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_three_left_delta_n,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_three_pack5_left_delta_n,
    },
    FieldOpDescriptor {
        weight: 1,
        op: push_n,
    },
    FieldOpDescriptor {
        weight: 310,
        op: push_n_and_non_topographical,
    },
    FieldOpDescriptor {
        weight: 2,
        op: pop_one_plus_one,
    },
    FieldOpDescriptor {
        weight: 1,
        op: pop_one_plus_n,
    },
    FieldOpDescriptor {
        weight: 1837,
        op: pop_all_but_one_plus_one,
    },
    FieldOpDescriptor {
        weight: 149,
        op: pop_all_but_one_plus_n,
    },
    FieldOpDescriptor {
        weight: 300,
        op: pop_all_but_one_plus_n_pack3_bits,
    },
    FieldOpDescriptor {
        weight: 634,
        op: pop_all_but_one_plus_n_pack6_bits,
    },
    FieldOpDescriptor {
        weight: 1,
        op: pop_n_plus_one,
    },
    FieldOpDescriptor {
        weight: 1,
        op: pop_n_plus_n,
    },
    FieldOpDescriptor {
        weight: 1,
        op: pop_n_and_non_topographical,
    },
    FieldOpDescriptor {
        weight: 76,
        op: non_topo_complex,
    },
    FieldOpDescriptor {
        weight: 271,
        op: non_topo_penultimate_plus_one,
    },
    FieldOpDescriptor {
        weight: 99,
        op: non_topo_complex_pack4_bits,
    },
    FieldOpDescriptor {
        weight: 25474,
        op: field_path_encode_finish,
    },
];

#[derive(Debug)]
enum Node {
    Leaf {
        weight: usize,
        num: usize,
    },
    Branch {
        weight: usize,
        num: usize,
        left: Box<Node>,
        right: Box<Node>,
    },
}

impl Node {
    fn weight(&self) -> usize {
        match self {
            Self::Leaf { weight, .. } => *weight,
            Self::Branch { weight, .. } => *weight,
        }
    }

    fn num(&self) -> usize {
        match self {
            Self::Leaf { num, .. } => *num,
            Self::Branch { num, .. } => *num,
        }
    }
}

// Ordering is inverted (other vs self) so BinaryHeap acts as a min-heap.
impl Ord for Node {
    fn cmp(&self, other: &Self) -> Ordering {
        if self.weight() == other.weight() {
            self.num().cmp(&other.num())
        } else {
            other.weight().cmp(&self.weight())
        }
    }
}

impl PartialOrd for Node {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Node {
    fn eq(&self, other: &Self) -> bool {
        self.weight() == other.weight() && self.num() == other.num()
    }
}

impl Eq for Node {}

/// Build a Huffman tree from the weighted operation descriptors.
fn build_fieldop_hierarchy() -> Node {
    let mut heap = BinaryHeap::with_capacity(FIELDOP_DESCRIPTORS.len());
    let mut num = 0;

    for desc in FIELDOP_DESCRIPTORS {
        heap.push(Node::Leaf {
            weight: desc.weight,
            num,
        });
        num += 1;
    }

    while heap.len() > 1 {
        let left = heap.pop().unwrap();
        let right = heap.pop().unwrap();
        heap.push(Node::Branch {
            weight: left.weight() + right.weight(),
            num,
            left: Box::new(left),
            right: Box::new(right),
        });
        num += 1;
    }

    heap.pop().unwrap()
}

static FIELDOP_HIERARCHY: LazyLock<Node> = LazyLock::new(build_fieldop_hierarchy);

// An eight-bit prefix resolves common operations in one lookup. A zero-length
// entry means the code is longer, so the tree must decode it instead. Store
// operation indices to keep this table to two bytes per entry.
const PREFIX_BITS: usize = 8;

#[derive(Clone, Copy)]
struct PrefixEntry {
    bits: u8,
    index: u8,
}

static FIELDOP_PREFIX: LazyLock<[PrefixEntry; 1 << PREFIX_BITS]> = LazyLock::new(|| {
    std::array::from_fn(|prefix| {
        let mut node = &*FIELDOP_HIERARCHY;
        let mut bits = 0;
        loop {
            match node {
                Node::Leaf { num, .. } => {
                    return PrefixEntry {
                        bits,
                        index: *num as u8,
                    };
                }
                Node::Branch { left, right, .. } if usize::from(bits) < PREFIX_BITS => {
                    node = if prefix & (1 << bits) == 0 {
                        left
                    } else {
                        right
                    };
                    bits += 1;
                }
                Node::Branch { .. } => {
                    return PrefixEntry { bits: 0, index: 0 };
                }
            }
        }
    })
});

fn read_field_op_tree(br: &mut BitReader) -> Result<usize> {
    let mut node = &*FIELDOP_HIERARCHY;
    loop {
        match node {
            Node::Leaf { num, .. } => return Ok(*num),
            Node::Branch { left, right, .. } => {
                node = if br.read_bool()? { right } else { left };
            }
        }
    }
}

/// Read field paths from a bit reader using the Huffman-coded encoding.
/// Clears and fills the provided buffer with decoded field paths.
pub fn read_field_paths(br: &mut BitReader, buf: &mut Vec<FieldPath>) -> Result<()> {
    read_field_paths_with_limits(br, buf, &DecodeLimits::default())
}

/// Limit-aware variant of [`read_field_paths`].
pub fn read_field_paths_with_limits(
    br: &mut BitReader,
    buf: &mut Vec<FieldPath>,
    limits: &DecodeLimits,
) -> Result<()> {
    buf.clear();
    let mut fp = FieldPath::default();
    let prefix = &*FIELDOP_PREFIX;

    loop {
        let op = if br.bits_remaining() >= PREFIX_BITS {
            let entry = prefix[br.peek_bits(PREFIX_BITS)? as usize];
            if entry.bits != 0 {
                br.skip_bits(usize::from(entry.bits))?;
                usize::from(entry.index)
            } else {
                read_field_op_tree(br)?
            }
        } else {
            // Do not require a full prefix near EOF. The tree preserves both
            // valid short finish codes and the exact cursor on truncated input.
            read_field_op_tree(br)?
        };
        // The first four wire operations only increment the last component.
        // Inline those checks and the finish operation; dispatch rare operations.
        match op {
            0..=3 => fp.inc_last(op as i64 + 1)?,
            index if index == FIELDOP_DESCRIPTORS.len() - 1 => return Ok(()),
            index => (FIELDOP_DESCRIPTORS[index].op)(&mut fp, br)?,
        }
        if fp.data[0] < 0 {
            return Err(Error::Parse {
                context: "field path has no root component".into(),
            });
        }
        limits.ensure(
            "entity field paths",
            buf.len().saturating_add(1),
            limits.max_field_paths(),
        )?;
        buf.push(fp);
    }
}

#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod tests {
    use super::*;

    // ── FieldPath basics ──

    #[test]
    fn default_values() {
        let fp = FieldPath::default();
        assert_eq!(fp.data[0], -1);
        assert_eq!(fp.last, 0);
        assert!(!fp.finished);
    }

    #[test]
    fn get_returns_data() {
        let fp = FieldPath::default();
        assert_eq!(fp.get(0), usize::MAX);
        assert_eq!(fp.get(1), 0);
    }

    #[test]
    fn default_path_has_no_field_key() {
        let fp = FieldPath::default();
        assert!(fp.try_pack().is_none());
    }

    #[test]
    fn pack_unpack_custom_roundtrip() {
        let fp = FieldPath {
            data: [1, 2, 3, 4, 5, 6, 7],
            last: 3,
            ..Default::default()
        };
        let key = fp.pack();
        let fp2 = FieldPath::unpack(key);
        assert_eq!(fp.data, fp2.data);
        assert_eq!(fp.last, fp2.last);
    }

    #[test]
    fn pack_unpack_max_last() {
        let fp = FieldPath {
            last: 6,
            data: [0; 7],
            ..Default::default()
        };
        let key = fp.pack();
        let fp2 = FieldPath::unpack(key);
        assert_eq!(fp2.last, 6);
    }

    // ── Private operations ──

    #[test]
    fn initial_root_advances_to_zero() {
        let mut fp = FieldPath::default();
        // Only the initial -1 root advances to zero.
        fp.inc_at(0, 1).unwrap();
        assert_eq!(fp.data[0], 0);
    }

    #[test]
    fn push_pop_sequence() {
        let mut fp = FieldPath::default();
        assert_eq!(fp.last, 0);
        fp.push(42).unwrap();
        assert_eq!(fp.last, 1);
        assert_eq!(fp.data[1], 42);
        fp.pop(1).unwrap();
        assert_eq!(fp.last, 0);
        assert_eq!(fp.data[1], 0);
    }

    #[test]
    fn inc_last_modifies_current() {
        let mut fp = FieldPath {
            data: [10, 0, 0, 0, 0, 0, 0],
            last: 0,
            finished: false,
        };
        fp.inc_last(5).unwrap();
        assert_eq!(fp.data[0], 15);
    }

    #[test]
    fn plus_one_field_op() {
        let mut fp = FieldPath {
            data: [10, 0, 0, 0, 0, 0, 0],
            last: 0,
            finished: false,
        };
        let data = [0u8; 1];
        let mut br = BitReader::new(&data);
        plus_one(&mut fp, &mut br).unwrap();
        assert_eq!(fp.data[0], 11);
    }

    #[test]
    fn field_path_encode_finish_sets_finished() {
        let mut fp = FieldPath::default();
        let data = [0u8; 1];
        let mut br = BitReader::new(&data);
        field_path_encode_finish(&mut fp, &mut br).unwrap();
        assert!(fp.finished);
    }
    proptest::proptest! {
        #[test]
        fn packed_pruning_matches_unpacked_paths(
            parent in proptest::array::uniform7(proptest::prelude::any::<u16>()),
            child in proptest::array::uniform7(proptest::prelude::any::<u16>()),
            parent_depth in 0usize..7,
            child_depth in 0usize..7,
            shared_components in 0usize..=7,
            cutoff in 0u64..4097,
        ) {
            let parent = FieldPath {
                data: std::array::from_fn(|i| (u32::from(parent[i]) & COMPONENT_MASKS[i]) as i16),
                last: parent_depth,
                finished: false,
            };
            let mut child = FieldPath {
                data: std::array::from_fn(|i| (u32::from(child[i]) & COMPONENT_MASKS[i]) as i16),
                last: child_depth,
                finished: false,
            };
            child.data[..shared_components].copy_from_slice(&parent.data[..shared_components]);
            let expected = child.last <= parent.last
                || child.data[..=parent.last] != parent.data[..=parent.last]
                || (child.data[parent.last + 1] as u64) < cutoff;
            proptest::prop_assert_eq!(FieldPath::retain_after_shrink(parent.pack(), cutoff)(child.pack()), expected);
        }
    }
}
