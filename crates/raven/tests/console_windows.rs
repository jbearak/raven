//! End-to-end tests for `raven console` on Windows, driven through a pseudo
//! console (ConPTY) the way Windows Terminal and VS Code's terminal drive it.
//! They cover what differs from Unix: embedding R.dll through `structRstart`,
//! UTF-8 under raven.exe's manifest, Ctrl-C and remote interrupts through
//! `UserBreak`, the named pipes behind `--ipc`/`--dap`, and the debugger's
//! Windows paths. Skipped (passing vacuously) when no R is on PATH; the
//! Windows CI job installs R.
#![cfg(windows)]

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::io::FromRawHandle;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
};

const TIMEOUT: Duration = Duration::from_secs(60);
/// A blocked pipe read can't time out, so a watchdog ends the console (and
/// with it every read) if a test outlives this.
const WATCHDOG: Duration = Duration::from_secs(240);

fn r_available() -> bool {
    let ok = Command::new("R")
        .arg("RHOME")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            s.lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .map(str::to_string)
        })
        .is_some_and(|h| {
            let bin = Path::new(h.trim()).join("bin");
            bin.join("x64").join("R.dll").exists() || bin.join("R.dll").exists()
        });
    if !ok {
        eprintln!("skipping: no R on PATH");
    }
    ok
}

fn scratch() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "rvwin-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The console's pipe for a socket path (`local_socket::pipe_name`).
fn pipe_name(path: &Path) -> String {
    let mangled: String = path
        .to_string_lossy()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!(r"\\.\pipe\raven-{mangled}")
}

fn connect(path: &Path) -> File {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(pipe_name(path))
        {
            Ok(f) => return f,
            // ERROR_PIPE_BUSY: every instance is taken for the moment.
            Err(e) if e.raw_os_error() == Some(231) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => panic!("connect {}: {e}", pipe_name(path)),
        }
    }
}

/// `\\?\C:\x` → `C:\x`, as the console reports paths.
fn plain(p: PathBuf) -> String {
    let s = p.to_string_lossy().into_owned();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

struct Console {
    hpc: HPCON,
    process: HANDLE,
    input: Option<File>,
    out: Arc<Mutex<Vec<u8>>>,
    dir: PathBuf,
    done: Arc<AtomicBool>,
    watchdog: Option<std::thread::JoinHandle<()>>,
}

impl Console {
    fn spawn() -> Console {
        let dir = scratch();
        let exe = env!("CARGO_BIN_EXE_raven");
        let cmdline = format!(
            "\"{exe}\" console --no-history --ipc \"{}\" --dap \"{}\" --no-save --no-restore --vanilla -q",
            dir.join("i").display(),
            dir.join("d").display()
        );
        let mut cmdline: Vec<u16> = cmdline.encode_utf16().chain(Some(0)).collect();
        let (mut in_read, mut in_write): (HANDLE, HANDLE) =
            (std::ptr::null_mut(), std::ptr::null_mut());
        let (mut out_read, mut out_write): (HANDLE, HANDLE) =
            (std::ptr::null_mut(), std::ptr::null_mut());
        let mut hpc: HPCON = 0;
        let mut pi = PROCESS_INFORMATION::default();
        // SAFETY: the documented ConPTY sequence; every pointer is valid for
        // the call it is passed to, and the attribute list outlives
        // CreateProcessW.
        unsafe {
            assert_ne!(
                CreatePipe(&mut in_read, &mut in_write, std::ptr::null(), 0),
                0
            );
            assert_ne!(
                CreatePipe(&mut out_read, &mut out_write, std::ptr::null(), 0),
                0
            );
            let hr = CreatePseudoConsole(COORD { X: 120, Y: 30 }, in_read, out_write, 0, &mut hpc);
            assert_eq!(hr, 0, "CreatePseudoConsole failed");
            CloseHandle(in_read);
            CloseHandle(out_write);

            let mut size = 0usize;
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
            let mut list = vec![0u8; size];
            let attrs = list.as_mut_ptr().cast();
            assert_ne!(InitializeProcThreadAttributeList(attrs, 1, 0, &mut size), 0);
            assert_ne!(
                UpdateProcThreadAttribute(
                    attrs,
                    0,
                    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                    hpc as *const std::ffi::c_void,
                    std::mem::size_of::<HPCON>(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                ),
                0
            );
            let mut si: STARTUPINFOEXW = std::mem::zeroed();
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            si.lpAttributeList = attrs;
            // Otherwise the child can inherit this process's redirected
            // stdio instead of the pseudo console's.
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
            si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
            si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
            let ok = CreateProcessW(
                std::ptr::null(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT,
                std::ptr::null(),
                std::ptr::null(),
                &si.StartupInfo,
                &mut pi,
            );
            assert_ne!(ok, 0, "CreateProcessW: {}", std::io::Error::last_os_error());
            DeleteProcThreadAttributeList(attrs);
            CloseHandle(pi.hThread);
        }
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        // SAFETY: the pipe's read end, owned from here on.
        let mut reader = unsafe { File::from_raw_handle(out_read) };
        std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                sink.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
        let done = Arc::new(AtomicBool::new(false));
        let process = pi.hProcess as usize;
        let watch = done.clone();
        let watchdog = std::thread::spawn(move || {
            let start = Instant::now();
            while !watch.load(Ordering::SeqCst) {
                if start.elapsed() > WATCHDOG {
                    // SAFETY: the handle stays open until Drop has joined
                    // this thread.
                    unsafe { TerminateProcess(process as HANDLE, 1) };
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        let c = Console {
            hpc,
            process: pi.hProcess,
            // SAFETY: the pipe's write end, owned from here on.
            input: Some(unsafe { File::from_raw_handle(in_write) }),
            out,
            dir,
            done,
            watchdog: Some(watchdog),
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
        c.expect(">");
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

    fn write(&mut self, bytes: &[u8]) {
        let input = self.input.as_mut().unwrap();
        input.write_all(bytes).unwrap();
        input.flush().unwrap();
    }

    fn type_line(&mut self, s: &str) {
        self.write(s.as_bytes());
        std::thread::sleep(Duration::from_millis(100));
        self.write(b"\r");
    }

    /// An IPC connection that has sent `msg` and read its first reply.
    fn request(&self, msg: Value) -> (BufReader<File>, Value) {
        let mut pipe = BufReader::new(connect(&self.dir.join("i")));
        writeln!(pipe.get_mut(), "{msg}").unwrap();
        let reply = read_json_line(&mut pipe);
        (pipe, reply)
    }
}

impl Drop for Console {
    fn drop(&mut self) {
        self.done.store(true, Ordering::SeqCst);
        if let Some(w) = self.watchdog.take() {
            let _ = w.join();
        }
        // SAFETY: handles this struct owns; the output reader keeps draining
        // while the pseudo console closes.
        unsafe {
            TerminateProcess(self.process, 1);
            drop(self.input.take());
            ClosePseudoConsole(self.hpc);
            CloseHandle(self.process);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn read_json_line(r: &mut BufReader<File>) -> Value {
    let mut line = String::new();
    assert!(r.read_line(&mut line).unwrap() > 0, "connection closed");
    serde_json::from_str(&line).unwrap()
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
            // OSC (window title): up to BEL or ST.
            Some(']') => {
                while let Some(n) = it.next() {
                    if n == '\x07' || (n == '\x1b' && it.peek() == Some(&'\\')) {
                        if n == '\x1b' {
                            it.next();
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// A minimal, single-threaded DAP client: a synchronous pipe handle can't
/// read and write concurrently, so every read follows the write it answers.
struct Dap {
    pipe: BufReader<File>,
    seq: i64,
    pending: Vec<Value>,
}

impl Dap {
    fn connect(c: &Console) -> Dap {
        let mut d = Dap {
            pipe: BufReader::new(connect(&c.dir.join("d"))),
            seq: 1,
            pending: Vec::new(),
        };
        d.req("initialize", json!({"adapterID": "raven-r"}));
        d.req("attach", json!({}));
        d
    }

    fn read(&mut self) -> Value {
        let mut len = 0usize;
        loop {
            let mut line = String::new();
            assert!(
                self.pipe.read_line(&mut line).unwrap() > 0,
                "DAP connection closed"
            );
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some(v) = line.strip_prefix("Content-Length:") {
                len = v.trim().parse().unwrap();
            }
        }
        let mut buf = vec![0u8; len];
        self.pipe.read_exact(&mut buf).unwrap();
        serde_json::from_slice(&buf).unwrap()
    }

    fn req(&mut self, command: &str, args: Value) -> Value {
        let seq = self.seq;
        self.seq += 1;
        let body = serde_json::to_vec(
            &json!({"seq": seq, "type": "request", "command": command, "arguments": args}),
        )
        .unwrap();
        let w = self.pipe.get_mut();
        write!(w, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
        w.write_all(&body).unwrap();
        loop {
            let m = self.read();
            if m["type"] == "response" && m["request_seq"] == seq {
                assert_eq!(m["success"], true, "{command} failed: {m}");
                return m;
            }
            self.pending.push(m);
        }
    }

    fn event(&mut self, name: &str) -> Value {
        if let Some(i) = self.pending.iter().position(|m| m["event"] == name) {
            return self.pending.remove(i);
        }
        loop {
            let m = self.read();
            if m["event"] == name {
                return m;
            }
            self.pending.push(m);
        }
    }
}

#[test]
fn typed_input_runs_in_r_with_utf8_native_encoding() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    // Outputs are computed, so the echoed input can't satisfy the match.
    c.type_line(r#"cat("RAVEN", 6 * 7, "\n", sep = "_")"#);
    c.expect("RAVEN_42");
    // "é" typed through the terminal reaches R as UTF-8, in a UTF-8 session
    // (raven.exe's manifest); a legacy code page would split or mangle it.
    c.type_line(r#"cat(utf8ToInt("é"), l10n_info()[["UTF-8"]], "\n", sep = "_")"#);
    c.expect("233_TRUE");
    c.type_line(r#"cat("ACCENT", "é", "\n", sep = "_")"#);
    c.expect("ACCENT_é");
}

#[test]
fn ctrl_c_interrupts_evaluation() {
    if !r_available() {
        return;
    }
    let mut c = Console::spawn();
    c.type_line(r#"Sys.sleep(30); cat(paste0("NOT", "_REACHED"))"#);
    std::thread::sleep(Duration::from_millis(1500));
    let start = Instant::now();
    c.write(b"\x03");
    c.type_line(r#"cat("BACK", 6 * 7, "\n", sep = "_")"#);
    c.expect("BACK_42");
    assert!(
        start.elapsed() < Duration::from_secs(20),
        "interrupt was slow"
    );
    assert!(!c.text().contains("NOT_REACHED"), "{}", c.text());
}

#[test]
fn the_ipc_pipe_runs_code_and_interrupts_it() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let (mut run, reply) =
        c.request(json!({"v": 1, "id": 1, "op": "execute", "code": "cat(\"IPC\", 40 + 2, \"\\n\", sep = \"_\")"}));
    assert_eq!(reply["status"], "queued");
    assert_eq!(read_json_line(&mut run)["status"], "done");
    c.expect("IPC_42");

    let (mut busy, reply) =
        c.request(json!({"v": 1, "id": 2, "op": "execute", "code": "Sys.sleep(30)"}));
    assert_eq!(reply["status"], "queued");
    std::thread::sleep(Duration::from_millis(1500));
    let start = Instant::now();
    let (_, reply) = c.request(json!({"v": 1, "id": 3, "op": "interrupt"}));
    assert_eq!(reply["status"], "ok");
    assert_eq!(read_json_line(&mut busy)["status"], "error");
    assert!(
        start.elapsed() < Duration::from_secs(20),
        "interrupt was slow"
    );

    let (mut after, _) =
        c.request(json!({"v": 1, "id": 4, "op": "execute", "code": "cat(\"AFTER\", 1, \"\\n\", sep = \"_\")"}));
    assert_eq!(read_json_line(&mut after)["status"], "done");
    c.expect("AFTER_1");
}

#[test]
fn the_debugger_stops_at_a_breakpoint_in_a_sourced_file() {
    if !r_available() {
        return;
    }
    let c = Console::spawn();
    let file = c.dir.join("a.R");
    std::fs::write(
        &file,
        "f <- function(x) {\n  y <- x + 1\n  y * 2\n}\nz <- f(1)\n",
    )
    .unwrap();
    let real = plain(std::fs::canonicalize(&file).unwrap());
    // VS Code sends a lower-case drive letter and backslashes; R reports
    // its own spelling. The console must match them.
    let mut vscode_path = real.clone();
    vscode_path.replace_range(0..1, &real[0..1].to_ascii_lowercase());

    let mut dap = Dap::connect(&c);
    let set = dap.req(
        "setBreakpoints",
        json!({"source": {"path": vscode_path}, "breakpoints": [{"line": 2}]}),
    );
    assert_eq!(set["body"]["breakpoints"][0]["verified"], true, "{set}");
    dap.req("configurationDone", json!({}));

    let source = format!("source({:?})", real.replace('\\', "/"));
    let (mut run, reply) = c.request(json!({"v": 1, "id": 1, "op": "execute", "code": source}));
    assert_eq!(reply["status"], "queued");

    let stopped = dap.event("stopped");
    assert_eq!(stopped["body"]["reason"], "breakpoint", "{stopped}");
    let trace = dap.req("stackTrace", json!({"threadId": 1}));
    let top = &trace["body"]["stackFrames"][0];
    assert_eq!(top["line"], 2, "{trace}");
    let shown = top["source"]["path"].as_str().unwrap_or_default();
    assert!(
        shown.eq_ignore_ascii_case(&real),
        "frame path {shown:?}, file {real:?}"
    );
    let frame = top["id"].clone();
    let x = dap.req(
        "evaluate",
        json!({"expression": "x * 10", "frameId": frame, "context": "repl"}),
    );
    assert!(
        x["body"]["result"]
            .as_str()
            .unwrap_or_default()
            .contains("10"),
        "{x}"
    );

    dap.req("continue", json!({"threadId": 1}));
    assert_eq!(read_json_line(&mut run)["status"], "done");
    let (mut check, _) = c.request(
        json!({"v": 1, "id": 2, "op": "execute", "code": "cat(\"Z\", z, \"\\n\", sep = \"_\")"}),
    );
    assert_eq!(read_json_line(&mut check)["status"], "done");
    c.expect("Z_4");
}
