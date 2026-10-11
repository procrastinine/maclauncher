fn main() {
    println!("cargo:rerun-if-changed=src/platform/macos/window.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/platform/macos/window.m")
            .flag("-fno-objc-arc")
            .flag("-fobjc-exceptions")
            .define("GL_SILENCE_DEPRECATION", None)
            .compile("maclauncher_ramen_appkit");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=objc");
    }
}
