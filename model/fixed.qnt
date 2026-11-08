// The protocol with both fixes the model found (see docs/journal/2026-11-06-quint-sync-model.md).
module fixed { import sync(LIVE_AFTER_HELLO = true, SERVER_SIDE_UNDO = true, REJECT_BEFORE_CATCHUP = true, SNAPSHOT_ON_JOIN = true, SNAPSHOT_SKEW = 0, REBASE = true, REBASE_DROPS_DECIDED = true).* from "./sync" }
