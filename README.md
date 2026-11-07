# mapcro

A real-time collaborative macro-coaching board for Deadlock. Place heroes on the minimap, toggle
objectives, draw rotations, step through scenes, and share a link to watch or edit live.

**Status:** early. The sync engine, server and browser client core work and are heavily tested;
the board UI is being designed. Start at [docs/specs/architecture-design.md](docs/specs/architecture-design.md)
and the build journal in [docs/journal/](docs/journal/).

## Develop

Everything runs in the Nix dev shell (`nix develop`):

- `just test`: Rust tests and 1,000 seeds of the deterministic sync simulation
- `just check`: everything CI runs, including the web client against the real server, the Quint
  protocol model and the NixOS service VM test
- `just sim --seed <n>`: replay one simulation seed
- `just model-check`: exhaustive TLC check of the protocol model

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
- `docs/journal/`: what was tried, what broke, and what we learned

## License

MIT. See [LICENSE](LICENSE).
