# 2026-11-09: The Rejuvenator, rift capture, the urn walking back, and shorter labels

The timers audit (docs/research/replay-timers-audit.md) found the mid boss's reward, the
Rejuvenator, entirely missing, and the open rift's deadline and capture progress unread. The
operator wanted every objective timer a coach would care about. Midway, the operator also asked
for hover labels to be labels only: short, and shown only when they add something.

## What changed

- **Worker, format 3.** `rejuv` (each team's Rejuvenator: taken, ends, revives left) and
  `rejuv_taken` / `rejuv_revive` / `rejuv_expired` events. Each rift's `give_up_s` and
  `capture` (both teams' progress at 2 Hz). +4.2 KB on 129738985 (1,497,595 to 1,501,758
  bytes, +0.28%).
- **Player.**
  - A Rejuvenator badge under the holding team's souls: the pack's crystal, revives left and the
    time left, both eased.
  - A capture ring per team on the open rift.
  - The mid boss's label carries a held Rejuvenator; the rift's says "Gives up in 0:41".
  - The urn on the ground says "Urn returns in m:ss".
- **Labels only** (operator). Nothing that's up and untimed says anything (camps, idle rifts).
  An objective with health says its name and health instead ("Walker 62%"), from the replay
  while Health is on; with none known, nothing. Timers are short: "Respawns in 1:20", "Buff respawns in 0:35". The
  "(at m:ss)" suffix and the buff effects are gone from labels. A token's eye and skull no
  longer label where those buttons aren't drawn.

## Surprises

- **The revive count rises per shard.** It goes 1, 2, 3 as the three shards are picked up
  (within a second), and drops at the death a revive covers, 3 s before the revive message.
  Expiry is exactly 180.0 s after the first shard on both of 129738985's.
- **The cash-in's first tick holds the last rift's progress.** As each later rift opens, the
  rules still read the previous capture (99%/100%) for one tick. The deadline is still FLT_MAX
  then and is set, with the progress reset, a tick later. The first parse drew every later rift
  as "captured" on opening; samples now wait for the deadline. A real-replay test pins it.
- **The capture states are indexed 0 Amber, 1 Sapphire,** confirmed against the scoring team on
  all five rifts.
- **The urn's walk-back counts from its landing,** not its spawn: the 25:00 urn landed at
  25:12.5 and set off at 28:13 (180.5 s).
- **Statues can't be read from a replay.** All 709 breakable props exist from before the horn
  and never change health or go away; going dormant is only visibility. Skipped, as is the pause
  mark.
- **A silent marker still has to take the hover.** When markers stopped naming themselves, the
  wave handle under the mid boss started labelling through it. A marker with nothing to say now
  resolves to an empty label, which isn't drawn.

## Defaults chosen

- Rings: Amber outer, Sapphire inner, each from 12 o'clock, team colours over a dark track, just
  outside the rift icon.
- Badge: `.GameClock`'s dark panel and font, "×N" and m:ss, team-colour underline.
- The Rejuvenator events go under the "Mid boss" filter; `rejuv_taken` pings at the mid boss.
- The capture is sampled at 2 Hz, against the audit's 1 Hz: the straight line between samples is
  within about a percent, for 2.7 KB.
