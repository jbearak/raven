//! End-to-end tests for the R debugger served by `raven console --dap`
//! (design: docs/superpowers/specs/2026-10-29-r-debugger-design.md). Each
//! test drives a real console through a pseudo-terminal, sends code over the
//! IPC socket the way the VS Code extension does, and speaks the Debug
//! Adapter Protocol to the console's DAP socket. Skipped (passing vacuously)
//! when no R with a shared libR is installed; CI installs `r-base-core`.
#![cfg(unix)]

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const TIMEOUT: Duration = Duration::from_secs(30);

fn r_available() -> bool {
    let ok = Command::new("R")
        .arg("RHOME")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|h| {
            let lib = Path::new(h.trim()).join("lib");
            lib.join("libR.so").exists() || lib.join("libR.dylib").exists()
        })
        .unwrap_or(false);
    if !ok {
        eprintln!("skipping: no R with a shared libR on PATH");
    }
    ok
}

/// A short scratch directory (macOS caps Unix socket paths at 104 bytes).
fn scratch() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = PathBuf::from(format!(
        "/tmp/rvdbg-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Open a pseudo-terminal pair for a console.
///
/// macOS `openpty` fails when called from several threads of one process at
/// once (errno -6, a negated `ENXIO`), and now and then even when serialized,
/// while other processes allocate PTYs (issue #908). Calls are serialized
/// within this test process, and a failed call is retried until `TIMEOUT`. A
/// PTY that never comes still fails the test, with the error.
///
/// Both descriptors are close-on-exec, so no console inherits another
/// console's PTY, or its own master. A console holding its own master never
/// sees its terminal hang up, and outlives a test process that is killed.
/// The returned guard keeps other threads from opening a PTY or spawning a
/// console until the caller has spawned its own; hold it through
/// `Command::spawn`.
fn open_pty(ws: &libc::winsize) -> (MutexGuard<'static, ()>, File, OwnedFd) {
    static OPENPTY: Mutex<()> = Mutex::new(());
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let mut master: libc::c_int = 0;
        let mut slave: libc::c_int = 0;
        let serialized = OPENPTY.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: openpty fills two descriptors; the winsize pointer is
        // valid. The pointer constness of the last two parameters differs
        // between macOS and Linux, hence the casts.
        let rc = unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut::<libc::termios>() as _,
                ws as *const libc::winsize as _,
            )
        };
        let err = std::io::Error::last_os_error();
        if rc == 0 {
            for fd in [master, slave] {
                // SAFETY: a descriptor openpty just returned.
                let set = unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
                assert_eq!(set, 0, "FD_CLOEXEC: {}", std::io::Error::last_os_error());
            }
            // SAFETY: both descriptors were just returned by openpty and are
            // owned here.
            return unsafe {
                (
                    serialized,
                    File::from_raw_fd(master),
                    OwnedFd::from_raw_fd(slave),
                )
            };
        }
        drop(serialized);
        assert!(Instant::now() < deadline, "openpty failed: {err}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// How a test console is given `--dap`.
enum DapArg {
    Socket,
    Unbindable,
    Off,
}

struct Console {
    child: Child,
    master: Option<File>,
    out: Arc<Mutex<Vec<u8>>>,
    dir: PathBuf,
    /// Leave `dir` in place when the console is dropped (another console
    /// of the test uses it).
    keep_dir: bool,
}

impl Console {
    fn spawn() -> Console {
        Console::spawn_with_env(&[])
    }

    fn spawn_with_env(env: &[(&str, &str)]) -> Console {
        let c = Console::launch(
            env,
            DapArg::Socket,
            &["--no-save", "--no-restore", "--vanilla", "-q"],
        );
        let deadline = Instant::now() + TIMEOUT;
        while !(c.dir.join("i").exists() && c.dir.join("d").exists()) {
            assert!(
                Instant::now() < deadline,
                "console sockets never appeared:\n{}",
                c.text()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        // Let R finish starting (and the debugger install its handlers).
        std::thread::sleep(Duration::from_millis(800));
        c
    }

    /// Start a console and return once its IPC socket exists (R may still
    /// be starting).
    fn launch(env: &[(&str, &str)], dap: DapArg, r_args: &[&str]) -> Console {
        Console::launch_in(scratch(), env, dap, r_args)
    }

    /// As `launch`, with the sockets in `dir`.
    fn launch_in(dir: PathBuf, env: &[(&str, &str)], dap: DapArg, r_args: &[&str]) -> Console {
        let (spawning, master, slave) = open_pty(&libc::winsize {
            ws_row: 30,
            ws_col: 120,
            ws_xpixel: 0,
            ws_ypixel: 0,
        });
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_raven"));
        cmd.arg("console")
            .args(["--no-history", "--ipc"])
            .arg(dir.join("i"));
        match dap {
            DapArg::Socket => {
                cmd.arg("--dap").arg(dir.join("d"));
            }
            // A directory that doesn't exist: the debugger can't listen.
            DapArg::Unbindable => {
                cmd.arg("--dap").arg(dir.join("missing").join("d"));
            }
            DapArg::Off => {}
        }
        cmd.args(r_args)
            .env("TERM", "xterm-256color")
            .envs(env.iter().copied())
            .env_remove("RAVEN_CONSOLE_BOOTSTRAPPED")
            .stdin(Stdio::from(slave.try_clone().unwrap()))
            .stdout(Stdio::from(slave.try_clone().unwrap()))
            .stderr(Stdio::from(slave));
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                libc::ioctl(0, libc::TIOCSCTTY as _, 0);
                Ok(())
            });
        }
        let child = cmd.spawn().expect("spawn raven console");
        drop(spawning);
        let out = Arc::new(Mutex::new(Vec::new()));
        let mut reader = master.try_clone().unwrap();
        let mut answer = master.try_clone().unwrap();
        let sink = out.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                // Answer cursor-position queries the way a terminal would.
                for _ in buf[..n].windows(4).filter(|w| *w == b"\x1b[6n") {
                    let _ = answer.write_all(b"\x1b[1;1R");
                }
                sink.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
        let c = Console {
            child,
            master: Some(master),
            out,
            dir,
            keep_dir: false,
        };
        let deadline = Instant::now() + TIMEOUT;
        while !c.dir.join("i").exists() {
            assert!(
                Instant::now() < deadline,
                "console IPC socket never appeared:\n{}",
                c.text()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        c
    }

    fn text(&self) -> String {
        strip_ansi(&String::from_utf8_lossy(&self.out.lock().unwrap()))
    }

    fn expect(&self, needle: &str) {
        let deadline = Instant::now() + TIMEOUT;
        while !self.text().contains(needle) {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {needle:?}; console:\n{}",
                self.text()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Type without pressing Enter.
    fn type_keys(&mut self, s: &str) {
        self.master
            .as_mut()
            .unwrap()
            .write_all(s.as_bytes())
            .unwrap();
    }

    fn type_line(&mut self, s: &str) {
        let m = self.master.as_mut().unwrap();
        m.write_all(s.as_bytes()).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        m.write_all(b"\r").unwrap();
    }

    fn write_file(&self, name: &str, text: &str) -> String {
        let p = self.dir.join(name);
        std::fs::write(&p, text).unwrap();
        std::fs::canonicalize(&p)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    /// Send code over IPC, optionally with its location in `path`.
    fn send(&self, code: &str, path: Option<&str>) {
        self.send_tagged(code, path.map(|p| (p, 1)));
    }

    /// Send `code` as having come from `path` starting at `line`.
    fn send_at(&self, code: &str, path: &str, line: u32) {
        self.send_tagged(code, Some((path, line)));
    }

    fn send_tagged(&self, code: &str, at: Option<(&str, u32)>) {
        self.execute(json!({"v": 1, "id": 1, "op": "execute", "code": code}), at);
    }

    /// Send `code` as a debug session's `program` (what F5 does).
    fn send_program(&self, code: &str) {
        self.execute(
            json!({"v": 1, "id": 1, "op": "execute", "code": code, "debugProgram": true}),
            None,
        );
    }

    fn execute(&self, mut msg: Value, at: Option<(&str, u32)>) {
        if let Some((p, line)) = at {
            msg["location"] = json!({"path": p, "line": line, "col": 0});
        }
        let s = UnixStream::connect(self.dir.join("i")).expect("ipc connect");
        s.set_read_timeout(Some(TIMEOUT)).unwrap();
        let mut w = s.try_clone().unwrap();
        writeln!(w, "{msg}").unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        assert!(line.contains("queued"), "not queued: {line}");
    }
}

impl Console {
    /// Send a one-line IPC request and return its `status`.
    fn ipc_status(&self, op: &str) -> String {
        let s = UnixStream::connect(self.dir.join("i")).expect("ipc connect");
        s.set_read_timeout(Some(TIMEOUT)).unwrap();
        let mut w = s.try_clone().unwrap();
        writeln!(w, "{}", json!({"v": 1, "id": 1, "op": op})).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        v["status"].as_str().unwrap_or("").to_string()
    }
}

impl Drop for Console {
    fn drop(&mut self) {
        let _ = self.child.kill();
        drop(self.master.take());
        let _ = self.child.wait();
        if !self.keep_dir {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        if it.next() == Some('[') {
            while let Some(&n) = it.peek() {
                it.next();
                if n.is_ascii_alphabetic() || n == '~' {
                    break;
                }
            }
        }
    }
    out
}

/// A minimal DAP client.
struct Dap {
    w: UnixStream,
    msgs: Arc<Mutex<Vec<Value>>>,
    seq: i64,
    dir: PathBuf,
}

impl Dap {
    /// Connect and attach; the caller sets breakpoints, then sends
    /// `configurationDone`.
    fn connect(c: &Console) -> Dap {
        Dap::open(&c.dir, false)
    }

    fn open(dir: &Path, configure: bool) -> Dap {
        let s = UnixStream::connect(dir.join("d")).expect("dap connect");
        let msgs = Arc::new(Mutex::new(Vec::new()));
        let sink = msgs.clone();
        let r = s.try_clone().unwrap();
        std::thread::spawn(move || {
            let mut r = BufReader::new(r);
            loop {
                let mut len = 0usize;
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let line = line.trim_end();
                    if line.is_empty() {
                        break;
                    }
                    if let Some(v) = line.strip_prefix("Content-Length:") {
                        len = v.trim().parse().unwrap();
                    }
                }
                let mut buf = vec![0u8; len];
                if r.read_exact(&mut buf).is_err() {
                    return;
                }
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_slice(&buf).unwrap());
            }
        });
        let mut d = Dap {
            w: s,
            msgs,
            seq: 1,
            dir: dir.to_path_buf(),
        };
        d.req("initialize", json!({"adapterID": "raven-r"}));
        d.req("attach", json!({}));
        if configure {
            d.req("configurationDone", json!({}));
        }
        d
    }

    /// What VS Code does after `terminated`: disconnect, and start a new
    /// session (on the next stop; here, right away).
    fn session_ended(&mut self) {
        let _ = self.send("disconnect", json!({}));
        let next = Dap::open(&self.dir.clone(), true);
        *self = next;
    }

    fn mark(&self) -> usize {
        self.msgs.lock().unwrap().len()
    }

    fn send(&mut self, command: &str, args: Value) -> i64 {
        let seq = self.seq;
        self.seq += 1;
        let body = serde_json::to_vec(
            &json!({"seq": seq, "type": "request", "command": command, "arguments": args}),
        )
        .unwrap();
        write!(self.w, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        self.w.write_all(&body).unwrap();
        seq
    }

    fn req(&mut self, command: &str, args: Value) -> Value {
        let seq = self.send(command, args);
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(r) = self
                .msgs
                .lock()
                .unwrap()
                .iter()
                .find(|m| m["type"] == "response" && m["request_seq"].as_i64() == Some(seq))
            {
                return r.clone();
            }
            assert!(Instant::now() < deadline, "no response to {command}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn event(&self, name: &str, after: usize) -> Value {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(e) = self.msgs.lock().unwrap()[after..]
                .iter()
                .find(|m| m["type"] == "event" && m["event"] == name)
            {
                return e.clone();
            }
            assert!(Instant::now() < deadline, "no {name} event");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn count(&self, name: &str, after: usize) -> usize {
        self.msgs.lock().unwrap()[after..]
            .iter()
            .filter(|m| m["type"] == "event" && m["event"] == name)
            .count()
    }

    /// `(name, line)` of each frame.
    fn stack(&mut self) -> Vec<(String, i64)> {
        let r = self.req("stackTrace", json!({"threadId": 1}));
        r["body"]["stackFrames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f["name"].as_str().unwrap().to_string(),
                    f["line"].as_i64().unwrap(),
                )
            })
            .collect()
    }

    /// The top frame's locals, as `name -> preview`.
    fn locals(&mut self) -> std::collections::BTreeMap<String, String> {
        let st = self.req("stackTrace", json!({"threadId": 1}));
        let frame = st["body"]["stackFrames"][0]["id"].clone();
        let sc = self.req("scopes", json!({"frameId": frame}));
        let r = sc["body"]["scopes"][0]["variablesReference"].clone();
        let vs = self.req("variables", json!({"variablesReference": r}));
        vs["body"]["variables"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                (
                    v["name"].as_str().unwrap().to_string(),
                    v["value"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    fn step(&mut self, command: &str) -> Value {
        let m = self.mark();
        self.req(command, json!({"threadId": 1}));
        self.event("stopped", m)
    }
}

const F_R: &str = "f <- function(x) {\n  y <- x + 1\n  z <- y * 2\n  z\n}\n";

#[test]
fn breakpoint_in_sent_code_stops_with_stack_locals_and_evaluate() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let a = c.write_file("a.R", F_R);
    let mut d = Dap::connect(&c);
    let r = d.req(
        "setBreakpoints",
        json!({"source": {"path": a}, "breakpoints": [{"line": 3}]}),
    );
    assert_eq!(r["body"]["breakpoints"][0]["verified"], false);
    d.req("configurationDone", json!({}));
    let m = d.mark();
    c.send(F_R, Some(&a));
    let bp = d.event("breakpoint", m);
    assert_eq!(bp["body"]["breakpoint"]["verified"], true, "{bp}");
    let m = d.mark();
    c.send("f(1)", None);
    let stop = d.event("stopped", m);
    assert_eq!(stop["body"]["reason"], "breakpoint");
    assert_eq!(
        stop["body"]["hitBreakpointIds"][0],
        r["body"]["breakpoints"][0]["id"]
    );
    assert_eq!(d.stack()[0], ("f".to_string(), 3));
    let locals = d.locals();
    assert_eq!(locals.get("x").map(String::as_str), Some("1"));
    assert_eq!(locals.get("y").map(String::as_str), Some("2"));
    let ev = d.req(
        "evaluate",
        json!({"expression": "y * 10", "frameId": 2, "context": "repl"}),
    );
    assert!(
        ev["body"]["result"].as_str().unwrap().contains("20"),
        "{ev}"
    );
    let hv = d.req(
        "evaluate",
        json!({"expression": "x", "frameId": 2, "context": "hover"}),
    );
    assert_eq!(hv["body"]["result"], "1");
    let stop = d.step("next");
    assert_eq!(stop["body"]["reason"], "step");
    assert_eq!(d.stack()[0].1, 4);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("[1] 4");
    // The debugger's own steps never show in the terminal.
    assert!(!c.text().contains("raven-probe"), "{}", c.text());
    assert!(!c.text().contains("raven.debug_hook"), "{}", c.text());
}

#[test]
fn conditions_logpoints_top_level_stops_and_stepping_across_expressions() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let src = "g <- function(n) {\n  total <- 0\n  for (i in seq_len(n)) {\n    total <- total + i\n  }\n  total\n}\na <- 10\nb <- g(3)\ncat(\"done\", b, \"\\n\")\n";
    let b = c.write_file("b.R", src);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": b}, "breakpoints": [
            {"line": 4, "condition": "i == 2"},
            {"line": 6, "logMessage": "total is {total}"},
            {"line": 9}
        ]}),
    );
    d.req("configurationDone", json!({}));
    let m = d.mark();
    c.send(src, Some(&b));
    assert_eq!(d.event("stopped", m)["body"]["reason"], "breakpoint");
    assert_eq!(d.stack()[0], ("<top level>".to_string(), 9));
    // Next over g(3) still stops at the conditional breakpoint inside it.
    let stop = d.step("next");
    assert_eq!(stop["body"]["reason"], "breakpoint");
    assert_eq!(d.stack()[0], ("g".to_string(), 4));
    assert_eq!(d.locals().get("i").map(String::as_str), Some("2"));
    // Typing at Browse> refreshes variables without a new stop.
    let m = d.mark();
    c.type_line("total * 100");
    d.event("invalidated", m);
    c.expect("[1] 100");
    assert_eq!(d.count("stopped", m), 0);
    // Step out runs the logpoint, then stops at the next top-level
    // expression of the same send.
    let m = d.mark();
    d.req("stepOut", json!({"threadId": 1}));
    let out = d.event("output", m);
    assert_eq!(out["body"]["output"].as_str().unwrap().trim(), "total is 6");
    let stop = d.event("stopped", m);
    assert_eq!(stop["body"]["reason"], "step");
    assert_eq!(d.stack()[0], ("<top level>".to_string(), 10));
    let m = d.mark();
    d.req("next", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("done 6");
    // Stepping off the end left no step flag behind for the next input.
    let m = d.mark();
    c.send("zz <- 42; zz", None);
    c.expect("[1] 42");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(d.count("stopped", m), 0);
}

#[test]
fn stepping_onto_a_breakpoint_line_stops_once() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let a = c.write_file("a.R", F_R);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": a}, "breakpoints": [{"line": 2}, {"line": 3}]}),
    );
    d.req("configurationDone", json!({}));
    c.send(F_R, Some(&a));
    let m = d.mark();
    c.send("f(1)", None);
    d.event("stopped", m);
    assert_eq!(d.stack()[0].1, 2);
    let m = d.mark();
    d.req("next", json!({"threadId": 1}));
    d.event("stopped", m);
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(d.count("stopped", m), 1, "one stop for one step");
    assert_eq!(d.stack()[0].1, 3);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("[1] 4");
}

#[test]
fn breakpoints_where_code_may_be_data_are_refused_with_a_reason() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let src =
        "q <- quote({\n  x <- 1\n})\nfoo <- function(e) substitute(e)\nr <- foo({\n  y <- 2\n})\n";
    let p = c.write_file("q.R", src);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": [{"line": 2}, {"line": 6}]}),
    );
    d.req("configurationDone", json!({}));
    c.send(&format!("{src}print(q); print(r)"), Some(&p));
    c.expect("y <- 2");
    let text = c.text();
    assert!(!text.contains("raven"), "probe leaked into data:\n{text}");
    let r = d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": [{"line": 2}, {"line": 6}]}),
    );
    for bp in r["body"]["breakpoints"].as_array().unwrap() {
        assert_eq!(bp["verified"], false, "{bp}");
        assert!(
            bp["message"]
                .as_str()
                .unwrap()
                .contains("Raven can't verify"),
            "{bp}"
        );
    }
}

#[test]
fn exceptions_function_breakpoints_and_source() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let h = c.write_file(
        "h.R",
        "h <- function(x) {\n  y <- x * 2\n  stop(\"boom: \", y)\n}\n",
    );
    let sq = c.write_file("sq.R", "sq <- function(v) {\n  w <- v^2\n  w + 1\n}\n");
    let mut d = Dap::connect(&c);
    d.req("setExceptionBreakpoints", json!({"filters": ["error"]}));
    d.req("configurationDone", json!({}));
    c.send(&std::fs::read_to_string(&h).unwrap(), Some(&h));
    let m = d.mark();
    c.send("h(5)", None);
    let stop = d.event("stopped", m);
    assert_eq!(stop["body"]["reason"], "exception");
    assert_eq!(d.stack()[0], ("h".to_string(), 3));
    let info = d.req("exceptionInfo", json!({"threadId": 1}));
    assert_eq!(info["body"]["description"], "boom: 10");
    assert_eq!(d.locals().get("y").map(String::as_str), Some("10"));
    let m = d.mark();
    d.req("next", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("boom: 10");
    d.req("setExceptionBreakpoints", json!({"filters": []}));

    c.send("h2 <- function(a) {\n  b <- a + 1\n  b\n}", None);
    std::thread::sleep(Duration::from_millis(300));
    let r = d.req(
        "setFunctionBreakpoints",
        json!({"breakpoints": [{"name": "h2"}]}),
    );
    assert_eq!(r["body"]["breakpoints"][0]["verified"], true);
    let m = d.mark();
    c.send("h2(1)", None);
    assert_eq!(
        d.event("stopped", m)["body"]["reason"],
        "function breakpoint"
    );
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    d.req("setFunctionBreakpoints", json!({"breakpoints": []}));

    d.req(
        "setBreakpoints",
        json!({"source": {"path": sq}, "breakpoints": [{"line": 3}]}),
    );
    std::thread::sleep(Duration::from_millis(300));
    let m = d.mark();
    c.send(&format!("source('{sq}')"), None);
    assert_eq!(
        d.event("breakpoint", m)["body"]["breakpoint"]["verified"],
        true
    );
    let m = d.mark();
    c.send("sq(3)", None);
    d.event("stopped", m);
    assert_eq!(d.stack()[0], ("sq".to_string(), 3));
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("[1] 10");
}

#[test]
fn pause_stops_a_busy_loop_and_terminate_returns_to_the_prompt() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("configurationDone", json!({}));
    let m = d.mark();
    c.send("k <- 0; repeat { k <- k + 1 }", None);
    std::thread::sleep(Duration::from_millis(800));
    d.req("pause", json!({"threadId": 1}));
    assert_eq!(d.event("stopped", m)["body"]["reason"], "pause");
    let ev = d.req(
        "evaluate",
        json!({"expression": "k > 0", "context": "repl"}),
    );
    assert!(ev["body"]["result"].as_str().unwrap().contains("TRUE"));
    d.req("terminate", json!({}));
    std::thread::sleep(Duration::from_millis(500));
    c.type_line("cat('alive\\n')");
    c.expect("alive");
}

#[test]
fn step_in_skips_code_without_srcref_and_frames_get_virtual_sources() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let src = "k <- function(v) {\n  m <- sd(v)\n  m + 1\n}\n";
    let e = c.write_file("e.R", src);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": e}, "breakpoints": [{"line": 2}]}),
    );
    d.req("configurationDone", json!({}));
    c.send(src, Some(&e));
    let m = d.mark();
    c.send("k(c(1, 2, 3))", None);
    d.event("stopped", m);
    let stop = d.step("stepIn");
    assert_eq!(stop["body"]["reason"], "step");
    assert_eq!(
        d.stack()[0],
        ("k".to_string(), 3),
        "stepped over sd() (no srcref)"
    );
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();

    d.req(
        "setFunctionBreakpoints",
        json!({"breakpoints": [{"name": "stats::var"}]}),
    );
    let m = d.mark();
    c.send("var(1:4)", None);
    d.event("stopped", m);
    let st = d.req("stackTrace", json!({"threadId": 1}));
    let src = &st["body"]["stackFrames"][0]["source"];
    let r = src["sourceReference"].as_i64().expect("virtual source");
    let text = d.req("source", json!({"source": src, "sourceReference": r}));
    assert!(
        text["body"]["content"]
            .as_str()
            .unwrap()
            .starts_with("var <- function")
    );
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
}

#[test]
fn steps_never_leak_into_a_later_send_and_function_breakpoints_bind_late() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let src = "u <- 1\nv <- u + 1\n";
    let p = c.write_file("s.R", src);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": [{"line": 2}]}),
    );
    // Set before `late` exists: unverified until it is defined.
    let fb = d.req(
        "setFunctionBreakpoints",
        json!({"breakpoints": [{"name": "late"}]}),
    );
    assert_eq!(fb["body"]["breakpoints"][0]["verified"], false, "{fb}");
    let fb_id = fb["body"]["breakpoints"][0]["id"].clone();
    d.req("configurationDone", json!({}));
    let m = d.mark();
    c.send(src, Some(&p));
    d.event("stopped", m);
    // Step off the end of the send.
    let m = d.mark();
    d.req("next", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    // A second tagged send runs without a stop.
    let q = c.write_file("t.R", "w <- 7\nw * 6\n");
    let m = d.mark();
    c.send("w <- 7\nw * 6\n", Some(&q));
    c.expect("[1] 42");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(d.count("stopped", m), 0, "step leaked into a new send");

    // Defining `late` binds its breakpoint at the next prompt.
    let m = d.mark();
    c.send("late <- function() {\n  41 + 1\n}", None);
    let ev = d.event("breakpoint", m);
    assert_eq!(ev["body"]["breakpoint"]["id"], fb_id, "{ev}");
    assert_eq!(ev["body"]["breakpoint"]["verified"], true, "{ev}");
    let m = d.mark();
    c.send("late()", None);
    assert_eq!(
        d.event("stopped", m)["body"]["reason"],
        "function breakpoint"
    );
    // The Debug Console shows printed output, messages and warnings, and
    // none of them reach the terminal.
    let ev = d.req(
        "evaluate",
        json!({"expression": "{cat('said\\n'); message('noted'); warning('careful'); 5}", "context": "repl"}),
    );
    let out = ev["body"]["result"].as_str().unwrap();
    for want in ["said", "noted", "Warning: careful", "[1] 5"] {
        assert!(out.contains(want), "{want} missing from {out:?}");
    }
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("[1] 42");
    assert!(!c.text().contains("careful"), "{}", c.text());
    d.req("setFunctionBreakpoints", json!({"breakpoints": []}));

    // The source() hook (installed while line breakpoints exist) keeps
    // source(exprs=) working.
    c.send("source(exprs = quote(cat('from exprs\\n')))", None);
    c.expect("from exprs");
    assert!(!c.text().contains("Error"), "{}", c.text());
}

/// The R package `later` is installed (callbacks the event pump runs).
fn later_available() -> bool {
    let ok = Command::new("Rscript")
        .args([
            "-e",
            "quit(status = !requireNamespace('later', quietly = TRUE))",
        ])
        .status()
        .is_ok_and(|s| s.success());
    if !ok {
        eprintln!("skipping: R package later is not installed");
    }
    ok
}

/// A browser opened by code the event pump runs (a `later` callback) reads
/// its input with the fallback line reader. A browser command typed there is
/// a resume, as at any other browser prompt: the session leaves its stop.
#[test]
fn typed_continue_at_a_callback_browser_resumes_the_session() {
    if !r_available() || !later_available() {
        return;
    }
    let mut c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("configurationDone", json!({}));
    let m = d.mark();
    c.send(
        "later::later(function() { browser(); cat(toupper('after callback'), '\\n') }, 0.3)",
        None,
    );
    d.event("stopped", m);
    let m = d.mark();
    c.type_line("c");
    c.expect("AFTER CALLBACK");
    d.event("continued", m);
}

#[test]
fn unbraced_bodies_handlers_completions_and_nested_browsers() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let src = "sq1 <- function(x) x^2 + 1\nsafe <- function() tryCatch(stop(\"no\"), error = function(e) {\n  conditionMessage(e)\n})\n";
    let p = c.write_file("u.R", src);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": [{"line": 1}, {"line": 3}]}),
    );
    d.req("configurationDone", json!({}));
    c.send(src, Some(&p));
    std::thread::sleep(Duration::from_millis(300));
    // A breakpoint on a one-line definition stops when the function runs.
    let m = d.mark();
    c.send("sq1(3)", None);
    d.event("stopped", m);
    assert_eq!(d.stack()[0], ("sq1".to_string(), 1));
    // Not forced yet: shown as the promise it is.
    assert_eq!(
        d.locals().get("x").map(String::as_str),
        Some("<promise: 3>")
    );
    // Completions see the frame's own names.
    let st = d.req("stackTrace", json!({"threadId": 1}));
    let frame = st["body"]["stackFrames"][0]["id"].clone();
    let comp = d.req(
        "completions",
        json!({"text": "x", "column": 2, "frameId": frame}),
    );
    let labels: Vec<&str> = comp["body"]["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels.first(), Some(&"x"), "{comp}");
    // An expression that reaches browser() continues instead of stopping.
    let m = d.mark();
    let ev = d.req(
        "evaluate",
        json!({"expression": "(function() { browser(); 7 })()", "frameId": frame, "context": "repl"}),
    );
    assert!(
        ev["body"]["result"]
            .as_str()
            .unwrap_or("")
            .contains("[1] 7"),
        "{ev}"
    );
    assert_eq!(d.count("stopped", m), 0);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("[1] 10");
    // A breakpoint in a tryCatch() handler binds and stops.
    let m = d.mark();
    c.send("safe()", None);
    d.event("stopped", m);
    assert_eq!(d.stack()[0].1, 3);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("\"no\"");
}

#[test]
fn session_lifecycle_survives_teardown_races_and_disconnect_semantics() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let src = "p1 <- 1\np2 <- 2\np3 <- 3\n";
    let p = c.write_file("l.R", src);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": [{"line": 1}, {"line": 3}]}),
    );
    d.req("configurationDone", json!({}));
    // Two stops in one send: one session, no `terminated` in between.
    let m = d.mark();
    c.send(src, Some(&p));
    d.event("stopped", m);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("stopped", m);
    assert_eq!(d.count("terminated", m), 0, "session ended between stops");
    assert_eq!(d.stack()[0].1, 3);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    c.send("rm(p1, p2, p3)", None);

    // VS Code's teardown `disconnect` can arrive after the next stop: it
    // must not resume it, and the next session sees that stop.
    let m = d.mark();
    c.send(src, Some(&p));
    d.event("stopped", m);
    d.session_ended();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(d.stack()[0].1, 1, "the new session sees the stop");

    // A user Disconnect lets R continue (to the next breakpoint)...
    d.req("disconnect", json!({"terminateDebuggee": false}));
    let mut d = Dap::open(&c.dir, true);
    d.event("stopped", 0);
    assert_eq!(d.stack()[0].1, 3);
    // ...and Stop (terminateDebuggee) quits the browser.
    d.req("disconnect", json!({"terminateDebuggee": true}));
    std::thread::sleep(Duration::from_millis(500));
    c.send("cat('after', exists('p3'), '\\n')", None);
    c.expect("after FALSE");
}

/// One request on a fresh IPC connection; its reply's `status`.
fn ipc_request(c: &Console, msg: &Value) -> String {
    let s = UnixStream::connect(c.dir.join("i")).expect("ipc connect");
    s.set_read_timeout(Some(TIMEOUT)).unwrap();
    let mut w = s.try_clone().unwrap();
    writeln!(w, "{msg}").unwrap();
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).unwrap();
    let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    v["status"].as_str().unwrap_or("").to_string()
}

/// The files the console has line breakpoints in, from the summary it
/// pushes to a subscriber after a mirror that names only a probe path.
fn armed_files(c: &Console) -> Vec<String> {
    let s = UnixStream::connect(c.dir.join("i")).expect("ipc connect");
    s.set_read_timeout(Some(Duration::from_millis(700)))
        .unwrap();
    let mut w = s.try_clone().unwrap();
    writeln!(w, "{}", json!({"v": 1, "id": 1, "op": "subscribe"})).unwrap();
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    let probe = c.dir.join("no-such-probe").to_string_lossy().into_owned();
    let status = ipc_request(
        c,
        &json!({"v": 1, "id": 2, "op": "breakpoints", "files": {probe: []}}),
    );
    assert_eq!(status, "ok");
    // Summaries queued earlier may arrive first: the last one counts.
    let mut files = Vec::new();
    loop {
        line.clear();
        match r.read_line(&mut line) {
            Ok(n) if n > 0 => {}
            _ => break,
        }
        let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        if v["event"] == "breakpoints" {
            files = v["breakpoints"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|b| b["source"]["path"].as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
        }
    }
    files
}

#[test]
fn a_stalled_breakpoint_request_cannot_undo_a_later_one() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let target = c.write_file("b.R", "x <- 1\ny <- 2\n");
    // A file whose read blocks until the test writes to it, standing in
    // for a stalled network filesystem.
    let fifo = c.dir.join("a_stall.R");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let fifo = fifo.to_string_lossy().into_owned();
    let deadline = Instant::now() + TIMEOUT;
    while c.ipc_status("breakpoints") != "ok" {
        assert!(Instant::now() < deadline, "debugger never became ready");
        std::thread::sleep(Duration::from_millis(50));
    }
    let arm = json!({"v": 1, "id": 1, "op": "breakpoints", "files": {&target: [{"line": 1}]}});
    assert_eq!(ipc_request(&c, &arm), "ok");
    assert_eq!(armed_files(&c), vec![target.clone()]);
    // An older request stalls reading its first file, before it reaches
    // the target...
    let stalled = {
        let msg = json!({"v": 1, "id": 2, "op": "breakpoints",
            "files": {&fifo: [{"line": 1}], &target: [{"line": 2}]}});
        let s = UnixStream::connect(c.dir.join("i")).expect("ipc connect");
        s.set_read_timeout(Some(TIMEOUT)).unwrap();
        let mut w = s.try_clone().unwrap();
        writeln!(w, "{msg}").unwrap();
        s
    };
    // The FIFO opens for writing only once the console is blocked reading
    // it, which is after the request took its place in line.
    let mut writer = {
        use std::os::unix::fs::OpenOptionsExt;
        let deadline = Instant::now() + TIMEOUT;
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&fifo)
            {
                Ok(f) => break f,
                Err(e) => {
                    assert!(Instant::now() < deadline, "the request never read: {e}");
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
    };
    // ... a newer one deletes the target's breakpoints ...
    let clear = json!({"v": 1, "id": 3, "op": "breakpoints", "files": {&target: []}});
    assert_eq!(ipc_request(&c, &clear), "ok");
    assert!(armed_files(&c).is_empty());
    // ... and then the stall ends, and the older request finishes.
    writer.write_all(b"z <- 1\n").unwrap();
    drop(writer);
    let mut line = String::new();
    BufReader::new(stalled).read_line(&mut line).unwrap();
    assert!(line.contains("\"ok\""), "{line}");
    let fifo = std::fs::canonicalize(&fifo)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    // It still arms the file no later request named.
    assert_eq!(
        armed_files(&c),
        vec![fifo.clone()],
        "the older request re-armed deleted breakpoints"
    );
    // Deleting a file's breakpoints doesn't read its text: nothing
    // writes to the FIFO here.
    let clear = json!({"v": 1, "id": 4, "op": "breakpoints", "files": {&fifo: []}});
    assert_eq!(ipc_request(&c, &clear), "ok");
    assert!(armed_files(&c).is_empty());
}

#[test]
fn sourcing_with_echo_shows_only_the_users_lines() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let src = "# a comment\nv1 <- 10\nfn <- function(x) {\n  x + v1\n}\nprint(fn(1))\n";
    let p = c.write_file("e.R", src);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": [{"line": 2}, {"line": 4}]}),
    );
    d.req("configurationDone", json!({}));
    std::thread::sleep(Duration::from_millis(300));
    let m = d.mark();
    c.send(&format!("source('{p}', echo = TRUE)"), None);
    d.event("stopped", m);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("stopped", m);
    assert_eq!(d.stack()[0], ("fn".to_string(), 4));
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    c.expect("[1] 11");
    let text = c.text();
    assert_eq!(text.matches("> # a comment").count(), 1, "{text}");
    assert_eq!(text.matches("> v1 <- 10").count(), 1, "{text}");
    assert!(!text.contains("Called from"), "{text}");
    assert!(text.contains("+   x + v1"), "{text}");
    assert!(!text.contains("#line"), "{text}");
    assert!(!text.contains("raven"), "{text}");
}

#[test]
fn r_markdown_breakpoints_bind_per_chunk() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let doc = "---\ntitle: t\n---\n\nProse (with an { open brace.\n\n```{r}\nrk <- function(x) {\n  x * 3\n}\n```\n";
    let p = c.write_file("r.Rmd", doc);
    let mut d = Dap::connect(&c);
    let r = d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": [{"line": 9}]}),
    );
    let msg = r["body"]["breakpoints"][0]["message"]
        .as_str()
        .unwrap_or("");
    assert!(msg.contains("not run"), "{r}");
    d.req("configurationDone", json!({}));
    // Run Chunk sends the chunk's code tagged with its first line.
    let chunk = "rk <- function(x) {\n  x * 3\n}";
    let m = d.mark();
    c.send_at(chunk, &p, 8);
    assert_eq!(
        d.event("breakpoint", m)["body"]["breakpoint"]["verified"],
        true
    );
    let m = d.mark();
    c.send("rk(2)", None);
    d.event("stopped", m);
    assert_eq!(d.stack()[0], ("rk".to_string(), 9));
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    c.expect("[1] 6");
}

#[test]
fn breakpoints_keep_source_semantics_set_value_scope_and_fbp_cleanup() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let me = c.write_file(
        "me.R",
        "where <- basename(sys.frame(1)$ofile)\nwhere2 <- where\n",
    );
    let other = c.write_file("other.R", "cat('other ran\\n')\n");
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": me}, "breakpoints": [{"line": 2}]}),
    );
    d.req("configurationDone", json!({}));
    std::thread::sleep(Duration::from_millis(300));
    // An instrumented file still finds itself through `ofile`.
    let m = d.mark();
    c.send(&format!("source('{me}')"), None);
    d.event("stopped", m);
    assert_eq!(d.stack()[0].1, 2, "stops at the top-level line");
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.send("cat('where:', where2, '\\n')", None);
    c.expect("where: me.R");
    // Files without breakpoints go to base source() untouched, including
    // arguments the wrapper doesn't handle itself.
    c.send(
        &format!("source('{other}', encoding = c('UTF-8', 'latin1'))"),
        None,
    );
    c.expect("other ran");

    // Set Value evaluates in the variable's own frame.
    c.send(
        "y <- 1000; sv <- function() {\n  x <- 1; y <- 5\n  browser()\n  x\n}",
        None,
    );
    let m = d.mark();
    c.send("sv()", None);
    d.event("stopped", m);
    let st = d.req("stackTrace", json!({"threadId": 1}));
    let frame = st["body"]["stackFrames"][0]["id"].clone();
    let sc = d.req("scopes", json!({"frameId": frame}));
    let r = sc["body"]["scopes"][0]["variablesReference"].clone();
    let set = d.req(
        "setVariable",
        json!({"variablesReference": r, "name": "x", "value": "y + 1"}),
    );
    assert_eq!(set["body"]["value"], "6", "{set}");
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("[1] 6");

    // A function breakpoint's old closure stops being debugged when the
    // function is redefined.
    c.send("fo <- function() 1", None);
    std::thread::sleep(Duration::from_millis(300));
    d.req(
        "setFunctionBreakpoints",
        json!({"breakpoints": [{"name": "fo"}]}),
    );
    c.send("old <- fo; fo <- function() 2", None);
    std::thread::sleep(Duration::from_millis(300));
    c.send("cat('old debugged:', isdebugged(old), '\\n')", None);
    c.expect("old debugged: FALSE");
}

#[test]
fn stop_interrupts_running_code_and_values_show_faithfully() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("setExceptionBreakpoints", json!({"filters": ["interrupt"]}));
    d.req("configurationDone", json!({}));
    // Stop while R runs: interrupted back to the prompt, even with the
    // Interrupts filter on, and no stop.
    let m = d.mark();
    c.send("spin <- 0; repeat { spin <- spin + 1 }", None);
    std::thread::sleep(Duration::from_millis(800));
    d.req("terminate", json!({}));
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(d.count("stopped", m), 0, "Stop opened a browser");
    d.session_ended();
    d.req("setExceptionBreakpoints", json!({"filters": []}));
    c.send("cat('alive', spin > 0, '\\n')", None);
    c.expect("alive TRUE");

    // Non-ASCII text, NaN, matrices and named vectors.
    c.send(
        "vals <- function() {\n  s <- \"a\u{2019}b\u{2014}c \u{4e2d}\u{6587}\"\n  m <- matrix(1:6, 2)\n  nv <- c(a = 1, b = NaN)\n  browser()\n  s\n}",
        None,
    );
    let m = d.mark();
    c.send("vals()", None);
    d.event("stopped", m);
    let locals = d.locals();
    assert_eq!(
        locals.get("s").map(String::as_str),
        Some("\"a\u{2019}b\u{2014}c \u{4e2d}\u{6587}\"")
    );
    assert!(locals["m"].starts_with("int [2 x 3] 1 2 3"), "{locals:?}");
    assert!(locals["nv"].contains("NaN"), "{locals:?}");
    let st = d.req("stackTrace", json!({"threadId": 1}));
    let frame = st["body"]["stackFrames"][0]["id"].clone();
    let sc = d.req("scopes", json!({"frameId": frame}));
    let r = sc["body"]["scopes"][0]["variablesReference"].clone();
    let vs = d.req("variables", json!({"variablesReference": r}));
    let nv = vs["body"]["variables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "nv")
        .unwrap()["variablesReference"]
        .clone();
    let kids = d.req("variables", json!({"variablesReference": nv}));
    let names: Vec<&str> = kids["body"]["variables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["a", "b"]);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
}

#[test]
fn function_breakpoints_respect_the_users_own_debug_state() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("configurationDone", json!({}));
    c.send(
        "mine <- function() 1; debug(mine); gone <- function() 2",
        None,
    );
    std::thread::sleep(Duration::from_millis(300));
    d.req(
        "setFunctionBreakpoints",
        json!({"breakpoints": [{"name": "mine"}, {"name": "gone"}]}),
    );
    // The name stops resolving: the closure it named stops being debugged.
    c.send("kept <- gone; rm(gone)", None);
    std::thread::sleep(Duration::from_millis(300));
    // Removing the breakpoint leaves the user's own debug() in place.
    d.req("setFunctionBreakpoints", json!({"breakpoints": []}));
    c.send(
        "cat('mine:', isdebugged(mine), 'kept:', isdebugged(kept), '\\n')",
        None,
    );
    c.expect("mine: TRUE kept: FALSE");
}

#[test]
fn step_out_and_over_return_to_the_caller_and_switch_arms_bind() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    // CRLF line endings, as a Windows-edited file sends them.
    let src = "inner <- function(x) {\r\n  y <- x * 2\r\n  y\r\n}\r\nouter <- function() {\r\n  a <- inner(1)\r\n  b <- inner(2)\r\n  a + b\r\n}\r\npick <- function(t) {\r\n  switch(t,\r\n    one = {\r\n      1\r\n    },\r\n    2)\r\n}\r\n";
    let p = c.write_file("o.R", src);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": [{"line": 2}, {"line": 13}]}),
    );
    d.req("configurationDone", json!({}));
    c.send(src, Some(&p));
    std::thread::sleep(Duration::from_millis(500));
    let m = d.mark();
    c.send("outer()", None);
    d.event("stopped", m);
    assert_eq!(d.stack()[0], ("inner".to_string(), 2));
    // Step Out lands in outer, at the statement after the call.
    d.step("stepOut");
    assert_eq!(d.stack()[0], ("outer".to_string(), 7));
    // Into inner again (its breakpoint line stops once), then Step Over
    // past its last line: back in outer.
    d.step("stepIn");
    assert_eq!(d.stack()[0], ("inner".to_string(), 2));
    d.step("next");
    assert_eq!(d.stack()[0], ("inner".to_string(), 3));
    let back = d.step("next");
    assert_eq!(back["body"]["reason"], "step");
    assert_eq!(d.stack()[0], ("outer".to_string(), 8));
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("[1] 6");
    // After Continue, the caller flag is gone: a later call runs through.
    d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": [{"line": 13}]}),
    );
    let m = d.mark();
    c.send("outer()", None);
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(d.count("stopped", m), 0);
    // A breakpoint inside a switch() arm stops.
    let m = d.mark();
    c.send("pick('one')", None);
    d.event("stopped", m);
    assert_eq!(d.stack()[0], ("pick".to_string(), 13));
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
}

#[test]
fn expressions_name_exactly_the_value_shown() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("configurationDone", json!({}));
    c.send(
        "x <- 'global'; sh <- function() {\n  x <- 'local'; l <- list(a = 1, a = 2)\n  browser()\n  x\n}",
        None,
    );
    let m = d.mark();
    c.send("sh()", None);
    d.event("stopped", m);
    let st = d.req("stackTrace", json!({"threadId": 1}));
    let frame = st["body"]["stackFrames"][0]["id"].clone();
    let sc = d.req("scopes", json!({"frameId": frame}));
    let scopes = sc["body"]["scopes"].as_array().unwrap().clone();
    let vars = |d: &mut Dap, r: &Value| {
        d.req("variables", json!({"variablesReference": r}))["body"]["variables"]
            .as_array()
            .unwrap()
            .clone()
    };
    let global = scopes.iter().find(|s| s["name"] == "Global").unwrap();
    let gx = vars(&mut d, &global["variablesReference"])
        .into_iter()
        .find(|v| v["name"] == "x")
        .unwrap();
    let locals = vars(&mut d, &scopes[0]["variablesReference"]);
    let l = locals.iter().find(|v| v["name"] == "l").unwrap();
    let second = vars(&mut d, &l["variablesReference"])[1].clone();
    // Each evaluateName, evaluated in the stopped frame, gives the value
    // that row shows.
    for (row, want) in [(&gx, "global"), (&second, "2")] {
        let ex = row["evaluateName"].as_str().unwrap();
        let ev = d.req(
            "evaluate",
            json!({"expression": ex, "frameId": frame, "context": "repl"}),
        );
        let got = ev["body"]["result"].as_str().unwrap_or("");
        assert!(got.contains(want), "{ex} gave {got}, row shows {want}");
    }
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
}

/// Stop that lands just after the user answered `readline()`, before R runs
/// again, still ends the program: the answer is dropped and the code that
/// asked is interrupted, instead of the program running on with it. Needs
/// the `test-support` delay that widens that gap.
#[cfg(feature = "test-support")]
#[test]
fn terminate_racing_a_readline_answer_still_ends_the_program() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn_with_env(&[("RAVEN_TEST_INPUT_DEPARTURE_DELAY_MS", "1500")]);
    let mut d = Dap::connect(&c);
    d.req("launch", json!({"program": "/w/p.R"}));
    d.req("configurationDone", json!({}));
    // The program's own output is upper-cased, so it can't match the echo.
    c.send_program("ans <- readline('answer: '); cat(toupper('program got'), ans, '\\n')");
    let deadline = Instant::now() + TIMEOUT;
    while c.text().matches("answer: ").count() < 2 {
        assert!(
            Instant::now() < deadline,
            "no readline() prompt: {}",
            c.text()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // Answer, then Stop while the answer is on its way back to R.
    c.type_line("yes");
    std::thread::sleep(Duration::from_millis(400));
    let m = d.mark();
    d.req("terminate", json!({}));
    d.event("terminated", m);
    std::thread::sleep(Duration::from_millis(2000));
    c.type_line("cat('alive', '\\n')");
    c.expect("alive ");
    assert!(
        !c.text().contains("PROGRAM GOT"),
        "the program ran on with the answer after Stop: {}",
        c.text()
    );
}

/// Stop ends an F5 program even while it waits at `readline()`, as it does
/// for a Python program waiting in `input()`: the next typed line runs at
/// the top-level prompt instead of answering the abandoned `readline()`.
#[test]
fn terminate_ends_a_program_waiting_at_readline() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("launch", json!({"program": "/w/p.R"}));
    d.req("configurationDone", json!({}));
    // The program's own output is upper-cased, so it can't match the echo.
    c.send_program("ans <- readline('answer: '); cat(toupper('program got'), ans, '\\n')");
    // Wait for the prompt itself: the echoed code also contains "answer: ".
    let deadline = Instant::now() + TIMEOUT;
    while c.text().matches("answer: ").count() < 2 {
        assert!(
            Instant::now() < deadline,
            "no readline() prompt: {}",
            c.text()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // A half-typed answer is abandoned with the program.
    c.type_keys("partial");
    c.expect("answer: partial");
    let m = d.mark();
    d.req("terminate", json!({}));
    d.event("terminated", m);
    std::thread::sleep(Duration::from_millis(500));
    c.type_line("cat('alive', '\\n')");
    c.expect("alive ");
    assert!(
        !c.text().contains("PROGRAM GOT"),
        "the typed line answered the stopped program's readline(): {}",
        c.text()
    );
    c.type_line("ans2 <- readline('again: ')");
    c.expect("again: ");
    c.type_line("fresh");
    c.type_line("cat(toupper(ans2), '\\n')");
    c.expect("FRESH");
    assert!(
        !c.text().contains("PARTIALFRESH"),
        "the abandoned answer leaked into the next readline(): {}",
        c.text()
    );
}

#[test]
fn a_program_session_ends_when_its_program_finishes() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("launch", json!({"program": "/w/p.R"}));
    d.req("configurationDone", json!({}));
    // Another send finishing first doesn't end the session...
    let m = d.mark();
    c.send("Sys.sleep(0.2); cat('other\\n')", None);
    c.expect("other");
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(d.count("terminated", m), 0, "ended on an unrelated send");
    // ...the program finishing does.
    c.send_program("cat('program ran\\n')");
    c.expect("program ran");
    d.event("terminated", m);
}

#[test]
fn continue_after_stepping_into_a_callee_runs_to_the_end() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let src = "mid <- function() {\n  z <- 1\n  z\n}\nouter2 <- function() {\n  a <- mid()\n  b <- 3\n  cat('outer2 done', a + b, '\\n')\n}\n";
    let p = c.write_file("s.R", src);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": [{"line": 6}]}),
    );
    d.req("configurationDone", json!({}));
    c.send(src, Some(&p));
    std::thread::sleep(Duration::from_millis(400));
    for step in ["stepIn", "next"] {
        let m = d.mark();
        c.send("outer2()", None);
        d.event("stopped", m);
        assert_eq!(d.stack()[0], ("outer2".to_string(), 6));
        d.step(step);
        if step == "next" {
            // Step Over a call with no breakpoint inside stays in outer2;
            // step into mid to set R's own flags on the way.
            d.step("stepIn");
        }
        let m = d.mark();
        d.req("continue", json!({"threadId": 1}));
        d.event("terminated", m);
        assert_eq!(
            d.count("stopped", m),
            0,
            "Continue after {step} stopped again"
        );
        d.session_ended();
        c.expect("outer2 done 4");
    }
}

/// A package-defined ALTREP integer class whose every method counts its
/// calls (`spy_calls()`), built with `R CMD SHLIB`.
const SPY_ALTREP_C: &str = r#"#include <R.h>
#include <Rinternals.h>
#include <R_ext/Altrep.h>
static R_altrep_class_t cls, lcls;
static int calls = 0;
static R_xlen_t len(SEXP x) { calls++; return 3; }
static int spy_elt(SEXP x, R_xlen_t i) { calls++; return (int)i + 1; }
static int data[3] = {1, 2, 3};
static void *dataptr(SEXP x, Rboolean w) { calls++; return data; }
static const void *dataptr_or_null(SEXP x) { calls++; return NULL; }
static SEXP lelt(SEXP x, R_xlen_t i) { calls++; return ScalarInteger(1); }
SEXP spy_make(void) { return R_new_altrep(cls, R_NilValue, R_NilValue); }
SEXP spy_list(void) { return R_new_altrep(lcls, R_NilValue, R_NilValue); }
SEXP spy_calls(void) { return ScalarInteger(calls); }
void R_init_spy(DllInfo *dll) {
  cls = R_make_altinteger_class("spy", "spypkg", dll);
  R_set_altrep_Length_method(cls, len);
  R_set_altinteger_Elt_method(cls, spy_elt);
  R_set_altvec_Dataptr_method(cls, dataptr);
  R_set_altvec_Dataptr_or_null_method(cls, dataptr_or_null);
  lcls = R_make_altlist_class("spylist", "spypkg", dll);
  R_set_altrep_Length_method(lcls, len);
  R_set_altlist_Elt_method(lcls, lelt);
  R_set_altvec_Dataptr_method(lcls, dataptr);
  R_set_altvec_Dataptr_or_null_method(lcls, dataptr_or_null);
}
"#;

#[test]
fn inspecting_a_package_altrep_vector_runs_none_of_its_code() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let src = c.write_file("spy.c", SPY_ALTREP_C);
    let built = Command::new("R")
        .args(["CMD", "SHLIB", &src])
        .current_dir(&c.dir)
        .output()
        .is_ok_and(|o| o.status.success());
    let so = c.dir.join("spy.so");
    if !built || !so.exists() {
        eprintln!("skipping: R CMD SHLIB unavailable");
        return;
    }
    let mut d = Dap::connect(&c);
    d.req("configurationDone", json!({}));
    c.send(
        &format!(
            "dyn.load('{}'); peek <- function() {{\n  x <- .Call('spy_make')\n  fy <- structure(1:2, levels = .Call('spy_make'), class = 'factor')\n  dd <- data.frame(a = 1:3); attr(dd, 'row.names') <- .Call('spy_make')\n  xl <- .Call('spy_list')\n  setClass('Spy', contains = 'integer')\n  sx <- .Call('spy_make'); attr(sx, 'class') <- structure('Spy', package = '.GlobalEnv'); sx <- asS4(sx)\n  n0 <- .Call('spy_calls')\n  browser()\n  x\n}}",
            so.display()
        ),
        None,
    );
    let m = d.mark();
    c.send("peek()", None);
    d.event("stopped", m);
    let locals = d.locals();
    assert!(locals["x"].contains("not read"), "{locals:?}");
    let st = d.req("stackTrace", json!({"threadId": 1}));
    let frame = st["body"]["stackFrames"][0]["id"].clone();
    let hv = d.req(
        "evaluate",
        json!({"expression": "x", "frameId": frame, "context": "hover"}),
    );
    assert!(
        hv["body"]["result"]
            .as_str()
            .unwrap_or("")
            .contains("not read"),
        "{hv}"
    );
    // The factor (levels) and data frame (row names) whose attributes are
    // such vectors: shown without reading them either.
    let _ = d.locals();
    for e in ["fy", "dd", "xl", "xl[[1]]", "sx", "sx@.Data"] {
        d.req(
            "evaluate",
            json!({"expression": e, "frameId": frame, "context": "hover"}),
        );
    }
    let calls = d.req(
        "evaluate",
        json!({"expression": ".Call('spy_calls') - n0", "frameId": frame, "context": "repl"}),
    );
    assert_eq!(calls["body"]["result"], "[1] 0", "{calls}");
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
}

#[test]
fn set_value_edits_list_elements_and_vector_entries() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("configurationDone", json!({}));
    c.send(
        "ed <- function() {\n  k <- 10; l <- list(a = 1, b = list(c = 2)); v <- c(5, 6, 7); dup <- list(a = 1, a = 2, `a [[1]]` = 3)\n  browser()\n  cat('now', l$a, l$b$c, v[2], dup[[1]], deparse(dup[[2]]), '\\n')\n}",
        None,
    );
    let m = d.mark();
    c.send("ed()", None);
    d.event("stopped", m);
    let st = d.req("stackTrace", json!({"threadId": 1}));
    let frame = st["body"]["stackFrames"][0]["id"].clone();
    let sc = d.req("scopes", json!({"frameId": frame}));
    let kids = |d: &mut Dap, r: &Value| {
        d.req("variables", json!({"variablesReference": r}))["body"]["variables"]
            .as_array()
            .unwrap()
            .clone()
    };
    let find = |vs: &[Value], n: &str| vs.iter().find(|v| v["name"] == n).unwrap().clone();
    let locals = kids(&mut d, &sc["body"]["scopes"][0]["variablesReference"]);
    let l = find(&locals, "l");
    let v = find(&locals, "v");
    let l_kids = kids(&mut d, &l["variablesReference"]);
    let b = find(&l_kids, "b");
    let b_kids = kids(&mut d, &b["variablesReference"]);
    let _ = b_kids;
    let v_kids = kids(&mut d, &v["variablesReference"]);
    assert_eq!(v_kids[1]["name"], "[2]");
    // The value is an expression in the frame (`k` is a local).
    // Repeated names get distinct rows; a language value is stored, not run.
    let dup = find(&locals, "dup");
    let dup_kids = kids(&mut d, &dup["variablesReference"]);
    let dup_names: Vec<&str> = dup_kids
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect();
    assert_eq!(dup_names, vec!["a [[1]]", "a [[2]]", "a [[1]]"]);
    // A label that names two elements is refused, not guessed, even when
    // only the first rows were fetched.
    let first_two = d.req(
        "variables",
        json!({"variablesReference": dup["variablesReference"], "start": 0, "count": 2}),
    );
    assert_eq!(first_two["body"]["variables"].as_array().unwrap().len(), 2);
    // Hover doesn't read `l[[k]]` as `l[["k"]]`.
    let hv = d.req(
        "evaluate",
        json!({"expression": "l[[k]]", "frameId": frame, "context": "hover"}),
    );
    assert_eq!(hv["success"], false, "{hv}");
    let amb = d.req(
        "setVariable",
        json!({"variablesReference": dup["variablesReference"], "name": "a [[1]]", "value": "0"}),
    );
    assert_eq!(amb["success"], false, "{amb}");
    for (r, name, value) in [
        (&l["variablesReference"], "a", "k + 1"),
        (&b["variablesReference"], "c", "99"),
        (&v["variablesReference"], "[2]", "-1"),
        (&dup["variablesReference"], "a [[2]]", "quote(stop('ran'))"),
    ] {
        let set = d.req(
            "setVariable",
            json!({"variablesReference": r, "name": name, "value": value}),
        );
        assert_eq!(set["success"], true, "{set}");
    }
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    c.expect("now 11 99 -1 1 stop(\"ran\")");
}

#[test]
fn a_function_breakpoint_binds_inside_the_sourced_file_that_defines_it() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let script = c.write_file(
        "run.R",
        "fresh <- function() {\n  41 + 1\n}\nres <- fresh()\ncat('res', res, '\\n')\n",
    );
    let mut d = Dap::connect(&c);
    let fb = d.req(
        "setFunctionBreakpoints",
        json!({"breakpoints": [{"name": "fresh"}]}),
    );
    assert_eq!(fb["body"]["breakpoints"][0]["verified"], false);
    d.req("configurationDone", json!({}));
    std::thread::sleep(Duration::from_millis(300));
    let m = d.mark();
    c.send(&format!("source('{script}', echo = TRUE)"), None);
    assert_eq!(
        d.event("stopped", m)["body"]["reason"],
        "function breakpoint"
    );
    assert_eq!(d.stack()[0].0, "fresh");
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("res 42");
    // source()'s value is the file's last value, breakpoint or not; and a
    // function the file defines locally binds too.
    let local = c.write_file(
        "loc.R",
        "fresh <- function() {\n  'local'\n}\ncat('got', fresh(), '\\n')\nfresh\n",
    );
    let m = d.mark();
    c.send(
        &format!("(function() {{ v <- source('{local}', local = TRUE)$value; cat('fn', is.function(v), '\\n') }})()"),
        None,
    );
    d.event("stopped", m);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    c.expect("fn TRUE");
    let text = c.text();
    assert!(!text.contains("rebind"), "{text}");
    assert_eq!(text.matches("> fresh <- function() {").count(), 1, "{text}");
    assert_eq!(text.matches("> res <- fresh()").count(), 1, "{text}");
}

#[test]
fn source_arguments_stay_lazy_under_a_function_breakpoint() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let target = c.write_file("target.R", "raven_source_result <- 815\n");
    let defines = c.write_file(
        "defines.R",
        "lazy_fn <- function() {\n  7\n}\nlazy_res <- lazy_fn()\n",
    );
    let mut d = Dap::connect(&c);
    d.req(
        "setFunctionBreakpoints",
        json!({"breakpoints": [{"name": "unrelated_fn"}, {"name": "lazy_fn"}]}),
    );
    d.req("configurationDone", json!({}));
    std::thread::sleep(Duration::from_millis(300));
    // The file defines neither function: base source() runs it as called,
    // and never forces `prompt.echo` (echo is off).
    c.send(
        &format!(
            "source('{target}', echo = FALSE, prompt.echo = stop('unexpected evaluation')); cat('ran:', raven_source_result, '\\n')"
        ),
        None,
    );
    c.expect("ran: 815");
    // What the wrapper reads to decide (`encoding`) is evaluated once.
    c.send(
        &format!(
            "n <- 0; source('{target}', encoding = {{ n <- n + 1; 'UTF-8' }}); cat('enc evals:', n, '\\n')"
        ),
        None,
    );
    c.expect("enc evals: 1");
    // A file that defines the function is rewritten so the breakpoint
    // binds; its unused arguments stay unevaluated too.
    let m = d.mark();
    c.send(
        &format!(
            "k <- 0; source('{defines}', echo = FALSE, encoding = {{ k <- k + 1; 'UTF-8' }}, prompt.echo = stop('unexpected evaluation')); cat('bound:', lazy_res, k, '\\n')"
        ),
        None,
    );
    assert_eq!(
        d.event("stopped", m)["body"]["reason"],
        "function breakpoint"
    );
    assert_eq!(d.stack()[0].0, "lazy_fn");
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    c.expect("bound: 7 1");
    assert!(!c.text().contains("Error"), "{}", c.text());
}

#[test]
fn step_out_of_a_loop_still_stops_at_later_breakpoints_in_it() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let src = "lp <- function() {\n  for (i in 1:3) {\n    x <- i\n  }\n  'done'\n}\n";
    let p = c.write_file("lp.R", src);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": [{"line": 3}]}),
    );
    d.req("configurationDone", json!({}));
    c.send(src, Some(&p));
    std::thread::sleep(Duration::from_millis(400));
    let m = d.mark();
    c.send("lp()", None);
    d.event("stopped", m);
    assert_eq!(d.locals().get("i").map(String::as_str), Some("1"));
    // Step Out finishes the loop in R, but the breakpoint inside it stops
    // again on the next iteration.
    let stop = d.step("stepOut");
    assert_eq!(stop["body"]["reason"], "breakpoint", "{stop}");
    assert_eq!(d.stack()[0], ("lp".to_string(), 3));
    assert_eq!(d.locals().get("i").map(String::as_str), Some("2"));
    d.req(
        "setBreakpoints",
        json!({"source": {"path": p}, "breakpoints": []}),
    );
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
}

#[test]
fn error_and_warning_filters_stop_in_code_from_files_only() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let h = c.write_file(
        "h.R",
        "h <- function(x) {\n  y <- x * 2\n  stop(\"boom: \", y)\n}\nw <- function() {\n  warning(\"ww\")\n  1\n}\n",
    );
    let top = c.write_file("top.R", "x <- log('a')\n");
    let s = c.write_file("s.R", "\nz <- log('s')\n");
    let mut d = Dap::connect(&c);
    let caps = d.req("initialize", json!({"adapterID": "raven-r"}));
    let filters = &caps["body"]["exceptionBreakpointFilters"];
    assert_eq!(filters[0]["filter"], "error");
    assert_eq!(filters[0]["default"], true);
    assert_eq!(filters[1]["default"], false);
    assert_eq!(filters[2]["default"], false);
    d.req(
        "setExceptionBreakpoints",
        json!({"filters": ["error", "warning"]}),
    );
    d.req("configurationDone", json!({}));
    c.send(&std::fs::read_to_string(&h).unwrap(), Some(&h));
    c.expect("> ");

    // Typed at the prompt: R prints the error, the debugger stays out.
    let m = d.mark();
    c.type_line("log('typed')");
    c.expect("Error in log(\"typed\")");
    c.type_line("{ stop('brace') }");
    c.expect("Error: brace");
    c.type_line("g <- function() stop('typed fn')");
    c.type_line("g()");
    c.expect("typed fn");
    c.type_line("warning('typed warning')");
    c.expect("typed warning");
    c.send("log('untagged')", None);
    c.expect("Error in log(\"untagged\")");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(d.count("stopped", m), 0);

    // A top-level line sent from a file stops at that line.
    let m = d.mark();
    c.send("x <- log('a')", Some(&top));
    assert_eq!(d.event("stopped", m)["body"]["reason"], "exception");
    let st = d.req("stackTrace", json!({"threadId": 1}));
    let f0 = &st["body"]["stackFrames"][0];
    assert_eq!(f0["line"], 1);
    assert_eq!(f0["source"]["path"], top.as_str());
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();

    // A function from a file, called from the prompt, stops inside it; an
    // error typed at its Browse> prompt doesn't stop again.
    let m = d.mark();
    c.type_line("h(5)");
    d.event("stopped", m);
    assert_eq!(d.stack()[0], ("h".to_string(), 3));
    let m = d.mark();
    c.type_line("log('at browse')");
    c.expect("Error in log(\"at browse\")");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(d.count("stopped", m), 0);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("boom: 10");

    // Warnings follow the same rule.
    let m = d.mark();
    c.type_line("w()");
    let stop = d.event("stopped", m);
    assert_eq!(stop["body"]["reason"], "exception");
    assert_eq!(d.stack()[0], ("w".to_string(), 6));
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();

    // source() of a file with no breakpoints (base R's source()).
    let m = d.mark();
    c.type_line(&format!("source('{s}')"));
    d.event("stopped", m);
    let st = d.req("stackTrace", json!({"threadId": 1}));
    let f0 = &st["body"]["stackFrames"][0];
    assert_eq!(f0["line"], 2);
    assert_eq!(f0["source"]["path"], s.as_str());
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("Error in log(\"s\")");

    // keep.source = FALSE leaves no file to stop in...
    let m = d.mark();
    c.type_line(&format!("source('{s}', keep.source = FALSE)"));
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(d.count("stopped", m), 0);

    // ...unless the file has a breakpoint: Raven's source() parses it
    // with srcrefs to instrument it.
    let si = c.write_file("si.R", "unused <- function() {\n  1\n}\nq <- log('i')\n");
    d.req(
        "setBreakpoints",
        json!({"source": {"path": si}, "breakpoints": [{"line": 2}]}),
    );
    for keep in ["TRUE", "FALSE"] {
        let m = d.mark();
        c.type_line(&format!("source('{si}', keep.source = {keep})"));
        d.event("stopped", m);
        let st = d.req("stackTrace", json!({"threadId": 1}));
        let f0 = &st["body"]["stackFrames"][0];
        assert_eq!(f0["line"], 4, "keep.source = {keep}");
        assert_eq!(f0["source"]["path"], si.as_str());
        let m = d.mark();
        d.req("continue", json!({"threadId": 1}));
        d.event("terminated", m);
        d.session_ended();
    }
}

#[test]
fn uncaught_errors_in_file_code_print_a_traceback() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let a = c.write_file(
        "a.R",
        "inner <- function(x) {\n  log(x)\n}\nouter <- function(y) {\n  inner(y)\n}\nsig <- function() {\n  signalCondition(simpleError(\"sig\"))\n  1\n}\nodd <- function() {\n  stop(\"one\\x1etwo\\nthree\")\n}\n",
    );
    let b = c.write_file("b.R", "outer('a')\n");
    let tracebacks = |c: &Console| c.text().matches("Traceback:").count();
    let mut d = Dap::connect(&c);
    d.req("setExceptionBreakpoints", json!({"filters": []}));
    d.req("configurationDone", json!({}));
    c.send(&std::fs::read_to_string(&a).unwrap(), Some(&a));
    c.expect("> ");

    // From a file: every frame with its line, then the top-level line.
    c.send("outer('a')", Some(&b));
    c.expect("Traceback:");
    c.expect(&format!("inner(y) at {a}:2"));
    c.expect(&format!("outer(\"a\") at {a}:5"));
    c.expect(&format!("<top level> at {b}:1"));

    // Typed at the prompt, calling file code: the file frames only.
    c.type_line("outer('b')");
    c.expect(&format!("outer(\"b\") at {a}:5"));
    assert_eq!(tracebacks(&c), 2);

    // Nothing for a typo, a caught error, or a signal that ends nothing.
    c.type_line("log('typo')");
    c.expect("Error in log(\"typo\")");
    c.type_line("tryCatch(outer('c'), error = function(e) 'caught')");
    c.expect("\"caught\"");
    c.type_line("sig()");
    c.expect("[1] 1");
    c.type_line("cat('marker', '\\n')");
    c.expect("marker ");
    assert_eq!(tracebacks(&c), 2);

    // A message with a field separator and a newline doesn't garble it.
    c.type_line("odd()");
    c.expect(&format!("odd() at {a}:12"));
    assert_eq!(tracebacks(&c), 3);

    // After a stop: Continue prints it; Stop (Q) prints no error and none.
    d.req("setExceptionBreakpoints", json!({"filters": ["error"]}));
    let m = d.mark();
    c.type_line("outer('d')");
    d.event("stopped", m);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect("outer(\"d\") at");
    assert_eq!(tracebacks(&c), 4);
    let m = d.mark();
    c.type_line("outer('e')");
    d.event("stopped", m);
    let m = d.mark();
    d.req("terminate", json!({}));
    d.event("terminated", m);
    d.session_ended();
    c.type_line("cat('after stop', '\\n')");
    c.expect("after stop ");
    assert_eq!(tracebacks(&c), 4);
}

#[test]
fn warnings_from_file_code_name_their_lines() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let w = c.write_file(
        "w.R",
        "one <- function() {\n  log(-1)\n}\ntwo <- function() {\n  warning(strrep(\"x\", 1500))\n  sqrt(-1)\n}\nboth <- function() {\n  one()\n  two()\n  as.integer(\"z\")\n}\nmany <- function() {\n  for (i in 1:20) warning(\"w\", i)\n}\nstopper <- function() {\n  log(-1)\n  y <- 1\n  y\n}\n",
    );
    let mut d = Dap::connect(&c);
    d.req("setExceptionBreakpoints", json!({"filters": []}));
    d.req("configurationDone", json!({}));
    c.send(&std::fs::read_to_string(&w).unwrap(), Some(&w));
    c.expect("> ");

    // One warning: its line under R's message.
    c.type_line("one()");
    c.expect("NaNs produced");
    c.expect(&format!("  at {w}:2"));
    // Again: R's record is equal to the last one, but new.
    c.type_line("one()");
    let deadline = Instant::now() + TIMEOUT;
    while c.text().matches(&format!("  at {w}:2")).count() < 2 {
        assert!(Instant::now() < deadline, "second warning has no location");
        std::thread::sleep(Duration::from_millis(20));
    }

    // Several, numbered as R numbers them, including a message R
    // truncates and a warning from base code called at the prompt's level.
    c.type_line("both()");
    c.expect("Warning locations:");
    c.expect(&format!("  1: {w}:2"));
    c.expect(&format!("  2: {w}:5"));
    c.expect(&format!("  3: {w}:6"));
    c.expect(&format!("  4: {w}:11"));
    c.type_line("{ one(); as.integer('q') }");
    c.expect("  2: (no file)");

    // Typed at the prompt, muffled, printed at once, or too many to list:
    // nothing.
    let count = |c: &Console| c.text().matches(&format!("{w}:")).count();
    let before = count(&c);
    c.type_line("as.integer('typed')");
    c.expect("NAs introduced by coercion");
    c.type_line("suppressWarnings(one())");
    c.type_line("local({ op <- options(warn = 1); on.exit(options(op)); one() })");
    c.type_line("many()");
    c.expect("There were 20 warnings");
    c.type_line("cat('done', '\\n')");
    c.expect("done ");
    assert_eq!(count(&c), before);

    // A warning before a breakpoint: R prints it as the browser opens.
    d.req(
        "setBreakpoints",
        json!({"source": {"path": w}, "breakpoints": [{"line": 18}]}),
    );
    c.send(&std::fs::read_to_string(&w).unwrap(), Some(&w));
    std::thread::sleep(Duration::from_millis(300));
    let m = d.mark();
    c.type_line("stopper()");
    d.event("stopped", m);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
    c.expect(&format!("  at {w}:17"));

    // One typed at Browse> while stopped is its own block, with no file.
    let m = d.mark();
    c.type_line("stopper()");
    d.event("stopped", m);
    let at17 = format!("  at {w}:17");
    let deadline = Instant::now() + TIMEOUT;
    while c.text().matches(&at17).count() < 2 {
        assert!(Instant::now() < deadline, "no location at the second stop");
        std::thread::sleep(Duration::from_millis(20));
    }
    let no_file = c.text().matches("(no file)").count();
    c.type_line("log(-2)");
    c.expect("In log(-2)");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(c.text().matches(&at17).count(), 2);
    assert_eq!(c.text().matches("(no file)").count(), no_file);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    d.session_ended();
}

#[test]
fn inspect_last_error_opens_its_frames_after_the_fact() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let a = c.write_file(
        "a.R",
        "inner <- function(x) {\n  y <- paste0(x, \"!\")\n  log(y)\n}\nouter <- function(z) {\n  w <- toupper(z)\n  inner(w)\n}\n",
    );
    let mut d = Dap::connect(&c);
    d.req("setExceptionBreakpoints", json!({"filters": []}));
    d.req("configurationDone", json!({}));
    c.send(&std::fs::read_to_string(&a).unwrap(), Some(&a));
    c.expect("> ");
    assert_eq!(c.ipc_status("inspect"), "none");

    // An editor is connected: the traceback offers Inspect.
    let sub = UnixStream::connect(c.dir.join("i")).unwrap();
    writeln!(&sub, "{}", json!({"v": 1, "id": 2, "op": "subscribe"})).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    c.type_line("outer('a')");
    c.expect("Inspect it: run Raven: Inspect Last Error");

    // Inspect: the saved stack, its variables, and evaluation in a frame.
    for round in 0..2 {
        let m = d.mark();
        assert_eq!(c.ipc_status("inspect"), "ok");
        let stop = d.event("stopped", m);
        assert_eq!(stop["body"]["reason"], "exception", "round {round}");
        let st = d.stack();
        assert_eq!(st[0], ("inner".to_string(), 3));
        assert_eq!(st[1], ("outer".to_string(), 7));
        assert_eq!(d.locals().get("y").map(String::as_str), Some("\"A!\""));
        let frames = d.req("stackTrace", json!({"threadId": 1}));
        let outer_id = frames["body"]["stackFrames"][1]["id"].clone();
        let ev = d.req(
            "evaluate",
            json!({"expression": "w", "frameId": outer_id, "context": "repl"}),
        );
        assert_eq!(ev["body"]["result"], "[1] \"A\"");
        assert_eq!(c.ipc_status("inspect"), "stopped");
        // A step has nothing to run: it ends the inspection.
        let m = d.mark();
        d.req(
            if round == 0 { "next" } else { "stepIn" },
            json!({"threadId": 1}),
        );
        d.event("terminated", m);
        d.session_ended();
    }

    // A typed `n` at Browse> ends it too; R is back at the prompt.
    let m = d.mark();
    assert_eq!(c.ipc_status("inspect"), "ok");
    d.event("stopped", m);
    let m = d.mark();
    c.type_line("n");
    d.event("terminated", m);
    d.session_ended();
    c.type_line("cat('back', '\\n')");
    c.expect("back ");

    // Busy while R runs.
    c.type_line("Sys.sleep(1.5)");
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(c.ipc_status("inspect"), "busy");
    std::thread::sleep(Duration::from_millis(1500));

    // Busy at a continuation prompt or a readline(), where it can't open.
    c.send("(1 +", None);
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(c.ipc_status("inspect"), "busy");
    c.type_line("1)");
    c.expect("[1] 2");
    c.type_line("ans <- readline('answer: ')");
    c.expect("answer: ");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(c.ipc_status("inspect"), "busy");
    c.type_line("yes");
    c.type_line("cat(ans, '\\n')");
    c.expect("yes ");

    // The next printed error replaces it.
    c.type_line("inner(1:2 > 0)");
    c.expect("inner(1:2 > 0) at");
    let m = d.mark();
    assert_eq!(c.ipc_status("inspect"), "ok");
    d.event("stopped", m);
    assert_eq!(d.stack().len(), 2);
    let m = d.mark();
    d.req("terminate", json!({}));
    d.event("terminated", m);
    d.session_ended();
    drop(sub);
}

#[test]
fn tab_indented_and_non_ascii_sends_run_what_they_echo() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let a = c.write_file("tabs.R", "");
    // R reports display columns (a tab spans to the next multiple of 8):
    // slicing by them as characters once ran `e <- 42` here.
    c.send("\tlongname <- 42", Some(&a));
    c.send("cat('ran:', exists('longname'), exists('e'), '\\n')", None);
    c.expect("ran: TRUE FALSE");
    // Tabs before and inside expressions, non-ASCII strings, and a
    // multi-line expression whose later lines are tab-indented.
    c.send(
        "s <- \"\u{e9}\u{65e5}\"; \tv <- c(1,\n\t\t2); \"\t\u{e9}\" -> q\n\tw <- nchar(q)",
        Some(&a),
    );
    c.send(
        "cat('vals:', s == '\u{e9}\u{65e5}', identical(v, c(1, 2)), w, '\\n')",
        None,
    );
    c.expect("vals: TRUE TRUE 2");
    // Breakpoints still bind and stop on the right line of tab-indented,
    // non-ASCII sent code.
    let src =
        "\tf <- function() {\n\t\tz <- \"\u{65e5}\u{672c}\"; \ty <- 2\n\t\ty + nchar(z)\n\t}\n";
    let b = c.write_file("tabs2.R", src);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": b}, "breakpoints": [{"line": 3}]}),
    );
    d.req("configurationDone", json!({}));
    let m = d.mark();
    c.send(src, Some(&b));
    let bp = d.event("breakpoint", m);
    assert_eq!(bp["body"]["breakpoint"]["verified"], true, "{bp}");
    let m = d.mark();
    c.send("f()", None);
    d.event("stopped", m);
    assert_eq!(d.stack()[0], ("f".to_string(), 3));
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    c.expect("[1] 4");
}

#[test]
fn source_exprs_keeps_its_semantics_with_a_breakpoint_armed() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let other = c.write_file("other.R", "x <- 1\nx <- 2\n");
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": other}, "breakpoints": [{"line": 2}]}),
    );
    d.req("configurationDone", json!({}));
    std::thread::sleep(Duration::from_millis(300));
    // The wrapper installed for the breakpoint must leave `exprs` to
    // base source(), which evaluates it in `local`.
    c.send(
        "e <- new.env(); res <- source(exprs = quote(x <- 12), local = e); cat('exprs:', e$x, res$visible, '\\n')",
        None,
    );
    c.expect("exprs: 12 FALSE");
    // Arguments are still evaluated once, lazily, by source() itself.
    c.send(
        "n <- 0; src <- function() { n <<- n + 1; textConnection('k <- 3') }; source(src(), local = e); cat('evals:', n, e$k, '\\n')",
        None,
    );
    c.expect("evals: 1 3");
}

#[test]
fn hover_runs_no_user_methods_and_reads_s4_slots() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("configurationDone", json!({}));
    c.send(
        "hits <- 0\n\
         counted <- function(x, ...) { hits <<- hits + 1; NextMethod() }\n\
         for (g in c(\"[\", \"[[\", \"as.character\")) registerS3method(g, \"labelset\", counted)\n\
         fac <- structure(1L, levels = structure(\"a\", class = \"labelset\"), class = \"factor\")\n\
         when <- structure(0, tzone = structure(\"UTC\", class = \"labelset\"), class = c(\"POSIXct\", \"POSIXt\"))\n\
         setClass(\"Box\", representation(value = \"numeric\", any = \"ANY\"))\n\
         obj <- new(\"Box\", value = 7)\n\
         setClass(\"WrappedNumbers\", contains = \"numeric\", representation(tag = \"character\"))\n\
         wrapped <- new(\"WrappedNumbers\", c(a = 4), tag = \"t\")\n\
         setClass(\"Grid\", contains = \"matrix\")\n\
         grid <- new(\"Grid\", matrix(1:4, 2))\n\
         setClass(\"Bag\", contains = \"list\")\n\
         bag <- new(\"Bag\", list(1, \"a\"))\n\
         setClass(\"Scope\", contains = \"environment\")\n\
         scope <- new(\"Scope\")\n\
         registerS3method(\"length\", \"pkgtag\", counted)\n\
         tagged <- new(\"WrappedNumbers\", 5, tag = \"t\")\n\
         tcls <- attr(tagged, \"class\"); attr(tcls, \"package\") <- structure(\".GlobalEnv\", class = \"pkgtag\")\n\
         attr(tagged, \"class\") <- tcls\n\
         hits <- 0\n\
         hv <- function() { browser(); 1 }",
        None,
    );
    std::thread::sleep(Duration::from_millis(300));
    let m = d.mark();
    c.send("hv()", None);
    d.event("stopped", m);
    let hover = |d: &mut Dap, e: &str| {
        d.req(
            "evaluate",
            json!({"expression": e, "frameId": 2, "context": "hover"}),
        )
    };
    let fac = hover(&mut d, "fac");
    assert_eq!(fac["body"]["result"], "a", "{fac}");
    let when = hover(&mut d, "when");
    assert!(
        when["body"]["result"]
            .as_str()
            .unwrap()
            .starts_with("1970-01-01"),
        "{when}"
    );
    // Hovering reads `hits` without running anything either.
    let hits = hover(&mut d, "hits");
    assert_eq!(hits["body"]["result"], "0", "a hover ran a user method");
    let slot = hover(&mut d, "obj@value");
    assert_eq!(slot["body"]["result"], "7", "{slot}");
    let empty = hover(&mut d, "obj@any");
    assert_eq!(empty["body"]["result"], "NULL", "{empty}");
    // `.Data` is the data part, which is no attribute: the object without
    // its slots. Each matches what `x@.Data` prints in R.
    let data = hover(&mut d, "wrapped@.Data");
    assert_eq!(data["body"]["result"], "4", "{data}");
    assert_eq!(data["body"]["type"], "num", "{data}");
    let data = hover(&mut d, "grid@.Data");
    assert_eq!(data["body"]["result"], "int [2 x 2] 1 2 3 4", "{data}");
    let data = hover(&mut d, "bag@.Data");
    assert_eq!(data["body"]["result"], "list [2]", "{data}");
    let data = hover(&mut d, "scope@.Data");
    assert_eq!(data["body"]["type"], "environment", "{data}");
    // Class metadata with a class of its own could dispatch: not read.
    let data = hover(&mut d, "tagged@.Data");
    assert_eq!(data["success"], false, "{data}");
    // A class with no data part: NULL, as in R.
    let data = hover(&mut d, "obj@.Data");
    assert_eq!(data["body"]["result"], "NULL", "{data}");
    let hits = hover(&mut d, "hits");
    assert_eq!(hits["body"]["result"], "0", "a hover ran a user method");
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
}

#[test]
fn user_output_that_looks_like_a_probe_announcement_is_shown() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    c.send("cat(\"debug at <raven-probe>#1\\n\"); print(24680)", None);
    c.expect("[1] 24680");
    assert!(
        c.text()
            .lines()
            .any(|l| l.trim_end() == "debug at <raven-probe>#1"),
        "{}",
        c.text()
    );
}

/// True once the console shows `line` as a whole output line.
fn shows_line(c: &Console, line: &str) -> bool {
    c.text().lines().any(|l| l.trim_end() == line)
}

#[test]
fn lookalike_output_is_shown_before_readline_asks() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    // Upper-cased by the program, so the echoed code can't match.
    c.send(
        "{ cat(\"debug at <raven-probe>#1\\n\"); cat(toupper(\"choose a number\\n\")); flush.console(); ans <- readline(); cat(toupper(\"got\"), ans, \"\\n\") }",
        None,
    );
    // Instructions printed before readline() are on screen while it waits.
    c.expect("CHOOSE A NUMBER");
    assert!(shows_line(&c, "debug at <raven-probe>#1"), "{}", c.text());
    c.type_line("7");
    c.expect("GOT 7");
    // A prompt label that is the start of an announcement, with no newline.
    c.send(
        "{ cat(\"Called \"); ans <- readline(); cat(toupper(\"then\"), ans, \"\\n\") }",
        None,
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !c.text().lines().any(|l| l.starts_with("Called ")) {
        assert!(
            Instant::now() < deadline,
            "the label is held back while readline() waits: {}",
            c.text()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    c.type_line("8");
    c.expect("THEN 8");
}

#[test]
fn lookalike_output_is_shown_before_r_quits() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    c.send(
        "cat(\"debug at <raven-probe>#1\\n\"); cat(toupper(\"last words\\n\")); q(\"no\")",
        None,
    );
    c.expect("LAST WORDS");
    assert!(shows_line(&c, "debug at <raven-probe>#1"), "{}", c.text());
}

#[test]
fn lookalike_output_is_shown_at_a_browser_prompt() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let file = c.write_file(
        "look.R",
        "g <- function() {\n  cat(\"debug at <raven-probe>#1\\n\")\n  cat(toupper(\"kept before the stop\\n\"))\n  z <- 1\n  z\n}\n",
    );
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": file}, "breakpoints": [{"line": 4}]}),
    );
    d.req("configurationDone", json!({}));
    let m = d.mark();
    c.send(&std::fs::read_to_string(&file).unwrap(), Some(&file));
    d.event("breakpoint", m);
    // Printed by the program just before a breakpoint stops it: only R's
    // own announcement of the debugger's step is hidden.
    let m = d.mark();
    c.send("g()", None);
    assert_eq!(d.event("stopped", m)["body"]["reason"], "breakpoint");
    c.expect("KEPT BEFORE THE STOP");
    assert!(shows_line(&c, "debug at <raven-probe>#1"), "{}", c.text());
    // Typed at Browse>: R announces nothing before the prompt returns.
    c.type_line("cat(\"debug at <raven-probe>#2\\n\"); cat(toupper(\"typed while stopped\\n\"))");
    c.expect("TYPED WHILE STOPPED");
    assert!(shows_line(&c, "debug at <raven-probe>#2"), "{}", c.text());
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    let text = c.text();
    assert!(!text.contains("base::identical("), "{text}");
    assert!(!text.contains("Called from:"), "{text}");
}

#[test]
fn ascii_sends_still_bind_breakpoints_outside_a_utf8_locale() {
    if !r_available() {
        return;
    }
    // Outside UTF-8, only non-ASCII sends fall back to raw feeding.
    let c = Console::spawn_with_env(&[("LC_ALL", "C"), ("LANG", "C")]);
    let a = c.write_file("a.R", F_R);
    let mut d = Dap::connect(&c);
    d.req(
        "setBreakpoints",
        json!({"source": {"path": a}, "breakpoints": [{"line": 3}]}),
    );
    d.req("configurationDone", json!({}));
    c.send("cat('utf8:', l10n_info()[['UTF-8']], '\\n')", None);
    c.expect("utf8: FALSE");
    let m = d.mark();
    c.send(F_R, Some(&a));
    let bp = d.event("breakpoint", m);
    assert_eq!(bp["body"]["breakpoint"]["verified"], true, "{bp}");
    let m = d.mark();
    c.send("f(1)", None);
    d.event("stopped", m);
    assert_eq!(d.stack()[0], ("f".to_string(), 3));
}

/// A `subscribe`d control connection: the events the console pushes.
struct Subscriber {
    reader: BufReader<UnixStream>,
}

impl Subscriber {
    fn connect(c: &Console) -> Subscriber {
        let s = UnixStream::connect(c.dir.join("i")).expect("ipc connect");
        s.set_read_timeout(Some(TIMEOUT)).unwrap();
        let mut w = s.try_clone().unwrap();
        writeln!(w, "{}", json!({"v": 1, "id": 1, "op": "subscribe"})).unwrap();
        let mut reader = BufReader::new(s);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("\"ok\""), "subscribe: {line}");
        Subscriber { reader }
    }

    /// The next pushed event named `name`, skipping others; `None` once
    /// nothing arrives for `wait`. A closed or broken subscription fails
    /// the test rather than passing for a quiet one.
    fn event(&mut self, name: &str, wait: Duration) -> Option<Value> {
        self.reader.get_ref().set_read_timeout(Some(wait)).unwrap();
        let mut line = String::new();
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("the console closed the subscription"),
                Ok(_) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    return None;
                }
                Err(e) => panic!("reading the subscription: {e}"),
            }
            let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            if v["event"] == name {
                return Some(v);
            }
        }
    }
}

#[test]
fn a_mirror_is_answered_unavailable_once_the_debugger_cannot_start() {
    if !r_available() {
        return;
    }
    // `not-ready` would keep the extension resending (and holding the
    // console's first send) for as long as its retry budget lasts.
    for dap in [DapArg::Unbindable, DapArg::Off] {
        let c = Console::launch(&[], dap, &["--no-save", "--no-restore", "--vanilla", "-q"]);
        let mirror = json!({"v": 1, "id": 1, "op": "breakpoints", "files": {}});
        let deadline = Instant::now() + Duration::from_secs(15);
        let status = loop {
            let status = ipc_request(&c, &mirror);
            if status != "not-ready" || Instant::now() > deadline {
                break status;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(status, "unavailable", "{}", c.text());
    }
}

#[test]
fn a_subscriber_hears_when_the_debugger_starts_after_slow_profiles() {
    if !r_available() {
        return;
    }
    let dir = scratch();
    let profile = dir.join("slow.R");
    // The profile runs until the test has seen `not-ready` (bounded, so a
    // failed test doesn't leave R waiting).
    let go = dir.join("go");
    std::fs::write(
        &profile,
        format!(
            "for (i in 1:600) {{ if (file.exists({:?})) break; Sys.sleep(0.05) }}\n",
            go.to_str().unwrap()
        ),
    )
    .unwrap();
    let c = Console::launch(
        &[("R_PROFILE_USER", profile.to_str().unwrap())],
        DapArg::Socket,
        &[
            "--no-save",
            "--no-restore",
            "--no-site-file",
            "--no-environ",
            "-q",
        ],
    );
    let mut sub = Subscriber::connect(&c);
    let mirror = json!({"v": 1, "id": 1, "op": "breakpoints", "files": {}});
    // R is still running the profile.
    assert_eq!(ipc_request(&c, &mirror), "not-ready");
    std::fs::write(&go, "").unwrap();
    assert!(
        sub.event("ready", TIMEOUT).is_some(),
        "no ready event:\n{}",
        c.text()
    );
    assert_eq!(ipc_request(&c, &mirror), "ok");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_stalled_mirror_cannot_restore_function_breakpoints_removed_since() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let deadline = Instant::now() + TIMEOUT;
    while c.ipc_status("breakpoints") != "ok" {
        assert!(Instant::now() < deadline, "debugger never became ready");
        std::thread::sleep(Duration::from_millis(50));
    }
    c.send("fb_target <- function() 1", None);
    // Errors stop only in code from a file.
    let e = c.write_file(
        "err.R",
        "err_target <- function() stop(toupper('filter stayed off'))\n",
    );
    c.send(&std::fs::read_to_string(&e).unwrap(), Some(&e));
    let fifo = c.dir.join("stall.R");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let fifo = fifo.to_string_lossy().into_owned();
    // An older mirror, carrying a function breakpoint, stalls reading a
    // file...
    let stalled = {
        let msg = json!({"v": 1, "id": 2, "op": "breakpoints",
            "files": {&fifo: [{"line": 1}]},
            "functions": ["fb_target"], "exceptionFilters": ["error"]});
        let s = UnixStream::connect(c.dir.join("i")).expect("ipc connect");
        s.set_read_timeout(Some(TIMEOUT)).unwrap();
        let mut w = s.try_clone().unwrap();
        writeln!(w, "{msg}").unwrap();
        s
    };
    let mut writer = {
        use std::os::unix::fs::OpenOptionsExt;
        let deadline = Instant::now() + TIMEOUT;
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&fifo)
            {
                Ok(f) => break f,
                Err(e) => {
                    assert!(Instant::now() < deadline, "the request never read: {e}");
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
    };
    // ... a newer one (the user removed the breakpoint) is applied ...
    let newer = json!({"v": 1, "id": 3, "op": "breakpoints", "files": {},
        "functions": [], "exceptionFilters": []});
    assert_eq!(ipc_request(&c, &newer), "ok");
    // ... and then the older one finishes.
    writer.write_all(b"z <- 1\n").unwrap();
    drop(writer);
    let mut line = String::new();
    BufReader::new(stalled).read_line(&mut line).unwrap();
    assert!(line.contains("\"ok\""), "{line}");
    std::thread::sleep(Duration::from_millis(300));
    c.send(
        "fb_target(); cat(toupper('ran past fb_target'), '\\n')",
        None,
    );
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let text = c.text();
        assert!(
            !text.contains("Browse["),
            "the older mirror re-armed a removed function breakpoint:\n{text}"
        );
        if text.contains("RAN PAST FB_TARGET") {
            break;
        }
        assert!(Instant::now() < deadline, "{text}");
        std::thread::sleep(Duration::from_millis(20));
    }
    // Nor the exception filter it carried: the error returns to the prompt.
    c.send("err_target()", None);
    c.send("cat(toupper('back at the prompt'), '\\n')", None);
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let text = c.text();
        assert!(
            !text.contains("Browse["),
            "the older mirror re-armed a removed exception filter:\n{text}"
        );
        if text.contains("BACK AT THE PROMPT") {
            assert!(text.contains("FILTER STAYED OFF"), "{text}");
            break;
        }
        assert!(Instant::now() < deadline, "{text}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn subscribing_while_r_is_stopped_reports_the_stop() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let deadline = Instant::now() + TIMEOUT;
    while c.ipc_status("breakpoints") != "ok" {
        assert!(Instant::now() < deadline, "debugger never became ready");
        std::thread::sleep(Duration::from_millis(50));
    }
    let a = c.write_file("a.R", "x <- 1\ny <- 2\n");
    let arm = json!({"v": 1, "id": 1, "op": "breakpoints", "files": {&a: [{"line": 2}]}});
    assert_eq!(ipc_request(&c, &arm), "ok");
    // No editor is connected when R stops.
    c.send(&format!("source({a:?})"), None);
    c.expect("Browse[");
    let mut sub = Subscriber::connect(&c);
    let ev = sub.event("stopped", Duration::from_secs(5));
    assert_eq!(
        ev.as_ref().map(|v| v["reason"].clone()),
        Some(json!("breakpoint")),
        "{}",
        c.text()
    );
    // Once a session shows the stop, another window subscribing isn't sent
    // it (its auto-attach would take the session over).
    let mut d = Dap::connect(&c);
    let m = d.mark();
    d.req("configurationDone", json!({}));
    d.event("stopped", m);
    let mut other = Subscriber::connect(&c);
    assert!(
        other.event("stopped", Duration::from_secs(1)).is_none(),
        "replayed a stop a live session shows"
    );
}

/// Two consoles given the same `--ipc`/`--dap` paths (only possible from the
/// command line: the extension makes each console a directory of its own).
/// The second is refused both sockets and the first keeps its clients; a
/// console killed outright leaves its sockets behind, and the next console
/// on those paths replaces them.
#[test]
fn a_second_console_on_live_sockets_is_refused_and_stale_sockets_are_replaced() {
    if !r_available() {
        return;
    }
    let args = ["--no-save", "--no-restore", "--vanilla", "-q"];
    let mut a = Console::spawn();
    a.keep_dir = true;
    let dir = a.dir.clone();
    let mut d = Dap::connect(&a);
    d.req("configurationDone", json!({}));

    let mut b = Console::launch_in(dir.clone(), &[], DapArg::Socket, &args);
    b.keep_dir = true;
    for socket in ["i", "d"] {
        b.expect(&format!(
            "cannot listen on {}: another raven console is listening here",
            dir.join(socket).display()
        ));
    }
    // New connections reach A, not B...
    let m = d.mark();
    a.send(
        "(function() { held <- toupper('in the first console'); browser() })()",
        None,
    );
    a.expect("Browse[");
    assert!(!b.text().contains("Browse["), "{}", b.text());
    // ...and the session connected before B started is still A's.
    d.event("stopped", m);
    assert_eq!(
        d.locals().get("held").map(String::as_str),
        Some("\"IN THE FIRST CONSOLE\"")
    );
    // So is a session connected after.
    assert!(!Dap::open(&dir, true).stack().is_empty());

    // Both die without a chance to clean up.
    drop(b);
    drop(a);
    assert!(dir.join("i").exists() && dir.join("d").exists());
    let c = Console::launch_in(dir.clone(), &[], DapArg::Socket, &args);
    let mirror = json!({"v": 1, "id": 1, "op": "breakpoints", "files": {}});
    let deadline = Instant::now() + TIMEOUT;
    loop {
        // Until C replaces it, the stale socket refuses connections.
        let status = UnixStream::connect(dir.join("i")).ok().map(|s| {
            s.set_read_timeout(Some(TIMEOUT)).unwrap();
            let mut w = s.try_clone().unwrap();
            writeln!(w, "{mirror}").unwrap();
            let mut line = String::new();
            let _ = BufReader::new(s).read_line(&mut line);
            line
        });
        if status.is_some_and(|l| l.contains("\"ok\"")) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the new console never listened:\n{}",
            c.text()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!c.text().contains("cannot listen"), "{}", c.text());
    c.send("cat(toupper('reached the new console'), '\\n')", None);
    c.expect("REACHED THE NEW CONSOLE");
    let mut d = Dap::open(&dir, true);
    assert_eq!(d.req("threads", json!({}))["success"], true);
}

/// A console stopped at line 2 of a two-line file (the only stop that
/// program makes), with a subscriber connected before any session.
fn stopped_once(c: &Console) -> Subscriber {
    let deadline = Instant::now() + TIMEOUT;
    while c.ipc_status("breakpoints") != "ok" {
        assert!(Instant::now() < deadline, "debugger never became ready");
        std::thread::sleep(Duration::from_millis(50));
    }
    let a = c.write_file("a.R", "x <- 1\ny <- 2\n");
    let arm = json!({"v": 1, "id": 1, "op": "breakpoints", "files": {&a: [{"line": 2}]}});
    assert_eq!(ipc_request(c, &arm), "ok");
    let mut sub = Subscriber::connect(c);
    c.send(&format!("source({a:?})"), None);
    assert!(sub.event("stopped", TIMEOUT).is_some(), "{}", c.text());
    sub
}

/// A session attached to the stop and showing it.
fn showing_the_stop(c: &Console) -> Dap {
    let d = Dap::open(&c.dir, true);
    d.event("stopped", 0);
    d
}

const QUIET: Duration = Duration::from_millis(1500);

/// A second window subscribes while the first shows a stop, so it is not
/// told of it. If the first then loses its debug connection without ending
/// the session, the stop is announced again, or the second would never
/// attach.
#[test]
fn a_stop_is_announced_again_when_the_session_showing_it_drops() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let _first = stopped_once(&c);
    let d = showing_the_stop(&c);
    let mut other = Subscriber::connect(&c);
    assert!(
        other.event("stopped", QUIET).is_none(),
        "replayed a stop a live session shows"
    );
    // The window showing the stop is gone without a word. (Both halves:
    // the test client's reader thread holds a clone of the socket.)
    d.w.shutdown(std::net::Shutdown::Both).unwrap();
    let ev = other.event("stopped", Duration::from_secs(5));
    assert_eq!(
        ev.as_ref().map(|v| v["reason"].clone()),
        Some(json!("breakpoint")),
        "{}",
        c.text()
    );
    // Once: the stop is not announced over and over.
    assert!(other.event("stopped", QUIET).is_none());
    // The session that attaches now is shown the same stop.
    let mut d = showing_the_stop(&c);
    assert_eq!(d.stack()[0].1, 2);
    // A connection the newer session replaced closing changes nothing...
    let mut newer = showing_the_stop(&c);
    d.w.shutdown(std::net::Shutdown::Both).unwrap();
    assert!(
        other.event("stopped", QUIET).is_none(),
        "announced a stop the replacement session shows"
    );
    assert_eq!(newer.stack()[0].1, 2);
}

/// A session that stops reading its connection (a hung extension host) is
/// dropped when a write to it times out, before its reader sees anything.
/// The stop it showed is announced again then too.
#[test]
fn a_stop_is_announced_again_when_a_write_to_its_session_fails() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let _first = stopped_once(&c);
    // A client that never reads what the console sends it.
    let mut hung = UnixStream::connect(c.dir.join("d")).expect("dap connect");
    hung.set_write_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let mut reader = hung.try_clone().unwrap();
    let mut seq = 0;
    let mut request = |command: &str| {
        seq += 1;
        let body = serde_json::to_vec(&json!({"seq": seq, "type": "request", "command": command,
            "arguments": {"threadId": 1}}))
        .unwrap();
        let framed = [
            format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes(),
            body,
        ]
        .concat();
        hung.write_all(&framed).is_ok()
    };
    for command in ["initialize", "attach", "configurationDone"] {
        assert!(request(command));
    }
    // It reads as far as the stop it is shown, and never again.
    let mut seen = Vec::new();
    reader.set_read_timeout(Some(TIMEOUT)).unwrap();
    while !String::from_utf8_lossy(&seen).contains("\"event\":\"stopped\"") {
        let mut buf = [0u8; 4096];
        let n = reader
            .read(&mut buf)
            .expect("the session was never shown the stop");
        assert!(n > 0, "the console closed the session");
        seen.extend_from_slice(&buf[..n]);
    }
    let mut other = Subscriber::connect(&c);
    assert!(
        other.event("stopped", QUIET).is_none(),
        "replayed a stop a live session shows"
    );
    // Responses pile up until the socket's buffer is full; the console's
    // write then times out (5 s). Requests stop once the console stops
    // taking them.
    let deadline = Instant::now() + TIMEOUT;
    let mut taking = true;
    let ev = loop {
        for _ in 0..200 {
            taking = taking && request("stackTrace");
        }
        if let Some(ev) = other.event("stopped", Duration::from_millis(200)) {
            break ev;
        }
        assert!(
            Instant::now() < deadline,
            "the stop was never announced again:\n{}",
            c.text()
        );
    };
    assert_eq!(ev["reason"], "breakpoint");
    let mut d = showing_the_stop(&c);
    assert_eq!(d.stack()[0].1, 2);
}

/// Every session's connection closes in the end. A stop is not announced
/// again when the session ended first: it is being resumed or quit, and a
/// window told of it would attach to a stop that is going away. Here, a
/// user detach (R continues).
#[test]
fn a_stop_is_not_announced_again_after_a_detach() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let _first = stopped_once(&c);
    let mut d = showing_the_stop(&c);
    let mut other = Subscriber::connect(&c);
    d.req("disconnect", json!({"terminateDebuggee": false}));
    d.w.shutdown(std::net::Shutdown::Both).unwrap();
    assert!(other.event("stopped", QUIET).is_none());
}

/// Nor after Stop, which quits the browser.
#[test]
fn a_stop_is_not_announced_again_after_terminate() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let _first = stopped_once(&c);
    let mut d = showing_the_stop(&c);
    let mut other = Subscriber::connect(&c);
    d.req("terminate", json!({}));
    d.w.shutdown(std::net::Shutdown::Both).unwrap();
    assert!(other.event("stopped", QUIET).is_none());
}

/// Nor after Continue, even when the connection is lost before R has taken
/// the command.
#[test]
fn a_stop_is_not_announced_again_when_a_continue_is_pending() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let _first = stopped_once(&c);
    let mut d = showing_the_stop(&c);
    let mut other = Subscriber::connect(&c);
    d.send("continue", json!({"threadId": 1}));
    d.w.shutdown(std::net::Shutdown::Both).unwrap();
    assert!(other.event("stopped", QUIET).is_none());
    c.send("cat(toupper('ran on'), '\\n')", None);
    c.expect("RAN ON");
}

/// The console ended the session (R reached the prompt) and R stops again
/// while the editor is still tearing that session down: the new stop is
/// announced once, as any stop is, and not again when the old session's
/// connection closes.
#[test]
fn a_stop_is_not_announced_again_when_an_ended_session_closes() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let mut first = stopped_once(&c);
    let mut d = showing_the_stop(&c);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    let a = c.dir.join("a.R");
    c.send(&format!("source({a:?})"), None);
    assert!(first.event("stopped", TIMEOUT).is_some(), "{}", c.text());
    d.w.shutdown(std::net::Shutdown::Both).unwrap();
    assert!(first.event("stopped", QUIET).is_none());
}

/// A resume ends the stop for subscribers at once, not when R next reaches
/// the top-level prompt: a window holding the stop back for a launch that is
/// still resolving must not attach to it after the user typed `c`, however
/// long the resumed code runs.
#[test]
fn a_resume_tells_subscribers_the_stop_is_over_while_r_runs_on() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let deadline = Instant::now() + TIMEOUT;
    while c.ipc_status("breakpoints") != "ok" {
        assert!(Instant::now() < deadline, "debugger never became ready");
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut sub = Subscriber::connect(&c);
    // After each stop R waits (bounded) for a file the test creates, so
    // "R is still running" is certain when the event is checked.
    let (go1, go2) = (c.dir.join("go1"), c.dir.join("go2"));
    c.send(
        &format!(
            "(function() {{ hold <- function(f) for (i in 1:600) {{ if (file.exists(f)) break; Sys.sleep(0.05) }}; \
             browser(); hold({go1:?}); browser(); hold({go2:?}); cat(toupper('ran to the end'), '\\n') }})()"
        ),
        None,
    );
    assert!(sub.event("stopped", TIMEOUT).is_some(), "{}", c.text());
    // Typed at `Browse>`.
    c.type_line("c");
    assert!(
        sub.event("running", Duration::from_secs(5)).is_some(),
        "no `running` while R ran on after a typed `c`:\n{}",
        c.text()
    );
    std::fs::write(&go1, "").unwrap();
    // The next stop is announced after it; a debug session continues it.
    assert!(sub.event("stopped", TIMEOUT).is_some(), "{}", c.text());
    let mut d = Dap::open(&c.dir, true);
    d.event("stopped", 0);
    d.req("continue", json!({"threadId": 1}));
    assert!(
        sub.event("running", Duration::from_secs(5)).is_some(),
        "no `running` while R ran on after Continue:\n{}",
        c.text()
    );
    std::fs::write(&go2, "").unwrap();
    c.expect("RAN TO THE END");
}

/// The value an evaluate in the Debug Console prints, at the top frame.
fn repl_value(d: &mut Dap, expr: &str) -> String {
    let st = d.req("stackTrace", json!({"threadId": 1}));
    let frame = st["body"]["stackFrames"][0]["id"].clone();
    let ev = d.req(
        "evaluate",
        json!({"expression": expr, "frameId": frame, "context": "repl"}),
    );
    ev["body"]["result"].as_str().unwrap_or("").to_string()
}

#[test]
fn set_value_on_a_long_unnamed_vector_labels_only_that_element() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("configurationDone", json!({}));
    c.send(
        "lv <- function() {\n  x <- numeric(3e6)\n  browser()\n  cat('fir', 'st', x[1], '\\n')\n}",
        None,
    );
    let m = d.mark();
    c.send("lv()", None);
    d.event("stopped", m);
    let st = d.req("stackTrace", json!({"threadId": 1}));
    let frame = st["body"]["stackFrames"][0]["id"].clone();
    let sc = d.req("scopes", json!({"frameId": frame}));
    let locals = d.req(
        "variables",
        json!({"variablesReference": sc["body"]["scopes"][0]["variablesReference"]}),
    );
    let x = locals["body"]["variables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "x")
        .unwrap()
        .clone();
    let page = d.req(
        "variables",
        json!({"variablesReference": x["variablesReference"], "start": 0, "count": 100}),
    );
    assert_eq!(page["body"]["variables"][0]["name"], "[1]");
    // Peak memory while setting one element: a label per element would be
    // millions of strings (well over 100 MB); x itself is 24 MB.
    let base: f64 = repl_value(&mut d, "cat(gc(reset = TRUE)[2, 2])") // Vcells used, MB
        .trim()
        .parse()
        .unwrap();
    let set = d.req(
        "setVariable",
        json!({"variablesReference": x["variablesReference"], "name": "[1]", "value": "42"}),
    );
    assert_eq!(set["success"], true, "{set}");
    let peak: f64 = repl_value(&mut d, "g <- gc(); cat(g[2, ncol(g)])")
        .trim()
        .parse()
        .unwrap();
    assert!(
        peak - base < 40.0,
        "setting one element peaked {} MB above {base} MB",
        peak - base
    );
    // A label past the end names nothing.
    let past = d.req(
        "setVariable",
        json!({"variablesReference": x["variablesReference"], "name": "[3000001]", "value": "1"}),
    );
    assert_eq!(past["success"], false, "{past}");
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    c.expect("fir st 42");
}

#[test]
fn inspect_last_error_sees_frames_under_a_hooked_source() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let s = c.write_file(
        "s.R",
        "g <- function() {\n  1\n}\nh <- function(x) {\n  y <- x * 2\n  stop(\"boom \", y)\n}\nh(21)\n",
    );
    let mut d = Dap::connect(&c);
    d.req("setExceptionBreakpoints", json!({"filters": []}));
    // Armed in a function the script never calls: source() goes through
    // the debugger's wrapper, and nothing stops.
    d.req(
        "setBreakpoints",
        json!({"source": {"path": s}, "breakpoints": [{"line": 2}]}),
    );
    d.req("configurationDone", json!({}));
    let sub = UnixStream::connect(c.dir.join("i")).unwrap();
    writeln!(&sub, "{}", json!({"v": 1, "id": 2, "op": "subscribe"})).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    c.type_line(&format!("source('{s}')"));
    c.expect("boom 42");
    c.expect("Inspect it: run Raven: Inspect Last Error");
    let m = d.mark();
    assert_eq!(c.ipc_status("inspect"), "ok");
    let stop = d.event("stopped", m);
    assert_eq!(stop["body"]["reason"], "exception");
    assert_eq!(d.stack()[0], ("h".to_string(), 6));
    assert_eq!(d.locals().get("y").map(String::as_str), Some("42"));
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    drop(sub);
}

#[test]
fn a_breakpoint_set_while_busy_binds_before_a_queued_source() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let a = c.write_file(
        "analysis.R",
        "u <- 1\nv <- u + 1\ncat('r', 'an', v, '\\n')\n",
    );
    let mut d = Dap::connect(&c);
    d.req("configurationDone", json!({}));
    // R stays busy until the test opens the gate.
    let gate = c.dir.join("gate");
    c.type_line(&format!(
        "cat('bu', 'sy\\n'); while (!file.exists('{}')) Sys.sleep(0.05)",
        gate.display()
    ));
    c.expect("bu sy");
    // The session's first breakpoint, while R is busy...
    d.req(
        "setBreakpoints",
        json!({"source": {"path": a}, "breakpoints": [{"line": 2}]}),
    );
    // ... then Source File, queued behind the running code.
    let m = d.mark();
    c.send(&format!("source('{a}')"), None);
    std::fs::write(&gate, "").unwrap();
    let stop = d.event("stopped", m);
    assert_eq!(stop["body"]["reason"], "breakpoint");
    assert_eq!(d.stack()[0].1, 2);
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    c.expect("r an 2");
}

#[test]
fn a_virtual_source_keeps_its_text_for_the_session() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("configurationDone", json!({}));
    c.send(
        "vs <- function() {\n  lapply(1, function(i) browser())\n  vapply(1, function(i) { browser(); 1 }, 1)\n}",
        None,
    );
    let virtual_frame = |d: &mut Dap, name: &str| {
        let st = d.req("stackTrace", json!({"threadId": 1}));
        st["body"]["stackFrames"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .and_then(|f| f["source"]["sourceReference"].as_i64())
            .unwrap_or_else(|| panic!("no virtual source for {name}: {st}"))
    };
    let content = |d: &mut Dap, r: i64| {
        d.req("source", json!({"sourceReference": r}))["body"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string()
    };
    let m = d.mark();
    c.send("vs()", None);
    d.event("stopped", m);
    let first = virtual_frame(&mut d, "lapply");
    assert!(content(&mut d, first).starts_with("lapply <- function"));
    // The next stop, in the same session, has another function without
    // source on its stack.
    let stop = d.step("continue");
    assert_eq!(stop["body"]["reason"], "breakpoint", "{stop}");
    let second = virtual_frame(&mut d, "vapply");
    assert_ne!(first, second);
    assert!(content(&mut d, second).starts_with("vapply <- function"));
    // The first tab's reference still names lapply.
    let again = content(&mut d, first);
    assert!(
        again.starts_with("lapply <- function"),
        "reference {first} now names: {}",
        again.lines().next().unwrap_or("")
    );
    // A client that attaches to a stop R already made (as VS Code does)
    // still opens that stop's sources.
    let mut d = Dap::open(&c.dir, true);
    d.event("stopped", 0);
    let attached = virtual_frame(&mut d, "vapply");
    assert_eq!(attached, second);
    assert!(content(&mut d, attached).starts_with("vapply <- function"));
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
}

#[test]
fn a_finished_stop_lets_go_of_its_frames() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let mut d = Dap::connect(&c);
    d.req("configurationDone", json!({}));
    c.send(
        "fin <- function(e) cat('frame', 'freed\\n')\nhold <- function() {\n  big <- numeric(10)\n  reg.finalizer(environment(), fin)\n  browser()\n  invisible(NULL)\n}",
        None,
    );
    let m = d.mark();
    c.send("hold()", None);
    d.event("stopped", m);
    // What the Variables view does: scopes, then the locals.
    assert!(d.locals().contains_key("big"));
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    d.event("terminated", m);
    std::thread::sleep(Duration::from_millis(300));
    c.type_line("invisible(gc()); cat('coll', 'ected\\n')");
    c.expect("coll ected");
    assert!(
        c.text().contains("frame freed"),
        "the stopped frame outlived its stop:\n{}",
        c.text()
    );
}

/// Code sent while R is stopped on an error ends that stop: the error
/// finishes as Continue finishes it (printed, rest of its submission
/// dropped), the session ends, and the new code runs at the top level. A
/// fixed typo sent again with Cmd+Enter runs instead of waiting behind the
/// stop.
#[test]
fn code_sent_at_an_error_stop_ends_it_and_runs_at_top_level() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    let a = c.write_file(
        "a.R",
        "prit(1)\nprint(1)\nh <- function(x) {\n  stop(\"boom \", x)\n}\nw <- function() {\n  warning(\"ww\")\n  1\n}\n",
    );
    c.send_at("h <- function(x) {\n  stop(\"boom \", x)\n}", &a, 3);
    c.send_at("w <- function() {\n  warning(\"ww\")\n  1\n}", &a, 6);
    c.send("cat('defined', 'h\\n')", None);
    c.expect("defined h");
    let mut d = Dap::connect(&c);
    d.req("setExceptionBreakpoints", json!({"filters": ["error"]}));
    d.req("configurationDone", json!({}));

    // The typo, sent from the file, stops on the error.
    let m = d.mark();
    c.send_at("prit(1)", &a, 1);
    assert_eq!(d.event("stopped", m)["body"]["reason"], "exception");
    c.expect("Browse[");
    // Another typo stops again, in the same session (it stays open while
    // the sent code runs, so the next stop can't race its teardown).
    let m = d.mark();
    c.send_at("prit(3)", &a, 1);
    assert_eq!(d.event("stopped", m)["body"]["reason"], "exception");
    assert_eq!(d.count("terminated", m), 0);
    // The fix, sent from the same file, runs at the top level, and the
    // session ends.
    let m = d.mark();
    c.send_at("cat(sys.nframe(), 'fixed\\n')", &a, 2);
    c.expect("0 fixed");
    c.expect("could not find function \"prit\"");
    d.event("terminated", m);
    d.session_ended();

    // A stop from code typed at the prompt yields to a send too, instead of
    // the send running inside the stopped frame.
    let m = d.mark();
    c.type_line("h(5)");
    assert_eq!(d.event("stopped", m)["body"]["reason"], "exception");
    let m = d.mark();
    c.send("cat(sys.nframe(), 'after typed\\n')", None);
    c.expect("0 after typed");
    c.expect("boom 5");
    d.event("terminated", m);
    d.session_ended();
    let t = c.text();
    let traceback = t.rfind(&format!("h(5) at {a}:4")).unwrap();
    let echoed = t.rfind("> cat(sys.nframe(), 'after typed").unwrap();
    assert!(
        traceback < echoed,
        "the traceback came after the next send:\n{t}"
    );

    // Inspect Last Error is a stop on an error too: a send ends it.
    let m = d.mark();
    assert_eq!(c.ipc_status("inspect"), "ok");
    d.event("stopped", m);
    let m = d.mark();
    c.send("cat(sys.nframe(), 'after inspect\\n')", None);
    c.expect("0 after inspect");
    d.event("terminated", m);
    d.session_ended();

    // A send queued while the failing code still ran is not a reply to the
    // stop: it waits, and the stop stays until the user acts on it.
    let m = d.mark();
    c.send_at("{ Sys.sleep(0.5); prit(2) }", &a, 1);
    c.send("cat('queued', 'behind\\n')", None);
    assert_eq!(d.event("stopped", m)["body"]["reason"], "exception");
    std::thread::sleep(Duration::from_millis(1000));
    assert!(!c.text().contains("queued behind"), "{}", c.text());
    assert_eq!(d.count("continued", m), 0);
    let m = d.mark();
    c.send("cat('sent', 'after\\n')", None);
    c.expect("sent after");
    d.event("terminated", m);
    d.session_ended();
    let t = c.text();
    assert!(t.find("queued behind").unwrap() < t.find("sent after").unwrap());

    // Same for a stop from typed code: a send queued before it waits for
    // the top level instead of running in the failed frame.
    let m = d.mark();
    c.type_line("{ Sys.sleep(0.5); h(6) }");
    std::thread::sleep(Duration::from_millis(150));
    c.send("cat(sys.nframe(), 'early\\n')", None);
    assert_eq!(d.event("stopped", m)["body"]["reason"], "exception");
    std::thread::sleep(Duration::from_millis(1000));
    let ran_early = |t: String| t.lines().any(|l| l.trim_end().ends_with(" early"));
    assert!(!ran_early(c.text()), "{}", c.text());
    let m = d.mark();
    d.req("continue", json!({"threadId": 1}));
    c.expect("0 early");
    d.event("terminated", m);
    d.session_ended();

    // Other stops are left alone: a send waits behind a warning stop.
    d.req(
        "setExceptionBreakpoints",
        json!({"filters": ["error", "warning"]}),
    );
    let m = d.mark();
    c.send_at("w()", &a, 6);
    assert_eq!(d.event("stopped", m)["body"]["reason"], "exception");
    c.send("cat('after', 'warning\\n')", None);
    std::thread::sleep(Duration::from_millis(1000));
    assert!(!c.text().contains("after warning"), "{}", c.text());
    assert_eq!(d.count("continued", m), 0);
    d.req("continue", json!({"threadId": 1}));
    c.expect("after warning");
}
