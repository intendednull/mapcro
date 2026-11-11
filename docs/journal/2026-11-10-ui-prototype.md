# UI prototype ready for feedback — 2026-11-10

Branch: `prototype-layout`; worktree `/tmp/mapcro-prototype`. Preview http://localhost:5175, backend8095. Start: `nix develop /tmp/mapcro-prototype -c bash /tmp/mapcro-topbar-dev/start-prototype.sh`. Existing topbar-ux edits were preserved in commit047e9a2; shared main unchanged. Sol implementers used isolated worktrees; follow-up work was integrated sequentially after operator request.

Current visual style retained. Navigation takes organizational ideas from Argon only: separate map layers/vision, drawing tools and compact transport; replay entry in Scenes; Events/Scene Notes tabs. No selected/pinned hero inspector. Scoreboard retains hold-Tab and current item artwork; cooldowns use translucent neutral gray and ability charges use overlapping centered circles. Level gets its own readable line. Map controls hide while scoreboard columns cover them.

Fallen hero portrait gets a red tint and game skull, fading together on replay time. Optional default-off crowd-control labels show stun/silence/disarm only on visible living heroes. General buffs/debuffs remain deferred.

FORMAT8 adds verified level, max HP, kills and assists, wired into scoreboard. Real replay129738985 was regenerated and sanitized in memory before writing; installed in local dev CDN cache. Resistance and game item progression remain unknown/backlogged. New fields require regeneration for other older replays. No production deployment or full release gate performed.

Verification: baseline219 web tests passed; after integration production build/typecheck and33 focused web tests passed; data agent65 replay unit tests plus real replay validation passed. Six integrated Chromium regressions passed (death fade/respawn/vision/follow/CC and editable/viewer topbar). Sanitized real replay checks at1280/1920/2320 widths passed with scoreboard inside sidebars and hold-Tab restoration; controls agent additionally checked1280x800/1440x800/1920x1080 and save/replay/notes/layer interactions. Screenshots `/tmp/mapcro-topbar-dev/final-layout-1920.png` and `final-1920.png`. Broader existing browser tests that directly access relocated controls may need revealControls helper; full browser suite not run.

## Follow-up pass (2026-11-10 afternoon)

- `a063b31`..`6b1af1f`: scene timeline, inline death recaps, elevation/zipline layer, vision-aware portraits, major-purchase filter (off by default).
- `2b3d0f1`: Effects section in a single hero's build dropdown (not the all-12 view). Repeats merge into one row with a count; effects lasting to the replay's end show ∞, not a countdown to match end; internal modifiers with no localised name and no icon (`permanent_pickup`) are left out.
- `040bb18`: Tab scoreboard matched to the in-game reference (`/tmp/paseo-attachments-lcjutS/46af987c….png`): replay names show only in the expanded columns (player name, hero name under it), level in a ringed disc on the portrait, health without a thousands separator. Scene mode keeps its under-bar names (Rename confirms there).
- Verified: 232 unit tests; player-names, topbar and death-skull e2e (9); browser smokes for effects and the Tab view at 1440/1920.
- Open: resistances still unknown (`—`); a timed (non-permanent) effect was not shown in the smoke because the sampled moments only had permanent ones.
