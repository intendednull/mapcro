# mapcro

A real-time collaborative macro-coaching board for Deadlock. Place heroes on the minimap, toggle
objectives, draw rotations, step through scenes, and share a link to watch or edit live.

**Status:** architecture under review. No code yet. Start at
[docs/specs/architecture-design.md](docs/specs/architecture-design.md).

## Game assets

mapcro ships **no Valve assets**. The map, icons and portraits are extracted on your machine from
your own Deadlock install, and they stay there. This repo's `.gitignore` excludes extracted output.
Deadlock and its assets are the property of Valve Corporation. mapcro is an unofficial fan tool
with no affiliation with Valve.

## Docs

- `docs/specs/`: the current design (living)
- `docs/research/`: prior-art research behind the design
- `docs/plans/`: implementation plans
