// Compiles the console's C shim (src/console/shim.c): the one place that runs
// R operations which may longjmp. See that file's header for why it is C.
fn main() {
    println!("cargo:rerun-if-changed=src/console/shim.c");
    if std::env::var("CARGO_CFG_UNIX").is_ok() {
        cc::Build::new()
            .file("src/console/shim.c")
            .warnings(true)
            .compile("raven_console_shim");
    }
}
