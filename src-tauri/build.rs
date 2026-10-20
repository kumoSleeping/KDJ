fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // CPAL 0.18 (the player's output backend) references the macOS 14.2 process-tap
        // symbols. Weak-link CoreAudio so the app still launches on older systems.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,CoreAudio");
    }
    tauri_build::build()
}
