fn main() {
    // The app still launches on macOS 10.15; only live audio capture needs 13+.
    // Weak-link the optional system framework and guard every entry at runtime.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
    }
    tauri_build::build()
}
