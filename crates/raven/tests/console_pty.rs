//! End-to-end tests for `raven console`, driven through a pseudo-terminal the
//! way a user's terminal drives it. Each test is skipped (passes vacuously,
//! with a note on stderr) when no R with a shared libR is installed; CI
//! installs `r-base-core` so they run there.
#![cfg(unix)]

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(20);

fn r_available() -> bool {
    let ok = Command::new("R")
        .arg("RHOME")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|h| {
            let lib = std::path::Path::new(h.trim()).join("lib");
            lib.join("libR.so").exists() || lib.join("libR.dylib").exists()
        })
        .unwrap_or(false);
    if !ok {
        eprintln!("skipping: no R with a shared libR on PATH");
    }
    ok
}

struct Console {
    child: Child,
    /// `None` only during drop: closed before reaping the child, because on
    /// macOS a child blocked writing to an unread PTY isn't reaped after
    /// SIGKILL while the master stays open.
    master: Option<File>,
    out: Vec<u8>,
    mark: usize,
}

impl Console {
    fn spawn(extra: &[&str]) -> Console {
        Self::spawn_with(extra, true)
    }

    fn spawn_with(extra: &[&str], no_history: bool) -> Console {
        let mut master: libc::c_int = 0;
        let mut slave: libc::c_int = 0;
        let ws = libc::winsize {
            ws_row: 30,
            ws_col: 100,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: openpty fills two descriptors; the winsize pointer is valid.
        // The pointer constness of the last two parameters differs between
        // macOS and Linux, hence the casts.
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
        // SAFETY: both descriptors were just returned by openpty and are owned here.
        let (master, slave) = unsafe { (File::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        // SAFETY: fcntl on a descriptor we own.
        unsafe {
            let flags = libc::fcntl(master.as_raw_fd(), libc::F_GETFL);
            libc::fcntl(master.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_raven"));
        cmd.arg("console")
            .args(if no_history {
                &["--no-history"][..]
            } else {
                &[][..]
            })
            .args(["--no-save", "--no-restore", "--vanilla", "-q"])
            .args(extra)
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
        Console {
            child,
            master: Some(master),
            out: Vec::new(),
            mark: 0,
        }
    }

    fn m(&mut self) -> &mut File {
        self.master.as_mut().expect("open")
    }

    /// Write all of `bytes`, draining output while the PTY's input buffer
    /// is full (the master is non-blocking).
    fn write(&mut self, mut bytes: &[u8]) {
        let deadline = Instant::now() + TIMEOUT;
        while !bytes.is_empty() {
            match self.m().write(bytes) {
                Ok(n) => bytes = &bytes[n..],
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    self.pump();
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("write to console: {e}"),
            }
        }
    }

    fn pump(&mut self) {
        let mut buf = [0u8; 65536];
        loop {
            match self.m().read(&mut buf) {
                Ok(0) => return,
                Ok(n) => {
                    // Answer cursor-position queries the way a terminal would.
                    if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                        let _ = self.m().write_all(b"\x1b[1;1R");
                    }
                    self.out.extend_from_slice(&buf[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return,
                Err(_) => return,
            }
        }
    }

    /// Plain text of everything since the last `send`, escapes removed.
    fn since_mark(&self) -> String {
        strip_ansi(&String::from_utf8_lossy(&self.out[self.mark..]))
    }

    fn expect(&mut self, needle: &str) -> String {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            self.pump();
            let text = self.since_mark();
            if text.contains(needle) {
                return text;
            }
            if Instant::now() > deadline {
                panic!("timed out waiting for {needle:?}; output since last input:\n{text}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Wait until output has been quiet for a moment (the editor settled).
    fn settle(&mut self) {
        let mut last = self.out.len();
        let mut quiet = Instant::now();
        let deadline = Instant::now() + TIMEOUT;
        while quiet.elapsed() < Duration::from_millis(250) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
            self.pump();
            if self.out.len() != last {
                last = self.out.len();
                quiet = Instant::now();
            }
        }
    }

    fn send(&mut self, s: &str) {
        self.settle();
        self.mark = self.out.len();
        self.write(s.as_bytes());
    }

    /// Type a line and press Enter as separate events, as a person would.
    fn line(&mut self, s: &str) {
        self.send(s);
        self.settle();
        self.write(b"\r");
    }
}

impl Drop for Console {
    fn drop(&mut self) {
        let _ = self.child.kill();
        drop(self.master.take());
        let _ = self.child.wait();
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
        match it.next() {
            Some('[') => {
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() || n == '~' {
                        break;
                    }
                }
            }
            Some(']') => {
                for n in it.by_ref() {
                    if n == '\x07' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[test]
fn evaluates_multiline_input_and_recovers_from_errors() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn(&[]);
    c.expect("> ");
    c.line("1 + 1");
    c.expect("[1] 2");
    // Enter continues incomplete input (R's parser decides), with indent.
    c.line("f <- function(a) {");
    c.line("b <- a * 10");
    c.line("b");
    c.line("}");
    c.line("f(4)");
    c.expect("[1] 40");
    // A multi-line call continues after a trailing comma.
    c.line("d <- data.frame(a = 1,");
    c.line("b = 2)");
    c.line("ncol(d)");
    c.expect("[1] 2");
    // Enter at an empty prompt is an empty line, not EOF.
    c.line("");
    c.line("2 + 2");
    c.expect("[1] 4");
    // A syntax error is reported, never traps the user in continuation.
    c.line("1 +* 2");
    c.expect("unexpected");
    c.line("3 + 3");
    c.expect("[1] 6");
}

#[test]
fn ctrl_c_interrupts_evaluation() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn(&[]);
    c.expect("> ");
    c.line("Sys.sleep(30); cat('not interrupted\\n')");
    std::thread::sleep(Duration::from_millis(800));
    let started = Instant::now();
    c.send("\x03");
    c.line("cat('alive\\n')");
    let out = c.expect("alive");
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(!out.contains("not interrupted"), "{out}");
}

#[test]
fn nested_prompts_get_their_own_input() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn(&[]);
    c.expect("> ");
    c.line("x <- readline('Name? ')");
    c.expect("Name? ");
    c.line("bob");
    c.line("cat(toupper(x), '\\n')");
    c.expect("BOB");
    c.line("g <- function() { y <- 5; browser(); y * 2 }");
    c.line("g()");
    c.expect("Browse[1]>");
    c.line("y");
    c.expect("[1] 5");
    c.line("c");
    c.expect("[1] 10");
}

fn request(socket: &std::path::Path, msg: serde_json::Value) -> Vec<String> {
    request_with_timeout(socket, msg, TIMEOUT)
}

fn request_with_timeout(
    socket: &std::path::Path,
    msg: serde_json::Value,
    timeout: Duration,
) -> Vec<String> {
    let s = UnixStream::connect(socket).expect("connect");
    s.set_read_timeout(Some(timeout)).unwrap();
    let mut w = s.try_clone().unwrap();
    writeln!(w, "{msg}").unwrap();
    let mut statuses = Vec::new();
    for line in BufReader::new(s).lines() {
        // A read timeout ends the exchange (the request is still running).
        let Ok(line) = line else { break };
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        let st = v["status"].as_str().unwrap_or_default().to_string();
        let more = st == "queued";
        statuses.push(st);
        if !more {
            break;
        }
    }
    statuses
}

#[test]
fn socket_runs_code_and_stops_at_the_first_error() {
    if !r_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("s");
    let mut c = Console::spawn(&["--ipc", sock.to_str().unwrap()]);
    c.expect("> ");
    // Half-typed input survives a request from the editor.
    c.send("half");
    c.settle();
    c.mark = c.out.len();
    let st = request(
        &sock,
        serde_json::json!({"v": 1, "id": 1, "op": "execute", "code": "x <- 6:8\nsum(x)"}),
    );
    assert_eq!(st, ["queued", "done"]);
    let out = c.expect("[1] 21");
    assert!(out.contains("x <- 6:8"), "request is echoed: {out}");
    c.expect("half");
    c.send("\x15"); // Ctrl-U: drop the restored text

    c.mark = c.out.len();
    let st = request(
        &sock,
        serde_json::json!({"v": 1, "id": 2, "op": "execute", "code": "stop('first fails')\ncat('must not run\\n')"}),
    );
    assert_eq!(st, ["queued", "error"]);
    let out = c.expect("first fails");
    c.settle();
    assert!(!c.since_mark().contains("must not run"), "{out}");

    // Interrupt a long-running request from the editor.
    c.settle();
    c.mark = c.out.len();
    let sock2 = sock.clone();
    let long = std::thread::spawn(move || {
        request(
            &sock2,
            serde_json::json!({"v": 1, "id": 3, "op": "execute", "code": "Sys.sleep(30)"}),
        )
    });
    // Interrupt only once R is running the request (echoed at the prompt).
    c.expect("Sys.sleep(30)");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        request(
            &sock,
            serde_json::json!({"v": 1, "id": 4, "op": "interrupt"})
        ),
        ["ok"]
    );
    assert_eq!(long.join().unwrap(), ["queued", "error"]);
}

#[test]
fn event_loop_runs_while_idle() {
    if !r_available() {
        return;
    }
    let has_later = Command::new("Rscript")
        .args([
            "-e",
            "quit(status = !requireNamespace('later', quietly = TRUE))",
        ])
        .status()
        .is_ok_and(|s| s.success());
    if !has_later {
        eprintln!("skipping: R package 'later' not installed");
        return;
    }
    let mut c = Console::spawn(&[]);
    c.expect("> ");
    // Long enough that the callback fires after typing has started.
    c.line("later::later(function() cat('fired\\n'), 2)");
    c.send("abc"); // typing in progress when the callback fires
    c.expect("fired");
}

#[test]
fn long_plain_input_is_delivered_whole() {
    if !r_available() {
        return;
    }
    // Longer than R's 4096-byte console buffer: must arrive intact, in pieces.
    let mut c = Console::spawn(&[]);
    c.expect("> ");
    c.line("x <- readline('> ')");
    c.settle();
    c.line(&"a".repeat(6000));
    c.line("cat(nchar(x), '\\n')");
    c.expect("6000");
}

#[test]
fn sent_lines_wait_while_a_browser_they_opened_runs() {
    if !r_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("s");
    let mut c = Console::spawn(&["--ipc", sock.to_str().unwrap()]);
    c.expect("> ");
    c.line("f <- function() { browser(); invisible(1) }");
    c.settle();
    c.mark = c.out.len();
    // `n` would be a debugger command if it were fed to the browser.
    let code = "f()\nn <- 42\ncat('after', n, '\\n')";
    let st = request_with_timeout(
        &sock,
        serde_json::json!({"v": 1, "id": 1, "op": "execute", "code": code}),
        Duration::from_secs(3),
    );
    assert_eq!(st, ["queued"], "request stays open while the browser runs");
    c.expect("Browse[1]>");
    c.settle();
    assert!(!c.since_mark().contains("after"), "{}", c.since_mark());
    c.line("c");
    c.expect("after 42");
}

#[test]
fn quitting_a_browser_drops_the_rest_of_a_sent_block() {
    if !r_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("s");
    let mut c = Console::spawn(&["--ipc", sock.to_str().unwrap()]);
    c.expect("> ");
    c.line("f <- function() { browser(); invisible(1) }");
    c.settle();
    let sock2 = sock.clone();
    let req = std::thread::spawn(move || {
        request(
            &sock2,
            serde_json::json!({"v": 1, "id": 1, "op": "execute", "code": "f()\ncat('after\\n')"}),
        )
    });
    c.expect("Browse[1]>");
    c.mark = c.out.len();
    c.line("Q");
    assert_eq!(req.join().unwrap(), ["queued", "error"]);
    c.line("cat('next\\n')");
    c.expect("next");
    assert!(!c.since_mark().contains("after"), "{}", c.since_mark());
}

#[test]
fn a_request_that_opens_a_browser_is_done_only_when_it_returns() {
    if !r_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("s");
    let mut c = Console::spawn(&["--ipc", sock.to_str().unwrap()]);
    c.expect("> ");
    let st = request_with_timeout(
        &sock,
        serde_json::json!({"v": 1, "id": 1, "op": "execute", "code": "browser()"}),
        Duration::from_secs(3),
    );
    assert_eq!(st, ["queued"], "not done while paused in the browser");
    c.expect("Browse[1]>");
}

#[test]
fn rapid_dependent_sends_run_in_order() {
    if !r_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("s");
    let mut c = Console::spawn(&["--ipc", sock.to_str().unwrap()]);
    c.expect("> ");
    // What the extension does: each send waits for the previous `queued`.
    for i in 0..20 {
        let code = if i == 0 {
            "acc <- ''".to_string()
        } else {
            format!("acc <- paste0(acc, {})", i % 10)
        };
        let st = request_with_timeout(
            &sock,
            serde_json::json!({"v": 1, "id": i, "op": "execute", "code": code}),
            Duration::from_millis(1),
        );
        assert_eq!(st.first().map(String::as_str), Some("queued"));
    }
    c.line("cat(acc, '\\n')");
    c.expect("1234567890123456789");
}

#[test]
fn socket_interrupt_works_after_a_readline_answer() {
    if !r_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("s");
    let mut c = Console::spawn(&["--ipc", sock.to_str().unwrap()]);
    c.expect("> ");
    c.line("x <- readline('go? '); Sys.sleep(30); cat('slept\\n')");
    c.expect("go? ");
    c.line("y");
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(
        request(
            &sock,
            serde_json::json!({"v": 1, "id": 9, "op": "interrupt"})
        ),
        ["ok"]
    );
    c.mark = c.out.len();
    c.line("cat('alive\\n')");
    let out = c.expect("alive");
    assert!(!out.contains("slept"), "{out}");
}

#[test]
fn history_survives_quit_and_restart() {
    if !r_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let hist = dir.path().join("history");
    let hist_arg = hist.to_str().unwrap();
    {
        let mut c = Console::spawn_with(&["--history-file", hist_arg], false);
        c.expect("> ");
        c.line("remember_me <- 123");
        c.line("q()");
        let deadline = Instant::now() + TIMEOUT;
        while c.child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            c.pump();
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    let saved = std::fs::read_to_string(&hist).unwrap_or_default();
    assert!(
        saved.contains("remember_me <- 123"),
        "history file: {saved:?}"
    );
}

#[test]
fn a_request_can_finish_an_expression_an_earlier_one_started() {
    if !r_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("s");
    let mut c = Console::spawn(&["--ipc", sock.to_str().unwrap()]);
    c.expect("> ");
    // Ctrl+Enter through a pipeline, one line at a time.
    let st = request(
        &sock,
        serde_json::json!({"v": 1, "id": 1, "op": "execute", "code": "x <- c(1, 2, 3) |>"}),
    );
    assert_eq!(st, ["queued", "done"]);
    let st = request(
        &sock,
        serde_json::json!({"v": 1, "id": 2, "op": "execute", "code": "  sum()"}),
    );
    assert_eq!(st, ["queued", "done"]);
    c.line("x");
    c.expect("[1] 6");
}

#[test]
fn enter_in_a_burst_still_opens_a_block() {
    if !r_available() {
        return;
    }
    // Keys arriving faster than repaints (type-ahead): one write.
    let mut c = Console::spawn(&[]);
    c.expect("> ");
    c.send("f <- function(a) {\r");
    c.settle();
    c.line("a * 10");
    c.line("}");
    c.line("f(4)");
    c.expect("[1] 40");
}

#[test]
fn ctrl_c_at_readline_and_continuation_prompts_interrupts() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn(&[]);
    c.expect("> ");
    c.line("answer_xyz <- readline('name: ')");
    c.expect("name: ");
    c.settle();
    c.send("\x03");
    c.line("cat('exists:', exists('answer_xyz'), '\\n')");
    c.expect("exists: FALSE");
    // At `+ `, Ctrl-C abandons the unfinished expression.
    c.line("1 +");
    c.settle();
    c.send("\x03");
    c.line("2 + 2");
    c.expect("[1] 4");
}

#[test]
fn falls_back_to_plain_r_when_it_cannot_embed() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn(&["--r-home", "/nonexistent/R"]);
    c.expect("starting plain R");
    c.expect("> ");
    c.line("1 + 1");
    c.expect("[1] 2");
}
