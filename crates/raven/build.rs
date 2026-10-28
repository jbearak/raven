// Compiles the console's C code: the shim (src/console/shim.c), the one place
// that runs R operations which may longjmp, and the system() flush hook
// (src/console/system_hook.c). See those files' headers for why they are C.
fn main() {
    println!("cargo:rerun-if-changed=src/console/shim.c");
    println!("cargo:rerun-if-changed=src/console/system_hook.c");
    if std::env::var("CARGO_CFG_UNIX").is_ok() {
        cc::Build::new()
            .file("src/console/shim.c")
            .file("src/console/system_hook.c")
            .warnings(true)
            .compile("raven_console_shim");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        // Let the dlopen'ed libR resolve system() to the console's wrapper.
        println!("cargo:rustc-link-arg-bins=-Wl,--export-dynamic-symbol=system");
    }
}
