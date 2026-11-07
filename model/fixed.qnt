// The protocol with both fixes the model found (see docs/journal/2026-11-06-quint-sync-model.md).
module fixed { import sync(LIVE_AFTER_HELLO = true, SERVER_SIDE_UNDO = true).* from "./sync" }
