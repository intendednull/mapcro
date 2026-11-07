# mapcro

A real-time collaborative macro-coaching board for Deadlock. Place heroes on the minimap, toggle
objectives, draw rotations, step through scenes, and share a link to watch or edit live.

**Status:** architecture under review. No code yet. Start at
[docs/specs/architecture-design.md](docs/specs/architecture-design.md).

## Game assets

The repo contains **no Valve assets**. Whoever runs a mapcro server extracts the map, icons and
portraits once from their own Deadlock install with `mapcro-extract`, and the server serves them.
Users don't extract anything. `.gitignore` excludes extracted output. mapcro is free and
non-commercial. Deadlock and its assets are the property of Valve Corporation, and mapcro is an
unofficial fan tool with no affiliation with Valve.

## Docs

- `docs/specs/`: the current design (living)
- `docs/research/`: prior-art research behind the design
- `docs/plans/`: implementation plans
