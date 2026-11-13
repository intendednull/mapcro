# mapcro task runner. Run inside `nix develop`.

model := "model"

# Random-simulate every sync-model property on the fixed design (fast).
model-sim samples="20000":
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{model}}
    for inv in noGap exactlyOnce noLostEdits confirmedIsLogPrefix quiescentConverges noClobber acksInOrder rejectedNeverLogged; do
      printf '%-22s ' "$inv"
      npx quint run fixed.qnt --main fixed --invariant "$inv" --max-samples {{samples}} --max-steps 25 --backend=rust \
        | grep -E 'violation|No violation'
    done

# Exhaustively check the fixed design with TLC (every reachable state; minutes).
model-check variant="fixed":
    #!/usr/bin/env bash
    set -euo pipefail
    out=$(mktemp -d)
    cd {{model}}
    npx quint compile --target tlaplus --main {{variant}} --invariant safety {{variant}}.qnt > "$out/{{variant}}.tla"
    jar=$(ls ~/.quint/apalache-dist-*/apalache/lib/apalache.jar | tail -1)
    unzip -o -q -j "$jar" tla2sany/StandardModules/Apalache.tla tla2sany/StandardModules/Variants.tla -d "$out"
    printf 'INIT q_init\nNEXT q_step\nINVARIANT q_inv\n' > "$out/{{variant}}.cfg"
    cd "$out" && tlc -workers auto -deadlock -config {{variant}}.cfg {{variant}}.tla

# Show a counterexample from the original design as one line per step.
model-trace invariant="noClobber" seed="0x345c":
    cd {{model}} && npx quint run asWritten.qnt --main asWritten --invariant {{invariant}} --max-samples 20000 \
      --max-steps 20 --seed {{seed}} --backend=rust --mbt --out-itf /tmp/mapcro-trace.itf.json >/dev/null || true
    python3 -I {{model}}/tools/summarize.py /tmp/mapcro-trace.itf.json

# Everyday tests: unit tests plus 1,000 simulation seeds.
test:
    cargo test -q --workspace
    # Crash points between a commit and its acks (test-only feature; never in a release build).
    cargo test -q -p mapcro-server --features failpoints --test system -- a_crash_between transactions_arriving
    cargo run -q --release -p mapcro-sim -- --seeds 1000

# Lints, warnings as errors (gated: just check, CI; docs/tech-debt.md rule 4).
clippy:
    cargo clippy -q --workspace --all-targets -- -D warnings

# The vendored boon and pbdems2's own tests (outside the workspace: crates/vendor/VENDORED.md).
vendor-test:
    cd crates/vendor/pbdems2 && CARGO_TARGET_DIR=../../../target/vendor cargo test -q --lib
    cd crates/vendor/boon-deadlock && CARGO_TARGET_DIR=../../../target/vendor cargo test -q --lib --config 'patch.crates-io.pbdems2.path="../pbdems2"'

# Train a storage dictionary from 300 simulation seeds (deterministic: same seeds, same bytes).
# Never overwrite one that has shipped: a new dictionary is a new codec (`zstd-v2`, codec.rs).
zdict out="crates/server/dict/ops-v1.zdict":
    cargo run -q --release -p mapcro-sim --example train_dict -- {{out}}

# Run the sync simulation (e.g. `just sim --seed 0x2a`, `just sim --seeds 10000 --steps 2000`).
sim *args:
    cargo run -q --release -p mapcro-sim -- {{args}}

# Regenerate the TypeScript types in web/src/gen from the Rust definitions.
ts:
    rm -rf web/src/gen
    cargo test -q -p mapcro-schema -p mapcro-engine --features ts export_bindings

# Record the map-state rows this build has as deployed (crates/schema/rows.lock). Run at each
# deploy, after it is live, and commit the file: a row may be written only once it is in here
# (docs/specs/map-state.md §4.3; the schema's test enforces it).
rows-lock:
    MAPCRO_ROWS_LOCK=1 cargo test -q -p mapcro-schema --lib rows_are_append_only

# Build the browser replica (WASM) into web/src/wasm.
wasm:
    cargo build -q --release -p mapcro-wasm --target wasm32-unknown-unknown
    wasm-bindgen --target web --out-dir web/src/wasm target/wasm32-unknown-unknown/release/mapcro_wasm.wasm

# Web client tests: the TypeScript session over the real WASM replica against the real server,
# plus the map renderer's pure parts; then the type check.
web-test: wasm ts
    cargo build -q -p mapcro-server
    cd web && npm test && npx tsc --noEmit

# Browser tests: real Chromium (from nix) against the real server serving the built client.
# `just e2e --headed`, or MAPCRO_SHOT_PACKS=~/.local/share/mapcro/packs just e2e to also
# screenshot the board with a real asset pack.
e2e *args: wasm
    cargo build -q -p mapcro-server
    cd web && npx vite build --logLevel warn && npx playwright test {{args}}

# The same specs in WebKit (from nix), the stand-in for the Linux app's WebKitGTK webview
# (desktop/README.md, Linux). Opt-in; specs on a Chromium-only API skip with the reason.
e2e-webkit *args: wasm
    cargo build -q -p mapcro-server
    cd web && npx vite build --logLevel warn && MAPCRO_E2E_WEBKIT=1 npx playwright test --project webkit {{args}}

# Many-peer soak on the real stack: the real server binary (release), real WebSockets, the
# TypeScript session over the WASM replica, IndexedDB via fake-indexeddb; drops, reloads, offline
# bursts and server kill -9s. Same seed, same schedule of actions. `just soak 0x2a 40 600`;
# flags after the three (`just soak 1 64 60 --default-caps`; `--help` lists them).
soak seed="random" peers="40" seconds="60" *flags: wasm
    cargo build -q --release -p mapcro-server
    cd web && node soak/bundle.mjs && node soak/.build/run.js --seed {{seed}} --peers {{peers}} --seconds {{seconds}} {{flags}}

# Performance: where the time goes from one person's input to another's paint, on the drag
# preview path, and in the server (web/perf/). Real browsers (Playwright) plus Node peers on a
# release server; results, traces and profiles go to /tmp/mapcro-perf/out, never the repo.
# Server stage timings need web/perf/server-timing.patch applied to the binary under test.
# `just perf local --fs tmpfs --peers 40 --storm 10`, `just perf live`, `just perf --help`.
perf *args: wasm
    cargo build -q --release -p mapcro-server
    cd web && npx vite build --logLevel warn && node perf/bundle.mjs && node perf/.build/run.js {{args}}

# Player's input latency and frame cost on a real replay (feedback #39; web/perf/player/): Tab to
# painted, hover to the game tooltip painted, a scrub step, and while playing fps, main-thread busy
# %, long tasks and a Chromium trace (Layerize, PrePaint, HitTest, Paint, style, layout totals;
# invalidations by kind), paused and playing, at 1x and 4x CPU throttle. Reads the dev stack's
# cached timeline (~/.local/share/mapcro/data/replays/<id>-cdn.json; fetch it on `just dev` first),
# else measures the reference replay 129738985. Prints numbers only, never names; summary.md and
# raw.json go to /tmp/mapcro-perf/out/player-<time> (PERF_OUT to choose; PERF_KEEP_TRACE=1 keeps
# the raw traces there). Keep the box's load low: each row records it.
# `just perf-player`, `just perf-player 129738985 1735`, `just perf-player 134623152 300,1735 1,4`.
perf-player match="134623152" at="300,1735" rates="1,4": wasm
    cargo build -q -p mapcro-server
    cd web && npx vite build --logLevel warn && PERF_MATCH={{match}} PERF_AT={{at}} PERF_RATES={{rates}} npx playwright test -c perf/player/playwright.config.ts

# Metrics, read-only (docs/specs/observability.md §4): `just stats summary`, `just stats failures
# --since 7d`, `just stats series op_ack_ms --since 6h --json` query production on `web` over the
# deploy SSH, as the mapcro user; `just stats local summary` queries the dev database
# (${XDG_DATA_HOME:-~/.local/share}/mapcro/data, or MAPCRO_DATA_DIR). Nothing here writes.
stats *args:
    #!/usr/bin/env bash
    set -euo pipefail
    set -- {{args}}
    if [ "${1:-}" = local ]; then
      shift
      cargo build -q -p mapcro-server
      exec target/debug/mapcro-server stats --data-dir "${MAPCRO_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mapcro/data}" "$@"
    fi
    exec ssh -i ~/.ssh/id_infra_2026 -o BatchMode=yes deploy@100.96.92.104 "sudo -u mapcro mapcro-stats $(printf '%q ' "$@")"

# Pull one of production's cached timelines to the dev box, for the lead (docs/deploy.md "Looking
# up a match from feedback"; find it first with `just stats timelines <id>`):
# `just pull-timeline <match id> [cdn|<scope>|<board id>] [--dev]`. It's copied, read-only, as
# the mapcro user, to ${XDG_DATA_HOME:-~/.local/share}/mapcro-lead/timelines/<id>-<scope>.json
# (0600, outside the repo) and never printed: timelines hold in-game names. `--dev` also puts it
# where the `just dev` server serves it to every local board, as <id>-cdn.json in the dev cache
# (MAPCRO_DATA_DIR or ~/.local/share/mapcro/data), moving a local one aside first.
pull-timeline +args:
    #!/usr/bin/env bash
    set -euo pipefail
    set -- {{args}}
    id="" which="" dev=0
    for a in "$@"; do
      case "$a" in
        --dev) dev=1 ;;
        -*) echo "pull-timeline: unknown flag $a" >&2; exit 2 ;;
        *) if [ -z "$id" ]; then id=$a; elif [ -z "$which" ]; then which=$a; else echo "pull-timeline: <match id> [cdn|scope|board] [--dev]" >&2; exit 2; fi ;;
      esac
    done
    [[ $id =~ ^[1-9][0-9]{0,11}$ ]] || { echo "pull-timeline: the match id is digits" >&2; exit 2; }
    which=${which:-cdn}
    if [[ $which == cdn || $which =~ ^[0-9a-f]{16}$ ]]; then
      scope=$which
    elif [[ $which =~ ^[A-Za-z0-9_-]{22}$ ]]; then
      scope=$(printf %s "$which" | sha256sum | cut -c1-16) # the board's scope (replays.rs scope_of)
    else
      echo "pull-timeline: name it by cdn, its 16-hex scope or its board id" >&2; exit 2
    fi
    dir="${XDG_DATA_HOME:-$HOME/.local/share}/mapcro-lead/timelines"
    mkdir -p -m 700 "$dir"
    out="$dir/$id-$scope.json"
    tmp=$(mktemp "$dir/.pull.XXXXXX")
    trap 'rm -f "$tmp"' EXIT
    ssh -i ~/.ssh/id_infra_2026 -o BatchMode=yes deploy@100.96.92.104 \
      "sudo -u mapcro gzip -c /var/lib/mapcro/replays/$id-$scope.json" | gunzip > "$tmp" \
      || { echo "pull-timeline: no $id-$scope.json on production (just stats timelines $id)" >&2; exit 1; }
    chmod 600 "$tmp"
    mv "$tmp" "$out"
    echo "pulled $id-$scope ($(stat -c %s "$out") bytes) to $out"
    [ "$dev" = 1 ] || exit 0
    data="${MAPCRO_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mapcro/data}"
    mkdir -p "$data/replays"
    dest="$data/replays/$id-cdn.json"
    if [ -e "$dest" ] && ! cmp -s "$dest" "$out"; then
      mkdir -p -m 700 "$dir/displaced"
      mv "$dest" "$dir/displaced/$id-cdn.$(date +%s).json"
      echo "moved the dev cache's own $id-cdn.json to $dir/displaced/"
    fi
    cp "$out" "$data/replays/.$id-cdn.pull" && mv "$data/replays/.$id-cdn.pull" "$dest"
    cargo build -q -p mapcro-server
    target/debug/mapcro-server stats timelines "$id" --data-dir "$data"
    echo "open match $id on any local board (the dev server needs REPLAY_DIR set to serve it: docs/deploy.md)"

# The app, live-reloading: the server (state and packs under ~/.local/share/mapcro, outside the
# repo) plus Vite on http://localhost:5173 proxying /api, /ws and /packs to it.
dev port="8094": wasm
    #!/usr/bin/env bash
    set -euo pipefail
    state="${XDG_DATA_HOME:-$HOME/.local/share}/mapcro"
    mkdir -p "$state/data" "$state/packs"
    cargo build -q -p mapcro-server
    PORT={{port}} DATA_DIR="$state/data" PACKS_DIR="$state/packs" \
      PUBLIC_ORIGIN=http://localhost:5173,http://127.0.0.1:5173 target/debug/mapcro-server &
    server=$!
    trap 'kill $server 2>/dev/null' EXIT
    cd web && MAPCRO_PORT={{port}} npx vite

# Everything CI runs, locally.
check: clippy test web-test e2e
    just model-sim 5000
    nix build .#checks.x86_64-linux.service

# Extract an asset pack from a local Deadlock install (read-only; output must be outside the repo).
# `just extract <citadel> <out> --stat-data <dir>` adds older patches' stat tables (`just stat-data`).
extract game out *args:
    cargo run -q --release -p mapcro-extract -- --game {{game}} --out {{out}} {{args}}

# Fetch boon-data snapshots (hash-checked) into a directory outside the repo, for the pack's
# per-patch stat tables (docs/research/stat-calc-spike.md "Production plan"). Re-runs fetch only
# new snapshots.
stat-data dir:
    python3 -I tools/stat-data/fetch.py {{dir}}

# Check calculated stats against a match's metadata (and its timeline): rates per stat, exit 1
# below the spike's floors. <data> is a boon-data snapshot dir or a pack's data/stats/<key>.json.
stat-check data metadata *timeline:
    cargo run -q --release -p mapcro-stats --example stat_calc_check -- {{data}} {{metadata}} {{timeline}} --floors

# Watch production every 15 min and alert the lead through Paseo (docs/deploy.md "Watching
# production"). A transient user timer on the dev box: re-run this after a reboot.
watch-install:
    systemctl --user stop mapcro-prod-watch.timer mapcro-prod-watch.service 2>/dev/null || true
    systemd-run --user --unit mapcro-prod-watch --on-calendar='*:0/15' --timer-property=Persistent=false \
      --setenv=PATH="$HOME/.nix-profile/bin:/run/current-system/sw/bin" \
      --working-directory={{justfile_directory()}} \
      nice -n 19 nix develop {{justfile_directory()}} -c python3 -I tools/prod-watch/watch.py
    systemctl --user list-timers mapcro-prod-watch.timer --no-pager

# The Linux app, smoke-tested for real (desktop/README.md, Smoke test): a debug build driven by
# tauri-driver and WebKitWebDriver under Xvfb, against a page with the site's CSP and a fake Steam
# install. A private D-Bus session: a mapcro:// link goes to the running app over it (the
# single-instance plugin), never to an app on your desktop's bus. Run inside `nix develop .#desktop`.
desktop-smoke:
    cd desktop/app && cargo build
    xvfb-run -a dbus-run-session -- node desktop/smoke/smoke.mjs desktop/app/target/debug/mapcro-desktop --fake-steam
