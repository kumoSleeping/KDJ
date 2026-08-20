fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() != "macos" {
        return;
    }

    // ort's static macOS archive references Core ML compatibility classes even when KDJ selects
    // only its CPU execution provider. An archive propagates the weak symbols through dependent
    // crates, whereas an rlib-local link argument does not.
    cc::Build::new()
        .file("src/coreml_link_stub.c")
        .compile("kdj_ort_coreml_link_stub");
    println!("cargo:rustc-link-lib=framework=CoreML");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rerun-if-changed=src/coreml_link_stub.c");
}
