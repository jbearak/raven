//! Local socket through which an editor sends code to the console.
//!
//! The socket thread never touches R: it parses requests, queues them, and
//! raises the editor's break flag so the R thread picks them up at the next
//! prompt. Protocol: newline-delimited JSON, one request per line.
//!
//! ```text
//! → {"v":1,"id":7,"op":"execute","code":"df |>\n  head()"}
//! ← {"id":7,"status":"queued"}      // accepted; it will run (never resend)
//! ← {"id":7,"status":"done"}        // R returned to a prompt
//! ← {"id":7,"status":"error"}       // an error or interrupt discarded the rest
//! → {"v":1,"id":8,"op":"interrupt"}
//! ← {"id":8,"status":"ok"}
//! ```
//!
//! Access control is the filesystem: the socket is created mode 0600 inside a
//! directory the editor created 0700.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct Request {
    pub id: u64,
    pub code: String,
    reply: Option<UnixStream>,
}

impl Request {
    pub fn finish(mut self, status: &str) {
        if let Some(s) = self.reply.as_mut() {
            let _ = writeln!(
                s,
                "{}",
                serde_json::json!({"id": self.id, "status": status})
            );
        }
    }
}

#[derive(Clone)]
pub struct Server {
    queue: Arc<Mutex<VecDeque<Request>>>,
}

/// Set while R is evaluating a submission (between handing input to R and
/// the next top-level prompt). An `interrupt` request only signals R then.
pub static R_BUSY: AtomicBool = AtomicBool::new(false);

impl Server {
    pub fn start(
        path: &Path,
        break_flag: Arc<AtomicBool>,
        main_thread: libc::pthread_t,
    ) -> std::io::Result<Self> {
        // Replace only a stale socket: `--ipc` is a public option, and a
        // mistyped path must never delete an ordinary file.
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            use std::os::unix::fs::FileTypeExt;
            if !meta.file_type().is_socket() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "path exists and is not a socket",
                ));
            }
            let _ = std::fs::remove_file(path);
        }
        // Create the socket owner-only from the start (no window where the
        // umask's mode applies). Runs at startup, before any thread that
        // creates files.
        // SAFETY: umask only swaps the process file-creation mask.
        let old = unsafe { libc::umask(0o077) };
        let bound = UnixListener::bind(path);
        // SAFETY: as above.
        unsafe { libc::umask(old) };
        let listener = bound?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let server = Server {
            queue: Arc::new(Mutex::new(VecDeque::new())),
        };
        let queue = server.queue.clone();
        let main = main_thread;
        std::thread::Builder::new()
            .name("raven-console-ipc".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let queue = queue.clone();
                    let break_flag = break_flag.clone();
                    let _ = std::thread::Builder::new()
                        .name("raven-console-client".into())
                        .spawn(move || {
                            serve(stream, &queue, &break_flag, main);
                        });
                }
            })?;
        Ok(server)
    }

    pub fn pop(&self) -> Option<Request> {
        self.queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pop_front()
    }

    pub fn has_pending(&self) -> bool {
        !self
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    }
}

fn serve(
    stream: UnixStream,
    queue: &Mutex<VecDeque<Request>>,
    break_flag: &AtomicBool,
    main: libc::pthread_t,
) {
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { return };
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
            let _ = writeln!(writer, "{}", serde_json::json!({"status": "invalid"}));
            continue;
        };
        let id = msg.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
        match msg.get("op").and_then(|v| v.as_str()) {
            Some("execute") => {
                let Some(code) = msg.get("code").and_then(|v| v.as_str()) else {
                    let _ = writeln!(
                        writer,
                        "{}",
                        serde_json::json!({"id": id, "status": "invalid"})
                    );
                    continue;
                };
                // Acknowledge and publish under the queue lock. The R thread
                // pops under the same lock, so it can't finish (and write
                // `done`) before this `queued` is written; and once a client
                // has `queued`, the request is already in line, so the
                // client's next send lands after it. After the ack the
                // request runs (unless the console itself exits); a client
                // must never fall back and resend it.
                let reply = writer.try_clone().ok();
                {
                    let mut q = queue.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = writeln!(
                        writer,
                        "{}",
                        serde_json::json!({"id": id, "status": "queued"})
                    );
                    q.push_back(Request {
                        id,
                        code: code.to_string(),
                        reply,
                    });
                }
                break_flag.store(true, Ordering::Relaxed);
            }
            Some("interrupt") => {
                if R_BUSY.load(Ordering::Relaxed) {
                    // SAFETY: delivering SIGINT to the R thread runs R's own
                    // handler there, exactly as a Ctrl-C would.
                    unsafe { libc::pthread_kill(main, libc::SIGINT) };
                }
                let _ = writeln!(writer, "{}", serde_json::json!({"id": id, "status": "ok"}));
            }
            Some("ping") => {
                let _ = writeln!(
                    writer,
                    "{}",
                    serde_json::json!({"id": id, "status": "ok", "version": 1})
                );
            }
            _ => {
                let _ = writeln!(
                    writer,
                    "{}",
                    serde_json::json!({"id": id, "status": "invalid"})
                );
            }
        }
    }
}
