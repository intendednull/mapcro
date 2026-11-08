# 2026-11-08: Names on the token, a Names toggle, and Player's keys

The operator asked for two things. Hovering a hero's token in Player said the board's slot
label ("Amber 2"), not the player's name. And an "anonymous mode", because content creators
hide usernames in their videos. The spec is §6b (Names).

## What changed

- **The token's title** now leads with the match's player name. The preview carries it, and
  the board's slot name is the fallback.
- **Names** is a transport toggle beside Troopers, Health and Pings. It shows only when the
  timeline has names, and it's on by default. One host accessor, `playerName(team, slot)`,
  answers for the top bar and the events. `preview` checks `showNames` for the tokens. With
  Names off, the top bar drops its name row, so the bar is shorter and the map gets that room.
- **It's local.** The other toggles are plain signals that last only as long as the page.
  Names is kept in localStorage (`mapcro.playerNames`), and the same setting covers every
  board, because someone recording wants it off everywhere. It is never sent in presence, so a
  follower keeps their own setting.

## Decisions

- **Search follows the setting.** With Names off, searching for a player's name finds
  nothing. If a hidden name could still be searched, an event list filtered by that name would
  show it on screen just the same.
- **Saved scenes don't hold player names.** Their names come from `shortLabel`, which uses
  heroes only ("Haze died"). So no saved data needed changing.
- **What stays visible.** Viewers' own names (people list, cursors) aren't player names and
  stay. The board's own slot names, typed by the board's editors, also stay.

## Found on the way

- The transport toggles look the same on and off. No `.btn.ghost.on` style exists, so only
  `aria-pressed` tells the two states apart. This applies to Troopers, Health and Pings as well
  as Names. Not changed here.

## Then: Player's keys

The operator asked for Space to play and pause, and for the arrows to split up: ← → move in
time and ↑ ↓ step through events. Before this, ← → stepped events. Spec §6b, "Keys while
watching".

- **Steps:** ← → seek 5 s, and Shift makes it 30 s. The ±10 buttons are still there for a
  middle step. A seek keeps playback playing or paused, and the clock clamps it to the match.
- **Space:** a tap is Space down, then up, with no autorepeat and no pointer press in between.
  A Space-drag pans (Board's `spaceHeld`) and never toggles. A tap toggles even when a button
  has focus, which is a change from the lead's draft that ignored Space on a focused button.
  Board's Space keydown already prevents the default, and in Chromium that stops a focused
  button's Space click. So with that draft, Space did nothing after you clicked Play, which is
  the most common case. The keyup also prevents the default, so a browser that clicks on keyup
  can't toggle twice. The mutation run can't tell that guard apart in Chromium, because Board's
  keydown already blocks the click there.
- **The events list** no longer treats ↑ ↓ as a scroll that stops it from following. They're
  the event step now, so the list follows the jump to the event.
- Each binding's e2e assertion failed with that binding removed: seek, events, the Space tap,
  and the pointer cancel that keeps a Space-drag from toggling (player-keys.spec.ts).
