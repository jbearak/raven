//! Terminal-mode helpers.

/// Run `f` with the terminal's interrupt key live.
///
/// reedline keeps the terminal in raw mode, where Ctrl-C is an ordinary key.
/// Work that calls into R from inside the editor (completion) re-enables
/// `ISIG` for its duration, so Ctrl-C raises SIGINT, R's handler flags the
/// interrupt, and R abandons the call at its next interrupt check — the shim
/// turns that jump into an ordinary failure. (Windows: processed input, so
/// Ctrl-C raises the console control event `sys` turns into R's interrupt.)
#[cfg(unix)]
pub fn with_interrupt_key<T>(f: impl FnOnce() -> T) -> T {
    // SAFETY: tcgetattr/tcsetattr on fd 0 with a properly sized termios.
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(0, &mut t) != 0 {
            return f();
        }
        let saved = t;
        t.c_lflag |= libc::ISIG;
        libc::tcsetattr(0, libc::TCSANOW, &t);
        let r = f();
        libc::tcsetattr(0, libc::TCSANOW, &saved);
        r
    }
}

#[cfg(windows)]
pub fn with_interrupt_key<T>(f: impl FnOnce() -> T) -> T {
    use windows_sys::Win32::System::Console::{
        ENABLE_PROCESSED_INPUT, GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE, SetConsoleMode,
    };
    // SAFETY: console-mode calls on the process's own input handle.
    unsafe {
        let h = GetStdHandle(STD_INPUT_HANDLE);
        let mut saved = 0u32;
        if GetConsoleMode(h, &mut saved) == 0 {
            return f();
        }
        SetConsoleMode(h, saved | ENABLE_PROCESSED_INPUT);
        let r = f();
        SetConsoleMode(h, saved);
        r
    }
}

/// Current terminal width in columns, if stdout is a terminal.
pub fn width() -> Option<u16> {
    crossterm::terminal::size()
        .ok()
        .map(|(w, _)| w)
        .filter(|w| *w > 0)
}
