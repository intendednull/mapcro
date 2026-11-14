#!/usr/bin/env bash
# Run one heavy job (cargo test or build, e2e, mutants, a gate, `just dev` for QA) when the shared
# box is free, one mapcro heavy job at a time. Usage: tools/heavy.sh <command...>
# It takes a lock that every mapcro agent and the lead's gate share, then waits until
# tools/box-busy.sh says free (no Adora heavy job here, load under 12). Don't nest it.
set -u
here=$(cd "$(dirname "$0")" && pwd)
exec 9>/tmp/mapcro-heavy.lock
flock 9
while bash "$here/box-busy.sh"; do sleep 20; done
nice -n 10 "$@"
