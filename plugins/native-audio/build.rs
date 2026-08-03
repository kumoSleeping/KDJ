const COMMANDS: &[&str] = &[
    "initialize",
    "apply_playback_snapshot",
    "register_listener",
    "remove_listener",
    "set_source",
    "set_queue",
    "play",
    "pause",
    "seek_to",
    "set_rate",
    "set_volume",
    "get_state",
    "get_progress_checkpoint",
    "clear_progress_checkpoint",
    "set_lyrics_timeline",
    "set_lyrics_playback_clock",
    "set_lyrics_overlay",
    "check_overlay_permission",
    "request_overlay_permission",
    "dispose",
    "save_png_to_gallery",
    "open_local_path",
    "pick_library_folder",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
