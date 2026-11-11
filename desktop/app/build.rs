// The app's own commands, declared so each has a permission (`allow-<name>`) that a capability
// grants explicitly: capabilities/site.json gives them to the live site only.
fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&["replays_list", "replay_read", "replay_timeline", "replay_preview", "replays_choose_folder"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("tauri build script");
}
