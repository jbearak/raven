//! DAP transport: a Unix socket the console listens on, speaking the Debug
//! Adapter Protocol's `Content-Length` framing (design §2).
//!
//! One client at a time (a newer connection replaces an older one: VS Code
//! reconnects for each debug session). The reader thread hands every parsed
//! message to the handler; replies and events go through [`Outbox`], whose
//! writer thread owns the socket, so the R thread never blocks on I/O. None
//! of these threads ever touches R.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

/// Sends messages to the current client (dropped when none is connected).
#[derive(Clone)]
pub struct Outbox {
    tx: mpsc::Sender<Value>,
    /// Incremented per connection; messages queued for an older connection
    /// are discarded.
    pub connection: Arc<AtomicU64>,
}

impl Outbox {
    pub fn send(&self, msg: Value) {
        let _ = self.tx.send(msg);
    }

    pub fn event(&self, event: &str, body: Value) {
        self.send(json!({"type": "event", "event": event, "body": body}));
    }

    pub fn respond(&self, req: &Value, body: Value) {
        self.send(json!({
            "type": "response",
            "request_seq": req.get("seq").cloned().unwrap_or(Value::Null),
            "success": true,
            "command": req.get("command").cloned().unwrap_or(Value::Null),
            "body": body,
        }));
    }

    pub fn fail(&self, req: &Value, message: &str) {
        self.send(json!({
            "type": "response",
            "request_seq": req.get("seq").cloned().unwrap_or(Value::Null),
            "success": false,
            "command": req.get("command").cloned().unwrap_or(Value::Null),
            "message": message,
            "body": {"error": {"id": 1, "format": message}},
        }));
    }
}

/// Write one framed message.
pub fn write_frame(w: &mut impl Write, msg: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(msg).unwrap_or_default();
    write!(w, "Content-Length: {}\r\n\r\n", body.len())?;
    w.write_all(&body)?;
    w.flush()
}

/// Read one framed message; `None` at EOF or on a malformed frame.
pub fn read_frame(r: &mut impl BufRead) -> Option<Value> {
    let mut len: Option<usize> = None;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            len = v.trim().parse().ok();
        }
    }
    let mut buf = vec![0u8; len?];
    r.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

/// Listen on `path` (created owner-only, like the IPC socket) and call
/// `on_message` for every message from the client, and `on_close` when a
/// client goes away.
pub fn start(
    path: &Path,
    on_message: impl Fn(Value) + Send + Sync + 'static,
    on_close: impl Fn() + Send + Sync + 'static,
) -> std::io::Result<Outbox> {
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
    // SAFETY: umask only swaps the process file-creation mask.
    let old = unsafe { libc::umask(0o077) };
    let bound = UnixListener::bind(path);
    // SAFETY: as above.
    unsafe { libc::umask(old) };
    let listener = bound?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;

    let (tx, rx) = mpsc::channel::<Value>();
    let current: Arc<Mutex<Option<(u64, UnixStream)>>> = Arc::new(Mutex::new(None));
    let connection = Arc::new(AtomicU64::new(0));

    let writer_current = current.clone();
    std::thread::Builder::new()
        .name("raven-dap-writer".into())
        .spawn(move || {
            let mut seq: u64 = 1;
            for mut msg in rx {
                let mut g = writer_current.lock().unwrap_or_else(|e| e.into_inner());
                let Some((_, stream)) = g.as_mut() else {
                    continue;
                };
                if let Some(obj) = msg.as_object_mut() {
                    obj.insert("seq".into(), json!(seq));
                }
                seq += 1;
                if write_frame(stream, &msg).is_err() {
                    *g = None;
                }
            }
        })?;

    let on_message = Arc::new(on_message);
    let on_close = Arc::new(on_close);
    let accept_current = current.clone();
    let accept_connection = connection.clone();
    std::thread::Builder::new()
        .name("raven-dap-accept".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let Ok(reader) = stream.try_clone() else {
                    continue;
                };
                let id = accept_connection.fetch_add(1, Ordering::SeqCst) + 1;
                *accept_current.lock().unwrap_or_else(|e| e.into_inner()) = Some((id, stream));
                let on_message = on_message.clone();
                let on_close = on_close.clone();
                let current = accept_current.clone();
                let _ = std::thread::Builder::new()
                    .name("raven-dap-client".into())
                    .spawn(move || {
                        let mut r = BufReader::new(reader);
                        while let Some(msg) = read_frame(&mut r) {
                            on_message(msg);
                        }
                        let mut g = current.lock().unwrap_or_else(|e| e.into_inner());
                        if g.as_ref().is_some_and(|(cid, _)| *cid == id) {
                            *g = None;
                            drop(g);
                            on_close();
                        }
                    });
            }
        })?;
    Ok(Outbox { tx, connection })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, &json!({"a": 1, "b": "é"})).unwrap();
        write_frame(&mut buf, &json!({"c": [1, 2]})).unwrap();
        let mut r = std::io::Cursor::new(buf);
        assert_eq!(read_frame(&mut r).unwrap()["b"], "é");
        assert_eq!(read_frame(&mut r).unwrap()["c"][1], 2);
        assert!(read_frame(&mut r).is_none());
    }
}
