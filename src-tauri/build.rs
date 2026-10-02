fn main() {
    // ScreenCaptureKit needs 13+; output-device taps need 14.2+.
    // Weak-link optional APIs so older systems can still launch the app.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
        // CPAL 0.18 also references the 14.2 process-tap symbols. The custom
        // output tap is runtime-guarded; CPAL is used only for real inputs here.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,CoreAudio");
        let minimum = if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64") {
            "11.0"
        } else {
            "10.15"
        };
        cc::Build::new()
            .file("src/live_vj/bluetooth/macos.m")
            .flag("-fobjc-arc")
            .flag(format!("-mmacosx-version-min={minimum}"))
            .compile("kdj_rfcomm");
        println!("cargo:rustc-link-lib=framework=IOBluetooth");
        println!("cargo:rerun-if-changed=src/live_vj/bluetooth/macos.m");
    }
    tauri_build::build()
}
