// The fixed design with a fresh join told its snapshot is one entry later than it is: the
// off-by-one between the base and the catch-up that the implementation must not make.
module snapshotSkew { import sync(LIVE_AFTER_HELLO = true, SERVER_SIDE_UNDO = true, REJECT_BEFORE_CATCHUP = true, SNAPSHOT_ON_JOIN = true, SNAPSHOT_SKEW = 1, REBASE = true, REBASE_DROPS_DECIDED = true, PRUNE_KEEPS_NEXT = true).* from "./sync" }
