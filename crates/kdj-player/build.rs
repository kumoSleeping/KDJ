use std::env;

fn main() {
    const SOURCE: &str = "vendor/rubberband/single/RubberBandSingle.cpp";

    println!("cargo:rerun-if-changed={SOURCE}");
    println!("cargo:rerun-if-changed=vendor/rubberband/rubberband");
    println!("cargo:rerun-if-changed=vendor/rubberband/src");

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .file(SOURCE)
        .include("vendor/rubberband")
        .warnings(false)
        .flag_if_supported("-std=c++11")
        .flag_if_supported("/std:c++14")
        .define("RUBBERBAND_STATIC", None);
    build.compile("kdj_rubberband");

    if env::var("CARGO_CFG_TARGET_VENDOR").as_deref() == Ok("apple") {
        println!("cargo:rustc-link-lib=framework=Accelerate");
    }
}
