# mapcro task runner. Run inside `nix develop`.

model := "model"

# Random-simulate every sync-model property on the fixed design (fast).
model-sim samples="20000":
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{model}}
    for inv in exactlyOnce noLostEdits confirmedIsLogPrefix quiescentConverges noClobber acksInOrder rejectedNeverLogged; do
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
    cargo run -q --release -p mapcro-sim -- --seeds 1000

# Run the sync simulation (e.g. `just sim --seed 0x2a`, `just sim --seeds 10000 --steps 2000`).
sim *args:
    cargo run -q --release -p mapcro-sim -- {{args}}
