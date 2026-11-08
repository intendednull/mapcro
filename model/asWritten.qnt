// The protocol exactly as spec §3–§7 first described it.
module asWritten { import sync(LIVE_AFTER_HELLO = false, SERVER_SIDE_UNDO = false, REJECT_BEFORE_CATCHUP = false, SNAPSHOT_ON_JOIN = false, SNAPSHOT_SKEW = 0, REBASE = false, REBASE_DROPS_DECIDED = true, PRUNE_KEEPS_NEXT = true).* from "./sync" }
