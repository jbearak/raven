//! `raven console`: a native terminal front end for R.
//!
//! R is embedded in-process on the main thread: the console finds the user's
//! R (see `discovery`), loads its `libR` at runtime (see `libr`), installs
//! itself as R's console callbacks, and hands control to R's own main loop.
//! R then calls back into `read_console` whenever it wants input, and the
//! console answers with a line editor (reedline) — so everything R does at
//! its prompt (autoprint, `.Last.value`, task callbacks, `browser()`, error
//! recovery) is exactly what plain R does.
//!
//! # Thread and safety model
//!
//! * Only the main thread touches R. The socket thread (`ipc`) and the
//!   output flusher never do.
//! * Every R operation the console starts itself goes through `shim.c`, which
//!   runs it under `R_ToplevelExec` so an R error or interrupt (a `longjmp`)
//!   can never cross a Rust frame. Callbacks R invokes (`WriteConsoleEx`, …)
//!   never call back into R.
//! * The line editor is taken out of the thread-local `State` while it runs,
//!   so a nested `ReadConsole` (R code run from the idle event pump asking for
//!   input) sees no editor and falls back to a plain line read instead of
//!   re-entering reedline.
//!
//! # Input state machine
//!
//! A submission (typed, or received over the socket) becomes a queue of
//! lines. `ReadConsole` drains one line per call, answering R's continuation
//! prompts silently, until the queue is empty and R asks at a top-level
//! prompt again — that marks the submission finished. An uncaught error or an
//! interrupt makes R call `ResetConsole`, which discards the rest of the
//! queue (so the lines after a failed `read.csv()` don't run). Queued lines
//! and socket requests are only ever fed to R's own REPL prompts, never to
//! `readline()`/`menu()`/`scan()` input (R marks those with `hist = 0`).

mod dap;
mod discovery;
mod editor;
mod ipc;
mod lexer;
mod libr;
mod output;
mod term;

use std::cell::RefCell;
use std::collections::VecDeque;
use std::ffi::{CStr, CString, OsString, c_char, c_int};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use reedline::{EditCommand, Reedline, Signal};

use editor::{EditMode, IndentRequest, PromptKind, RPrompt};
use libr::Sexp;
use output::ColorMode;

const HELPERS_R: &str = include_str!("helpers.R");
/// How often R's event loop is serviced while the editor waits for input.
const EVENT_PUMP_INTERVAL: Duration = Duration::from_millis(33);

struct Options {
    r_home: Option<PathBuf>,
    ipc: Option<PathBuf>,
    dap: Option<PathBuf>,
    edit_mode: EditMode,
    color: ColorMode,
    history_file: Option<PathBuf>,
    r_args: Vec<OsString>,
}

pub fn print_help() {
    println!(
        "raven console — an R console with syntax highlighting, completion, and colored output

Usage: raven console [OPTIONS] [R OPTIONS...]

Options:
  --r-home DIR          Use the R installation at DIR (default: $R_HOME, else `R RHOME`)
  --edit-mode MODE      emacs (default) or vi
  --color-output MODE   streams (default), values, or off
  --history-file PATH   Where to keep input history
  --no-history          Keep history in memory only
  --ipc PATH            Listen for code from an editor on this Unix socket
  --dap PATH            Serve the R debugger (Debug Adapter Protocol) on this Unix socket
  --help                Show this help

Every other option is passed to R unchanged (e.g. --no-save, --vanilla, -q)."
    );
}

fn parse_args(args: Vec<OsString>) -> Result<Option<Options>, String> {
    let mut o = Options {
        r_home: None,
        ipc: None,
        dap: None,
        edit_mode: EditMode::Emacs,
        color: if std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()) {
            ColorMode::Off
        } else {
            ColorMode::Streams
        },
        history_file: default_history_file(),
        r_args: Vec::new(),
    };
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| -> Result<OsString, String> {
            it.next().ok_or_else(|| format!("{name} needs a value"))
        };
        match a.to_str() {
            Some("--help") => return Ok(None),
            Some("--r-home") => o.r_home = Some(PathBuf::from(value("--r-home")?)),
            Some("--ipc") => o.ipc = Some(PathBuf::from(value("--ipc")?)),
            Some("--dap") => o.dap = Some(PathBuf::from(value("--dap")?)),
            Some("--history-file") => {
                o.history_file = Some(PathBuf::from(value("--history-file")?))
            }
            Some("--no-history") => o.history_file = None,
            Some("--edit-mode") => {
                o.edit_mode = match value("--edit-mode")?.to_str() {
                    Some("emacs") => EditMode::Emacs,
                    Some("vi") => EditMode::Vi,
                    _ => return Err("--edit-mode must be emacs or vi".into()),
                }
            }
            Some("--color-output") => {
                let v = value("--color-output")?;
                o.color = v
                    .to_str()
                    .and_then(ColorMode::parse)
                    .ok_or("--color-output must be streams, values, or off")?;
            }
            _ => o.r_args.push(a),
        }
    }
    Ok(Some(o))
}

fn default_history_file() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let dir = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/raven")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".local/share"))
            .join("raven")
    };
    Some(dir.join("console_history"))
}

/// Entry point for `raven console`. Never returns on success: R's main loop
/// exits the process itself (`q()`).
pub fn main(args: Vec<OsString>) -> i32 {
    let opts = match parse_args(args) {
        Ok(Some(o)) => o,
        Ok(None) => {
            print_help();
            return 0;
        }
        Err(e) => {
            eprintln!("raven console: {e}");
            return 2;
        }
    };

    // A console needs a terminal. Anything else (pipes, CI) gets plain R.
    // SAFETY: isatty only inspects the descriptor.
    let interactive = unsafe { libc::isatty(0) == 1 && libc::isatty(1) == 1 };

    let install = match discovery::discover(opts.r_home.as_deref()) {
        Ok(discovery::Discovered::NeedsReexec(install, env)) => {
            let err = discovery::reexec(&env);
            return fallback(
                Some(&install.home),
                &opts,
                &format!("could not restart with R's environment: {err}"),
            );
        }
        Ok(discovery::Discovered::Ready(install)) => install,
        Err(e) => return fallback(e.home.as_deref(), &opts, &e.reason),
    };
    if !interactive {
        return fallback(Some(&install.home), &opts, "");
    }
    let lib = match libr::load(&install.libr) {
        Ok(l) => l,
        Err(reason) => return fallback(Some(&install.home), &opts, &reason),
    };
    // SAFETY: called once, on the main thread, before R is initialised.
    unsafe { start_r(lib, opts) }
}

/// Run plain R instead (same installation when known), after saying why.
fn fallback(home: Option<&std::path::Path>, opts: &Options, reason: &str) -> i32 {
    if !reason.is_empty() {
        eprintln!("\x1b[2mraven console: {reason}; starting plain R\x1b[0m");
    }
    let err = discovery::exec_plain_r(home, &opts.r_args);
    eprintln!("raven console: could not start R: {err}");
    127
}

// ---- R thread state ---------------------------------------------------------

struct State {
    editor: Option<Reedline>,
    /// For `hist == 0` input (`readline()` and friends).
    plain_editor: Option<Reedline>,
    /// Lines of the submission being fed to R.
    pending: VecDeque<String>,
    /// Location-tagged top-level expressions not yet rendered and fed (the
    /// debugger renders each one just before it runs; see `dap`).
    segments: VecDeque<dap::Segment>,
    /// Lines of the current rendered segment still to feed without echo
    /// (its original lines were echoed instead).
    quiet_lines: usize,
    /// Echo each pending line as it is fed (socket submissions).
    echo: bool,
    /// The socket request that owns `pending`, if any.
    request: Option<ipc::Request>,
    /// ResetConsole fired during the current request.
    request_failed: bool,
    /// Browser depth (0 = top level) the current request started at.
    request_level: u32,
    /// Browser depth (0 = top level) of the prompt the submission started at.
    start_level: u32,
    /// Submissions set aside while a deeper `browser()` runs (innermost last).
    suspended: Vec<Submission>,
    /// The rest of a line too long for R's input buffer; R reads it next.
    overflow: String,
    /// The user's half-typed buffer, set aside while a socket request runs.
    stash: Option<(String, usize)>,
    ipc: Option<ipc::Server>,
    break_flag: Arc<AtomicBool>,
    indent: Arc<IndentRequest>,
    set_width_fn: Sexp,
    release_hook_fn: Sexp,
    depth: u32,
}

/// A partly fed submission, parked while a nested `browser()` it started runs.
struct Submission {
    pending: VecDeque<String>,
    segments: VecDeque<dap::Segment>,
    quiet_lines: usize,
    echo: bool,
    request: Option<ipc::Request>,
    request_failed: bool,
    request_level: u32,
    start_level: u32,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> Option<T> {
    STATE.with(|s| s.borrow_mut().as_mut().map(f))
}

unsafe fn start_r(lib: &'static libr::LibR, opts: Options) -> i32 {
    // argv for R: program name, R's options, and --no-readline (the console
    // owns line editing). The strings must outlive R, so they are leaked.
    let mut argv: Vec<*mut c_char> = Vec::new();
    let push = |argv: &mut Vec<*mut c_char>, s: &[u8]| {
        argv.push(CString::new(s).unwrap_or_default().into_raw());
    };
    push(&mut argv, b"R");
    for a in &opts.r_args {
        use std::os::unix::ffi::OsStrExt;
        push(&mut argv, a.as_bytes());
    }
    push(&mut argv, b"--no-readline");
    let argc = argv.len() as c_int;
    let argv: &'static mut [*mut c_char] = Vec::leak(argv);

    // SAFETY: documented embedding sequence (R-exts §8.1): initialise, then
    // replace the console callbacks, then set up and run the main loop.
    unsafe {
        (lib.initialize_r)(argc, argv.as_mut_ptr());
        *lib.r_interactive = 1;
        *lib.r_outputfile = std::ptr::null_mut();
        *lib.r_consolefile = std::ptr::null_mut();
        *lib.ptr_write_console = None;
        *lib.ptr_write_console_ex = Some(write_console_ex);
        // R calls the C wrapper, which calls `read_console` and raises any
        // interrupt it reports once the Rust frames are gone.
        libr::raven_set_read_console(read_console);
        *lib.ptr_read_console = Some(libr::raven_read_console);
        *lib.ptr_reset_console = Some(reset_console);
        *lib.ptr_flush_console = Some(flush_console);
        *lib.ptr_clearerr_console = Some(noop);
        *lib.ptr_show_message = Some(show_message);
        *lib.ptr_busy = Some(busy);
        *lib.r_wait_usec = 10_000;
    }
    output::init(opts.color, output::Headers::default());

    let break_flag = Arc::new(AtomicBool::new(false));
    let indent = Arc::new(IndentRequest::default());
    // SAFETY: pthread_self has no preconditions.
    let main_thread = unsafe { libc::pthread_self() };
    let subscribers = Arc::new(std::sync::Mutex::new(Vec::new()));
    let ipc = opts.ipc.as_ref().and_then(|p| {
        match ipc::Server::start(p, break_flag.clone(), main_thread, subscribers.clone()) {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("raven console: cannot listen on {}: {e}", p.display());
                None
            }
        }
    });

    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            editor: None,
            plain_editor: None,
            pending: VecDeque::new(),
            segments: VecDeque::new(),
            quiet_lines: 0,
            echo: false,
            request: None,
            request_failed: false,
            request_level: 0,
            start_level: 0,
            suspended: Vec::new(),
            overflow: String::new(),
            stash: None,
            ipc,
            break_flag: break_flag.clone(),
            indent: indent.clone(),
            set_width_fn: std::ptr::null_mut(),
            release_hook_fn: std::ptr::null_mut(),
            depth: 0,
        })
    });

    // Runs the site and user profiles (including Raven's plot/data-viewer
    // bootstrap via R_PROFILE_USER) and prints the banner.
    // SAFETY: as above.
    unsafe { (lib.setup_rmainloop)() };

    // The helpers need a live R; build the editor once they exist.
    let helpers = load_helpers();
    let complete_fn = helpers
        .as_ref()
        .map(|h| h.complete)
        .unwrap_or(std::ptr::null_mut());
    let set_width_fn = helpers
        .as_ref()
        .map(|h| h.set_width)
        .unwrap_or(std::ptr::null_mut());
    let release_hook_fn = helpers
        .as_ref()
        .map(|h| h.release_hook)
        .unwrap_or(std::ptr::null_mut());
    if let Some(h) = helpers {
        output::get().set_headers(h.headers);
    }
    if opts.dap.is_some()
        && let Err(e) = dap::init(
            opts.dap.as_deref(),
            break_flag.clone(),
            main_thread,
            subscribers,
        )
    {
        eprintln!("\x1b[2mraven console: {e}\x1b[0m");
    }
    let printer = reedline::ExternalPrinter::new(4096);
    let printer_tx = printer.sender();
    let mut ed = editor::build(editor::EditorConfig {
        mode: opts.edit_mode,
        history_file: opts.history_file.clone(),
        complete_fn,
        break_flag: break_flag.clone(),
        indent,
        printer,
    });
    let ipc_for_idle = with_state(|s| s.ipc.clone()).flatten();
    let flag_for_idle = break_flag.clone();
    let mut pump = event_pump();
    ed = ed.with_idle_callback(Box::new(move || {
        pump();
        output::get().pump_editor();
        if dap::has_work() {
            dap::service();
        }
        if ACCEPTING.load(Ordering::Relaxed)
            && ipc_for_idle.as_ref().is_some_and(ipc::Server::has_pending)
        {
            flag_for_idle.store(true, Ordering::Relaxed);
        }
    }));
    let plain = editor::build_plain(Box::new(event_pump()));
    with_state(|s| {
        s.editor = Some(ed);
        s.plain_editor = Some(plain);
        s.set_width_fn = set_width_fn;
        s.release_hook_fn = release_hook_fn;
    });
    PRINTER.with(|p| *p.borrow_mut() = Some(printer_tx));

    // SAFETY: as above. R exits the process from q(); this does not return.
    unsafe { (lib.run_rmainloop)() };
    0
}

/// The editor is at a prompt where it would start a queued request now (the
/// idle callback only interrupts the editor for requests it can serve, so a
/// request that has to wait never spins the read loop).
static ACCEPTING: AtomicBool = AtomicBool::new(false);

/// Services R's event loop while an editor waits for input. reedline calls
/// its idle callback on every loop iteration (including after each key), so
/// the R work is throttled to [`EVENT_PUMP_INTERVAL`].
fn event_pump() -> impl FnMut() + Send {
    let mut last = Instant::now();
    move || {
        if last.elapsed() >= EVENT_PUMP_INTERVAL {
            last = Instant::now();
            // SAFETY: only reached on the R thread, inside `read_line` while R
            // is idle; the shim guards jumps.
            unsafe { libr::raven_pump_events() };
        }
    }
}

thread_local! {
    static PRINTER: RefCell<Option<std::sync::mpsc::SyncSender<String>>> = const { RefCell::new(None) };
}

struct Helpers {
    complete: Sexp,
    set_width: Sexp,
    release_hook: Sexp,
    headers: output::Headers,
}

/// Evaluate `helpers.R` into its private environment.
fn load_helpers() -> Option<Helpers> {
    let code = CString::new(HELPERS_R).ok()?;
    let mut env: Sexp = std::ptr::null_mut();
    // SAFETY: R thread, R idle; the shim guards jumps.
    if unsafe { libr::raven_eval(code.as_ptr(), std::ptr::null_mut(), &mut env) } != 0 {
        return None;
    }
    let get = |name: &str| -> Option<Sexp> {
        let c = CString::new(name).ok()?;
        let mut out: Sexp = std::ptr::null_mut();
        // SAFETY: as above; `env` is preserved.
        (unsafe { libr::raven_eval(c.as_ptr(), env, &mut out) } == 0).then_some(out)
    };
    let complete = get("complete")?;
    let set_width = get("set_width")?;
    let release_hook = get("release_output_hook")?;
    let mut headers = output::Headers::default();
    if let Some(h) = get("headers") {
        let mut out: Sexp = std::ptr::null_mut();
        // SAFETY: as above.
        if unsafe { libr::raven_call(h, 0, std::ptr::null(), &mut out) } == 0 {
            // SAFETY: preserved result.
            let v = unsafe { libr::strings(out) };
            // SAFETY: releases the shim's reference.
            unsafe { libr::raven_release(out) };
            let mut bucket = None;
            for s in v {
                match s.as_str() {
                    "E" => bucket = Some(true),
                    "W" => bucket = Some(false),
                    _ => match bucket {
                        Some(true) if !headers.error.contains(&s) => headers.error.push(s),
                        Some(false) if !headers.warning.contains(&s) => headers.warning.push(s),
                        _ => {}
                    },
                }
            }
        }
        // SAFETY: releases the reference `get` took.
        unsafe { libr::raven_release(h) };
    }
    Some(Helpers {
        complete,
        set_width,
        release_hook,
        headers,
    })
}

/// The console must own R's output hook: output written behind its back
/// (colorout writes straight to the terminal) would bypass ordering, the
/// editor's above-the-prompt printing, and the socket echo. Checked after the
/// profiles run and at every prompt (a cheap pointer comparison).
fn reclaim_output_hook() {
    let lib = libr::get();
    // SAFETY: R thread; plain reads/writes of R's callback globals.
    let ours = unsafe { *lib.ptr_write_console_ex }
        .is_some_and(|f| std::ptr::fn_addr_eq(f, write_console_ex as libr::WriteConsoleExFn));
    if ours {
        return;
    }
    let fun = with_state(|s| s.release_hook_fn).unwrap_or(std::ptr::null_mut());
    let mut who = String::new();
    if !fun.is_null() {
        let mut out: Sexp = std::ptr::null_mut();
        // SAFETY: R thread, R idle; the shim guards jumps.
        if unsafe { libr::raven_call(fun, 0, std::ptr::null(), &mut out) } == 0 {
            // SAFETY: preserved result; released right after.
            who = unsafe { libr::strings(out) }
                .into_iter()
                .next()
                .unwrap_or_default();
            unsafe { libr::raven_release(out) };
        }
    }
    // SAFETY: as above.
    unsafe {
        *lib.ptr_write_console = None;
        *lib.ptr_write_console_ex = Some(write_console_ex);
        *lib.r_outputfile = std::ptr::null_mut();
        *lib.r_consolefile = std::ptr::null_mut();
    }
    let what = if who.is_empty() {
        "another package".to_string()
    } else {
        who
    };
    output::get().write(
        format!("\x1b[2mraven console: {what} replaced the console's output; turned it off for this session (Raven colors output itself)\x1b[0m\n").as_bytes(),
        0,
    );
}

// ---- callbacks R invokes ----------------------------------------------------

unsafe extern "C" fn write_console_ex(buf: *const c_char, len: c_int, otype: c_int) {
    let _ = std::panic::catch_unwind(|| {
        if buf.is_null() || len <= 0 {
            return;
        }
        // SAFETY: R passes a buffer of `len` bytes.
        let bytes = unsafe { std::slice::from_raw_parts(buf.cast::<u8>(), len as usize) };
        if otype == 0 && dap::active() {
            let text = dap::filter_output(&String::from_utf8_lossy(bytes));
            if !text.is_empty() {
                output::get().write(text.as_bytes(), otype);
            }
            return;
        }
        output::get().write(bytes, otype);
    });
}

unsafe extern "C" fn flush_console() {
    let _ = std::panic::catch_unwind(|| output::get().flush());
}

unsafe extern "C" fn noop() {}

/// R's macOS (Aqua) builds call `R_Busy(1)` just before `system()` and
/// `system2()` start a child, so write out buffered output first: the child
/// writes straight to the terminal and must not overtake it.
unsafe extern "C" fn busy(which: c_int) {
    if which == 1 {
        let _ = std::panic::catch_unwind(|| output::get().flush());
    }
}

unsafe extern "C" fn show_message(msg: *const c_char) {
    let _ = std::panic::catch_unwind(|| {
        if msg.is_null() {
            return;
        }
        // SAFETY: NUL-terminated string from R.
        let m = unsafe { CStr::from_ptr(msg) }.to_string_lossy();
        output::get().write(format!("{m}\n").as_bytes(), 1);
    });
}

/// R calls this after an uncaught error or an interrupt (including `Q` in
/// the browser): discard whatever is left of the current submission *and* of
/// any submission parked behind a nested browser — errors stop the rest of
/// what was sent, wherever it was waiting. Parked socket requests are
/// reported as failed.
unsafe extern "C" fn reset_console() {
    let _ = std::panic::catch_unwind(|| {
        let parked = with_state(|s| {
            s.pending.clear();
            s.segments.clear();
            s.quiet_lines = 0;
            if s.request.is_some() {
                s.request_failed = true;
            }
            std::mem::take(&mut s.suspended)
        })
        .unwrap_or_default();
        for sub in parked {
            if let Some(r) = sub.request {
                r.finish("error");
            }
        }
    });
}

thread_local! {
    /// Set by an input path when Ctrl-C there means "interrupt R" (plain
    /// input, continuation lines); `read_console` hands it to the C wrapper.
    static INTERRUPT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn request_interrupt() {
    INTERRUPT.with(|i| i.set(true));
}

unsafe extern "C" fn read_console(
    prompt: *const c_char,
    buf: *mut u8,
    len: c_int,
    hist: c_int,
    interrupt: *mut c_int,
) -> c_int {
    let r = read_console_inner(prompt, buf, len, hist);
    if INTERRUPT.with(|i| i.replace(false)) && !interrupt.is_null() {
        // SAFETY: the shim passes a valid out-pointer.
        unsafe { *interrupt = 1 };
        // What R would discard on the interrupt anyway.
        with_state(|s| {
            s.pending.clear();
            s.overflow.clear();
        });
    }
    r
}

fn read_console_inner(prompt: *const c_char, buf: *mut u8, len: c_int, hist: c_int) -> c_int {
    let prompt = if prompt.is_null() {
        String::new()
    } else {
        // SAFETY: NUL-terminated prompt from R.
        unsafe { CStr::from_ptr(prompt) }
            .to_string_lossy()
            .into_owned()
    };
    if buf.is_null() || len < 2 {
        return 0;
    }
    let cap = (len - 1) as usize; // room for the NUL
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Every path is bounded here, once: whatever doesn't fit in R's
        // buffer is kept and handed to R on its next read.
        read_console_impl(&prompt, hist, cap).map(|mut line| {
            let chunk = take_chunk(&mut line, cap);
            if !line.is_empty() {
                with_state(|s| s.overflow = line);
            }
            chunk
        })
    }));
    let line = match r {
        Ok(Some(l)) => l,
        Ok(None) | Err(_) => return 0, // EOF
    };
    let bytes = line.as_bytes();
    debug_assert!(bytes.len() <= cap);
    let n = bytes.len().min(cap);
    // SAFETY: `buf` has `len` bytes; we write at most `cap` plus a NUL.
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf, n);
        *buf.add(n) = 0;
    }
    1
}

fn classify(prompt: &str, hist: c_int) -> PromptKind {
    if hist == 0 {
        return PromptKind::Other;
    }
    if is_browser_prompt(prompt) {
        return PromptKind::Browser;
    }
    if option_string(c"continue").is_some_and(|c| c == prompt) {
        return PromptKind::Continuation;
    }
    // Any other REPL prompt (the `prompt` option, or a prompt set by a
    // package) is treated as top level.
    PromptKind::TopLevel
}

/// `getOption(name)` if it is a string (through the shim: looking up the
/// option's symbol can allocate, and so jump).
fn option_string(name: &CStr) -> Option<String> {
    let mut buf = [0 as c_char; 256];
    // SAFETY: R thread, R idle; the buffer is valid for its length.
    let found =
        unsafe { libr::raven_option_string(name.as_ptr(), buf.as_mut_ptr(), buf.len() as c_int) };
    // SAFETY: the shim NUL-terminates within the buffer.
    (found == 1).then(|| {
        unsafe { CStr::from_ptr(buf.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    })
}

fn is_browser_prompt(p: &str) -> bool {
    browse_level(p).is_some()
}

/// `n` for a `Browse[n]> ` prompt.
fn browse_level(p: &str) -> Option<u32> {
    p.strip_prefix("Browse[")
        .and_then(|r| r.strip_suffix("]> "))
        .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|n| n.parse().ok())
}

/// Next chunk of a pending line that fits in R's buffer, cut on a UTF-8
/// boundary; the remainder stays queued (R keeps reading until it sees the
/// newline).
fn take_chunk(line: &mut String, cap: usize) -> String {
    if line.len() <= cap {
        return std::mem::take(line);
    }
    let mut cut = cap;
    while cut > 0 && !line.is_char_boundary(cut) {
        cut -= 1;
    }
    let rest = line.split_off(cut);
    std::mem::replace(line, rest)
}

/// Pops the next piece of pending input for R, if any.
fn next_pending(cap: usize) -> Option<(String, bool)> {
    with_state(|s| {
        let mut line = s.pending.pop_front()?;
        let chunk = take_chunk(&mut line, cap);
        if !line.is_empty() {
            s.pending.push_front(line);
        }
        let mut echo = s.echo;
        if s.quiet_lines > 0 {
            echo = false;
            if chunk.ends_with('\n') {
                s.quiet_lines -= 1;
            }
        }
        Some((chunk, echo))
    })
    .flatten()
}

/// One newline-terminated line per element. Empty input is one empty line
/// (plain R's behaviour for Enter at an empty prompt), never EOF.
fn split_submission(text: &str) -> VecDeque<String> {
    if text.is_empty() {
        return VecDeque::from([String::from("\n")]);
    }
    text.split_inclusive('\n')
        .map(|l| {
            if l.ends_with('\n') {
                l.to_string()
            } else {
                format!("{l}\n")
            }
        })
        .collect()
}

fn echo_line(prompt: &str, kind: PromptKind, line: &str) {
    let color = if kind == PromptKind::Browser {
        "\x1b[33m"
    } else {
        "\x1b[34m"
    };
    let body = line.trim_end_matches('\n');
    let styled = editor::highlight_ansi(body);
    let mut out = std::io::stdout().lock();
    let _ = write!(out, "\r\x1b[2K{color}{prompt}\x1b[0m{styled}\n");
    let _ = out.flush();
}

fn read_console_impl(prompt: &str, hist: c_int, cap: usize) -> Option<String> {
    // The rest of an over-long line comes first: R is still reading it.
    if let Some(rest) = with_state(|s| std::mem::take(&mut s.overflow)).filter(|r| !r.is_empty()) {
        return Some(rest);
    }
    reclaim_output_hook();
    output::get().at_prompt();
    let kind = classify(prompt, hist);
    let repl_prompt = kind != PromptKind::Other;
    if repl_prompt {
        // A request whose lines have all been fed is finished once R asks at
        // a REPL prompt at (or above) the level it started from — not inside
        // a `browser()` its last line opened. Record that before deciding
        // what to feed next.
        let level = browse_level(prompt).unwrap_or(0);
        if with_state(|s| s.pending.is_empty() && s.segments.is_empty() && level <= s.request_level)
            .unwrap_or(false)
        {
            finish_request();
        }
        route_submission(level);
        // The debugger's hidden input (stack capture, stepping through
        // probes, installing handlers) comes before anything queued.
        if let Some(hidden) = dap::on_repl_prompt(level) {
            return Some(hidden);
        }
        if kind == PromptKind::TopLevel {
            start_next_segment(prompt);
        }
    }

    // Continue feeding the current submission at R's own REPL prompts.
    if repl_prompt && let Some((chunk, echo)) = next_pending(cap) {
        if echo {
            echo_line(prompt, kind, &chunk);
        }
        return Some(chunk);
    }

    let depth = with_state(|s| {
        s.depth += 1;
        s.depth
    })?;
    let result = read_new_input(prompt, kind, cap, depth);
    with_state(|s| s.depth -= 1);
    result
}

/// At a top-level prompt with no lines pending, render the next tagged
/// expression of the submission (if any) and queue its lines; its original
/// lines are echoed now, the rendered ones are fed silently.
fn start_next_segment(prompt: &str) {
    let next = with_state(|s| {
        if s.pending.is_empty() {
            s.segments.pop_front().map(|seg| (seg, s.echo))
        } else {
            None
        }
    })
    .flatten();
    let Some((seg, echo)) = next else { return };
    dap::on_next_segment();
    let text = dap::render_segment(&seg);
    if echo {
        for (i, line) in seg.echo.iter().enumerate() {
            let p = if i == 0 { prompt } else { "+ " };
            let kind = if i == 0 {
                PromptKind::TopLevel
            } else {
                PromptKind::Continuation
            };
            echo_line(p, kind, line);
        }
    }
    with_state(|s| {
        s.pending = split_submission(&text);
        s.quiet_lines = s.pending.len();
    });
}

/// Keep a submission's lines out of a deeper `browser()` that one of its own
/// lines started (they would become debugger commands — `n`, `c`, `Q`): set
/// it aside there, and pick it up again once R is back at the level it
/// started from.
fn route_submission(level: u32) {
    with_state(|s| {
        if (!s.pending.is_empty() || !s.segments.is_empty()) && level > s.start_level {
            let parked = Submission {
                pending: std::mem::take(&mut s.pending),
                segments: std::mem::take(&mut s.segments),
                quiet_lines: std::mem::take(&mut s.quiet_lines),
                echo: s.echo,
                request: s.request.take(),
                request_failed: std::mem::take(&mut s.request_failed),
                request_level: s.request_level,
                start_level: s.start_level,
            };
            s.suspended.push(parked);
            s.start_level = level;
        } else if s.pending.is_empty()
            && s.segments.is_empty()
            && s.request.is_none()
            && s.suspended.last().is_some_and(|p| level <= p.start_level)
        {
            let p = s.suspended.pop().expect("checked");
            s.pending = p.pending;
            s.segments = p.segments;
            s.quiet_lines = p.quiet_lines;
            s.echo = p.echo;
            s.request = p.request;
            s.request_failed = p.request_failed;
            s.request_level = p.request_level;
            s.start_level = p.start_level;
        }
    });
}

fn finish_request() {
    let finished = with_state(|s| {
        let failed = std::mem::take(&mut s.request_failed);
        s.request.take().map(|r| (r, failed))
    })
    .flatten();
    if let Some((r, failed)) = finished {
        r.finish(if failed { "error" } else { "done" });
    }
}

fn read_new_input(prompt: &str, kind: PromptKind, cap: usize, depth: u32) -> Option<String> {
    ipc::R_BUSY.store(false, Ordering::Relaxed);
    let result = read_new_input_from(prompt, kind, cap, depth);
    if result.is_some() {
        // R runs again (also after a `readline()` answer): socket interrupts
        // apply from here.
        ipc::R_BUSY.store(true, Ordering::Relaxed);
    }
    result
}

fn read_new_input_from(prompt: &str, kind: PromptKind, cap: usize, depth: u32) -> Option<String> {
    // `readline()`, `menu()`, `scan()`: a plain line, as R's own console
    // reads it — no history, completion, or pairing.
    if kind == PromptKind::Other {
        let plain = if depth == 1 {
            with_state(|s| s.plain_editor.take()).flatten()
        } else {
            None
        };
        let Some(mut ed) = plain else {
            return plain_read(prompt);
        };
        let result = plain_edit(&mut ed, prompt);
        with_state(|s| s.plain_editor = Some(ed));
        return result;
    }
    let editor = if depth == 1 {
        with_state(|s| s.editor.take()).flatten()
    } else {
        None
    };
    let Some(mut ed) = editor else {
        return plain_read(prompt);
    };

    let result = edit_loop(&mut ed, prompt, kind, cap);
    with_state(|s| s.editor = Some(ed));
    if result.is_some() {
        // A Ctrl-C pressed while R was idle must not interrupt the new input.
        if let Some(p) = libr::get().r_interrupts_pending {
            // SAFETY: R thread; R's own handler only ever stores 1 here.
            unsafe { *p = 0 };
        }
    }
    result
}

fn edit_loop(ed: &mut Reedline, prompt: &str, kind: PromptKind, cap: usize) -> Option<String> {
    // Every REPL prompt takes queued requests, including `+ ` (a request may
    // finish an expression an earlier one started, as typed lines would) —
    // but only one request at a time: one paused in a `browser()` it opened
    // keeps the next waiting.
    let accepts_queue =
        kind != PromptKind::Other && with_state(|s| s.request.is_none()).unwrap_or(false);
    // Socket request waiting? Run it before showing the editor.
    if accepts_queue && let Some(line) = start_request(prompt, kind, cap) {
        return Some(line);
    }
    // Restore a buffer the user was typing when a request arrived.
    if let Some((buf, pos)) = with_state(|s| s.stash.take()).flatten() {
        ed.run_edit_commands(&[
            EditCommand::InsertString(buf),
            EditCommand::MoveToPosition {
                position: pos,
                select: false,
            },
        ]);
    }
    let rprompt = RPrompt {
        text: prompt.to_string(),
        kind,
    };
    let printer = PRINTER.with(|p| p.borrow().clone());
    ACCEPTING.store(accepts_queue, Ordering::Relaxed);
    loop {
        update_width();
        output::get().set_editor_sink(printer.clone());
        let sig = ed.read_line(&rprompt);
        output::get().set_editor_sink(None);
        match sig {
            Ok(Signal::Success(text)) => {
                // `q()` exits the process without dropping the editor, so
                // history is written after every submission.
                let _ = ed.sync_history();
                if kind == PromptKind::Browser {
                    dap::on_user_line(&text);
                }
                with_state(|s| {
                    s.pending = split_submission(&text);
                    s.echo = false;
                    s.start_level = browse_level(prompt).unwrap_or(0);
                });
                return next_pending(cap).map(|(c, _)| c);
            }
            // At `+ `, Ctrl-C abandons the unfinished expression, as in plain
            // R; elsewhere it just clears the line being edited.
            Ok(Signal::CtrlC) if kind == PromptKind::Continuation => {
                request_interrupt();
                return Some("\n".into());
            }
            Ok(Signal::CtrlC) => continue,
            Ok(Signal::CtrlD) => return None,
            Ok(Signal::ExternalBreak(buf)) => {
                // The debugger resumes R (Continue, Step…): feed its browser
                // command, keeping whatever the user had typed for later.
                if kind == PromptKind::Browser
                    && let Some(cmd) = dap::take_resume()
                {
                    if !buf.is_empty() {
                        let pos = ed.current_insertion_point();
                        with_state(|s| s.stash = Some((buf, pos)));
                    }
                    ed.run_edit_commands(&[EditCommand::Clear]);
                    echo_line(prompt, kind, &cmd);
                    return Some(format!("{cmd}\n"));
                }
                let indent = with_state(|s| s.indent.take()).flatten();
                if let Some(indent) = indent {
                    ed.run_edit_commands(&[EditCommand::InsertString(indent)]);
                    continue;
                }
                let queued = with_state(|s| s.ipc.as_ref().is_some_and(ipc::Server::has_pending))
                    .unwrap_or(false);
                if accepts_queue && queued {
                    let pos = ed.current_insertion_point();
                    with_state(|s| s.stash = Some((buf, pos)));
                    ed.run_edit_commands(&[EditCommand::Clear]);
                    // Repaint the (now empty) prompt in place so the echoed
                    // request replaces it instead of the half-typed text.
                    with_state(|s| s.break_flag.store(true, Ordering::Relaxed));
                    let _ = ed.read_line(&rprompt);
                    if let Some(line) = start_request(prompt, kind, cap) {
                        return Some(line);
                    }
                }
            }
            Ok(_) => continue,
            Err(_) => return plain_read(prompt),
        }
    }
}

/// Pop a socket request (if any) and return its first line for R.
fn start_request(prompt: &str, kind: PromptKind, cap: usize) -> Option<String> {
    let req = with_state(|s| s.ipc.as_ref().and_then(ipc::Server::pop)).flatten()?;
    // Code sent from an editor with its location, at a top-level prompt,
    // runs expression by expression wrapped in `{ #line … }` so its srcrefs
    // point at the file (and breakpoints can be injected; design §3).
    let segments = if kind == PromptKind::TopLevel && browse_level(prompt).is_none() {
        req.location
            .as_ref()
            .and_then(|loc| dap::split_submission(&req.code, loc))
    } else {
        None
    };
    if let Some(segments) = segments {
        with_state(|s| {
            s.pending.clear();
            s.segments = segments;
            s.echo = true;
            s.request_failed = false;
            s.request = Some(req);
            s.start_level = 0;
            s.request_level = 0;
        });
        start_next_segment(prompt);
        let (chunk, echo) = next_pending(cap)?;
        if echo {
            echo_line(prompt, kind, &chunk);
        }
        return Some(chunk);
    }
    with_state(|s| {
        s.pending = split_submission(&req.code);
        s.echo = true;
        s.request_failed = false;
        s.request = Some(req);
        s.start_level = browse_level(prompt).unwrap_or(0);
        s.request_level = s.start_level;
    });
    let (chunk, _) = next_pending(cap)?;
    echo_line(prompt, kind, &chunk);
    Some(chunk)
}

fn update_width() {
    let Some(w) = term::width() else { return };
    let fun = with_state(|s| s.set_width_fn).unwrap_or(std::ptr::null_mut());
    if fun.is_null() {
        return;
    }
    let arg = CString::new(w.to_string()).expect("digits");
    let args = [arg.as_ptr()];
    let mut out: Sexp = std::ptr::null_mut();
    // SAFETY: R thread, R idle; the shim guards jumps.
    if unsafe { libr::raven_call(fun, 1, args.as_ptr(), &mut out) } == 0 {
        // SAFETY: releases the shim's reference.
        unsafe { libr::raven_release(out) };
    }
}

fn plain_edit(ed: &mut Reedline, prompt: &str) -> Option<String> {
    let rprompt = RPrompt {
        text: prompt.to_string(),
        kind: PromptKind::Other,
    };
    loop {
        match ed.read_line(&rprompt) {
            Ok(Signal::Success(text)) => return Some(text + "\n"),
            Ok(Signal::CtrlC) => {
                // As in R's own console: Ctrl-C at `readline()` interrupts
                // the code that asked.
                request_interrupt();
                return Some("\n".into());
            }
            Ok(Signal::CtrlD) => return None,
            Ok(_) => continue,
            Err(_) => return plain_read(prompt),
        }
    }
}

/// Input for reads nested inside the editor (R code run by the event pump
/// asking for input): a cooked-mode line.
fn plain_read(prompt: &str) -> Option<String> {
    let raw = crossterm::terminal::is_raw_mode_enabled().unwrap_or(false);
    if raw {
        let _ = crossterm::terminal::disable_raw_mode();
    }
    {
        let mut out = std::io::stdout().lock();
        let _ = write!(out, "{prompt}");
        let _ = out.flush();
    }
    // Read with libc so that Ctrl-C (EINTR) interrupts instead of retrying.
    // Poll first, so the debugger is served while this nested read waits (a
    // breakpoint hit inside a `later`/httpuv callback stops here; design §2).
    let browser = is_browser_prompt(prompt);
    let mut line = Vec::new();
    let mut byte = 0u8;
    let result = loop {
        if line.is_empty() && dap::active() {
            if dap::has_work() {
                dap::service();
            }
            if browser && let Some(cmd) = dap::take_resume() {
                break Some(format!("{cmd}\n"));
            }
            let mut pfd = libc::pollfd {
                fd: 0,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd.
            let ready = unsafe { libc::poll(&mut pfd, 1, 50) };
            if ready == 0 {
                continue;
            }
            if ready < 0
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
            {
                request_interrupt();
                break Some("\n".into());
            }
        }
        // SAFETY: reading one byte into a valid buffer.
        let n = unsafe { libc::read(0, (&raw mut byte).cast(), 1) };
        if n == 1 {
            line.push(byte);
            if byte == b'\n' {
                break Some(String::from_utf8_lossy(&line).into_owned());
            }
        } else if n == 0 {
            break None;
        } else if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            request_interrupt();
            break Some("\n".into());
        } else {
            break None;
        }
    };
    if raw {
        let _ = crossterm::terminal::enable_raw_mode();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_prompts() {
        assert!(is_browser_prompt("Browse[1]> "));
        assert!(is_browser_prompt("Browse[12]> "));
        assert!(!is_browser_prompt("Browse[]> "));
        assert!(!is_browser_prompt("> "));
    }

    #[test]
    fn browse_levels() {
        assert_eq!(browse_level("Browse[2]> "), Some(2));
        assert_eq!(browse_level("> "), None);
    }

    #[test]
    fn chunks_respect_utf8_and_capacity() {
        let mut s = "aé😀b\n".to_string();
        let a = take_chunk(&mut s, 4);
        assert_eq!(a, "aé");
        assert_eq!(take_chunk(&mut s, 4), "😀");
        assert_eq!(take_chunk(&mut s, 4), "b\n");
    }

    #[test]
    fn submissions_split_into_newline_terminated_lines() {
        let v: Vec<_> = split_submission("a <- 1\nb").into_iter().collect();
        assert_eq!(v, vec!["a <- 1\n", "b\n"]);
        let v: Vec<_> = split_submission("").into_iter().collect();
        assert_eq!(v, vec!["\n"]);
    }

    #[test]
    fn args_split_console_and_r_options() {
        let o = parse_args(
            [
                "--edit-mode",
                "vi",
                "--no-save",
                "-q",
                "--color-output",
                "values",
            ]
            .map(OsString::from)
            .to_vec(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(o.edit_mode, EditMode::Vi);
        assert_eq!(o.color, ColorMode::Values);
        assert_eq!(
            o.r_args,
            vec![OsString::from("--no-save"), OsString::from("-q")]
        );
    }
}
