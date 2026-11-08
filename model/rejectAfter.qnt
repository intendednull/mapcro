// Fixes 1 and 2 only: rejections still follow the catch-up (engine finding 3 unfixed).
module rejectAfter { import sync(LIVE_AFTER_HELLO = true, SERVER_SIDE_UNDO = true, REJECT_BEFORE_CATCHUP = false, SNAPSHOT_ON_JOIN = true, SNAPSHOT_SKEW = 0, REBASE = true, REBASE_DROPS_DECIDED = true, PRUNE_KEEPS_NEXT = true).* from "./sync" }
