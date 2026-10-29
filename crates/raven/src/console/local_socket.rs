//! The local sockets the console serves (`--ipc`, `--dap`): a Unix-domain
//! socket on Unix, a named pipe on Windows.
//!
//! Both are addressed by a filesystem path inside a directory the editor
//! created privately. On Windows the pipe's name is derived from that path
//! ([`pipe_name`]; the VS Code extension derives the same name), and once the
//! pipe is listening an empty file is created at the path itself, so "the
//! path exists" means "the console is listening" on every platform.
//!
//! Access control: Unix sockets are created mode 0600; named pipes get a DACL
//! that admits only the pipe's owner (and SYSTEM), and refuse remote clients.

pub use imp::{Listener, Stream};

#[cfg(unix)]
mod imp {
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::path::Path;

    pub type Stream = std::os::unix::net::UnixStream;

    pub struct Listener(UnixListener);

    impl Listener {
        /// Listen on `path`, owner-only from the start.
        pub fn bind(path: &Path) -> io::Result<Listener> {
            // Replace only a stale socket: `--ipc`/`--dap` are public
            // options, and a mistyped path must never delete an ordinary
            // file.
            if let Ok(meta) = std::fs::symlink_metadata(path) {
                use std::os::unix::fs::FileTypeExt;
                if !meta.file_type().is_socket() {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "path exists and is not a socket",
                    ));
                }
                let _ = std::fs::remove_file(path);
            }
            // No window where the umask's mode applies. Runs at startup,
            // before any thread that creates files.
            // SAFETY: umask only swaps the process file-creation mask.
            let old = unsafe { libc::umask(0o077) };
            let bound = UnixListener::bind(path);
            // SAFETY: as above.
            unsafe { libc::umask(old) };
            let listener = bound?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            Ok(Listener(listener))
        }

        /// Connections as they arrive (failed accepts are skipped).
        pub fn incoming(&self) -> impl Iterator<Item = Stream> + '_ {
            self.0.incoming().flatten()
        }
    }
}

/// The named pipe the console listens on for `path` (Windows). A path that
/// already names a pipe (`\\.\pipe\…`) is used as is.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn pipe_name(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    if s.starts_with(r"\\.\pipe\") {
        return s.into_owned();
    }
    let mangled: String = s
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

#[cfg(windows)]
mod imp {
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_CONNECTED,
        ERROR_PIPE_NOT_CONNECTED, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
        WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX, ReadFile,
        WriteFile,
    };
    use windows_sys::Win32::System::IO::{
        CancelIoEx, GetOverlappedResult, GetOverlappedResultEx, OVERLAPPED,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::CreateEventW;

    const BUFFER: u32 = 64 * 1024;
    /// Owner (the user who started the console) and SYSTEM only; protected
    /// from inherited ACEs. The default pipe DACL lets Everyone read.
    const SDDL: &str = "D:P(A;;GA;;;OW)(A;;GA;;;SY)";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A manual-reset event for one overlapped operation.
    struct Event(HANDLE);

    impl Event {
        fn new() -> io::Result<Event> {
            // SAFETY: plain event creation; no security attributes or name.
            let h = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            if h.is_null() {
                Err(io::Error::last_os_error())
            } else {
                Ok(Event(h))
            }
        }
    }

    impl Drop for Event {
        fn drop(&mut self) {
            // SAFETY: an event handle this struct owns.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub struct Listener {
        name: Vec<u16>,
        /// The instance the next client will connect to. One is always
        /// listening, so a client never finds the pipe missing (it would
        /// get "file not found" rather than wait for a busy pipe).
        next: Mutex<Option<OwnedHandle>>,
    }

    impl Listener {
        /// Listen on the pipe named for `path`, then mark `path`.
        pub fn bind(path: &Path) -> io::Result<Listener> {
            // The marker is an empty file; anything else at the path is the
            // user's and is never replaced.
            if let Ok(meta) = std::fs::symlink_metadata(path)
                && !(meta.is_file() && meta.len() == 0)
            {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "path exists and is not a console marker",
                ));
            }
            let name = wide(&super::pipe_name(path));
            let first = create_instance(&name, true)?;
            std::fs::File::create(path)?;
            Ok(Listener {
                name,
                next: Mutex::new(Some(first)),
            })
        }

        fn accept(&self) -> io::Result<Stream> {
            let pending = self.next.lock().unwrap_or_else(|e| e.into_inner()).take();
            let h = match pending {
                Some(h) => h,
                None => create_instance(&self.name, false)?,
            };
            let connected = connect(&h);
            *self.next.lock().unwrap_or_else(|e| e.into_inner()) =
                create_instance(&self.name, false).ok();
            connected?;
            Ok(Stream {
                inner: Arc::new(Inner {
                    handle: h,
                    write_timeout_ms: AtomicU32::new(0),
                }),
            })
        }

        /// Connections as they arrive (failed accepts are skipped, after a
        /// pause so a persistent failure can't spin).
        pub fn incoming(&self) -> impl Iterator<Item = Stream> + '_ {
            std::iter::repeat_with(move || {
                self.accept().inspect_err(|_| {
                    std::thread::sleep(Duration::from_millis(100));
                })
            })
            .flatten()
        }
    }

    fn create_instance(name: &[u16], first: bool) -> io::Result<OwnedHandle> {
        let sddl = wide(SDDL);
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: a valid NUL-terminated SDDL string and out-pointer.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        let open_mode = PIPE_ACCESS_DUPLEX
            | FILE_FLAG_OVERLAPPED
            | if first {
                FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };
        // SAFETY: `name` is NUL-terminated; `sa` and its descriptor are live
        // for the call.
        let h = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                open_mode,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                BUFFER,
                BUFFER,
                0,
                &sa,
            )
        };
        let err = io::Error::last_os_error();
        // SAFETY: allocated by ConvertStringSecurityDescriptor…, freed once.
        unsafe { LocalFree(sd) };
        if h == INVALID_HANDLE_VALUE {
            return Err(err);
        }
        // SAFETY: a fresh handle owned from here on.
        Ok(unsafe { OwnedHandle::from_raw_handle(h) })
    }

    /// Wait for a client on `h`.
    fn connect(h: &OwnedHandle) -> io::Result<()> {
        let ev = Event::new()?;
        let mut ov = OVERLAPPED {
            hEvent: ev.0,
            ..Default::default()
        };
        let h = h.as_raw_handle();
        // SAFETY: `ov` and its event outlive the operation (waited below).
        if unsafe { ConnectNamedPipe(h, &mut ov) } != 0 {
            return Ok(());
        }
        // SAFETY: no preconditions.
        match unsafe { GetLastError() } {
            ERROR_PIPE_CONNECTED => Ok(()),
            ERROR_IO_PENDING => {
                let mut n = 0u32;
                // SAFETY: waits for the operation started above.
                if unsafe { GetOverlappedResult(h, &ov, &mut n, 1) } != 0 {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                }
            }
            e => Err(io::Error::from_raw_os_error(e as i32)),
        }
    }

    struct Inner {
        handle: OwnedHandle,
        /// 0 = none.
        write_timeout_ms: AtomicU32,
    }

    /// One client connection. Clones share the pipe; reads and writes may
    /// run concurrently on different clones (each is its own overlapped
    /// operation — a synchronous pipe handle would serialise them, so a
    /// blocked read would stall every write).
    pub struct Stream {
        inner: Arc<Inner>,
    }

    impl Stream {
        pub fn try_clone(&self) -> io::Result<Stream> {
            Ok(Stream {
                inner: self.inner.clone(),
            })
        }

        /// Like `UnixStream::set_write_timeout`: applies to every clone.
        pub fn set_write_timeout(&self, t: Option<Duration>) -> io::Result<()> {
            let ms = t.map_or(0, |d| d.as_millis().clamp(1, u32::MAX as u128 - 1) as u32);
            self.inner.write_timeout_ms.store(ms, Ordering::Relaxed);
            Ok(())
        }

        fn raw(&self) -> HANDLE {
            self.inner.handle.as_raw_handle()
        }
    }

    fn disconnected(e: u32) -> bool {
        matches!(
            e,
            ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA
        )
    }

    impl io::Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let ev = Event::new()?;
            let mut ov = OVERLAPPED {
                hEvent: ev.0,
                ..Default::default()
            };
            let len = buf.len().min(u32::MAX as usize) as u32;
            let h = self.raw();
            // SAFETY: `buf` and `ov` outlive the operation (waited below).
            if unsafe { ReadFile(h, buf.as_mut_ptr(), len, std::ptr::null_mut(), &mut ov) } == 0 {
                // SAFETY: no preconditions.
                let e = unsafe { GetLastError() };
                if disconnected(e) {
                    return Ok(0);
                }
                if e != ERROR_IO_PENDING {
                    return Err(io::Error::from_raw_os_error(e as i32));
                }
            }
            let mut n = 0u32;
            // SAFETY: waits for the read started above.
            if unsafe { GetOverlappedResult(h, &ov, &mut n, 1) } == 0 {
                // SAFETY: no preconditions.
                let e = unsafe { GetLastError() };
                if disconnected(e) {
                    return Ok(0);
                }
                return Err(io::Error::from_raw_os_error(e as i32));
            }
            Ok(n as usize)
        }
    }

    impl io::Write for Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let ev = Event::new()?;
            let mut ov = OVERLAPPED {
                hEvent: ev.0,
                ..Default::default()
            };
            let len = buf.len().min(u32::MAX as usize) as u32;
            let h = self.raw();
            // SAFETY: `buf` and `ov` outlive the operation (waited below,
            // and cancelled-then-waited on timeout).
            if unsafe { WriteFile(h, buf.as_ptr(), len, std::ptr::null_mut(), &mut ov) } == 0 {
                // SAFETY: no preconditions.
                let e = unsafe { GetLastError() };
                if e != ERROR_IO_PENDING {
                    return Err(if disconnected(e) {
                        io::ErrorKind::BrokenPipe.into()
                    } else {
                        io::Error::from_raw_os_error(e as i32)
                    });
                }
            }
            let mut n = 0u32;
            let timeout = match self.inner.write_timeout_ms.load(Ordering::Relaxed) {
                0 => u32::MAX, // INFINITE
                ms => ms,
            };
            // SAFETY: waits for the write started above.
            if unsafe { GetOverlappedResultEx(h, &ov, &mut n, timeout, 0) } != 0 {
                return Ok(n as usize);
            }
            // SAFETY: no preconditions.
            let e = unsafe { GetLastError() };
            if e == WAIT_TIMEOUT {
                // The reader stopped reading. Cancel, and wait for the
                // cancellation so `buf` and `ov` stay valid until it lands.
                // SAFETY: cancels exactly the operation above, then waits.
                let finished = unsafe {
                    CancelIoEx(h, &ov);
                    GetOverlappedResult(h, &ov, &mut n, 1)
                };
                // It may have completed before the cancel landed.
                return if finished != 0 {
                    Ok(n as usize)
                } else {
                    Err(io::ErrorKind::TimedOut.into())
                };
            }
            Err(if disconnected(e) {
                io::ErrorKind::BrokenPipe.into()
            } else {
                io::Error::from_raw_os_error(e as i32)
            })
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_names_are_derived_from_the_path() {
        assert_eq!(
            pipe_name(std::path::Path::new(r"C:\Users\Ana Lí\Temp\raven-cAb1\s")),
            r"\\.\pipe\raven-C--Users-Ana-L--Temp-raven-cAb1-s"
        );
        assert_eq!(
            pipe_name(std::path::Path::new(r"\\.\pipe\mine")),
            r"\\.\pipe\mine"
        );
    }
}
