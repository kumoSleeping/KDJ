fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        return;
    }

    // `rustc-link-arg` does not propagate from an rlib to kdj-player / kdj-playback. Keep ort's
    // weak compatibility symbols and the native SCNet bridge in one archive Cargo propagates.
    cc::Build::new()
        .file("src/coreml_link_stub.c")
        .file("src/coreml_bridge.m")
        .flag("-fobjc-arc")
        .compile("kdj_coreml_link_stub");
    println!("cargo:rustc-link-lib=framework=CoreML");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rerun-if-changed=src/coreml_link_stub.c");
    println!("cargo:rerun-if-changed=src/coreml_bridge.m");
}
