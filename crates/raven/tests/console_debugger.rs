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
        let mut msg = json!({"v": 1, "id": 1, "op": "execute", "code": code});
        if let Some(p) = path {
            msg["location"] = json!({"path": p, "line": 1, "col": 0});
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
}

impl Dap {
    fn connect(c: &Console) -> Dap {
        let s = UnixStream::connect(c.dir.join("d")).expect("dap connect");
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
        let mut d = Dap { w: s, msgs, seq: 1 };
        d.req("initialize", json!({"adapterID": "raven-r"}));
        d.req("attach", json!({}));
        d
    }

    fn mark(&self) -> usize {
        self.msgs.lock().unwrap().len()
    }

    fn req(&mut self, command: &str, args: Value) -> Value {
        let seq = self.seq;
        self.seq += 1;
        let body = serde_json::to_vec(
            &json!({"seq": seq, "type": "request", "command": command, "arguments": args}),
        )
        .unwrap();
        write!(self.w, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        self.w.write_all(&body).unwrap();
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
}
