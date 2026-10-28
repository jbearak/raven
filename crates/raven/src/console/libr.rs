//! Runtime-loaded bindings to the user's `libR`.
//!
//! Raven never links against R: the console `dlopen`s the shared library of
//! the R installation the user would get by typing `R` (see
//! [`super::discovery`]), so one Raven binary works with any R release that
//! exports the documented front-end interface (*Writing R Extensions*,
//! "Linking GUIs and other front-ends to R"). Every symbol is resolved once,
//! up front, into [`LibR`]; a missing symbol fails startup before R is
//! initialised, which lets the console fall back to plain R cleanly.

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
    pub r_check_activity: unsafe extern "C" fn(c_int, c_int) -> *mut c_void,
    pub r_run_handlers: unsafe extern "C" fn(*mut c_void, *mut c_void),
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
    pub fn raven_read_console(
        prompt: *const c_char,
        buf: *mut u8,
        len: c_int,
        hist: c_int,
    ) -> c_int;
}

/// Everything the console uses from libR. Data symbols are raw pointers to
/// R's globals; they are only read or written on the R (main) thread, except
/// `interrupts_pending`, which R's own SIGINT handler also writes
/// asynchronously.
pub struct LibR {
    pub initialize_r: unsafe extern "C" fn(c_int, *mut *mut c_char) -> c_int,
    pub setup_rmainloop: unsafe extern "C" fn(),
    pub run_rmainloop: unsafe extern "C" fn(),
    pub string_elt: unsafe extern "C" fn(Sexp, isize) -> Sexp,
    pub r_char: unsafe extern "C" fn(Sexp) -> *const c_char,
    pub typeof_: unsafe extern "C" fn(Sexp) -> c_int,
    pub rf_length: unsafe extern "C" fn(Sexp) -> c_int,
    pub r_na_string: *mut Sexp,

    pub r_interactive: *mut c_int,
    pub r_outputfile: *mut *mut c_void,
    pub r_consolefile: *mut *mut c_void,
    pub r_wait_usec: *mut c_int,
    pub r_interrupts_pending: Option<*mut c_int>,

    pub ptr_read_console: *mut Option<ReadConsoleFn>,
    pub ptr_write_console: *mut Option<unsafe extern "C" fn(*const c_char, c_int)>,
    pub ptr_write_console_ex: *mut Option<WriteConsoleExFn>,
    pub ptr_reset_console: *mut Option<VoidFn>,
    pub ptr_flush_console: *mut Option<VoidFn>,
    pub ptr_clearerr_console: *mut Option<VoidFn>,
    pub ptr_show_message: *mut Option<ShowMessageFn>,
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

/// `dlopen` `path` with global symbol visibility (compiled packages resolve R's
/// API through it) and resolve every symbol the console needs.
pub fn load(path: &Path) -> Result<&'static LibR, String> {
    use libloading::os::unix::{Library, RTLD_GLOBAL, RTLD_NOW};

    // SAFETY: loading libR runs its static initialisers, which have no
    // preconditions; the library is intentionally leaked so every pointer
    // resolved below stays valid for the life of the process.
    let lib = unsafe { Library::open(Some(path), RTLD_NOW | RTLD_GLOBAL) }
        .map_err(|e| format!("cannot load {}: {e}", path.display()))?;
    let lib: &'static Library = Box::leak(Box::new(lib));

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
                .map(|p| p.cast())
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
        r_check_activity: sym!("R_checkActivity"),
        r_run_handlers: sym!("R_runHandlers"),
        r_input_handlers: sym!("R_InputHandlers"),
        r_polled_events: sym!("R_PolledEvents"),
        rf_get_option1: sym!("Rf_GetOption1"),
        typeof_: sym!("TYPEOF"),
        string_elt: sym!("STRING_ELT"),
        r_char: sym!("R_CHAR"),
        r_check_user_interrupt: sym!("R_CheckUserInterrupt"),
        r_interrupts_pending: opt_sym!("R_interrupts_pending").unwrap_or(std::ptr::null_mut()),
        r_global_env: sym!("R_GlobalEnv"),
        r_nil_value: sym!("R_NilValue"),
        r_unbound_value: sym!("R_UnboundValue"),
    };

    let libr = LibR {
        initialize_r: sym!("Rf_initialize_R"),
        setup_rmainloop: sym!("setup_Rmainloop"),
        run_rmainloop: sym!("run_Rmainloop"),
        string_elt: sym!("STRING_ELT"),
        r_char: sym!("R_CHAR"),
        typeof_: sym!("TYPEOF"),
        rf_length: sym!("Rf_length"),
        r_na_string: sym!("R_NaString"),
        r_interactive: sym!("R_Interactive"),
        r_outputfile: sym!("R_Outputfile"),
        r_consolefile: sym!("R_Consolefile"),
        r_wait_usec: sym!("R_wait_usec"),
        r_interrupts_pending: opt_sym!("R_interrupts_pending"),
        ptr_read_console: sym!("ptr_R_ReadConsole"),
        ptr_write_console: sym!("ptr_R_WriteConsole"),
        ptr_write_console_ex: sym!("ptr_R_WriteConsoleEx"),
        ptr_reset_console: sym!("ptr_R_ResetConsole"),
        ptr_flush_console: sym!("ptr_R_FlushConsole"),
        ptr_clearerr_console: sym!("ptr_R_ClearerrConsole"),
        ptr_show_message: sym!("ptr_R_ShowMessage"),
    };

    // SAFETY: `shim` holds valid addresses for the life of the process; the
    // shim copies the table.
    unsafe { raven_shim_init(&shim) };
    Ok(LIBR.get_or_init(|| libr))
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
