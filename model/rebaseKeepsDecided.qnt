// The fixed design, except a rebased client keeps the pending transactions the server says it
// already decided: the bug a naive "adopt the base" makes (the model shows what it breaks).
module rebaseKeepsDecided { import sync(LIVE_AFTER_HELLO = true, SERVER_SIDE_UNDO = true, REJECT_BEFORE_CATCHUP = true, SNAPSHOT_ON_JOIN = true, SNAPSHOT_SKEW = 0, REBASE = true, REBASE_DROPS_DECIDED = false).* from "./sync" }
