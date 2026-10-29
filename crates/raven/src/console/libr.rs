//! Runtime-loaded bindings to the user's `libR`.
//!
//! Raven never links against R: the console loads the shared library of the
//! R installation the user would get by typing `R` (`libR` on Unix, `R.dll`
//! on Windows; see [`super::discovery`]), so one Raven binary works with any
//! R release that exports the documented front-end interface (*Writing R
//! Extensions*, "Linking GUIs and other front-ends to R"). Every symbol is
//! resolved once, up front, into [`LibR`]; a missing symbol fails startup
//! before R is initialised, which lets the console fall back to plain R
//! cleanly.
//!
//! The two front-end interfaces differ: Unix R is initialised with
//! `Rf_initialize_R` and its callbacks are the `ptr_R_*` globals; Windows R
//! takes its options and callbacks in a `structRstart` (`Rstart`) passed to
//! `R_SetParams`, and has no input handlers (its event loop is
//! `R_ProcessEvents`).

use std::ffi::{c_char, c_int, c_uint, c_void};
use std::path::Path;

pub type Sexp = *mut c_void;

/// `ptr_R_ReadConsole`.
pub type ReadConsoleFn = unsafe extern "C" fn(*const c_char, *mut u8, c_int, c_int) -> c_int;
/// `ptr_R_WriteConsoleEx`.
pub type WriteConsoleExFn = unsafe extern "C" fn(*const c_char, c_int, c_int);
pub type VoidFn = unsafe extern "C" fn();
/// The Rust half of `ReadConsole`; sets `*interrupt` to ask the C wrapper in
/// `shim.c` to raise an R interrupt.
pub type RustReadConsoleFn =
    unsafe extern "C" fn(*const c_char, *mut u8, c_int, c_int, *mut c_int) -> c_int;
pub type ShowMessageFn = unsafe extern "C" fn(*const c_char);
pub type BusyFn = unsafe extern "C" fn(c_int);

/// Function table passed to `shim.c` (layout must match `RavenRApi` there).
#[repr(C)]
pub struct ShimApi {
    pub r_toplevel_exec:
        unsafe extern "C" fn(unsafe extern "C" fn(*mut c_void), *mut c_void) -> c_int,
    pub r_parse_vector: unsafe extern "C" fn(Sexp, c_int, *mut c_int, Sexp) -> Sexp,
    pub rf_mk_string: unsafe extern "C" fn(*const c_char) -> Sexp,
    pub rf_mk_char_ce: unsafe extern "C" fn(*const c_char, c_int) -> Sexp,
    pub rf_alloc_vector: unsafe extern "C" fn(c_uint, isize) -> Sexp,
    pub set_string_elt: unsafe extern "C" fn(Sexp, isize, Sexp),
    pub rf_protect: unsafe extern "C" fn(Sexp) -> Sexp,
    pub rf_unprotect: unsafe extern "C" fn(c_int),
    pub rf_eval: unsafe extern "C" fn(Sexp, Sexp) -> Sexp,
    pub vector_elt: unsafe extern "C" fn(Sexp, isize) -> Sexp,
    pub rf_length: unsafe extern "C" fn(Sexp) -> c_int,
    pub rf_find_var_in_frame: unsafe extern "C" fn(Sexp, Sexp) -> Sexp,
    pub rf_install: unsafe extern "C" fn(*const c_char) -> Sexp,
    pub rf_lcons: unsafe extern "C" fn(Sexp, Sexp) -> Sexp,
    pub rf_cons: unsafe extern "C" fn(Sexp, Sexp) -> Sexp,
    pub r_preserve_object: unsafe extern "C" fn(Sexp),
    pub r_release_object: unsafe extern "C" fn(Sexp),
    // Unix event loop; None/null on Windows.
    pub r_check_activity: Option<unsafe extern "C" fn(c_int, c_int) -> *mut c_void>,
    pub r_run_handlers: Option<unsafe extern "C" fn(*mut c_void, *mut c_void)>,
    pub r_input_handlers: *mut *mut c_void,
    pub r_polled_events: *mut Option<VoidFn>,
    pub rf_get_option1: unsafe extern "C" fn(Sexp) -> Sexp,
    pub typeof_: unsafe extern "C" fn(Sexp) -> c_int,
    pub string_elt: unsafe extern "C" fn(Sexp, isize) -> Sexp,
    pub r_char: unsafe extern "C" fn(Sexp) -> *const c_char,
    pub r_check_user_interrupt: unsafe extern "C" fn(),
    pub r_interrupts_pending: *mut c_int,
    pub r_global_env: *mut Sexp,
    pub r_nil_value: *mut Sexp,
    pub r_unbound_value: *mut Sexp,
    // Windows event loop and interrupt flag; None/null on Unix.
    pub r_process_events: Option<VoidFn>,
    pub user_break: *mut c_int,
}

unsafe extern "C" {
    fn raven_shim_init(table: *const ShimApi);
    pub fn raven_eval(code: *const c_char, env: Sexp, out: *mut Sexp) -> c_int;
    pub fn raven_call(fun: Sexp, nargs: c_int, args: *const *const c_char, out: *mut Sexp)
    -> c_int;
    pub fn raven_release(x: Sexp);
    pub fn raven_parse_status(code: *const c_char) -> c_int;
    pub fn raven_pump_events() -> c_int;
    pub fn raven_option_string(name: *const c_char, buf: *mut c_char, buflen: c_int) -> c_int;
    pub fn raven_set_read_console(f: RustReadConsoleFn);
    pub fn raven_set_flush_hook(hook: unsafe extern "C" fn());
    pub fn raven_read_console(
        prompt: *const c_char,
        buf: *mut u8,
        len: c_int,
        hist: c_int,
    ) -> c_int;
}

/// Everything the console uses from libR. Data symbols are raw pointers to
/// R's globals; they are only read or written on the R (main) thread, except
/// `interrupts_pending` and `user_break`, which interrupts (R's own SIGINT
/// handler; the console's Ctrl-C handler on Windows) write asynchronously.
pub struct LibR {
    pub setup_rmainloop: unsafe extern "C" fn(),
    pub run_rmainloop: unsafe extern "C" fn(),
    pub string_elt: unsafe extern "C" fn(Sexp, isize) -> Sexp,
    pub r_char: unsafe extern "C" fn(Sexp) -> *const c_char,
    pub typeof_: unsafe extern "C" fn(Sexp) -> c_int,
    pub rf_length: unsafe extern "C" fn(Sexp) -> c_int,
    pub r_na_string: *mut Sexp,
    pub r_interrupts_pending: Option<*mut c_int>,

    #[cfg(unix)]
    pub unix: UnixFrontEnd,
    #[cfg(windows)]
    pub windows: WindowsFrontEnd,
    #[cfg(windows)]
    pub user_break: *mut c_int,
}

/// Unix's front-end interface: `Rf_initialize_R` and the callback globals.
#[cfg(unix)]
pub struct UnixFrontEnd {
    pub initialize_r: unsafe extern "C" fn(c_int, *mut *mut c_char) -> c_int,
    pub r_interactive: *mut c_int,
    pub r_outputfile: *mut *mut c_void,
    pub r_consolefile: *mut *mut c_void,
    pub r_wait_usec: *mut c_int,

    pub ptr_read_console: *mut Option<ReadConsoleFn>,
    pub ptr_write_console: *mut Option<unsafe extern "C" fn(*const c_char, c_int)>,
    pub ptr_write_console_ex: *mut Option<WriteConsoleExFn>,
    pub ptr_reset_console: *mut Option<VoidFn>,
    pub ptr_flush_console: *mut Option<VoidFn>,
    pub ptr_clearerr_console: *mut Option<VoidFn>,
    pub ptr_show_message: *mut Option<ShowMessageFn>,
    pub ptr_busy: *mut Option<BusyFn>,
}

/// Windows' front-end interface (R 4.2+, `RSTART_VERSION` 1).
#[cfg(windows)]
pub struct WindowsFrontEnd {
    pub r_def_params_ex: unsafe extern "C" fn(*mut Rstart, c_int) -> c_int,
    pub r_set_params: unsafe extern "C" fn(*mut Rstart),
    pub r_common_command_line: unsafe extern "C" fn(*mut c_int, *mut *mut c_char, *mut Rstart),
    pub r_set_command_line_arguments: unsafe extern "C" fn(c_int, *mut *mut c_char),
    pub get_r_user: unsafe extern "C" fn() -> *mut c_char,
    pub r_set_start_time: Option<VoidFn>,
    /// `GA_initapp` from `Rgraphapp.dll`: needed by `windows()` devices.
    pub ga_initapp: Option<unsafe extern "C" fn(c_int, *mut *mut c_char) -> c_int>,
}

/// `structRstart` (`R_ext/RStartup.h`) on Windows, version 1 (R 4.2+). The
/// layout is R's public ABI for front ends; R fills every field in
/// `R_DefParamsEx`.
#[cfg(windows)]
#[repr(C)]
pub struct Rstart {
    pub r_quiet: c_int,
    pub r_no_echo: c_int,
    pub r_interactive: c_int,
    pub r_verbose: c_int,
    pub load_site_file: c_int,
    pub load_init_file: c_int,
    pub debug_init_file: c_int,
    pub restore_action: c_int,
    pub save_action: c_int,
    pub vsize: usize,
    pub nsize: usize,
    pub max_vsize: usize,
    pub max_nsize: usize,
    pub ppsize: usize,
    /// The `NoRenviron : 16` and `RstartVersion : 16` bit-fields.
    pub no_renviron_and_version: c_int,
    pub nconnections: c_int,
    pub rhome: *mut c_char,
    pub home: *mut c_char,
    pub read_console: Option<ReadConsoleFn>,
    pub write_console: Option<unsafe extern "C" fn(*const c_char, c_int)>,
    /// R calls this from `R_ProcessEvents`, unconditionally.
    pub call_back: Option<VoidFn>,
    pub show_message: Option<ShowMessageFn>,
    pub yes_no_cancel: Option<unsafe extern "C" fn(*const c_char) -> c_int>,
    pub busy: Option<BusyFn>,
    /// `UImode`: 0 RGui, 1 RTerm, 2 LinkDLL.
    pub character_mode: c_int,
    pub write_console_ex: Option<WriteConsoleExFn>,
    pub emit_embedded_utf8: c_int,
    pub clean_up: Option<unsafe extern "C" fn(c_int, c_int, c_int)>,
    pub clearerr_console: Option<VoidFn>,
    pub flush_console: Option<VoidFn>,
    pub reset_console: Option<VoidFn>,
    pub suicide: Option<unsafe extern "C" fn(*const c_char)>,
}

// SAFETY: LibR is a table of addresses into a library that is never
// unloaded. Thread-affinity rules are enforced by callers (only the R thread
// dereferences them), not by the type.
unsafe impl Send for LibR {}
unsafe impl Sync for LibR {}

static LIBR: std::sync::OnceLock<LibR> = std::sync::OnceLock::new();

/// The loaded library. Panics if called before [`load`] succeeded.
pub fn get() -> &'static LibR {
    LIBR.get().expect("libR not loaded")
}

/// Open the shared library: `dlopen` with global symbol visibility on Unix
/// (compiled packages resolve R's API through it); on Windows, `R.dll` with
/// its own directory searched for its dependencies (`Rblas.dll`, …).
fn open(path: &Path) -> Result<libloading::Library, String> {
    #[cfg(unix)]
    let lib = {
        use libloading::os::unix::{Library, RTLD_GLOBAL, RTLD_NOW};
        // SAFETY: loading libR runs its static initialisers, which have no
        // preconditions.
        unsafe { Library::open(Some(path), RTLD_NOW | RTLD_GLOBAL) }.map(Into::into)
    };
    #[cfg(windows)]
    let lib = {
        use libloading::os::windows::{LOAD_WITH_ALTERED_SEARCH_PATH, Library};
        // SAFETY: as above (DllMain).
        unsafe { Library::load_with_flags(path, LOAD_WITH_ALTERED_SEARCH_PATH) }.map(Into::into)
    };
    lib.map_err(|e| format!("cannot load {}: {e}", path.display()))
}

/// Load `path` and resolve every symbol the console needs.
pub fn load(path: &Path) -> Result<&'static LibR, String> {
    // The library is intentionally leaked so every pointer resolved below
    // stays valid for the life of the process.
    let lib: &'static libloading::Library = Box::leak(Box::new(open(path)?));

    macro_rules! sym {
        ($name:literal) => {{
            // SAFETY: the symbol's type is fixed by R's public headers and
            // matched by the field it is assigned to.
            let s = unsafe { lib.get::<*mut c_void>(concat!($name, "\0").as_bytes()) }
                .map_err(|_| format!("libR does not export `{}`", $name))?;
            let raw: *mut c_void = *s;
            if raw.is_null() {
                return Err(format!("libR symbol `{}` is null", $name));
            }
            // SAFETY: as above; transmute converts the symbol address into
            // the declared fn-pointer or data-pointer type.
            unsafe { std::mem::transmute_copy(&raw) }
        }};
    }
    macro_rules! opt_sym {
        ($name:literal) => {{
            // SAFETY: see `sym!`.
            unsafe { lib.get::<*mut c_void>(concat!($name, "\0").as_bytes()) }
                .ok()
                .map(|s| *s)
                .filter(|p| !p.is_null())
                // SAFETY: see `sym!`.
                .map(|p| unsafe { std::mem::transmute_copy(&p) })
        }};
    }

    let shim = ShimApi {
        r_toplevel_exec: sym!("R_ToplevelExec"),
        r_parse_vector: sym!("R_ParseVector"),
        rf_mk_string: sym!("Rf_mkString"),
        rf_mk_char_ce: sym!("Rf_mkCharCE"),
        rf_alloc_vector: sym!("Rf_allocVector"),
        set_string_elt: sym!("SET_STRING_ELT"),
        rf_protect: sym!("Rf_protect"),
        rf_unprotect: sym!("Rf_unprotect"),
        rf_eval: sym!("Rf_eval"),
        vector_elt: sym!("VECTOR_ELT"),
        rf_length: sym!("Rf_length"),
        rf_find_var_in_frame: sym!("Rf_findVarInFrame"),
        rf_install: sym!("Rf_install"),
        rf_lcons: sym!("Rf_lcons"),
        rf_cons: sym!("Rf_cons"),
        r_preserve_object: sym!("R_PreserveObject"),
        r_release_object: sym!("R_ReleaseObject"),
        #[cfg(unix)]
        r_check_activity: Some(sym!("R_checkActivity")),
        #[cfg(unix)]
        r_run_handlers: Some(sym!("R_runHandlers")),
        #[cfg(unix)]
        r_input_handlers: sym!("R_InputHandlers"),
        #[cfg(unix)]
        r_polled_events: sym!("R_PolledEvents"),
        #[cfg(windows)]
        r_check_activity: None,
        #[cfg(windows)]
        r_run_handlers: None,
        #[cfg(windows)]
        r_input_handlers: std::ptr::null_mut(),
        #[cfg(windows)]
        r_polled_events: std::ptr::null_mut(),
        rf_get_option1: sym!("Rf_GetOption1"),
        typeof_: sym!("TYPEOF"),
        string_elt: sym!("STRING_ELT"),
        r_char: sym!("R_CHAR"),
        r_check_user_interrupt: sym!("R_CheckUserInterrupt"),
        r_interrupts_pending: opt_sym!("R_interrupts_pending").unwrap_or(std::ptr::null_mut()),
        r_global_env: sym!("R_GlobalEnv"),
        r_nil_value: sym!("R_NilValue"),
        r_unbound_value: sym!("R_UnboundValue"),
        #[cfg(unix)]
        r_process_events: None,
        #[cfg(unix)]
        user_break: std::ptr::null_mut(),
        #[cfg(windows)]
        r_process_events: Some(sym!("R_ProcessEvents")),
        #[cfg(windows)]
        user_break: sym!("UserBreak"),
    };

    let libr = LibR {
        setup_rmainloop: sym!("setup_Rmainloop"),
        run_rmainloop: sym!("run_Rmainloop"),
        string_elt: sym!("STRING_ELT"),
        r_char: sym!("R_CHAR"),
        typeof_: sym!("TYPEOF"),
        rf_length: sym!("Rf_length"),
        r_na_string: sym!("R_NaString"),
        r_interrupts_pending: opt_sym!("R_interrupts_pending"),
        #[cfg(unix)]
        unix: UnixFrontEnd {
            initialize_r: sym!("Rf_initialize_R"),
            r_interactive: sym!("R_Interactive"),
            r_outputfile: sym!("R_Outputfile"),
            r_consolefile: sym!("R_Consolefile"),
            r_wait_usec: sym!("R_wait_usec"),
            ptr_read_console: sym!("ptr_R_ReadConsole"),
            ptr_write_console: sym!("ptr_R_WriteConsole"),
            ptr_write_console_ex: sym!("ptr_R_WriteConsoleEx"),
            ptr_reset_console: sym!("ptr_R_ResetConsole"),
            ptr_flush_console: sym!("ptr_R_FlushConsole"),
            ptr_clearerr_console: sym!("ptr_R_ClearerrConsole"),
            ptr_show_message: sym!("ptr_R_ShowMessage"),
            ptr_busy: sym!("ptr_R_Busy"),
        },
        #[cfg(windows)]
        windows: WindowsFrontEnd {
            r_def_params_ex: sym!("R_DefParamsEx"),
            r_set_params: sym!("R_SetParams"),
            r_common_command_line: sym!("R_common_command_line"),
            r_set_command_line_arguments: sym!("R_set_command_line_arguments"),
            get_r_user: sym!("getRUser"),
            r_set_start_time: opt_sym!("R_setStartTime"),
            ga_initapp: graphapp_initapp(path),
        },
        #[cfg(windows)]
        user_break: shim.user_break,
    };

    // SAFETY: `shim` holds valid addresses for the life of the process; the
    // shim copies the table.
    unsafe { raven_shim_init(&shim) };
    Ok(LIBR.get_or_init(|| libr))
}

/// `GA_initapp` from the `Rgraphapp.dll` next to `R.dll`, if it loads.
#[cfg(windows)]
fn graphapp_initapp(
    r_dll: &Path,
) -> Option<unsafe extern "C" fn(c_int, *mut *mut c_char) -> c_int> {
    let lib: &'static libloading::Library =
        Box::leak(Box::new(open(&r_dll.with_file_name("Rgraphapp.dll")).ok()?));
    // SAFETY: GA_initapp's signature is fixed by R's headers.
    unsafe { lib.get(b"GA_initapp\0") }.ok().map(|s| *s)
}

/// Copy a CHARSXP/STRSXP element out of R. Never jumps: `STRING_ELT` and
/// `R_CHAR` only read memory.
///
/// # Safety
/// Must be called on the R thread with `x` a live STRSXP and `i` in range.
pub unsafe fn string_at(x: Sexp, i: isize) -> Option<String> {
    let r = get();
    // SAFETY: caller guarantees `x` is a STRSXP and `i < length(x)`.
    let ch = unsafe { (r.string_elt)(x, i) };
    // SAFETY: R_NaString is a valid global once R is initialised.
    if ch == unsafe { *r.r_na_string } {
        return None;
    }
    // SAFETY: R_CHAR returns a NUL-terminated buffer owned by the CHARSXP.
    let s = unsafe { std::ffi::CStr::from_ptr((r.r_char)(ch)) };
    Some(s.to_string_lossy().into_owned())
}

/// All elements of a STRSXP (`NA` → empty string); empty for other types.
///
/// # Safety
/// Must be called on the R thread with `x` a live, protected or preserved SEXP.
pub unsafe fn strings(x: Sexp) -> Vec<String> {
    const STRSXP: c_int = 16;
    let r = get();
    // SAFETY: TYPEOF/Rf_length only read the header of a live SEXP.
    if unsafe { (r.typeof_)(x) } != STRSXP {
        return Vec::new();
    }
    // SAFETY: as above.
    let n = unsafe { (r.rf_length)(x) }.max(0) as isize;
    (0..n)
        // SAFETY: `i < n == length(x)`.
        .map(|i| unsafe { string_at(x, i) }.unwrap_or_default())
        .collect()
}
