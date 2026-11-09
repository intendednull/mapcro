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
check: test web-test e2e
    just model-sim 5000
    nix build .#checks.x86_64-linux.service

# Extract an asset pack from a local Deadlock install (read-only; output must be outside the repo).
extract game out:
    cargo run -q --release -p mapcro-extract -- --game {{game}} --out {{out}}
