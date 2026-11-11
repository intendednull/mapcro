# Replay death cue prototype — 2026-11-10

A fallen hero keeps its existing minimap portrait and token size, with a restrained red rim and
wash and the extracted game skull as a small badge. Both belong to one SVG group whose opacity
comes from replay time, so pause, seek and following agree. The existing 2.5-second quadratic
fade and `deathSeen` vision rule are preserved; unseen enemy deaths gain no new cue. Existing
omniscient event pings remain as documented in the backlog.

A quick respawn ends the fallen portrait immediately, using explicit respawn intervals or alive
position samples for older timelines. A subsequent death replaces an earlier death within the
window. No retained token, hover target, player name or asset copy is added. Packs without the
skull retain the existing schematic skull fallback; packs without hero art retain a red disc.

Validation: 12 focused skull unit tests pass; TypeScript check and production Vite build pass
with the companion Board `art={p.art}` prop (owned by the controls branch). Initial two focused
browser tests timed out before reaching feature assertions, in joinNew's nickname input, with
shared WASM symlink setup. Browser verification is being retried with a local WASM copy.

Optional next scope proposed to coordinator: default-off, one tiny active hard-CC text badge
under visible living tokens, stun/silence/disarm only. General buffs and effect stacks deferred
to avoid clutter and attribution ambiguity. No deployment, asset commit or real-player capture.

## Optional compact CC follow-up

Coordinator approved a separate, default-off Crowd control map layer. The host exposes
`showCC`/`setShowCC`; the controls branch supplies its toggle. The map shows one small text label
under a currently visible living hero, prioritized Stunned (20), Silenced (17), Disarmed (14).
These are the extracted pawn-mask state indices in the worker's CC_STATES, independent of source
attribution. Half-open decisecond intervals use replay time directly. No label is attached to
last-seen ghosts or hidden/dead heroes; summary timelines and unsupported CC states show none.

Three focused CC tests pass alongside the 12 death tests. Production typecheck/build passes
with the companion Board art prop. A synthetic browser case covers default off, pause, seek,
death suppression, last-seen suppression and interval expiry; coordinator will run it after
sequentially merging the companion controls toggle. Browser debugging stopped per coordinator.
General buffs, effect icon stacks and other CC states remain deferred. No extracted asset added.
