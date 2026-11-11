# Vendored crates

Two crates are copied here from crates.io and patched in with `[patch.crates-io]` (the root
`Cargo.toml` and `desktop/app/Cargo.toml`). Both are MIT, by Peter Xenopoulos; their licence
files are kept beside them (`*/LICENSE`).

| Crate | Version | Upstream | Source commit (`.cargo_vcs_info.json`) |
|---|---|---|---|
| `boon-deadlock` (lib `boon`) | 0.19.0 | <https://github.com/pnxenopoulos/boon> (`crates/boon`) | `1edc59733bce6cdffc90f661402002079c6bc2e6` |
| `pbdems2` | 0.4.1 | <https://crates.io/crates/pbdems2> | `a7cefbec370e034df06161603fe1252ef8f62c46` |

The copies are the published packages as they are, without their `Cargo.lock`. The first commit
that adds them (`vendor boon-deadlock 0.19.0 and pbdems2 0.4.1 unchanged`) changes nothing
inside them, so `git diff <that commit> -- crates/vendor` is the whole patch. They are outside
the workspace (`exclude`), so `just clippy` and `just test` don't lint or test them; `just
vendor-test` runs their own tests.

## Why

boon parses a demo only from one buffer holding the whole file: `Parser::from_file` maps it and
`from_bytes` takes a `Vec<u8>`, and pbdems2's `Demo`, `CommandIter` and `CommandFrame` borrow
that buffer. A browser has no mmap, and a 500 MB buffer doesn't fit a phone; the worker paid for
the map (VmHWM ~530 MB a job) and, for a CDN download, wrote the decompressed demo to disk to
map it. A full forward pass doesn't need the whole file: it reads each command once, in order
(docs/research/parser-memory.md §2). The patch adds that pass over any `Read`.

## The patch

**pbdems2: `StreamPlayback`** (new file `src/playback/stream.rs`). `initialize(reader, adapter,
tick_interval)` checks the magic and plays the signon through `DEM_SyncTick` exactly as
`DemoParser::initialize` does, then restores the adapter from its checkpoint as a
`PreparedPlayback::session` does. `project_properties(filter)` is `session_with_properties`.
`try_run_to_end_filtered_with_adapter` is `replay_cursor`'s loop with no end tick: the same
`handle_command` calls and tick callbacks in the same order. The reader holds a 256 KiB
`BufReader`, one encoded body and one decoded body. A stream can't be indexed ahead, so a run
with a property selection that meets `DEM_SendTables` or `DEM_ClassInfo` after signon fails with
`SCHEMA_CHANGED` (the mapped parser checks its index and decodes such a demo in full instead);
the caller plays it again without a selection. Its tests check the streamed commands against
`CommandIter` (also one byte per read) and that a stream cut inside a command is an error.

**boon: `StreamParser`** (new file `src/demo/stream.rs`). `new(reader)`, `file_header()`,
`class_info()`, `serializers()` and `run_to_end_with_properties(...)`, the last the same as
`Parser::run_to_end_with_properties` over `StreamPlayback`. `Error::is_schema_change()` tells
the `SCHEMA_CHANGED` failure apart. Its tests check that failure, and a no-selection run giving
the mapped parser's ticks.

**boon: features** `mmap` (memmap2, `Parser::from_file`) and `download` (reqwest, boon-data
downloads), both default. mapcro-replay turns the default off and asks for `mmap` only where it
maps (the preview's fallback, `parse::header`, the probes), so reqwest is out of the build.

The rest of the patch, as a diff against upstream (the two new files aside):

```diff
--- a/pbdems2/src/demo/stream.rs
+++ b/pbdems2/src/demo/stream.rs
 impl<'a> CommandFrame<'a> {
+    /// A frame read from a stream rather than borrowed from a whole file
+    /// (mapcro patch: [`crate::playback::StreamPlayback`]).
+    pub(crate) const fn streamed(
+        index: usize,
+        (offset, end_offset): (usize, usize),
+        header: CmdHeader,
+        encoded_body: &'a [u8],
+        limits: DecodeLimits,
+    ) -> Self {
+        Self { index, offset, end_offset, header, encoded_body, limits }
+    }
--- a/pbdems2/src/playback.rs
+++ b/pbdems2/src/playback.rs
 mod prepared;
+mod stream;
+pub use stream::{SCHEMA_CHANGED, StreamPlayback};
--- a/pbdems2/src/lib.rs
+++ b/pbdems2/src/lib.rs
-    PlaybackSegment, PlaybackSession, PreparedPlayback,
+    PlaybackSegment, PlaybackSession, PreparedPlayback, StreamPlayback,
--- a/boon-deadlock/Cargo.toml
+++ b/boon-deadlock/Cargo.toml
+[features]
+default = ["download", "mmap"]
+download = ["dep:reqwest"]
+mmap = ["dep:memmap2"]
 [dependencies.memmap2]
+optional = true
 [dependencies.reqwest]
+optional = true
--- a/boon-deadlock/src/demo/mod.rs
+++ b/boon-deadlock/src/demo/mod.rs
+mod stream;
+pub use stream::StreamParser;
--- a/boon-deadlock/src/lib.rs
+++ b/boon-deadlock/src/lib.rs
-    CmdHeader, Context, GameEvent, MessageInfo, Parser, command_name, decode_event_payload,
+    CmdHeader, Context, GameEvent, MessageInfo, Parser, StreamParser, command_name,
+    decode_event_payload,
--- a/boon-deadlock/src/demo/parser.rs
+++ b/boon-deadlock/src/demo/parser.rs
+#[cfg(feature = "mmap")]
 use std::path::Path;
+#[cfg(feature = "mmap")]
 use memmap2::Mmap;
 enum Storage {
+    #[cfg(feature = "mmap")]
     Mmap(Mmap),
             Storage::Mmap(m) => m,   (the same cfg on the match arm)
     /// Open a demo file and memory-map it for zero-copy parsing.
+    #[cfg(feature = "mmap")]
     pub fn from_file(path: &Path) -> Result<Self> {
--- a/boon-deadlock/src/data.rs
+++ b/boon-deadlock/src/data.rs
-#[cfg(not(target_family = "wasm"))]
+#[cfg(all(feature = "download", not(target_family = "wasm")))]
 use std::time::Duration;            (and on the HTTP client and its fetch branch)
+    #[cfg(feature = "download")]
     Http(#[from] reqwest::Error),
-        #[cfg(target_family = "wasm")]
+        #[cfg(any(not(feature = "download"), target_family = "wasm"))]
-                "boon-data downloads are unavailable on WebAssembly",
+                "boon-data downloads are unavailable on WebAssembly or without the download feature",
```

Size: the two new files are about 385 lines with their comments (rustfmt's layout, as
upstream's) and 175 lines of tests; the edits above are about 40. The estimate was ~200: the
reader keeps `CommandIter`'s errors (a stream cut inside a command is an error, not an end), and
the schema fallback needed its own error.

## Updating

To move to a new upstream version: copy the new packages over these directories (drop their
`Cargo.lock`), commit that alone, then re-apply the two new files and the edits above, and run
`just vendor-test` and the identity check in docs/research/parser-memory.md ("Streamed"). If
upstream gains a reader API, drop the patch and the `[patch.crates-io]` lines.
