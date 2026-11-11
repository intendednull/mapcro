# Replay parser memory (2026-11-11, parser-memory)

Question (operator): how can the replay parser use less memory, so that (a) a WebAssembly build
can parse a ~500 MB demo in a browser (no mmap, the `File` read in slices, phones), (b) the
Windows and Linux app parses more lightly, and (c) the server's `mapcro-replay` worker costs less
per job?

**Answer.** On main a full parse of 129738985 (504 MB, format 9) peaks at **48 MB anonymous**
memory. The other ~485 MB is the memory-mapped demo's clean file pages. Two thirds of the
anonymous peak is state we don't read: boon's modifier table and fields of busy classes we never
look at. The branch removes it with the same timeline output. The anonymous peak drops to
**32.5 MB (-32%)**, and a parse now finishes under a 36M cgroup cap, where main is killed at 40M.
A browser build needs one more change: a streamed reader, because boon only parses a buffer
holding the whole file (`from_bytes`: +481 MB measured). With a streamed reader the projected
wasm peak is **about 35–40 MB**.

**Update (branch `stream-parse`, §5):** the streamed reader is built. The timeline is the same
bytes, a job's VmHWM falls from ~540 to 37–40 MB, downloads stop writing the expanded demo, and a
wasm32 build of the parse ran in node in **30.7 MiB** of wasm memory with the same output.

Probe: `crates/replay/examples/memory_probe.rs <mode> <demo> [out.json]`, release build. It
prints sizes, counts and timings only, never names or ids. Modes: `full` (the worker's job, by
phase), `boon`, `bytes`, `state`, `state-filtered`, `census` and `spliced`. The workspace forbids
`unsafe`, so the probe has no counting allocator. It reads `/proc/self/status` per phase
(VmHWM is reset through `clear_refs`, and a sampler reads RssAnon and RssFile every 20 ms). Heap
attribution comes from `valgrind --tool=massif` (system valgrind) on `full`, and CPU from
`perf record`. All numbers below are from this box at load 7–12 (shared, `nice -n 10`).

## 1. Where the memory goes today

| | main | branch |
|---|---|---|
| Max RssAnon during the parse | 48.0 MB | **32.5 MB** |
| Heap peak (massif, useful heap) | 48.7 MB | 32.2 MB |
| Max RssFile (the mmapped demo, clean, reclaimable) | 484.6 MB | 484.8 MB |
| VmHWM (= `JobStats.peak_rss_bytes`, anonymous + file) | 532 MB | 517 MB |
| `MemoryMax=40M` (`systemd-run --user --scope`, swap 0) | killed (SIGKILL), twice | completes; at **36M** too, with identical output |
| Wall time (A/B, alternating, load ~10) | 15.4 s, 14.3 s | 14.4 s, 13.7 s |

The worker's `peak_rss_bytes` metric is VmHWM, so the mapped file dominates it. It reads ~530 MB
for any parse of this demo and says nothing about the anonymous part. The anonymous part is
what a cap or a wasm heap has to hold. The figure "26 MB anonymous" (spec §6a, desktop-app §4,
nix/module.nix `memoryMax`) was taken before formats 7 to 9; those texts now give the new
numbers. The record now also carries `peak_anon_bytes` (the child's RssAnon, sampled every
20 ms): 35.2 MB for this demo's `job` run on the branch (it includes the sampler thread's stack
and the decompression phase).

**Measuring a CDN download's zstd window:** each fetched job's record carries
`zstd_window_bytes`, read from the download's first frame header, and the server keeps it as the
`zstd_window_bytes` histogram (`mapcro-server stats series zstd_window_bytes`). After the first
fetches, that and `parse_peak_anon_bytes` together give the cap: anonymous peak + window +
page-cache headroom.

**Breakdown at main's heap peak** (massif snapshot 47 of 61, 48.7 MB, near the end of the match;
the class split is from `state`, sampled every 640 ticks at its largest):

| What | Size | Notes |
|---|---|---|
| boon `ModifierState` (parse_hero's `HeroTracker`) | **8.0 MB live, 14.4 MB at a rehash** | 474,603 table changes. 9,147 live entries at most, in a 14,336-slot map of `(u32, CModifierTableEntry)` at 584 B each. boon drops an entry only at an explicit removal, so it holds every modifier ever applied that wasn't removed. We read 5 fields of it |
| Entity field maps (`FxHashMap<u64, FieldValue>`, 40 B a slot) | 13.4 MB (16.1 MB in massif with the baseline clones) | `CCitadel_BreakableProp` 709 entities 6.2 MB (we read the subclass and origin, on 78 tough crates); `CNPC_Trooper` 216 3.4 MB; `CCitadelZipLineNode` 334 1.5 MB; pawns 0.4; health pickups 0.4; teams 0.2; everything else < 0.2 each |
| Our per-second observations (`Obs`) | ~14 MB at the end | `seconds`: heroes 5.1 MB (`HeroObs` 136 B, 12 a second, plus a name `String` cloned every second), objectives 3.3, troopers 2.5 (82,559 rows, 31/s), zip_teams 0.8, the `Sample` vec 0.7, powerups and casts 0.3. Events: damage 0.9 (27,046 rows), effects and applications 0.4, the rest < 0.2 |
| boon's prepared state | ~2 MB | serializers 1.05 MB, the command index 1 MB (`distinct_ticks`, 173k i32 with growth headroom), signon string tables |
| Buffers | ~1.5 MB | the decompressed command body (largest 0.6 MB: full packets), the per-tick event payloads (largest tick 0.2 MB) |
| `derive` | +0 | 0.05 s; it reuses freed heap (the timeline is smaller than `Obs`) |
| `serde_json::to_vec` | +0.7 MB anonymous | the 1.8 MB timeline JSON |

**The demo bytes.** `Parser::from_file` mmaps the file. `parse::header` maps it a second time
for the header (cheap: one page). boon's index (`prepare`) walks every command header before the
first tick (55–60 ms warm), and the forward pass then touches every page, so RssFile grows to
the whole file. Those pages are clean and the cgroup reclaims them, which is why a capped parse
survives (~18% slower at 64M per desktop-app §4; the branch took 14.0 s under 40M). `from_bytes`
of a `std::fs::read` (mode `bytes`) costs **481 MB anonymous** before the parse starts, and
504 MB at its peak.

**Decompression (CDN downloads).** This wasn't measured: no `.bz2` or `.zst` download was
opened. `worker::expand` streams the decoder into `work/<job>.dem` on disk, then mmaps that file.
The decoders are small: bzip2 needs ~3.7 MB at block size 9 (its manual), and zstd up to its
window, capped at 128 MiB by `window_log_max(27)`. The CDN frames' real window size is unknown.
The expanded 504 MB file is written through the page cache, and in the worker's cgroup those
pages are charged as dirty until written back. So a fetched job's footprint includes a write of
the whole demo, which a streamed parse fed straight from the decoder would not need.

**CPU, for phones** (perf, branch build, 6,096 samples). boon's own decoding is under half the
time. Mode `boon` (boon alone, the worker's classes, an empty callback) takes 5.6 s, against
12.6 s for the full observe. Our per-tick trackers make up the rest, because each one walks
every entity on every one of ~170k ticks: `vision_tick` 11.3%, `urn_tick` 6.6%, `crate_tick`
5.5%, `heal_tick` 4.7%, `buff_tick` 4.0%, and much of `Entity::get_i64` (12.3%). This is TD-8.

## 2. What a browser (wasm) parse needs

**boon needs the whole file in memory today.** `Parser` stores `Mmap` or `Vec<u8>`. pbdems2's
`Demo`, `CommandIter` and `CommandFrame` all borrow `&'a [u8]`. `PreparedPlayback` builds the
index with a full header walk and checks that a session runs on the same buffer
(`DemoIdentity`: its address and length). There is no reader API.

**The forward pass doesn't need random access.** `DemoParser::replay_cursor` is a plain loop:
read a command header, read its body, decode the body into a reused buffer, call
`adapter.handle_command(frame, body, ctx)`, and emit the tick when the tick number changes.
boon's `CitadelAdapter` only reads `frame.header()` and the decoded body, never the offset or
the buffer. The index is only used to seek (`parse_to_tick`, segments), and a full parse doesn't
seek. So a reader-based pass needs:

- **pbdems2 (vendored, MIT):** a public `CommandFrame` constructor, or a `replay_reader(adapter,
  state, impl Read, class_filter, on_tick)` beside `replay_cursor`, plus an `initialize` that
  reads through `DEM_SyncTick`. The property projection (`EntityContainer::project_properties`)
  is `pub(crate)`, so it has to live inside the crate. About 150 lines.
- **boon (vendored, MIT):** `Parser::run_reader_with_properties(reader, classes, properties,
  event_types, on_tick)` that builds the `pub(crate)` `CitadelAdapter` and calls the above.
  About 60 lines. Wire both in with `[patch.crates-io]`. The same patch could feature-gate
  boon's `reqwest`, `tempfile` and `memmap2`, which only boon-data downloads and `from_file` use.
- **mapcro:** `parse::observe_with` (added on this branch) is the seam. It takes the class
  filter, the property filter, the message types and the per-tick callback, and lets the caller
  play the demo. The header (build, `server_start_tick`) comes from the first command
  (`CDemoFileHeader`), as `preview.rs` already reads it.
- **Browser:** run it in a Web Worker. Implement `std::io::Read` over
  `FileReaderSync.readAsArrayBuffer(file.slice(a, b))` in 1 MB chunks (synchronous in a worker).

**Projected peak for a streamed parse:** the branch's ~31 MB of state, plus a 1 MB read chunk,
plus one encoded body (≤ 0.3 MB) and one decoded body (≤ 0.6 MB), is ~33 MB of heap. wasm's
allocator never returns memory to the browser, and the module and the JS-side chunk add a few
MB, so plan on **35–40 MB** of wasm memory. Without streaming it is ≥ 510 MB of wasm memory plus
the JS `ArrayBuffer` it was copied from: possible on a desktop (wasm32 allows 4 GB), not on a
phone.

**A route with no patch, tried: the spliced read** (`memory_probe spliced`; the preview's
technique, run over the whole match). The probe reads the file forward once. It plays each
stretch from one full packet to the next (one minute) as its own small demo, with the signon in
front (`from_bytes`, header offsets zeroed), through `observe_with`. A full packet at tick T
comes *after* tick T's packet (`7@3841 13@3841 7@3842`). So each stretch's last tick is held
back, its events kept, and it is given once, with the next stretch's restored state and both
sets of events. Results: 47 stretches, the largest 14.8 MB, max RssAnon 46 MB (the stretch
buffer grows by doubling; reserving it exactly would give ~35–40 MB), 13.0 s. **The timeline is
identical except for the tough crates:** 70 of 78 crates and 202 of 232 cleared intervals. The
players, objectives, vision, effects, casts and charges are all exact. The cause wasn't found.
The likely one is that a restore from a full packet doesn't give the breakable props' subclass
or active state as the delta stream has it (instance baselines or dormancy). So the splice needs
that fixed before it can serve. The streamed reader keeps the command order and state of the
mmapped run, so it should be exact by construction, but that is untested.

## 3. Ranked plan

Saving is anonymous peak on 129738985; effort is S under an hour or so, M about a day.

| # | Win | Saving | Effort | Status |
|---|---|---|---|---|
| 1 | Keep only the modifier fields read (`parse_hero::Modifiers`: parent and stack count per serial, ~25 B, against boon's whole 584 B entries) | 8 MB live; 14 MB at the rehash peak | S | **done on the branch** |
| 2 | boon's property filter for troopers, breakable props and zipline nodes, and collect only the 5 message types read (`run_to_end_with_properties`) | ~5.6 MB of entity state; fewer event payload copies | S | **done on the branch** |
| 3 | A streamed reader in vendored pbdems2 + boon (§2) | wasm: 481 MB → ~1 MB of demo bytes; server and app: no mmap, so no SIGBUS case and no 485 MB of file pages to reclaim | M | **done on `stream-parse`** (§5): VmHWM 540 → 37 MB, anon −1 MB |
| 4 | Feed the CDN decoder (bz2/zstd) straight into the streamed parse: no 504 MB `work/` file, no dirty page cache, no disk write | the page cache and disk I/O of a fetched job; the decoder window stays | S after 3 | **done on `stream-parse`** (§5): 506 → 1.9 MB written |
| 5 | Slimmer per-second `Obs`: the hero name once, not every second; objectives as changes; narrower types (`i64` → `i16`/`u8` for team, lane, phase) | ~14 → ~6 MB | M (derive.rs) | proposed |
| 6 | Trackers on changed entities only (`entity_changes`/`updated_indices`), not a walk of every entity every tick | CPU: up to ~40% of parse time (TD-8), phones' main cost | M | proposed; exact if done by change, not by cadence |
| 7 | Field maps keep the baseline's capacity after projection: breakable props still hold 3.1 MB for 2 fields (`state-filtered`) | ~4 MB | S upstream (shrink after projection) | upstream |
| 8 | Write the timeline incrementally | ~0.7 MB | M | not worth it |

Lower-cadence trackers (sampling every Nth tick) were weighed for win 6 and set aside: the up and
down events are stamped finer than a second (heals, crates, urn), so the output would change.
Working from changed entities gives the same saving without that.

## 4. wasm32 feasibility

`cargo check --target wasm32-unknown-unknown -p mapcro-replay --features parse` passes, and
`cargo build --release` of the library also succeeds. That hides one blocker:

- **zstd-sys (C):** `cc` used the dev shell's gcc for the wasm target. `libzstd.a` holds
  **x86-64 ELF objects**, so a wasm `cdylib` link would fail. zstd is only for CDN downloads in
  `worker.rs`, and a user's own `.dem` is never compressed. Fix: split a `worker` feature (zstd,
  bzip2, libc, `worker`) off `parse`, or move to `ruzstd` (pure Rust, already used by
  `crates/extract`).
- **bzip2 0.6** uses `libbz2-rs-sys` (pure Rust) and builds for wasm.
- **memmap2** compiles, but `Parser::from_file` fails at runtime: use `from_bytes` or the
  streamed reader.
- **`std::fs` / `&Path` entry points** (`parse::header`, `parse::observe`, `preview::read`'s
  `File`, the worker) compile and fail at runtime. `observe_with` is the seam for the parse;
  `preview::read` would need to be generic over `Read + Seek`.
- **`std::time::Instant`** (worker.rs `run_job`, `serve`) panics on wasm32-unknown-unknown at
  runtime. The wasm entry must call `observe_with` → `derive` → `serde_json`, not `worker::job`.
- **std::process** (the worker's children) compiles but can't be used. Expected.
- **Threads:** the parse uses none. boon has a `Mutex` and a `OnceLock` (fine single-threaded),
  and pbdems2 uses threads only in tests.
- **reqwest (blocking, rustls) and tempfile** are unconditional boon dependencies. They compiled
  for wasm32 and are dead code for us. Size wasn't measured.
- Not done: a `cdylib`, the JS glue, a run in a browser, code size, or a check that std's
  `RandomState` behaves on wasm32-unknown-unknown at runtime.

## 5. Streamed (2026-11-11, branch `stream-parse`)

**What was built.** boon 0.19.0 and pbdems2 0.4.1 are vendored (`crates/vendor/`, MIT, the diff
in `VENDORED.md`). pbdems2's `StreamPlayback` plays the signon and then the forward run of a
`PlaybackSession` over any `Read`: the same `handle_command` calls and tick callbacks, through a
256 KiB `BufReader`, one encoded body and one decoded body. boon's `StreamParser` is
`run_to_end_with_properties` over it. In mapcro, `parse::observe_stream(open, match_id)` reads
the first command (`DEM_FileHeader`) itself, so the build and Brawl checks still come before the
signon is parsed, then hands the stream on. `parse::observe(path)` streams from the file;
`observe_mapped` keeps the old path for this A/B. The worker's `demo_reader` gives the file
itself or its bz2/zstd decoder, capped at `max_dem_bytes`; a decoder error is `not_a_replay`,
the cap `too_large`. Nothing is written to `work/` but the timeline and its record.

**Same output.** The timeline JSON of 129738985 (match id 129738985, through `mapcro-replay job`)
from main's binary (4a7634a, mapped) and the branch's (streamed) is byte for byte the same, from
the `.dem`, from a `.zst` (zstd -3, 356 MB, 2 MiB window) and from a `.bz2` (bzip2 -9, 349 MB):
six runs, one SHA-256. `memory_probe full` (streamed) and `full-mapped` give the same bytes too,
and so does the wasm build below. Repeated runs are identical (TD-24).

**Before and after** (`mapcro-replay job`, release, this box at load 8–13, `nice -n 10`; disk is
the child's `wchar`, all of it file writes):

| Input | | wall | `peak_anon_bytes` | VmHWM (`peak_rss_bytes`) | written |
|---|---|---|---|---|---|
| `.dem` 504 MB | main | 13.4 s, 12.5 s | 35.2 MB | 542 MB | 1.86 MB (the timeline) |
| | branch | 13.5 s, 12.4 s | 32.7, 33.0 MB | 36.2, 36.8 MB | 1.86 MB |
| `.zst` 356 MB | main | 14.7 s (1.5 s expanding) | 35.2 MB | 542 MB | **506 MB** (504 MB demo + timeline) |
| | branch | 13.9 s | 35.9 MB | 39.4 MB | **1.86 MB** |
| `.bz2` 349 MB | main | 36.6 s (23.8 s expanding) | 35.2 MB | 542 MB | **506 MB** |
| | branch | 37.4 s | 37.0 MB | 40.4 MB | **1.86 MB** |

The anonymous peak drops ~2 MB for a `.dem` (no `distinct_ticks` index, ~1 MB, and no header
map). A decoder adds its own: zstd's 2 MiB window, bzip2's ~3.7 MB at block size 9. Wall time is
the same within noise; for bz2 the decoder dominates either way (one core, serial). Under
`systemd-run --scope -p MemoryMax=34M -p MemorySwapMax=0`, main's job is SIGKILLed and the
branch's completes with the same bytes (36M too). `memory_probe`'s phase view: the streamed
observe peaks at 31.8 MB anonymous and **3.6 MB of file pages** (the binary), where the mapped
one has 32.7 MB and 484.7 MB.

**A schema change after signon.** The mapped parser checks its index and decodes such a demo in
full; a stream can't look ahead. So a streamed run with a property filter that meets
`DEM_SendTables` or `DEM_ClassInfo` after signon fails with `SCHEMA_CHANGED`
(`Error::is_schema_change`), and `observe_stream` opens the input again and plays it without the
filter (same output: the filter only drops fields we don't read). A fetched download is decoded
twice then. 129738985 has none (its streamed parse takes one parse's time, not two); boon's unit
test covers the path.

**wasm32.** A scratch `cdylib` (in /tmp, not committed) over `mapcro-replay` with
`default-features = false, features = ["parse"]` builds for `wasm32-unknown-unknown`: no C code
(`cargo tree` lists no `-sys` crate; zstd-sys is in `worker` now), 852 KB at `opt-level = "s"`
with LTO, before wasm-opt. Its `run` export reads the demo through an imported `read_chunk(ptr,
len)`, the shape a Web Worker's `FileReaderSync` over `file.slice` would have, and node's
`fs.readSync` served it in 1,927 reads of 256 KiB. Result: the **same timeline bytes**, **30.7 MiB
of wasm memory** at the end (`memory.buffer.byteLength`; wasm memory never shrinks, so that is
the peak), 21.2 s against 12.5 s native (V8, this box). What still stands between this and a
browser parse:

- **The glue:** wasm-bindgen (or the raw imports above), a Web Worker, `FileReaderSync` reads,
  and posting the JSON back. Not built, by the brief.
- **`preview::read`** maps (its fallback is boon's `from_file`) and seeks a `File`; it is behind
  the `mmap` feature now (TD-28). A browser picker card needs a `Read + Seek` version.
- **`parse::observe(path)`, `parse::header`** use `std::fs` (and `header` maps): a browser calls
  `observe_stream`, then `derive::derive` and `serde_json::to_vec`.
- **boon's `tempfile`** is still an unconditional dependency (pure Rust; it compiles and is dead
  code for us). reqwest is out (boon's `download` feature, off), memmap2 too unless `mmap`.
- Not measured: a real browser, a phone's speed (desktop V8 took 1.7× native), the size after
  wasm-opt, a cancel mid-parse.

## The tracer on this branch

`parse_hero.rs`: `Modifiers` replaces boon's `ModifierState`. It reports the same applied and
removed changes, and a changed one when the parent or the stack count changed (boon also reports
changes to fields nothing reads). `parse.rs`: `run_to_end_with_properties` with the property
filter and the message types above, and `observe_with` split out of `observe`.

**Same output:** the timeline JSON is byte-identical run to run. It is identical to main's once
each player's `charges` is sorted. main itself isn't deterministic there: `HeroTracker` walked a
`HashMap` to emit a tenth-second's charge reads, so same-instant reads came out in random order.
Two main runs differed in 4 and 30 places, all in `charges`. The branch emits them in key order
(tech-debt TD-24). With the charges sorted, main ×2 and branch ×2 are equal. A run capped at 36M
gives the same bytes. Tests: `cargo test -p mapcro-replay --release -- --include-ignored` passes
with `MAPCRO_REPLAY(_129738985)` set (73 unit, 11 local-replay, 3 queue tests). The old-map and
Street Brawl local tests weren't run: only 129738985 was opened. Clippy is clean on the crate's
lib, tests, bins and this probe.

## Traps

- **VmHWM isn't the parse's memory:** with mmap it is the file size plus the anonymous part.
  Watch RssAnon, or the cgroup's `memory.stat` `anon`.
- **boon's `ModifierState` grows for the whole match:** entries go only at an explicit removal.
  Don't keep one for a long run unless it's needed.
- **A property filter keeps the map's capacity:** the projected entities are still built from a
  clone of the full baseline (`BaselineCache::apply`), so a class with few kept fields still pays
  for its baseline's slots.
- **Main's timeline isn't byte-stable** (charges order, above). Compare with `charges` sorted, or
  against this branch.
- **The full packet follows its tick's packet:** a splice cut at a full packet's offset splits
  that tick in two.
- **A probe's timeline isn't a job's:** `memory_probe` passes match id 0, the job its own, so
  compare like with like.
- **`decompress_s` is gone from new records:** decompression streams into the parse, so it's in
  `parse_s` (stream-parse).
