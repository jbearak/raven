//! The R debugger served from `raven console` (design:
//! `docs/superpowers/specs/2026-10-29-r-debugger-design.md`).
//!
//! # Threads (design §2)
//!
//! * The DAP reader thread ([`server`]) parses requests and answers those that
//!   need no R from [`Shared`] (breakpoints, threads, stack traces, exception
//!   info). It never calls R.
//! * Requests that need R (scopes, variables, evaluate, setVariable,
//!   function breakpoints) become [`Job`]s, drained by [`service`] on the R
//!   thread at the console's service points: the line editor's idle callback
//!   at a prompt, and the nested-read poll loop. Resume commands (`n`, `c`, …)
//!   are handed to the editor through the break flag, because they must
//!   change the prompt.
//! * No lock is held across an R call: [`Shared`] is locked only to copy
//!   plain data (the lesson of positron#5024).
//!
//! # Stops (design §4)
//!
//! Every `Browse[n]>` prompt goes through [`on_repl_prompt`]. A prompt whose
//! current srcref is a probe line ([`annotate::PROBE_FILE`]) is stepped
//! through with hidden `n` input; any other is a real stop: the console feeds
//! the hidden capture call (RStudio's trick: evaluated in the browsed
//! environment), and the next prompt reports `stopped`.
//!
//! # Breakpoints (design §5)
//!
//! Probes are injected into code sent from the editor ([`split_submission`],
//! [`render_segment`]) and into files read by `source()` and by pkgload/shiny
//! through Ark's `.ark_annotate_source` hook (the `plan_file`/`render_file`
//! RPCs). The probe calls the R hook (`debug.R`), which asks Rust over the
//! RPC routine whether to stop.

pub mod annotate;
pub mod server;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ffi::{CStr, CString, c_char, c_int};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};

use serde_json::{Value, json};

use super::libr::{self, Sexp};
use super::local_socket::Stream;
use annotate::{BpRequest, Placement, Wrap};

const DEBUG_R: &str = include_str!("debug.R");
/// Separator for fields passed between R and Rust as one string.
const US: &str = "\x1f";
/// Hidden input that captures the stack at a browser prompt.
const CAPTURE: &str = "base::.raven_dbg_capture()\n";
/// Hidden input that installs the global condition handlers at the first
/// top-level prompt (they must be installed from R's real top level).
const INSTALL: &str = "base::.raven_dbg_install()\n";
/// Most hidden `n` steps through probe scaffolding before giving up (§4).
const MAX_HIDDEN_STEPS: u8 = 4;
/// Most hidden `f` steps out of code with no srcref before giving up
/// ("just my code", §4).
const MAX_JMC_STEPS: u8 = 64;
/// Id of the one-shot probe that continues stepping into the next top-level
/// expression of a submission (§4).
const STEP_PROBE: &str = "step";

unsafe extern "C" {
    fn raven_dbg_init(err: *mut c_char, errlen: c_int) -> c_int;
    fn raven_dbg_set_rpc(
        f: unsafe extern "C" fn(*const c_char, *const c_char, *const c_char) -> *const c_char,
    );
    fn raven_dbg_current_srcref(
        use_na: c_int,
        lines: *mut c_int,
        file: *mut c_char,
        filelen: c_int,
    ) -> c_int;
    fn raven_dbg_clear_global_rdebug();
}

/// Where sent code came from (the IPC `execute` op's `location`).
#[derive(Debug, Clone)]
pub struct Location {
    pub path: String,
    /// 1-based line of the code's first character.
    pub line: u32,
    /// 0-based character column of the code's first character.
    pub col: u32,
    /// The file line of each line of the code, when the code isn't one
    /// contiguous range (e.g. several R Markdown chunks run together).
    pub lines: Option<Vec<u32>>,
}

/// One top-level expression of a tagged submission, rendered lazily just
/// before it is fed (callee checks see what earlier expressions did, §5.3).
#[derive(Debug, Clone)]
pub struct Segment {
    pub text: String,
    pub path: String,
    pub line: u32,
    pub col: u32,
    /// Original lines to echo when this expression starts.
    pub echo: Vec<String>,
}

#[derive(Debug, Clone)]
struct LineBp {
    id: u64,
    line: u32,
    condition: String,
    hit_condition: String,
    log_message: String,
    verified: bool,
    reason: Option<String>,
    /// Line the probe is anchored to, once known.
    anchor: Option<u32>,
    hits: u64,
    /// Text of the anchored statement when its probe was injected; a later
    /// change to that text means "not run since edit" (§5.5).
    bound_text: Option<String>,
}

impl LineBp {
    fn to_dap(&self, path: &str) -> Value {
        let mut v = json!({
            "id": self.id,
            "verified": self.verified,
            "line": self.anchor.unwrap_or(self.line),
            "source": {"path": path},
        });
        if let Some(r) = &self.reason {
            v["message"] = json!(r);
        }
        v
    }
}

#[derive(Debug, Clone, Default)]
struct Frame {
    /// R's frame number (0 = top level).
    r_index: i64,
    name: String,
    path: String,
    line: u32,
    col: u32,
    end_line: u32,
    end_col: u32,
    /// `sourceReference` of the deparsed function, for frames whose
    /// function has no srcref (design §6).
    source_ref: Option<i64>,
}

#[derive(Debug, Clone)]
struct Stop {
    reason: String,
    description: String,
    hit_ids: Vec<u64>,
    frames: Vec<Frame>,
    exception: Option<(String, String, String)>,
}

enum Job {
    Scopes(Value),
    Variables(Value),
    Evaluate(Value),
    SetVariable(Value),
    Completions(Value),
    FunctionBreakpoints(Option<Value>, Vec<String>),
}

#[derive(Default)]
struct Shared {
    files: BTreeMap<String, Vec<LineBp>>,
    /// The newest request applied to each file's breakpoints (see
    /// [`breakpoint_ticket`]). An entry outlives the file's breakpoints:
    /// it is what stops an older request arming them again.
    file_tickets: HashMap<String, u64>,
    next_id: u64,
    filters: Vec<String>,
    /// The newest request applied to `filters`, and to the function
    /// breakpoints (see [`breakpoint_ticket`]): what stops a mirror that
    /// stalled reading a file from restoring older ones.
    filters_ticket: u64,
    functions_ticket: u64,
    configured: bool,
    connected: bool,
    stop: Option<Stop>,
    resume: Option<String>,
    jobs: VecDeque<Job>,
    /// Function-breakpoint names last requested (applied on the R thread).
    fn_names: Vec<String>,
    /// Whether a stop's `n` should become `f` (after exception/pause stops).
    rewrite_next: bool,
    /// Line breakpoints changed: the R thread re-syncs the `source()` hook.
    hooks_dirty: bool,
    /// Virtual sources (deparsed functions) of the current stop.
    sources: HashMap<i64, String>,
    /// The session asked to step into code without source too
    /// (`justMyCode: false`).
    all_code: bool,
    /// The current session was launched to run a `program`, and that
    /// program's request (marked `debugProgram` by the extension) has
    /// finished.
    runs_program: bool,
    program_done: bool,
    /// The current session has seen a stop and not yet been ended.
    session_open: bool,
    /// `terminated` was sent to the current client: its `disconnect` is
    /// VS Code's teardown, not a user detach, and must not resume R.
    ended: bool,
}

impl Shared {
    fn bp_by_id(&mut self, id: u64) -> Option<(&String, &mut LineBp)> {
        self.files
            .iter_mut()
            .find_map(|(p, v)| v.iter_mut().find(|b| b.id == id).map(|b| (p, b)))
    }
}

/// Everything shared between the DAP threads, the IPC thread and R.
pub struct Handle {
    shared: Arc<Mutex<Shared>>,
    out: Option<server::Outbox>,
    break_flag: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    /// Stop asked to end what R is running: the interrupt it sends must
    /// return R to the prompt, not open a browser.
    abort: AtomicBool,
    /// IPC subscribers (the extension's control connections).
    subscribers: Arc<Mutex<Vec<Stream>>>,
}

static HANDLE: std::sync::OnceLock<Handle> = std::sync::OnceLock::new();

fn handle() -> Option<&'static Handle> {
    HANDLE.get()
}

fn lock(h: &Handle) -> std::sync::MutexGuard<'_, Shared> {
    h.shared.lock().unwrap_or_else(|e| e.into_inner())
}

/// Debugger state owned by the R thread.
struct RState {
    helpers: HashMap<&'static str, Sexp>,
    use_na: bool,
    installed: bool,
    /// The previous prompt's hidden input was the capture call.
    awaiting_capture: bool,
    hidden_steps: u8,
    current: Option<(String, [u32; 4])>,
    /// The capture call's frames (JSON) and flags (`fbp`, `nosrc`,
    /// `entry:<line>`).
    captured: Option<(String, String)>,
    /// A stop is active (reported and not resumed into running code).
    stopped: bool,
    /// A step/continue command was fed since the last stop.
    resumed: bool,
    had_stop: bool,
    last_user_resume: Option<String>,
    pending_hit: Option<u64>,
    /// The one-shot step probe fired: the next stop is a step (§4).
    pending_step: bool,
    pending_exception: Option<(String, String)>,
    /// R recorded a warning's location that isn't printed yet.
    warnings_pending: bool,
    /// Inspect Last Error is open: the frames are dead, so steps continue.
    inspecting: bool,
    step_next_segment: bool,
    /// One-shot step probe armed for the segment being fed.
    step_probe_armed: bool,
    plans: HashMap<String, (String, annotate::Plan)>,
    hook_installed: bool,
    /// The JIT was turned off for a step-in; restore it at the next prompt.
    jit_off: bool,
    jmc_steps: u8,
    /// Names the rebinding detector last reported.
    masked: String,
    /// Function breakpoints' bound state (`1`/`0` per name) last reported.
    fn_bound: String,
    /// Some code has been instrumented in this session (the rebinding
    /// notice matters only then).
    instrumented: bool,
}

thread_local! {
    static R: RefCell<Option<RState>> = const { RefCell::new(None) };
    static RPC_OUT: RefCell<CString> = RefCell::new(CString::default());
}

fn with_r<T>(f: impl FnOnce(&mut RState) -> T) -> Option<T> {
    R.with(|r| r.try_borrow_mut().ok().and_then(|mut g| g.as_mut().map(f)))
}

/// The debugger has started (callable from any thread).
pub fn ready() -> bool {
    handle().is_some()
}

static INIT_SETTLED: AtomicBool = AtomicBool::new(false);

/// The console is past the point where it starts the debugger, whether or
/// not it did: called once on the R thread after `init` (or in its place
/// when the console runs without `--dap`).
pub fn init_settled() {
    INIT_SETTLED.store(true, Ordering::SeqCst);
}

/// The debugger will never start in this console (R too old, its helpers
/// failed, the console runs without `--dap`). Unlike `!ready()`, this is
/// final: the extension stops waiting for it.
pub fn unavailable() -> bool {
    INIT_SETTLED.load(Ordering::SeqCst) && !ready()
}

/// Why R is stopped in the debugger, if it is (callable from any thread).
pub fn stop_reason() -> Option<String> {
    let h = handle()?;
    lock(h).stop.as_ref().map(|s| s.reason.clone())
}

/// The debugger is running in this console.
pub fn active() -> bool {
    R.with(|r| r.try_borrow().map(|g| g.is_some()).unwrap_or(false))
}

// ---- startup --------------------------------------------------------------

/// Start the debugger: load the R helpers, register the native routines,
/// and (when `dap` is given) listen for DAP clients there. Called on the R
/// thread once R is set up. Returns an error message when the debugger
/// can't run (the console continues without it).
pub fn init(
    dap: Option<&Path>,
    break_flag: Arc<AtomicBool>,
    subscribers: Arc<Mutex<Vec<Stream>>>,
) -> Result<(), String> {
    let mut err = [0 as c_char; 128];
    // SAFETY: R thread, R idle; the buffer is valid for its length.
    if unsafe { raven_dbg_init(err.as_mut_ptr(), err.len() as c_int) } != 0 {
        // SAFETY: the C side NUL-terminates.
        let what = unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy();
        return Err(format!("debugger unavailable: libR lacks {what}"));
    }
    // SAFETY: registers a plain extern "C" fn.
    unsafe { raven_dbg_set_rpc(rpc) };
    let code = CString::new(DEBUG_R).map_err(|_| "debugger helpers contain NUL")?;
    let mut env: Sexp = std::ptr::null_mut();
    // SAFETY: R thread, R idle; the shim guards jumps.
    if unsafe { libr::raven_eval(code.as_ptr(), std::ptr::null_mut(), &mut env) } != 0 {
        return Err("debugger helpers failed to load".into());
    }
    let mut helpers = HashMap::new();
    for name in [
        "variables",
        "scopes",
        "evaluate",
        "hover",
        "set_variable",
        "function_breakpoints",
        "verify_callees",
        "split_exprs",
        "completions",
        "set_source_hook",
        "install_hook_only",
        "on_stop",
        "on_resume",
        "at_prompt",
        "take_warnings",
    ] {
        let c = CString::new(format!("get(\"{name}\", envir = environment())")).expect("name");
        let mut out: Sexp = std::ptr::null_mut();
        // SAFETY: as above; `env` is preserved.
        if unsafe { libr::raven_eval(c.as_ptr(), env, &mut out) } != 0 {
            return Err(format!("debugger helper `{name}` missing"));
        }
        helpers.insert(name, out);
    }
    let use_na = r_version_at_least(4, 5);
    let shared = Arc::new(Mutex::new(Shared {
        next_id: 1,
        ..Default::default()
    }));
    let out = match dap {
        Some(path) => {
            let s1 = shared.clone();
            let s2 = shared.clone();
            Some(
                server::start(path, move |msg| on_message(&s1, msg), move || on_close(&s2))
                    .map_err(|e| format!("cannot listen on {}: {e}", path.display()))?,
            )
        }
        None => None,
    };
    let _ = HANDLE.set(Handle {
        shared,
        out,
        break_flag,
        pause: Arc::new(AtomicBool::new(false)),
        abort: AtomicBool::new(false),
        subscribers,
    });
    R.with(|r| {
        *r.borrow_mut() = Some(RState {
            helpers,
            use_na,
            installed: false,
            awaiting_capture: false,
            hidden_steps: 0,
            current: None,
            captured: None,
            stopped: false,
            resumed: false,
            had_stop: false,
            last_user_resume: None,
            pending_hit: None,
            pending_step: false,
            pending_exception: None,
            warnings_pending: false,
            inspecting: false,
            step_next_segment: false,
            step_probe_armed: false,
            plans: HashMap::new(),
            hook_installed: false,
            jit_off: false,
            jmc_steps: 0,
            masked: String::new(),
            fn_bound: String::new(),
            instrumented: false,
        })
    });
    // The probe hook and Ark's annotate hook can be bound now; the global
    // condition handlers wait for the first top-level prompt.
    if call_helper("install_hook_only", &[]).as_deref() == Some("ok") {
        with_r(|r| r.hook_installed = true);
    }
    // A breakpoint mirror sent while R was still starting was answered
    // `not-ready`; the extension sends it again on this.
    push_control(json!({"event": "ready"}));
    Ok(())
}

fn r_version_at_least(major: u32, minor: u32) -> bool {
    let code = c"as.character(getRversion())";
    let mut out: Sexp = std::ptr::null_mut();
    // SAFETY: R thread, R idle; the shim guards jumps.
    if unsafe { libr::raven_eval(code.as_ptr(), std::ptr::null_mut(), &mut out) } != 0 {
        return true;
    }
    // SAFETY: preserved result, released right after.
    let v = unsafe { libr::strings(out) };
    unsafe { libr::raven_release(out) };
    let mut it = v
        .first()
        .map(|s| {
            s.split('.')
                .filter_map(|p| p.parse::<u32>().ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
        .into_iter();
    let (ma, mi) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
    (ma, mi) >= (major, minor)
}

thread_local! {
    /// Helper calls in progress on the R thread (see [`on_repl_prompt`]).
    static HELPER_DEPTH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Call an R helper with string arguments; its result as one string.
fn call_helper(name: &str, args: &[&str]) -> Option<String> {
    let fun = with_r(|r| r.helpers.get(name).copied()).flatten()?;
    HELPER_DEPTH.with(|d| d.set(d.get() + 1));
    let out = call_helper_inner(fun, args);
    HELPER_DEPTH.with(|d| d.set(d.get() - 1));
    out
}

fn call_helper_inner(fun: Sexp, args: &[&str]) -> Option<String> {
    let owned: Vec<CString> = args
        .iter()
        .map(|a| CString::new(a.replace('\0', "")).unwrap_or_default())
        .collect();
    let ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
    let mut out: Sexp = std::ptr::null_mut();
    // SAFETY: R thread, R idle; the shim guards jumps and passes each
    // argument as a length-1 character vector.
    if unsafe { libr::raven_call(fun, ptrs.len() as c_int, ptrs.as_ptr(), &mut out) } != 0 {
        return None;
    }
    // SAFETY: preserved result; released right after.
    let s = unsafe { libr::strings(out) }.into_iter().next();
    unsafe { libr::raven_release(out) };
    s
}

// ---- DAP requests (reader thread; never touches R) ------------------------

fn outbox() -> Option<&'static server::Outbox> {
    handle().and_then(|h| h.out.as_ref())
}

fn on_close(shared: &Arc<Mutex<Shared>>) {
    let mut s = shared.lock().unwrap_or_else(|e| e.into_inner());
    s.connected = false;
    s.configured = false;
}

/// The key breakpoints and stops are matched on: the real path. On Windows
/// that is the on-disk spelling (so `c:\a.R` from VS Code and `C:/A.R` from R
/// agree) without the `\\?\` prefix `canonicalize` adds, which neither R nor
/// VS Code uses.
fn canonical(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| strip_verbatim(p.to_string_lossy().into_owned()))
        .unwrap_or_else(|_| path.to_string())
}

/// `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\x` → `\\srv\x`; anything else as is.
fn strip_verbatim(p: String) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\")
        && rest.as_bytes().get(1) == Some(&b':')
    {
        rest.to_string()
    } else {
        p
    }
}

fn capabilities() -> Value {
    json!({
        "supportsConfigurationDoneRequest": true,
        "supportsFunctionBreakpoints": true,
        "supportsConditionalBreakpoints": true,
        "supportsHitConditionalBreakpoints": true,
        "supportsLogPoints": true,
        "supportsEvaluateForHovers": true,
        "supportsSetVariable": true,
        "supportsCompletionsRequest": true,
        "supportsExceptionInfoRequest": true,
        "supportsBreakpointLocationsRequest": true,
        "supportsTerminateRequest": true,
        "supportTerminateDebuggee": true,
        "supportsDelayedStackTraceLoading": true,
        "supportsClipboardContext": true,
        "exceptionBreakpointFilters": [
            {"filter": "error", "label": "Uncaught errors", "default": true,
             "description": "Stop where an error is signalled in code from a file, if no tryCatch()/try() handles it. Errors in code typed at the prompt don't stop."},
            {"filter": "warning", "label": "Warnings (not muffled)", "default": false,
             "description": "Stop where a warning is signalled in code from a file, unless a local handler muffles it."},
            {"filter": "interrupt", "label": "Interrupts", "default": false,
             "description": "Stop where R is interrupted (Ctrl-C) instead of returning to the prompt."}
        ]
    })
}

fn on_message(shared: &Arc<Mutex<Shared>>, msg: Value) {
    if msg.get("type").and_then(Value::as_str) != Some("request") {
        return;
    }
    let Some(out) = outbox() else { return };
    let cmd = msg.get("command").and_then(Value::as_str).unwrap_or("");
    let args = msg.get("arguments").cloned().unwrap_or(Value::Null);
    match cmd {
        "initialize" => {
            {
                let mut s = lock_shared(shared);
                s.connected = true;
                s.ended = false;
                s.configured = false;
                s.runs_program = false;
                s.program_done = false;
            }
            out.respond(&msg, capabilities());
            out.event("initialized", json!({}));
        }
        "attach" | "launch" => {
            let mut s = lock_shared(shared);
            s.all_code = args["justMyCode"] == json!(false);
            s.runs_program = cmd == "launch" && args["program"].is_string();
            drop(s);
            out.respond(&msg, json!({}));
        }
        "configurationDone" => {
            let stop = {
                let mut s = lock_shared(shared);
                s.configured = true;
                s.program_done = false;
                s.stop.clone()
            };
            out.respond(&msg, json!({}));
            // A session that attached while R is stopped gets the stop
            // replayed (§2.1).
            if let Some(stop) = stop {
                send_stopped(out, &stop);
            }
        }
        "setBreakpoints" => {
            let path = args["source"]["path"].as_str().unwrap_or("").to_string();
            let wanted: Vec<(u32, String, String, String)> = args["breakpoints"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|b| {
                            (
                                b["line"].as_u64().unwrap_or(0) as u32,
                                b["condition"].as_str().unwrap_or("").to_string(),
                                b["hitCondition"].as_str().unwrap_or("").to_string(),
                                b["logMessage"].as_str().unwrap_or("").to_string(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let result = set_file_breakpoints(&path, wanted, breakpoint_ticket());
            out.respond(&msg, json!({"breakpoints": result}));
        }
        "setFunctionBreakpoints" => {
            let names: Vec<String> = args["breakpoints"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|b| b["name"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let mut s = lock_shared(shared);
            s.functions_ticket = breakpoint_ticket();
            s.jobs
                .push_back(Job::FunctionBreakpoints(Some(msg.clone()), names));
        }
        "setExceptionBreakpoints" => {
            let filters: Vec<String> = args["filters"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|f| f.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            {
                let mut s = lock_shared(shared);
                s.filters_ticket = breakpoint_ticket();
                s.filters = filters;
            }
            out.respond(&msg, json!({}));
        }
        "threads" => out.respond(&msg, json!({"threads": [{"id": 1, "name": "R console"}]})),
        "stackTrace" => {
            let stop = lock_shared(shared).stop.clone();
            let Some(stop) = stop else {
                out.respond(&msg, json!({"stackFrames": [], "totalFrames": 0}));
                return;
            };
            let start = args["startFrame"].as_u64().unwrap_or(0) as usize;
            let levels = args["levels"].as_u64().unwrap_or(0) as usize;
            let total = stop.frames.len();
            let end = if levels == 0 {
                total
            } else {
                (start + levels).min(total)
            };
            let frames: Vec<Value> = stop.frames[start.min(total)..end]
                .iter()
                .map(frame_to_dap)
                .collect();
            out.respond(&msg, json!({"stackFrames": frames, "totalFrames": total}));
        }
        "scopes" => queue_job(Job::Scopes(msg)),
        "variables" => queue_job(Job::Variables(msg)),
        "evaluate" => queue_job(Job::Evaluate(msg)),
        "setVariable" => queue_job(Job::SetVariable(msg)),
        "completions" => queue_job(Job::Completions(msg)),
        "exceptionInfo" => {
            let stop = lock_shared(shared).stop.clone();
            match stop.and_then(|s| s.exception) {
                Some((class, message, call)) => out.respond(
                    &msg,
                    json!({
                        "exceptionId": class,
                        "description": message,
                        "breakMode": "unhandled",
                        "details": {"message": message, "typeName": class, "stackTrace": call},
                    }),
                ),
                None => out.fail(&msg, "no exception"),
            }
        }
        "continue" | "next" | "stepIn" | "stepOut" => {
            let cmd_letter = match cmd {
                "continue" => "c",
                "next" => "n",
                "stepIn" => "s",
                _ => STEP_OUT,
            };
            // Respond first: the resume's `continued` (and any next
            // `stopped`) must follow the response.
            if cmd == "continue" {
                out.respond(&msg, json!({"allThreadsContinued": true}));
            } else {
                out.respond(&msg, json!({}));
            }
            request_resume(cmd_letter);
        }
        "pause" => {
            request_pause();
            out.respond(&msg, json!({}));
        }
        "disconnect" => {
            // After our own `terminated` this is VS Code's teardown. Else a
            // user detach: R goes on (as other debuggers' attach sessions
            // do), or quits the browser when asked to end the debuggee.
            let ended = std::mem::replace(&mut lock_shared(shared).ended, true);
            let terminate = args["terminateDebuggee"].as_bool().unwrap_or(false);
            out.respond(&msg, json!({}));
            if !ended {
                let stopped = lock_shared(shared).stop.is_some();
                match (terminate, stopped) {
                    (true, true) => request_resume("Q"),
                    (true, false) => request_abort(),
                    (false, _) => request_resume("c"),
                }
            }
        }
        "terminate" => {
            let stopped = {
                let mut s = lock_shared(shared);
                s.ended = true;
                s.stop.is_some()
            };
            out.respond(&msg, json!({}));
            out.event("terminated", json!({}));
            // Stopped: quit the browser. Running: interrupt, as Stop ends a
            // running Python or Node program.
            if stopped {
                request_resume("Q");
            } else {
                request_abort();
            }
        }
        "breakpointLocations" => {
            let path = args["source"]["path"].as_str().unwrap_or("");
            let line = args["line"].as_u64().unwrap_or(1) as u32;
            let end = args["endLine"].as_u64().map(|e| e as u32).unwrap_or(line);
            let lines = statement_lines(path, line, end);
            let locs: Vec<Value> = lines.into_iter().map(|l| json!({"line": l})).collect();
            out.respond(&msg, json!({"breakpoints": locs}));
        }
        "source" => {
            let r = args["sourceReference"]
                .as_i64()
                .or_else(|| args["source"]["sourceReference"].as_i64())
                .unwrap_or(0);
            match lock_shared(shared).sources.get(&r).cloned() {
                Some(text) => out.respond(&msg, json!({"content": text, "mimeType": "text/x-r"})),
                None => out.fail(&msg, "source not available"),
            }
        }
        _ => out.fail(&msg, &format!("unsupported request: {cmd}")),
    }
}

fn lock_shared(shared: &Arc<Mutex<Shared>>) -> std::sync::MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|e| e.into_inner())
}

fn queue_job(job: Job) {
    if let Some(h) = handle() {
        lock(h).jobs.push_back(job);
    }
}

/// The UI's Step Out, distinct from an `f` meant as R's own (exception and
/// pause stops rewrite Step Over to `f`, to let the condition unwind).
const STEP_OUT: &str = "out";

/// Feed `cmd` to R's browser at the next opportunity (the editor's break
/// flag interrupts the line being edited).
fn request_resume(cmd: &str) {
    let Some(h) = handle() else { return };
    {
        let mut s = lock(h);
        if s.stop.is_none() {
            return;
        }
        let cmd = if cmd == "n" && s.rewrite_next {
            "f"
        } else {
            cmd
        };
        s.resume = Some(cmd.to_string());
    }
    h.break_flag.store(true, Ordering::Relaxed);
}

fn request_abort() {
    let Some(h) = handle() else { return };
    super::with_r_wait(|wait| match wait {
        super::RWait::Evaluating => {
            h.abort.store(true, Ordering::SeqCst);
            super::sys::interrupt_r();
        }
        // A `readline()` the program is waiting on: break the read and
        // interrupt the code that asked, as Ctrl-C there does. If the answer
        // is already on its way, `read_new_input` takes the abort instead.
        super::RWait::UserInput => {
            h.abort.store(true, Ordering::SeqCst);
            INPUT_ABORT.store(true, Ordering::SeqCst);
        }
        super::RWait::IdleTopLevel | super::RWait::OtherPrompt => {}
    });
}

/// Set by Stop while R waits for user input; breaks the `readline()` editor
/// (its break signal) or the cooked fallback read ([`take_input_abort`]).
static INPUT_ABORT: std::sync::LazyLock<Arc<AtomicBool>> =
    std::sync::LazyLock::new(|| Arc::new(AtomicBool::new(false)));

pub fn input_abort_signal() -> Arc<AtomicBool> {
    INPUT_ABORT.clone()
}

pub fn take_input_abort() -> bool {
    INPUT_ABORT.swap(false, Ordering::SeqCst)
}

fn request_pause() {
    let Some(h) = handle() else { return };
    if super::r_wait() == super::RWait::Evaluating {
        h.pause.store(true, Ordering::SeqCst);
        // Interrupt R exactly as a Ctrl-C would; the global interrupt
        // handler sees the pause flag and opens the browser instead (§7).
        super::sys::interrupt_r();
    }
}

fn frame_to_dap(f: &Frame) -> Value {
    let mut v = json!({
        "id": f.r_index + 1,
        "name": f.name,
        "line": f.line.max(1),
        "column": f.col.max(1),
    });
    if let Some(r) = f.source_ref {
        v["source"] = json!({
            "name": format!("{} (deparsed)", f.name),
            "sourceReference": r,
            "presentationHint": "deemphasize",
        });
        v["line"] = json!(1);
        v["column"] = json!(1);
        v["presentationHint"] = json!("subtle");
    } else if !f.path.is_empty() && !f.path.starts_with('<') {
        let name = Path::new(&f.path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        v["source"] = json!({"path": f.path, "name": name});
        if f.end_line > 0 {
            v["endLine"] = json!(f.end_line);
            v["endColumn"] = json!(f.end_col + 1);
        }
    } else {
        v["presentationHint"] = json!("subtle");
        v["line"] = json!(0);
        v["column"] = json!(0);
    }
    v
}

fn send_stopped(out: &server::Outbox, stop: &Stop) {
    let mut body = json!({
        "reason": stop.reason,
        "threadId": 1,
        "allThreadsStopped": true,
        "description": stop.description,
    });
    if !stop.hit_ids.is_empty() {
        body["hitBreakpointIds"] = json!(stop.hit_ids);
    }
    if let Some((_, msg, _)) = &stop.exception {
        body["text"] = json!(msg);
    }
    out.event("stopped", body);
}

/// Lines in `[from, to]` of `path` where a breakpoint can bind (a
/// statement starts there).
fn statement_lines(path: &str, from: u32, to: u32) -> Vec<u32> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let text = annotate::r_code_of(path, &text);
    let reqs: Vec<BpRequest> = (from..=to)
        .map(|l| BpRequest {
            id: l.to_string(),
            line: l,
        })
        .collect();
    let plan = annotate::plan(&text, 1, &reqs);
    let mut out: Vec<u32> = plan
        .placements
        .iter()
        .filter_map(|p| match p {
            Placement::Inject { line, .. } => Some(*line),
            _ => None,
        })
        .filter(|l| *l >= from && *l <= to)
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// The order in which breakpoint requests arrived, taken once per request
/// as soon as it is read (a mirror naming several files uses one ticket for
/// all of them). [`set_file_breakpoints`] reads the file before it applies,
/// and that read can block for as long as the filesystem does, so requests
/// can finish out of order.
pub fn breakpoint_ticket() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::SeqCst)
}

/// Replace the breakpoints for `path` (from DAP `setBreakpoints`, or the
/// extension's mirror over IPC). Breakpoints that already existed at the
/// same line keep their id, state and hit count.
///
/// `ticket` is the request's [`breakpoint_ticket`]. A request older than
/// the last one applied to this file changes nothing: it was stuck reading
/// while a newer one (say, the editor deleting the breakpoints after a
/// reattach) was applied, and applying it now would undo that. Deleting
/// doesn't read the file's text, which it has no use for.
pub fn set_file_breakpoints(
    path: &str,
    wanted: Vec<(u32, String, String, String)>,
    ticket: u64,
) -> Vec<Value> {
    let Some(h) = handle() else { return Vec::new() };
    let key = canonical(path);
    let text = if wanted.is_empty() {
        None
    } else {
        std::fs::read_to_string(&key)
            .ok()
            .map(|t| annotate::r_code_of(&key, &t).into_owned())
    };
    let plan = text.as_deref().map(|t| {
        let reqs: Vec<BpRequest> = wanted
            .iter()
            .map(|(l, ..)| BpRequest {
                id: l.to_string(),
                line: *l,
            })
            .collect();
        annotate::plan(t, 1, &reqs)
    });
    let mut s = lock(h);
    if s.file_tickets.get(&key).is_some_and(|t| *t > ticket) {
        let current = s
            .files
            .get(&key)
            .map(|bps| bps.iter().map(|b| b.to_dap(&key)).collect())
            .unwrap_or_default();
        drop(s);
        // The mirror's sender waits for a summary after every request.
        push_breakpoint_summary();
        return current;
    }
    s.file_tickets.insert(key.clone(), ticket);
    let old = s.files.remove(&key).unwrap_or_default();
    let mut new = Vec::new();
    for (line, condition, hit_condition, log_message) in wanted {
        let placement = plan.as_ref().and_then(|p| {
            p.placements.iter().find(|pl| match pl {
                Placement::Inject { id, .. } | Placement::Invalid { id, .. } => {
                    *id == line.to_string()
                }
            })
        });
        let (anchor, invalid) = match placement {
            Some(Placement::Inject { line: a, .. }) => (Some(*a), None),
            Some(Placement::Invalid { reason, .. }) => (None, Some(reason.clone())),
            None => (None, None),
        };
        let current_text = anchor.and_then(|a| {
            text.as_deref()
                .and_then(|t| t.lines().nth((a - 1) as usize))
                .map(str::to_string)
        });
        let prev = old.iter().find(|b| b.line == line);
        let id = prev.map(|b| b.id).unwrap_or_else(|| {
            let id = s.next_id;
            s.next_id += 1;
            id
        });
        let mut bp = LineBp {
            id,
            line,
            condition,
            hit_condition,
            log_message,
            verified: false,
            reason: None,
            anchor,
            hits: prev.map(|b| b.hits).unwrap_or(0),
            bound_text: prev.and_then(|b| b.bound_text.clone()),
        };
        if let Some(reason) = invalid {
            bp.reason = Some(reason);
        } else if let Some(prev) = prev
            && prev.verified
        {
            if prev.bound_text.is_some() && prev.bound_text == current_text {
                bp.verified = true;
            } else {
                bp.reason = Some("not run since edit".into());
                bp.bound_text = None;
            }
        } else {
            bp.reason = Some(prev.and_then(|b| b.reason.clone()).unwrap_or_else(|| {
                "not run in this session yet: binds when this code runs".into()
            }));
        }
        new.push(bp);
    }
    let result = new.iter().map(|b| b.to_dap(&key)).collect();
    s.hooks_dirty = true;
    if new.is_empty() {
        s.files.remove(&key);
    } else {
        s.files.insert(key, new);
    }
    drop(s);
    push_breakpoint_summary();
    result
}

/// Function breakpoints and exception filters mirrored by the extension
/// while no session exists. `ticket` is the request's
/// [`breakpoint_ticket`]: like a file's breakpoints, each is left alone when
/// a newer request (a later mirror, or a session's own
/// `setFunctionBreakpoints` / `setExceptionBreakpoints`) has set it since.
/// The check and the queueing share one lock, so the R thread applies
/// function breakpoints in ticket order.
pub fn set_mirrored(functions: Option<Vec<String>>, filters: Option<Vec<String>>, ticket: u64) {
    let Some(h) = handle() else { return };
    let mut s = lock(h);
    if let Some(f) = filters
        && s.filters_ticket < ticket
    {
        s.filters_ticket = ticket;
        s.filters = f;
    }
    if let Some(names) = functions
        && s.functions_ticket < ticket
    {
        s.functions_ticket = ticket;
        s.jobs.push_back(Job::FunctionBreakpoints(None, names));
    }
}

/// Every line breakpoint's state, pushed to the extension's control
/// connection so it can summarize them while no session exists (§5.5).
fn push_breakpoint_summary() {
    let Some(h) = handle() else { return };
    let items: Vec<Value> = {
        let s = lock(h);
        s.files
            .iter()
            .flat_map(|(path, bps)| bps.iter().map(move |b| b.to_dap(path)))
            .collect()
    };
    push_control(json!({"event": "breakpoints", "breakpoints": items}));
}

fn notify_breakpoints(changed: Vec<(String, LineBp)>) {
    if !changed.is_empty() {
        push_breakpoint_summary();
    }
    let Some(out) = outbox() else { return };
    for (path, bp) in changed {
        out.event(
            "breakpoint",
            json!({"reason": "changed", "breakpoint": bp.to_dap(&path)}),
        );
    }
}

/// Push an event to every `subscribe`d control connection. The writes
/// happen on a thread of their own: an extension host that stops reading
/// must never block the R thread.
fn push_control(event: Value) {
    static TX: OnceLock<Mutex<mpsc::Sender<String>>> = OnceLock::new();
    let Some(h) = handle() else { return };
    let tx = TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<String>();
        let subscribers = h.subscribers.clone();
        let _ = std::thread::Builder::new()
            .name("raven-dap-control".into())
            .spawn(move || {
                for line in rx {
                    let mut subs = subscribers.lock().unwrap_or_else(|e| e.into_inner());
                    subs.retain_mut(|s| {
                        use std::io::Write;
                        s.write_all(line.as_bytes()).is_ok()
                    });
                }
            });
        Mutex::new(tx)
    });
    let _ = tx
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .send(format!("{event}\n"));
}

// ---- RPC from R (R thread, inside R's evaluation; never calls R) -----------

/// Entry point for `.Call(raven_dbg_rpc, op, a, b)`.
unsafe extern "C" fn rpc(op: *const c_char, a: *const c_char, b: *const c_char) -> *const c_char {
    let s = |p: *const c_char| {
        if p.is_null() {
            String::new()
        } else {
            // SAFETY: the C side passes NUL-terminated strings owned by R.
            unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
        }
    };
    let (op, a, b) = (s(op), s(a), s(b));
    let out = std::panic::catch_unwind(|| rpc_impl(&op, &a, &b)).unwrap_or_default();
    RPC_OUT.with(|o| {
        *o.borrow_mut() = CString::new(out.replace('\0', "")).unwrap_or_default();
        o.borrow().as_ptr()
    })
}

fn rpc_impl(op: &str, a: &str, b: &str) -> String {
    let Some(h) = handle() else {
        return String::new();
    };
    match op {
        "bp" => {
            if a == STEP_PROBE {
                return format!("{US}{US}");
            }
            let Ok(id) = a.parse::<u64>() else {
                return String::new();
            };
            let mut s = lock(h);
            match s.bp_by_id(id) {
                Some((_, bp)) => format!(
                    "{}{US}{}{US}{}",
                    bp.condition, bp.hit_condition, bp.log_message
                ),
                None => String::new(),
            }
        }
        "hit" => {
            let Ok(id) = a.parse::<u64>() else {
                return "1".into();
            };
            let mut s = lock(h);
            match s.bp_by_id(id) {
                Some((_, bp)) => {
                    bp.hits += 1;
                    bp.hits.to_string()
                }
                None => "1".into(),
            }
        }
        "stop" => {
            if a == STEP_PROBE {
                with_r(|r| r.pending_step = true);
                return "stop".into();
            }
            let id = a.parse::<u64>().ok();
            let stepping = with_r(|r| {
                matches!(r.last_user_resume.as_deref(), Some("n" | "s" | "f")) && r.resumed
            })
            .unwrap_or(false);
            if b == "1" && stepping {
                // R's own step stops at the next statement of this frame
                // anyway (§4): count the hit, but don't open a second browser.
                with_r(|r| r.pending_hit = id);
                return "suppress".into();
            }
            with_r(|r| r.pending_hit = id);
            "stop".into()
        }
        "log" => {
            let text = format!("{b}\n");
            match outbox().filter(|_| lock(h).connected) {
                Some(out) => out.event("output", json!({"category": "console", "output": text})),
                None => super::output::get().write(text.as_bytes(), 1),
            }
            String::new()
        }
        "captured" => {
            with_r(|r| r.captured = Some((a.to_string(), b.to_string())));
            String::new()
        }
        "exception" => {
            with_r(|r| r.pending_exception = Some((a.to_string(), b.to_string())));
            String::new()
        }
        "take_pause" => {
            if h.abort.swap(false, Ordering::SeqCst) {
                h.pause.store(false, Ordering::SeqCst);
                "abort".into()
            } else if h.pause.swap(false, Ordering::SeqCst) {
                "1".into()
            } else {
                String::new()
            }
        }
        "last_error" => {
            HAS_LAST_ERROR.store(a == "1", Ordering::SeqCst);
            String::new()
        }
        "inspecting" => {
            with_r(|r| r.inspecting = a == "1");
            String::new()
        }
        "warnings_pending" => {
            with_r(|r| r.warnings_pending = true);
            String::new()
        }
        "at_browser" => {
            if with_r(|r| r.stopped && !r.resumed).unwrap_or(false) {
                "1".into()
            } else {
                String::new()
            }
        }
        // At a browser prompt (stopped, not resumed) the condition comes from
        // what the user typed there; R is already stopped, so don't nest.
        "filters" if with_r(|r| r.stopped && !r.resumed).unwrap_or(false) => String::new(),
        "filters" => lock(h).filters.join(","),
        "plan_file" => plan_file(a, b),
        "has_bps" => {
            if bp_requests(&canonical(a)).is_empty() {
                "0".into()
            } else {
                "1".into()
            }
        }
        "render_file" => render_file(a, b),
        "unsupported_source" => {
            let key = canonical(a);
            let mut changed = Vec::new();
            {
                let mut s = lock(h);
                if let Some(bps) = s.files.get_mut(&key) {
                    for bp in bps.iter_mut().filter(|b| !b.verified) {
                        bp.reason = Some("sourced via an unsupported source() form".into());
                        changed.push((key.clone(), bp.clone()));
                    }
                }
            }
            notify_breakpoints(changed);
            String::new()
        }
        _ => String::new(),
    }
}

fn bp_requests(path: &str) -> Vec<BpRequest> {
    let Some(h) = handle() else { return Vec::new() };
    let s = lock(h);
    s.files
        .get(path)
        .map(|v| {
            v.iter()
                .map(|b| BpRequest {
                    id: b.id.to_string(),
                    line: b.line,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn callee_spec(plan: &annotate::Plan) -> String {
    plan.callees()
        .into_iter()
        .map(|c| format!("{}::{}", c.pkg, c.name))
        .collect::<Vec<_>>()
        .join(US)
}

/// `plan_file`: "-" when the file has no breakpoints, else the callees R
/// must confirm (possibly empty).
fn plan_file(path: &str, text: &str) -> String {
    let key = canonical(path);
    let reqs = bp_requests(&key);
    if reqs.is_empty() || !annotate::line_directive_safe(&key) {
        return "-".into();
    }
    let plan = annotate::plan(text, 1, &reqs);
    let spec = callee_spec(&plan);
    with_r(|r| r.plans.insert(key, (text.to_string(), plan)));
    spec
}

/// `render_file`: the file's text with the planned probes whose callees R
/// confirmed; "" when nothing is injected.
fn render_file(path: &str, verified: &str) -> String {
    let key = canonical(path);
    let Some((text, plan)) = with_r(|r| r.plans.remove(&key)).flatten() else {
        return String::new();
    };
    let ok: Vec<&str> = verified.split(US).filter(|s| !s.is_empty()).collect();
    let (inj, any) = apply_plan(&key, &text, 1, &plan, &ok);
    if !any {
        return String::new();
    }
    annotate::render(&text, &key, 1, 0, &inj, std::process::id(), Wrap::File)
}

/// Turn a plan into injections, recording each breakpoint's new state.
/// Returns the injections and whether there are any.
fn apply_plan(
    path: &str,
    text: &str,
    first_line: u32,
    plan: &annotate::Plan,
    verified_callees: &[&str],
) -> (Vec<annotate::Injection>, bool) {
    let Some(h) = handle() else {
        return (Vec::new(), false);
    };
    let lines: Vec<&str> = text.lines().collect();
    let mut inj = Vec::new();
    let mut changed = Vec::new();
    {
        let mut s = lock(h);
        for p in &plan.placements {
            match p {
                Placement::Inject {
                    id,
                    byte,
                    line,
                    callees,
                    brace_end,
                } => {
                    let unconfirmed = callees.iter().find(|c| {
                        !verified_callees.contains(&format!("{}::{}", c.pkg, c.name).as_str())
                    });
                    let Ok(num) = id.parse::<u64>() else {
                        if id == STEP_PROBE {
                            inj.push(annotate::Injection {
                                byte: *byte,
                                id: id.clone(),
                                brace_end: *brace_end,
                            });
                        }
                        continue;
                    };
                    let Some((_, bp)) = s.bp_by_id(num) else {
                        continue;
                    };
                    if let Some(c) = unconfirmed {
                        bp.verified = false;
                        bp.reason = Some(format!(
                            "`{}` is masked or not loaded: Raven can't verify this runs as code",
                            c.name
                        ));
                    } else {
                        bp.verified = true;
                        bp.reason = None;
                        bp.anchor = Some(*line);
                        bp.bound_text = lines
                            .get((line - first_line) as usize)
                            .map(|l| l.to_string());
                        inj.push(annotate::Injection {
                            byte: *byte,
                            id: id.clone(),
                            brace_end: *brace_end,
                        });
                    }
                    changed.push((path.to_string(), bp.clone()));
                }
                Placement::Invalid { id, reason } => {
                    if let Ok(num) = id.parse::<u64>()
                        && let Some((_, bp)) = s.bp_by_id(num)
                    {
                        bp.verified = false;
                        bp.reason = Some(reason.clone());
                        changed.push((path.to_string(), bp.clone()));
                    }
                }
            }
        }
    }
    notify_breakpoints(changed);
    let any = !inj.is_empty();
    if any {
        with_r(|r| r.instrumented = true);
    }
    (inj, any)
}

// ---- tagged submissions (R thread) -----------------------------------------

/// Split a tagged submission into top-level expressions with R's parser.
/// `None` when R can't parse it or the path can't appear in `#line`; the
/// console then feeds the code raw, as it always has.
pub fn split_submission(code: &str, loc: &Location) -> Option<VecDeque<Segment>> {
    if !active() || !annotate::line_directive_safe(&loc.path) {
        return None;
    }
    let json = call_helper("split_exprs", &[code])?;
    let ranges: Vec<Vec<u32>> = serde_json::from_str(&json).ok()?;
    let lines: Vec<&str> = code.split('\n').collect();
    let path = canonical(&loc.path);
    let mut out = VecDeque::new();
    let mut echoed_through = 0u32;
    for r in ranges {
        let [l1, c1, l2, c2] = r[..] else {
            return None;
        };
        if l1 == 0 || l2 < l1 || l2 as usize > lines.len() {
            return None;
        }
        // R's columns are display columns (a tab advances to the next
        // multiple of 8); map them back to character indexes of the lines.
        let from = display_col_to_char(lines[(l1 - 1) as usize], c1)?;
        let to = display_col_to_char(lines[(l2 - 1) as usize], c2)? + 1;
        let mut text = String::new();
        for l in l1..=l2 {
            let chars: Vec<char> = lines[(l - 1) as usize].chars().collect();
            let a = if l == l1 { from } else { 0 };
            let b = if l == l2 { to } else { chars.len() };
            if a > b {
                return None;
            }
            text.extend(&chars[a..b]);
            if l != l2 {
                text.push('\n');
            }
        }
        let echo = if l2 > echoed_through {
            let first = echoed_through + 1;
            echoed_through = l2;
            (first..=l2)
                .map(|l| lines[(l - 1) as usize].to_string())
                .collect()
        } else {
            Vec::new()
        };
        let (line, first_col) = match &loc.lines {
            Some(map) => {
                // An expression must lie on consecutive file lines for `#line`
                // to map it; one that doesn't is fed with the first line's
                // mapping (its srcrefs are approximate, never wrong-file).
                (*map.get((l1 - 1) as usize)?, 0)
            }
            None => (loc.line + l1 - 1, if l1 == 1 { loc.col } else { 0 }),
        };
        out.push_back(Segment {
            text,
            path: path.clone(),
            line,
            col: first_col + from as u32,
            echo,
        });
    }
    if out.is_empty() { None } else { Some(out) }
}

/// The 0-based character index in `line` of the character R's parser puts
/// at 1-based display column `col` (srcref elements 5 and 6). R counts one
/// column per character, except that a tab advances to the next multiple
/// of 8 (R's byte columns are no help: they drift on non-ASCII text inside
/// string literals). `None` when no character sits at that column.
fn display_col_to_char(line: &str, col: u32) -> Option<usize> {
    let mut at = 0u32;
    for (i, ch) in line.chars().enumerate() {
        at = if ch == '\t' { (at + 8) & !7 } else { at + 1 };
        if at == col {
            return Some(i);
        }
        if at > col {
            return None;
        }
    }
    None
}

/// The text to feed for `seg`: wrapped in `{ #line … }` with probes for its
/// breakpoints whose callees R confirms now (§3, §5.3).
pub fn render_segment(seg: &Segment) -> String {
    let mut reqs = bp_requests(&seg.path);
    let step = with_r(|r| std::mem::take(&mut r.step_probe_armed)).unwrap_or(false);
    if step {
        reqs.push(BpRequest {
            id: STEP_PROBE.into(),
            line: seg.line,
        });
    }
    let plan = annotate::plan(&seg.text, seg.line, &reqs);
    let spec = callee_spec(&plan);
    let verified = if spec.is_empty() {
        String::new()
    } else {
        call_helper("verify_callees", &[&spec]).unwrap_or_default()
    };
    let ok: Vec<&str> = verified.split(US).filter(|s| !s.is_empty()).collect();
    let (inj, _) = apply_plan(&seg.path, &seg.text, seg.line, &plan, &ok);
    annotate::render(
        &seg.text,
        &seg.path,
        seg.line,
        seg.col as usize,
        &inj,
        std::process::id(),
        Wrap::Braced,
    )
}

/// Called at a top-level prompt with no lines pending: arms the one-shot
/// step probe if the user was stepping when the previous expression
/// finished and `continuing` (another segment of the same submission is
/// about to run, §4). Otherwise the carried-over step is dropped, so it
/// never reaches a later, unrelated send.
pub fn on_next_segment(continuing: bool) {
    with_r(|r| {
        if std::mem::take(&mut r.step_next_segment) && continuing {
            r.step_probe_armed = true;
        }
    });
}

// ---- prompts (R thread) ----------------------------------------------------

fn read_current_srcref(use_na: bool) -> Option<(String, [u32; 4])> {
    let mut lines = [0 as c_int; 4];
    let mut file = vec![0 as c_char; 4096];
    // SAFETY: R thread at a prompt; buffers are valid for their lengths.
    let ok = unsafe {
        raven_dbg_current_srcref(
            c_int::from(use_na),
            lines.as_mut_ptr(),
            file.as_mut_ptr(),
            file.len() as c_int,
        )
    };
    if ok == 0 {
        return None;
    }
    // SAFETY: NUL-terminated by the C side.
    let f = unsafe { CStr::from_ptr(file.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    Some((f, lines.map(|v| v.max(0) as u32)))
}

/// Called for every REPL prompt (top level or browser) before the console
/// feeds anything. Returns hidden input to give R instead of reading.
pub fn on_repl_prompt(level: u32, more: bool) -> Option<String> {
    if !active() {
        return None;
    }
    // A Debug Console or Watch expression reached a `browser()` (or a
    // debug()ged function): the debugger is already stopped, so it can't
    // stop again inside its own request. Continue, and say so.
    if HELPER_DEPTH.with(|d| d.get()) > 0 {
        if level > 0 {
            if let Some(out) = outbox() {
                out.event(
                    "output",
                    json!({"category": "important", "output": "raven debugger: skipped a browser() reached while evaluating an expression\n"}),
                );
            }
            return Some("c\n".into());
        }
        return None;
    }
    if with_r(|r| std::mem::take(&mut r.jit_off)).unwrap_or(false) && level > 0 {
        let _ = call_helper("at_prompt", &["FALSE"]);
    }
    print_warning_locations(level == 0);
    if level == 0 {
        return on_top_level(more);
    }
    let awaiting = with_r(|r| std::mem::take(&mut r.awaiting_capture))?;
    if awaiting {
        return on_captured();
    }
    let use_na = with_r(|r| r.use_na)?;
    let cur = read_current_srcref(use_na);
    let marker = cur.as_ref().is_some_and(|(f, _)| f == annotate::PROBE_FILE);
    if marker {
        let step = with_r(|r| {
            if r.hidden_steps < MAX_HIDDEN_STEPS {
                r.hidden_steps += 1;
                true
            } else {
                false
            }
        })?;
        if step {
            release_held(Release::Announced { called_from: false });
            return Some("n\n".into());
        }
    }
    with_r(|r| {
        r.hidden_steps = 0;
        r.current = cur;
        r.awaiting_capture = true;
    });
    Some(CAPTURE.into())
}

/// DAP id of the `i`th function breakpoint (the list is replaced as a whole
/// by every `setFunctionBreakpoints`, so position is a stable identity).
fn fn_bp_id(i: usize) -> u64 {
    FN_BP_ID_BASE + i as u64
}

const FN_BP_ID_BASE: u64 = 1 << 40;

/// A function breakpoint whose name came to (or stopped) resolving since the
/// last prompt, for example because the function was defined after the
/// breakpoint was set, is re-reported to the client.
fn report_function_breakpoints(bound: &str) {
    let prev =
        with_r(|r| std::mem::replace(&mut r.fn_bound, bound.to_string())).unwrap_or_default();
    if prev == bound || prev.len() != bound.len() {
        return;
    }
    let Some(out) = outbox() else { return };
    for (i, (a, b)) in prev.bytes().zip(bound.bytes()).enumerate() {
        if a != b {
            out.event(
                "breakpoint",
                json!({"reason": "changed", "breakpoint": {"id": fn_bp_id(i), "verified": b == b'1'}}),
            );
        }
    }
}

/// The session ends (`terminated`, so VS Code leaves debug mode) when R is
/// back at the top-level prompt with nothing more of the submission to run,
/// if it stopped, or it was launched to run a program that has now run. While
/// more of the same submission is pending the session stays: the next
/// expression may stop again (stepping across expressions, several
/// breakpoints in one Run All Chunks), and ending in between would race the
/// next stop against VS Code's teardown.
fn end_session_at_prompt(more: bool) {
    let Some(h) = handle() else { return };
    let end = {
        let mut s = lock(h);
        let ran = s.runs_program && s.program_done;
        if more || !(s.session_open || ran) {
            return;
        }
        s.session_open = false;
        s.program_done = false;
        for bps in s.files.values_mut() {
            for bp in bps.iter_mut() {
                bp.hits = 0;
            }
        }
        let live = s.connected && !s.ended;
        s.ended = true;
        live
    };
    if end && let Some(out) = outbox() {
        out.event(
            "continued",
            json!({"threadId": 1, "allThreadsContinued": true}),
        );
        out.event("terminated", json!({}));
    }
    push_control(json!({"event": "running"}));
}

/// A debug session's `program` request has finished.
pub fn on_program_finished() {
    if let Some(h) = handle() {
        lock(h).program_done = true;
    }
}

/// R reset the console (an uncaught error or an interrupt) since the last
/// top-level prompt: one of the conditions for printing a traceback.
static RESET_SINCE_PROMPT: AtomicBool = AtomicBool::new(false);

/// Called from the console's `ResetConsole` callback.
pub fn note_reset() {
    RESET_SINCE_PROMPT.store(true, Ordering::SeqCst);
}

/// After R printed its warnings: where each came from, if R recorded any
/// warning since the last top-level prompt (see `take_warnings`).
fn print_warning_locations(top: bool) {
    if !with_r(|r| r.warnings_pending).unwrap_or(false) {
        return;
    }
    let json = call_helper("take_warnings", &[if top { "TRUE" } else { "FALSE" }]);
    let Some(json) = json.filter(|j| !j.is_empty()) else {
        return;
    };
    with_r(|r| r.warnings_pending = false);
    let lines: Vec<String> = serde_json::from_str(&json).unwrap_or_default();
    if lines.is_empty() {
        return;
    }
    let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
    super::output::get().write(format!("\x1b[2m{text}\x1b[0m").as_bytes(), 1);
}

/// Most traceback lines printed; the rest are counted.
const TRACEBACK_LINES: usize = 8;

/// The last printed error kept its frames: Inspect Last Error has
/// something to open. Read by the socket thread.
static HAS_LAST_ERROR: AtomicBool = AtomicBool::new(false);
/// The editor asked to inspect the last error; taken at the next idle
/// top-level prompt.
static INSPECT_REQUESTED: AtomicBool = AtomicBool::new(false);

/// The socket thread's answer to an `inspect` request: `ok` (R opens the
/// last error at its prompt), or why not (`none`, `busy`, `stopped`).
pub fn request_inspect() -> &'static str {
    let Some(h) = handle() else { return "none" };
    if !HAS_LAST_ERROR.load(Ordering::SeqCst) {
        return "none";
    }
    if lock(h).stop.is_some() {
        return "stopped";
    }
    // Picked up only at R's top-level prompt (not a `+` continuation, a
    // `readline()`, or a browser).
    if super::r_wait() != super::RWait::IdleTopLevel {
        return "busy";
    }
    INSPECT_REQUESTED.store(true, Ordering::SeqCst);
    h.break_flag.store(true, Ordering::Relaxed);
    "ok"
}

/// Hidden input that opens the last error, if one was requested.
pub fn take_inspect() -> Option<String> {
    INSPECT_REQUESTED
        .swap(false, Ordering::SeqCst)
        .then(|| ".raven_dbg_inspect()\n".to_string())
}

/// Print the traceback `at_prompt` returned (`{"lines": [...], "inspect":
/// bool}`, each line `call at /abs/file.R:12`, innermost first), dim, after
/// R's error message. VS Code's terminal links the `path:line` itself. The
/// Inspect hint is shown only when an editor is connected to run it.
fn print_traceback(json: &str) {
    let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    let lines: Vec<String> = v["lines"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| l.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if lines.is_empty() {
        return;
    }
    let editor = handle().is_some_and(|h| {
        !h.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    });
    let mut text = String::from("Traceback:\n");
    for l in lines.iter().take(TRACEBACK_LINES) {
        text.push_str(&format!("  {l}\n"));
    }
    if lines.len() > TRACEBACK_LINES {
        text.push_str(&format!("  … {} more\n", lines.len() - TRACEBACK_LINES));
    }
    if editor && v["inspect"] == true {
        text.push_str("Inspect it: run Raven: Inspect Last Error\n");
    }
    super::output::get().write(format!("\x1b[2m{text}\x1b[0m").as_bytes(), 1);
}

fn on_top_level(more: bool) -> Option<String> {
    release_held(Release::All);
    // A pause or Stop that arrived as R finished on its own must not change
    // what a later Ctrl-C does.
    if let Some(h) = handle() {
        h.pause.store(false, Ordering::SeqCst);
        h.abort.store(false, Ordering::SeqCst);
    }
    INPUT_ABORT.store(false, Ordering::SeqCst);
    let reset = if RESET_SINCE_PROMPT.swap(false, Ordering::SeqCst) {
        "TRUE"
    } else {
        "FALSE"
    };
    let reply = call_helper("at_prompt", &["TRUE", reset]).unwrap_or_default();
    let mut fields = reply.splitn(3, '\x1e');
    let masked = fields.next().unwrap_or("").to_string();
    let bound = fields.next().unwrap_or("").to_string();
    print_traceback(fields.next().unwrap_or("{}"));
    report_function_breakpoints(&bound);
    let changed = with_r(|r| {
        r.jit_off = false;
        if r.masked != masked {
            r.masked = masked.clone();
            r.instrumented
        } else {
            false
        }
    })
    .unwrap_or(false);
    if changed && !masked.is_empty() {
        let names: Vec<String> = masked.split(US).map(|n| format!("`{n}`")).collect();
        let note = format!(
            "raven debugger: {} rebound; code instrumented for breakpoints earlier may expose its probes until re-run\n",
            names.join(", ")
        );
        super::output::get().write(format!("\x1b[2m{}\x1b[0m", note).as_bytes(), 1);
        if let Some(out) = outbox() {
            out.event("output", json!({"category": "important", "output": note}));
        }
    }
    let (had_stop, installed) = with_r(|r| (std::mem::take(&mut r.had_stop), r.installed))?;
    if had_stop {
        // SAFETY: R thread at a prompt.
        unsafe { raven_dbg_clear_global_rdebug() };
        with_r(|r| {
            // A step that finished a top-level expression stops at the
            // start of the next expression of the same submission (§4).
            r.step_next_segment =
                matches!(r.last_user_resume.as_deref(), Some("n" | "s" | "f")) && r.resumed;
            r.stopped = false;
            r.resumed = false;
            r.last_user_resume = None;
            r.pending_hit = None;
            r.pending_exception = None;
        });
        if let Some(h) = handle() {
            let mut s = lock(h);
            s.stop = None;
            s.resume = None;
            s.rewrite_next = false;
            s.session_open = true;
        }
    }
    end_session_at_prompt(more);
    if !installed {
        with_r(|r| r.installed = true);
        return Some(INSTALL.into());
    }
    None
}

/// The capture call has run: classify the stop. Returns hidden input when
/// the stop isn't shown (stepping back out of code with no srcref).
fn on_captured() -> Option<String> {
    let h = handle()?;
    let (captured, cur, stopped, resumed) =
        with_r(|r| (r.captured.take(), r.current.clone(), r.stopped, r.resumed))?;
    let (frames_json, flags) = captured.unwrap_or_else(|| ("[]".into(), String::new()));
    let fbp = flags.split(',').any(|f| f == "fbp");
    let top_nosrc = flags.split(',').any(|f| f == "nosrc");
    // "Just my code" (§4): a step-in that lands in a function with no
    // srcref (base R, an installed package) steps back out, unseen.
    let all_code = lock(h).all_code;
    let jmc = with_r(|r| {
        let step_in = !all_code && r.resumed && r.last_user_resume.as_deref() == Some("s");
        if step_in && top_nosrc && r.jmc_steps < MAX_JMC_STEPS {
            r.jmc_steps += 1;
            true
        } else {
            r.jmc_steps = 0;
            false
        }
    })
    .unwrap_or(false);
    if jmc {
        release_held(Release::Announced { called_from: false });
        return Some("f\n".into());
    }
    // Step Into first stops on the function's whole body, at its opening
    // brace; step once more, unseen, so it lands on the first statement as
    // in other debuggers.
    let entry = flags
        .split(',')
        .find_map(|f| f.strip_prefix("entry:"))
        .and_then(|l| l.parse::<u32>().ok());
    let on_body =
        entry.is_some_and(|e| cur.as_ref().is_some_and(|(_, l)| l[0] == e && l[2] > l[0]));
    let stepped_in =
        with_r(|r| r.resumed && r.last_user_resume.as_deref() == Some("s")).unwrap_or(false);
    if on_body && stepped_in && !fbp {
        release_held(Release::Announced { called_from: false });
        return Some("n\n".into());
    }
    let mut sources: Vec<(i64, String)> = Vec::new();
    let mut frames: Vec<Frame> = serde_json::from_str::<Vec<Value>>(&frames_json)
        .unwrap_or_default()
        .iter()
        .map(|f| {
            let loc = f["loc"].as_array().cloned().unwrap_or_default();
            let num = |i: usize| loc.get(i).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let source_ref = f["fsrc"].as_str().map(|text| {
                let id = 1000 + sources.len() as i64;
                sources.push((id, text.to_string()));
                id
            });
            Frame {
                source_ref,
                r_index: f["id"].as_i64().unwrap_or(0),
                name: f["name"].as_str().unwrap_or("?").to_string(),
                path: loc
                    .first()
                    .and_then(|v| v.as_str())
                    .map(canonical)
                    .unwrap_or_default(),
                line: num(1),
                col: num(2),
                end_line: num(3),
                end_col: num(4),
            }
        })
        .collect();
    if let (Some(top), Some((file, l))) = (frames.first_mut(), cur.as_ref())
        && top.source_ref.is_none()
        && (l[0] > 0 || top.line == 0)
    {
        top.path = if file.is_empty() || file.starts_with('<') {
            file.clone()
        } else {
            canonical(file)
        };
        top.line = l[0];
        top.col = l[1];
        top.end_line = l[2];
        top.end_col = l[3];
    }
    // A prompt with no step or continue since the last stop is R coming back
    // after the user evaluated something at Browse>: same stop, refreshed
    // variables (§6).
    if stopped && !resumed {
        let same = lock(h)
            .stop
            .as_ref()
            .is_some_and(|s| frames_equal(&s.frames, &frames));
        if same {
            // R announced nothing before this prompt: what is held is
            // what the user's own expression printed.
            release_held(Release::All);
            if let Some(out) = outbox() {
                out.event(
                    "invalidated",
                    json!({"areas": ["variables"], "threadId": 1}),
                );
            }
            return None;
        }
    }
    let (hit, exception, last, step_probe) = with_r(|r| {
        (
            r.pending_hit.take(),
            r.pending_exception.take(),
            r.last_user_resume.clone(),
            std::mem::take(&mut r.pending_step),
        )
    })
    .unwrap_or((None, None, None, false));
    // A `Called from:` R printed for the debugger's own browser() (a probe,
    // or the frame browser of an exception or pause stop) is noise; one for
    // the user's browser() is kept, as R shows it.
    let own_browser = hit.is_some() || step_probe || exception.is_some();
    let (reason, description, exc) = if let Some((kind, detail)) = exception {
        let mut parts = detail.split(US);
        let class = parts.next().unwrap_or("condition").to_string();
        let message = parts.next().unwrap_or("").to_string();
        let call = parts.next().unwrap_or("").to_string();
        if kind == "pause" {
            ("pause".to_string(), "Paused".to_string(), None)
        } else {
            (
                "exception".to_string(),
                format!("{class}: {message}"),
                Some((class, message, call)),
            )
        }
    } else if hit.is_some() {
        ("breakpoint".to_string(), "Breakpoint".to_string(), None)
    } else if step_probe {
        ("step".to_string(), "Step".to_string(), None)
    } else if fbp && !resumed {
        (
            "function breakpoint".to_string(),
            "Function breakpoint".to_string(),
            None,
        )
    } else if resumed && matches!(last.as_deref(), Some("n" | "s" | "f")) {
        ("step".to_string(), "Step".to_string(), None)
    } else {
        ("breakpoint".to_string(), "browser()".to_string(), None)
    };
    let hit_ids: Vec<u64> = hit.into_iter().collect();
    let rewrite = reason == "exception" || reason == "pause";
    let stop = Stop {
        reason,
        description,
        hit_ids,
        frames,
        exception: exc,
    };
    let configured = {
        let mut s = lock(h);
        s.sources = sources.into_iter().collect();
        s.stop = Some(stop.clone());
        s.rewrite_next = rewrite;
        s.resume = None;
        s.configured
    };
    with_r(|r| {
        r.stopped = true;
        r.resumed = false;
        r.had_stop = true;
    });
    release_held(Release::Announced {
        called_from: !own_browser,
    });
    let _ = call_helper("on_stop", &[]);
    if configured && let Some(out) = outbox() {
        send_stopped(out, &stop);
    }
    push_control(json!({"event": "stopped", "reason": stop.reason}));
    None
}

fn frames_equal(a: &[Frame], b: &[Frame]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x.r_index == y.r_index && x.name == y.name && x.line == y.line)
}

/// A resume command for the editor to return as input, if the debugger
/// asked for one (checked when the break flag interrupts the editor).
pub fn take_resume() -> Option<String> {
    let h = handle()?;
    let mut cmd = lock(h).resume.take()?;
    // Inspecting the last error, there is nothing to step through.
    if with_r(|r| r.inspecting).unwrap_or(false) {
        cmd = "c".into();
    }
    // Step Out is R's `c` once the caller is flagged to stop (`on_resume`
    // for "f"): R's own `f` would mark a loop as finishing, where R takes
    // no steps, so a breakpoint later in the loop couldn't stop.
    if cmd == STEP_OUT {
        note_resume("f");
        return Some("c".into());
    }
    note_resume(&cmd);
    Some(cmd)
}

fn note_resume(cmd: &str) {
    if call_helper("on_resume", &[cmd]).as_deref() == Some("ok") && cmd == "s" {
        with_r(|r| r.jit_off = true);
    }
    with_r(|r| {
        r.resumed = true;
        r.last_user_resume = Some(cmd.to_string());
        r.pending_hit = None;
    });
    // Running again: nothing to show until the next stop.
    if let Some(h) = handle() {
        lock(h).stop = None;
    }
    if let Some(out) = outbox() {
        out.event(
            "continued",
            json!({"threadId": 1, "allThreadsContinued": true}),
        );
    }
}

/// The user typed `text` at a browser prompt in the terminal: browser
/// commands count as resumes, exactly as if clicked in the UI (§2.1).
/// While inspecting the last error a step is a Continue, so a typed `n`,
/// `s` or `f` comes back as `c` for R to read.
pub fn on_user_line(text: &str) -> Option<String> {
    if !active() {
        return None;
    }
    let t = text.trim();
    let inspecting = with_r(|r| r.inspecting).unwrap_or(false);
    let replaced = (inspecting && matches!(t, "n" | "s" | "f")).then(|| "c".to_string());
    let t = replaced.as_deref().unwrap_or(t);
    if matches!(t, "n" | "s" | "f" | "c" | "cont" | "Q") {
        let cmd = if t == "cont" { "c" } else { t };
        if let Some(h) = handle() {
            lock(h).resume = None;
        }
        note_resume(cmd);
    }
    replaced
}

/// Run queued R work (scopes, variables, evaluate, …). Called on the R
/// thread at prompts only.
pub fn service() {
    let Some(h) = handle() else { return };
    loop {
        let job = lock(h).jobs.pop_front();
        let Some(job) = job else { break };
        run_job(h, job);
    }
    if std::mem::take(&mut lock(h).hooks_dirty) {
        sync_source_hook(h);
    }
}

pub fn has_work() -> bool {
    handle().is_some_and(|h| {
        let s = lock(h);
        !s.jobs.is_empty() || s.resume.is_some() || s.hooks_dirty
    })
}

fn r_frame(frame_id: &Value) -> String {
    (frame_id.as_i64().unwrap_or(1) - 1).max(0).to_string()
}

fn run_job(h: &Handle, job: Job) {
    let Some(out) = h.out.as_ref() else {
        if let Job::FunctionBreakpoints(_, names) = job {
            {
                let mut s = lock(h);
                s.fn_names = names.clone();
                s.hooks_dirty = true;
            }
            let _ = call_helper("function_breakpoints", &[&names.join(US)]);
        }
        return;
    };
    match job {
        Job::Scopes(req) => {
            let frame = r_frame(&req["arguments"]["frameId"]);
            let json = call_helper("scopes", &[&frame]).unwrap_or_else(|| "[]".into());
            let scopes: Value = serde_json::from_str(&json).unwrap_or(json!([]));
            out.respond(&req, json!({"scopes": scopes}));
        }
        Job::Variables(req) => {
            let a = &req["arguments"];
            let r = a["variablesReference"].as_u64().unwrap_or(0).to_string();
            let start = a["start"].as_u64().unwrap_or(0).to_string();
            let count = a["count"].as_u64().unwrap_or(0).to_string();
            let filter = a["filter"].as_str().unwrap_or("").to_string();
            let json = call_helper("variables", &[&r, &start, &count, &filter])
                .unwrap_or_else(|| "[]".into());
            let vars: Value = serde_json::from_str(&json).unwrap_or(json!([]));
            out.respond(&req, json!({"variables": vars}));
        }
        Job::Evaluate(req) => {
            let a = &req["arguments"];
            let expr = a["expression"].as_str().unwrap_or("");
            let frame = if a["frameId"].is_null() {
                "0".to_string()
            } else {
                r_frame(&a["frameId"])
            };
            let context = a["context"].as_str().unwrap_or("repl");
            let json = if context == "hover" {
                call_helper("hover", &[expr, &frame])
            } else {
                let timeout = if context == "watch" { "2" } else { "0" };
                call_helper("evaluate", &[expr, &frame, context, timeout])
            }
            .unwrap_or_else(|| "{\"error\":\"evaluation failed\"}".into());
            let v: Value =
                serde_json::from_str(&json).unwrap_or(json!({"error": "evaluation failed"}));
            if let Some(e) = v.get("error").and_then(Value::as_str) {
                out.fail(&req, e);
            } else {
                out.respond(&req, v);
            }
        }
        Job::Completions(req) => {
            let a = &req["arguments"];
            let (head, column) = completion_head(
                a["text"].as_str().unwrap_or(""),
                a["line"].as_u64(),
                a["column"].as_u64().unwrap_or(1),
            );
            let frame = if a["frameId"].is_null() {
                "0".to_string()
            } else {
                r_frame(&a["frameId"])
            };
            let json = call_helper("completions", &[&head, &frame]).unwrap_or_default();
            let v: Value = serde_json::from_str(&json).unwrap_or(json!({}));
            let token = v["token"].as_str().unwrap_or("");
            let len = token.encode_utf16().count() as u64;
            let cands: Vec<String> = v["items"]
                .as_array()
                .map(|l| {
                    l.iter()
                        .filter_map(|c| c.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let targets: Vec<Value> = super::editor::rank(token, &cands)
                .into_iter()
                .map(|c| json!({"label": c, "start": column.saturating_sub(len), "length": len}))
                .collect();
            out.respond(&req, json!({"targets": targets}));
        }
        Job::SetVariable(req) => {
            let a = &req["arguments"];
            let r = a["variablesReference"].as_u64().unwrap_or(0).to_string();
            let name = a["name"].as_str().unwrap_or("");
            let value = a["value"].as_str().unwrap_or("");
            let json = call_helper("set_variable", &[&r, name, value, "0"])
                .unwrap_or_else(|| "{\"error\":\"failed\"}".into());
            let v: Value = serde_json::from_str(&json).unwrap_or(json!({"error": "failed"}));
            if let Some(e) = v.get("error").and_then(Value::as_str) {
                out.fail(&req, e);
            } else {
                out.respond(&req, v);
            }
        }
        Job::FunctionBreakpoints(req, names) => {
            {
                let mut s = lock(h);
                s.fn_names = names.clone();
                s.hooks_dirty = true;
            }
            let json = call_helper("function_breakpoints", &[&names.join(US)])
                .unwrap_or_else(|| "[]".into());
            let mut bps: Value = serde_json::from_str(&json).unwrap_or(json!([]));
            let mut bound = String::new();
            if let Some(list) = bps.as_array_mut() {
                for (i, bp) in list.iter_mut().enumerate() {
                    bp["id"] = json!(fn_bp_id(i));
                    bound.push(if bp["verified"] == json!(true) {
                        '1'
                    } else {
                        '0'
                    });
                }
            }
            with_r(|r| r.fn_bound = bound);
            if let Some(req) = req {
                out.respond(&req, json!({"breakpoints": bps}));
            }
        }
    }
}

/// The line a `completions` request completes, up to the cursor, and the
/// cursor's 1-based column (DAP columns count UTF-16 units; VS Code sends
/// 1-based lines and columns).
fn completion_head(text: &str, line: Option<u64>, column: u64) -> (String, u64) {
    let row = line.unwrap_or(1).max(1) as usize - 1;
    let l = text.split('\n').nth(row).unwrap_or("");
    let mut units = 0u64;
    let mut head = String::new();
    for ch in l.chars() {
        if units + ch.len_utf16() as u64 > column.saturating_sub(1) {
            break;
        }
        units += ch.len_utf16() as u64;
        head.push(ch);
    }
    (head, units + 1)
}

/// Keep the `source()` hook installed while line or function breakpoints
/// exist (a sourced file may define a function a breakpoint names).
fn sync_source_hook(h: &Handle) {
    let want = {
        let s = lock(h);
        !s.files.is_empty() || !s.fn_names.is_empty()
    };
    let _ = call_helper("set_source_hook", &[if want { "TRUE" } else { "FALSE" }]);
}

// ---- output filtering (R thread) -------------------------------------------

/// R's announcements the debugger hides: its own steps through a probe.
const DROP: &[&str] = &[
    "debug at <raven-probe>#",
    "debug: base::`if`(base::identical(",
];
/// R's announcement of a `browser()` call: hidden for the debugger's own.
const HOLD: &str = "Called from: ";
/// How R starts any step announcement, a user line's included.
const STEP: &[&str] = &["debug at ", "debug: "];
/// Most text held back. An announcement of the debugger's own is far
/// shorter; past this the text is written out as it is.
const HELD_MAX: usize = 64 * 1024;

/// What the prompt that ends a hold says about the held text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Release {
    /// R announced nothing before this prompt: all of it is the user's.
    All,
    /// A browser prompt R announced: the last announcement held is R's,
    /// and is shown unless it is a probe step, or a `Called from:` when
    /// `called_from` is false. Text before it is the user's.
    Announced { called_from: bool },
}

/// The state of [`filter_output`]. R prints an announcement just before it
/// reads at a `Browse>` prompt, and only then; the program can print the
/// same words at any time. So text that starts like one the debugger hides
/// is held, with everything after it, until the next read shows which it
/// was ([`Release`]).
///
/// This is process-global, not R-thread state, so that text still held
/// when R exits can be written by the exit handler
/// ([`take_held_at_exit`]). It is locked only to move text, never across
/// an R call or a write.
#[derive(Debug, Default)]
struct OutputFilter {
    /// Held text, starting at a line that looks like a hidden announcement.
    held: String,
    /// Offset in `held` of the last write that starts like an announcement.
    last: usize,
    /// The start of a line that may still become one.
    line_buf: String,
    holding: bool,
}

static FILTER: Mutex<OutputFilter> = Mutex::new(OutputFilter {
    held: String::new(),
    last: 0,
    line_buf: String::new(),
    holding: false,
});

impl OutputFilter {
    /// Take `text` R wrote; returns what to write now.
    fn push(&mut self, text: &str) -> String {
        let mut out = String::new();
        for piece in text.split_inclusive('\n') {
            if self.holding {
                if STEP.iter().any(|p| piece.starts_with(p)) || piece.starts_with(HOLD) {
                    self.last = self.held.len();
                }
                self.held.push_str(piece);
                if self.held.len() > HELD_MAX {
                    out.push_str(&std::mem::take(&mut self.held));
                    self.holding = false;
                }
                continue;
            }
            self.line_buf.push_str(piece);
            let hidden = || DROP.iter().copied().chain(std::iter::once(HOLD));
            if hidden().any(|p| self.line_buf.starts_with(p)) {
                self.held = std::mem::take(&mut self.line_buf);
                self.last = 0;
                self.holding = true;
            } else if !hidden().any(|p| p.starts_with(self.line_buf.as_str())) {
                out.push_str(&self.line_buf);
                self.line_buf.clear();
            }
        }
        out
    }

    /// A read ends the hold; returns the held text to write.
    fn release(&mut self, how: Release) -> String {
        let mut out = std::mem::take(&mut self.held);
        if self.holding
            && let Release::Announced { called_from } = how
        {
            let tail = out.split_off(self.last.min(out.len()));
            let show = if DROP.iter().any(|p| tail.starts_with(p)) {
                false
            } else if tail.starts_with(HOLD) {
                called_from
            } else {
                true
            };
            if show {
                out.push_str(&tail);
            }
        }
        self.holding = false;
        // A partial line is never R's: it writes an announcement whole.
        out.push_str(&std::mem::take(&mut self.line_buf));
        out
    }
}

fn filter() -> std::sync::MutexGuard<'static, OutputFilter> {
    FILTER.lock().unwrap_or_else(|e| e.into_inner())
}

/// Filter R's stdout so the debugger's own steps stay invisible: a probe's
/// `debug at` announcement and the `Called from:` of the debugger's own
/// `browser()` are held until the next read shows whether they were R's
/// (see `OutputFilter`), and written out before that only past `HELD_MAX`.
pub fn filter_output(text: &str) -> String {
    if !active() {
        return text.to_string();
    }
    filter().push(text)
}

/// At a prompt: write what the hold kept that isn't the debugger's.
fn release_held(how: Release) {
    let text = filter().release(how);
    if !text.is_empty() {
        super::output::get().write(text.as_bytes(), 0);
    }
}

/// R asks for input that isn't a REPL prompt (`readline()`, `menu()`,
/// `scan()`). R announces nothing before such a read, so anything held is
/// the program's own output, and the user must see it before answering.
pub fn on_input_prompt() {
    if active() {
        release_held(Release::All);
    }
}

/// Text still held when the process exits (`q()` runs no further prompt),
/// for the exit handler to write. Never blocks: the handler may run while
/// a write is in progress.
pub fn take_held_at_exit() -> String {
    FILTER
        .try_lock()
        .map(|mut f| f.release(Release::All))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefixes_are_stripped() {
        assert_eq!(strip_verbatim(r"\\?\C:\w\a.R".into()), r"C:\w\a.R");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\s\a.R".into()), r"\\srv\s\a.R");
        assert_eq!(strip_verbatim("/w/a.R".into()), "/w/a.R");
    }

    /// Columns as R 4.x's parser reports them (srcref elements 5 and 6) for
    /// these lines.
    #[test]
    fn display_columns_map_to_characters_across_tabs_and_non_ascii() {
        // `\tlongname <- 42`: R gives first col 9, last col 22.
        let l = "\tlongname <- 42";
        assert_eq!(display_col_to_char(l, 9), Some(1));
        assert_eq!(display_col_to_char(l, 22), Some(14));
        // A tab mid-line advances to the next multiple of 8.
        let l = "\"\t\u{e9}\" -> q; w";
        assert_eq!(display_col_to_char(l, 15), Some(8));
        assert_eq!(display_col_to_char(l, 18), Some(11));
        // Two tabs, then text.
        assert_eq!(display_col_to_char("\t\ty", 17), Some(2));
        // One column per character, multibyte or not.
        assert_eq!(display_col_to_char("\u{65e5}\u{672c} <- 1; x", 10), Some(9));
        // No character there: inside a tab's span, or past the end.
        assert_eq!(display_col_to_char("\tx", 4), None);
        assert_eq!(display_col_to_char("x", 2), None);
    }

    #[test]
    fn held_output_is_bounded_and_written_in_order() {
        let mut f = OutputFilter::default();
        assert_eq!(f.push("plain\n"), "plain\n");
        assert_eq!(f.push("debug at <raven-probe>#1\n"), "");
        let line = "x".repeat(1023) + "\n";
        let mut out = String::new();
        for _ in 0..200 {
            out.push_str(&f.push(&line));
            assert!(f.held.len() <= HELD_MAX, "{}", f.held.len());
        }
        out.push_str(&f.release(Release::All));
        assert_eq!(
            out,
            format!("debug at <raven-probe>#1\n{}", line.repeat(200))
        );
        // Past the bound the filter starts over: a later announcement of
        // the debugger's own is still hidden.
        assert_eq!(f.push("debug at <raven-probe>#2: base::`if`(...)\n"), "");
        assert_eq!(f.release(Release::Announced { called_from: false }), "");
    }

    #[test]
    fn only_the_announcement_before_a_browser_prompt_is_hidden() {
        let hide = Release::Announced { called_from: false };
        let mut f = OutputFilter::default();
        // The program's lookalike, then the debugger's own browser().
        f.push("debug at <raven-probe>#1\nmine\n");
        f.push("Called from: g()\n");
        assert_eq!(f.release(hide), "debug at <raven-probe>#1\nmine\n");
        // ... then its hidden step, announced over several lines.
        f.push("debug at <raven-probe>#1: base::`if`(a,\n    b)\n");
        assert_eq!(f.release(hide), "");
        // A `Called from:` for the user's own browser() is shown.
        f.push("Called from: g()\n");
        assert_eq!(
            f.release(Release::Announced { called_from: true }),
            "Called from: g()\n"
        );
        // A step onto a user's line is shown, with what came before it.
        f.push("Called from: here\nmine\n");
        f.push("debug at /a.R#3: y <- 2\n");
        assert_eq!(
            f.release(hide),
            "Called from: here\nmine\ndebug at /a.R#3: y <- 2\n"
        );
        // With no announcement from R, everything is the program's.
        f.push("debug at <raven-probe>#1\nmine\n");
        assert_eq!(f.release(Release::All), "debug at <raven-probe>#1\nmine\n");
        // A label that only starts like one is released as it is.
        assert_eq!(f.push("Called "), "");
        assert_eq!(f.release(hide), "Called ");
        assert_eq!(f.push("Called off\n"), "Called off\n");
    }

    #[test]
    fn frames_compare_by_identity_and_line() {
        let f = |i, l| Frame {
            r_index: i,
            name: "f".into(),
            line: l,
            ..Default::default()
        };
        assert!(frames_equal(&[f(1, 3)], &[f(1, 3)]));
        assert!(!frames_equal(&[f(1, 3)], &[f(1, 4)]));
    }
}
