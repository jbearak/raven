// Compiles the console's C code: the shim (src/console/shim.c), the one place
// that runs R operations which may longjmp, and the system() flush hook
// (src/console/system_hook.c). See those files' headers for why they are C.
fn main() {
    println!("cargo:rerun-if-changed=src/console/shim.c");
    println!("cargo:rerun-if-changed=src/console/system_hook.c");
    println!("cargo:rerun-if-changed=src/console/debug.c");
    println!("cargo:rerun-if-changed=raven.exe.manifest");
    let unix = std::env::var("CARGO_CFG_UNIX").is_ok();
    let windows = std::env::var("CARGO_CFG_WINDOWS").is_ok();
    if unix || windows {
        cc::Build::new()
            .file("src/console/shim.c")
            .file("src/console/system_hook.c")
            .file("src/console/debug.c")
            .warnings(true)
            .compile("raven_console_shim");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        // Let the dlopen'ed libR resolve system() to the console's wrapper.
        println!("cargo:rustc-link-arg-bins=-Wl,--export-dynamic-symbol=system");
    }
    if windows && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // R (4.2+) takes its native encoding from the process's active code
        // page, which only the executable's manifest can set to UTF-8 — as
        // Rterm.exe's does. Without it `raven console` would hand R UTF-8
        // input in a legacy code page.
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("raven.exe.manifest");
        println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-bins=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
