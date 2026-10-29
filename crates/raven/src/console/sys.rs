//! Platform specifics of interrupting R and of the terminal the console runs
//! in. Everything else in the console is platform-neutral.
//!
//! Interrupting R from another thread (the IPC `interrupt` request, the
//! debugger's Pause/Stop) must look exactly like the user's Ctrl-C:
//!
//! * Unix: `SIGINT` delivered to the R thread runs R's own handler there.
//! * Windows: R polls its exported `UserBreak` flag (in `R_ProcessEvents`,
//!   which `R_CheckUserInterrupt` calls), so the flag is set. Ctrl-C itself
//!   reaches the console as a console control event while R runs (outside
//!   the line editor's raw mode), and the handler installed by [`init`] sets
//!   the same flag — Rterm does the same.

#[cfg(unix)]
mod imp {
    use std::sync::OnceLock;

    struct MainThread(libc::pthread_t);
    // SAFETY: pthread_t is an opaque thread id; it is only passed to
    // pthread_kill.
    unsafe impl Send for MainThread {}
    unsafe impl Sync for MainThread {}

    static MAIN: OnceLock<MainThread> = OnceLock::new();

    /// Record the R thread. Call on it, before any thread may interrupt.
    pub fn init(_lib: &'static crate::console::libr::LibR) {
        // SAFETY: pthread_self has no preconditions.
        let _ = MAIN.set(MainThread(unsafe { libc::pthread_self() }));
    }

    pub fn interrupt_r() {
        if let Some(t) = MAIN.get() {
            // SAFETY: delivering SIGINT to the R thread runs R's own handler
            // there, exactly as a Ctrl-C would.
            unsafe { libc::pthread_kill(t.0, libc::SIGINT) };
        }
    }

    pub fn stdin_and_stdout_are_terminals() -> bool {
        // SAFETY: isatty only inspects the descriptor.
        unsafe { libc::isatty(0) == 1 && libc::isatty(1) == 1 }
    }

    /// Nothing to set up: Unix terminals interpret escape sequences and
    /// carry UTF-8 already.
    pub fn prepare_terminal() -> bool {
        true
    }

    pub fn read_line(mut idle: Option<&mut dyn FnMut() -> Option<String>>) -> super::Line {
        use super::Line;
        use std::io::{Error, ErrorKind};
        // Read with libc so that Ctrl-C (EINTR) interrupts instead of
        // retrying.
        let mut line = Vec::new();
        let mut byte = 0u8;
        loop {
            if line.is_empty()
                && let Some(idle) = idle.as_mut()
            {
                if let Some(text) = idle() {
                    return Line::Text(text);
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
                if ready < 0 && Error::last_os_error().kind() == ErrorKind::Interrupted {
                    return Line::Interrupted;
                }
            }
            // SAFETY: reading one byte into a valid buffer.
            let n = unsafe { libc::read(0, (&raw mut byte).cast(), 1) };
            if n == 1 {
                line.push(byte);
                if byte == b'\n' {
                    return Line::Text(String::from_utf8_lossy(&line).into_owned());
                }
            } else if n != 0 && Error::last_os_error().kind() == ErrorKind::Interrupted {
                return Line::Interrupted;
            } else {
                return Line::Eof;
            }
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_int;
    use std::io::IsTerminal;
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

    use windows_sys::Win32::Foundation::{ERROR_OPERATION_ABORTED, GetLastError, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Console::{
        CTRL_BREAK_EVENT, CTRL_C_EVENT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, GetConsoleMode,
        GetStdHandle, INPUT_RECORD, KEY_EVENT, PeekConsoleInputW, ReadConsoleInputW, ReadConsoleW,
        STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetConsoleCP, SetConsoleCtrlHandler,
        SetConsoleMode, SetConsoleOutputCP,
    };
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    /// R's `UserBreak` (an `int`-sized `Rboolean`).
    static USER_BREAK: AtomicPtr<c_int> = AtomicPtr::new(std::ptr::null_mut());
    /// Ctrl-C was pressed (for [`read_line`], which must stop waiting).
    static CTRL_C: AtomicBool = AtomicBool::new(false);

    /// Record R's interrupt flag and route Ctrl-C to it.
    pub fn init(lib: &'static crate::console::libr::LibR) {
        USER_BREAK.store(lib.user_break, Ordering::SeqCst);
        // Handlers run newest first, so this one answers Ctrl-C before the
        // C runtime's (which would end the process).
        // SAFETY: registers a plain extern "system" fn.
        unsafe { SetConsoleCtrlHandler(Some(on_ctrl), 1) };
    }

    unsafe extern "system" fn on_ctrl(event: u32) -> windows_sys::core::BOOL {
        if event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT {
            CTRL_C.store(true, Ordering::SeqCst);
            interrupt_r();
            return 1;
        }
        0
    }

    pub fn interrupt_r() {
        let p = USER_BREAK.load(Ordering::SeqCst);
        if !p.is_null() {
            // SAFETY: R's exported global, valid for the life of the process;
            // R only ever reads it as a flag, as from a signal handler.
            unsafe { std::ptr::write_volatile(p, 1) };
        }
    }

    pub fn stdin_and_stdout_are_terminals() -> bool {
        std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
    }

    /// Make the console carry UTF-8 (R's native encoding under raven.exe's
    /// manifest; Rterm does the same) and interpret escape sequences.
    /// Returns false when it can't do the latter (colors are then off).
    pub fn prepare_terminal() -> bool {
        // SAFETY: plain console-mode calls on the process's own handles.
        unsafe {
            SetConsoleOutputCP(65001);
            SetConsoleCP(65001);
            let mut vt = true;
            for which in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
                let h = GetStdHandle(which);
                let mut mode = 0u32;
                if GetConsoleMode(h, &mut mode) == 0 {
                    continue;
                }
                if SetConsoleMode(h, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) == 0 {
                    vt = false;
                }
            }
            vt
        }
    }

    /// A cooked console line. ReadConsoleW directly, because Rust's stdin
    /// retries after Ctrl-C (which must interrupt instead).
    pub fn read_line(mut idle: Option<&mut dyn FnMut() -> Option<String>>) -> super::Line {
        use super::Line;
        // SAFETY: the process's own input handle.
        let h = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        CTRL_C.store(false, Ordering::SeqCst);
        if let Some(idle) = idle.as_mut() {
            loop {
                if let Some(text) = idle() {
                    return Line::Text(text);
                }
                if CTRL_C.swap(false, Ordering::SeqCst) {
                    return Line::Interrupted;
                }
                // SAFETY: waiting on a console input handle.
                if unsafe { WaitForSingleObject(h, 50) } == WAIT_OBJECT_0 && key_pending(h) {
                    break;
                }
            }
        }
        let mut line: Vec<u16> = Vec::new();
        let mut buf = [0u16; 512];
        loop {
            let mut n = 0u32;
            // SAFETY: `buf` holds `buf.len()` UTF-16 units.
            let ok = unsafe {
                ReadConsoleW(
                    h,
                    buf.as_mut_ptr().cast(),
                    buf.len() as u32,
                    &mut n,
                    std::ptr::null(),
                )
            };
            // Ctrl-C ends a cooked read early with nothing read (the control
            // handler, on its own thread, may not have run yet).
            // SAFETY: no preconditions.
            let aborted = ok != 0 && n == 0 && unsafe { GetLastError() } == ERROR_OPERATION_ABORTED;
            if aborted || CTRL_C.swap(false, Ordering::SeqCst) {
                return Line::Interrupted;
            }
            if ok == 0 || n == 0 {
                return Line::Eof;
            }
            line.extend_from_slice(&buf[..n as usize]);
            if line.last() == Some(&(b'\n' as u16)) {
                break;
            }
        }
        let text = String::from_utf16_lossy(&line);
        let text = text.trim_end_matches(['\r', '\n']);
        // Ctrl-Z at the start of a line is the console's end of input.
        if text.starts_with('\u{1a}') {
            return Line::Eof;
        }
        Line::Text(format!("{text}\n"))
    }

    /// Whether the console's input holds a key press; other events (focus,
    /// mouse, key releases) are discarded, so a wait on the handle doesn't
    /// spin on them.
    fn key_pending(h: windows_sys::Win32::Foundation::HANDLE) -> bool {
        // SAFETY: an all-zero INPUT_RECORD is valid; the API writes at most
        // `recs.len()` records.
        unsafe {
            let mut recs: [INPUT_RECORD; 64] = std::mem::zeroed();
            let mut n = 0u32;
            if PeekConsoleInputW(h, recs.as_mut_ptr(), recs.len() as u32, &mut n) == 0 {
                return true; // let the read decide
            }
            let key = recs[..n as usize]
                .iter()
                .any(|r| u32::from(r.EventType) == KEY_EVENT && r.Event.KeyEvent.bKeyDown != 0);
            if !key && n > 0 {
                ReadConsoleInputW(h, recs.as_mut_ptr(), n, &mut n);
            }
            key
        }
    }
}

/// What a cooked-mode line read ended with.
pub enum Line {
    /// The line, ending in `\n`.
    Text(String),
    /// Ctrl-C.
    Interrupted,
    Eof,
}

/// Read one cooked-mode line from the terminal. While nothing has been typed,
/// `idle` (if given) is called about every 50 ms; a line it returns is used
/// instead.
pub use imp::read_line;

pub use imp::{init, interrupt_r, prepare_terminal, stdin_and_stdout_are_terminals};
