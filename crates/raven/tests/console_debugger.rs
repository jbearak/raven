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
use std::sync::{Arc, Mutex};
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

struct Console {
    child: Child,
    master: Option<File>,
    out: Arc<Mutex<Vec<u8>>>,
    dir: PathBuf,
}

impl Console {
    fn spawn() -> Console {
        let dir = scratch();
        let mut master: libc::c_int = 0;
        let mut slave: libc::c_int = 0;
        let ws = libc::winsize {
            ws_row: 30,
            ws_col: 120,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: openpty fills two descriptors; the winsize pointer is valid.
        let rc = unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut::<libc::termios>() as _,
                &ws as *const libc::winsize as _,
            )
        };
        assert_eq!(rc, 0, "openpty failed");
        // SAFETY: both descriptors were just returned by openpty.
        let (master, slave) = unsafe { (File::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_raven"));
        cmd.arg("console")
            .args(["--no-history", "--ipc"])
            .arg(dir.join("i"))
            .arg("--dap")
            .arg(dir.join("d"))
            .args(["--no-save", "--no-restore", "--vanilla", "-q"])
            .env("TERM", "xterm-256color")
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
        };
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

impl Drop for Console {
    fn drop(&mut self) {
        let _ = self.child.kill();
        drop(self.master.take());
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
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
            "dyn.load('{}'); peek <- function() {{\n  x <- .Call('spy_make')\n  fy <- structure(1:2, levels = .Call('spy_make'), class = 'factor')\n  dd <- data.frame(a = 1:3); attr(dd, 'row.names') <- .Call('spy_make')\n  xl <- .Call('spy_list')\n  n0 <- .Call('spy_calls')\n  browser()\n  x\n}}",
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
    for e in ["fy", "dd", "xl", "xl[[1]]"] {
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
