// The fixed design, except pruning a heard rejection doesn't keep the client's next cseq: after
// a restart the server rebuilds it one short (review 2026-11-07, finding 2).
module pruneLosesNext { import sync(LIVE_AFTER_HELLO = true, SERVER_SIDE_UNDO = true, REJECT_BEFORE_CATCHUP = true, SNAPSHOT_ON_JOIN = true, SNAPSHOT_SKEW = 0, REBASE = true, REBASE_DROPS_DECIDED = true, PRUNE_KEEPS_NEXT = false).* from "./sync" }
