const COMMANDS: &[&str] = &[
    "initialize",
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
    "set_lyrics_overlay",
    "check_overlay_permission",
    "request_overlay_permission",
    "dispose",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
