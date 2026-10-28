//! Console output: R's `WriteConsoleEx` hot path.
//!
//! Invariants:
//! * Never calls into R (it runs inside R's printing code; see `shim.c`).
//! * Preserves order between stdout and stderr: when both are the same
//!   terminal, every chunk goes through one buffer to fd 1.
//! * Passes ANSI escapes, `\r`, and partial lines through untouched; styling
//!   is only ever *added* around text that has no styling of its own.
//! * Output is batched only during bursts. A write that follows a pause
//!   longer than [`BURST_GAP`] first flushes anything pending and then goes
//!   straight to the terminal, so slow streaming output appears at once, and
//!   so does output printed just before R hands the terminal to something else
//!   (`system()`, compiled code writing to fd 1). Inside a burst (`print()` of
//!   a long vector is about a million writes) writes are coalesced and flushed
//!   by a background thread after [`FLUSH_INTERVAL`], before every prompt, on
//!   `flush.console()`, at 64 KB, and at process exit (`q()`). R's own writer
//!   makes one syscall per write; batching is where the console's output speed
//!   comes from. The trade-off: during a burst, native output can land up to
//!   `FLUSH_INTERVAL` early, and an abnormal exit (`abort`) loses that tail.
//!
//! Styles use the terminal's 16-colour palette roles, so they follow the
//! user's terminal theme (light or dark) without configuration.

use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;

const FLUSH_INTERVAL: Duration = Duration::from_millis(2);
/// A write arriving this long after the previous one is not part of a burst.
const BURST_GAP: Duration = Duration::from_millis(1);
const MAX_BUFFER: usize = 64 * 1024;
/// Lines longer than this are passed through without value styling.
const MAX_STYLED_LINE: usize = 4096;

const RESET: &str = "\x1b[0m";
const ERROR: &str = "\x1b[31m";
const WARNING: &str = "\x1b[33m";
const MESSAGE: &str = "\x1b[36m";
const V_INDEX: &str = "\x1b[90m";
const V_NUMBER: &str = "\x1b[34m";
const V_STRING: &str = "\x1b[32m";
const V_CONST: &str = "\x1b[35m";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    /// No styling at all.
    Off,
    /// Style stderr by condition kind (error / warning / message).
    Streams,
    /// `Streams`, plus colorout-style styling of printed values on stdout.
    Values,
}

impl ColorMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "off" => Some(Self::Off),
            "streams" => Some(Self::Streams),
            "values" => Some(Self::Values),
            _ => None,
        }
    }
}

/// The condition kind currently being printed on stderr.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Condition {
    Error,
    Warning,
    Message,
}

/// Localised headers R prints before conditions. Filled from R's own message
/// catalogue at startup (`gettext(..., domain = "R")`), so non-English
/// sessions classify correctly; English is the default.
#[derive(Debug, Clone)]
pub struct Headers {
    pub error: Vec<String>,
    pub warning: Vec<String>,
}

impl Default for Headers {
    fn default() -> Self {
        Self {
            error: vec!["Error in ".into(), "Error: ".into()],
            warning: vec![
                "Warning message".into(),
                "Warning messages".into(),
                "Warning in ".into(),
                "Warning: ".into(),
                "In addition: ".into(),
                "There were ".into(),
                "There was ".into(),
            ],
        }
    }
}

/// Classifies stderr text by line. Best effort by design: R hands the console
/// text, not condition objects. A line starting with a localised error or
/// warning header switches the style; R's own continuation lines (indented,
/// `n: ` numbered warnings, `Calls:`) keep it; any other line is a message.
/// A header that is the whole line (`Warning message:`, the block R prints
/// after a top-level call) styles everything up to the next prompt. The state
/// resets at every prompt and whenever stdout is written.
#[derive(Debug)]
struct StderrClassifier {
    headers: Headers,
    current: Option<Condition>,
    /// Inside a block introduced by a whole-line header.
    block: bool,
    at_line_start: bool,
    /// The current line has carried an escape sequence: leave the rest of it
    /// alone (a sequence may continue in the next write).
    line_raw: bool,
    /// A package's SGR style is still in effect (it may span lines).
    sgr_active: bool,
}

impl StderrClassifier {
    fn new(headers: Headers) -> Self {
        Self {
            headers,
            current: None,
            block: false,
            at_line_start: true,
            line_raw: false,
            sgr_active: false,
        }
    }

    fn reset(&mut self) {
        self.current = None;
        self.block = false;
        self.at_line_start = true;
        self.line_raw = false;
        self.sgr_active = false;
    }

    fn classify_line_start(&mut self, line: &str) -> Condition {
        let starts = |hs: &[String]| {
            hs.iter()
                .any(|h| !h.is_empty() && line.starts_with(h.as_str()))
        };
        if starts(&self.headers.error) {
            return Condition::Error;
        }
        if starts(&self.headers.warning) {
            if line.trim_end().ends_with(':') {
                self.block = true;
            }
            return Condition::Warning;
        }
        if self.block
            && let Some(cur) = self.current
        {
            return cur;
        }
        if let Some(cur @ (Condition::Error | Condition::Warning)) = self.current {
            let continuation =
                line.starts_with("  ") || line.starts_with("Calls:") || is_numbered_item(line);
            if continuation {
                return cur;
            }
        }
        Condition::Message
    }

    /// Append `text` to `out` with condition styling.
    fn style(&mut self, text: &str, out: &mut Vec<u8>) {
        for piece in text.split_inclusive('\n') {
            if escapes_only(piece) {
                self.sgr_active = sgr_active_after(piece, self.sgr_active);
                out.extend_from_slice(piece.as_bytes());
                continue;
            }
            if self.at_line_start {
                self.current = Some(self.classify_line_start(piece));
            }
            let color = match self.current.unwrap_or(Condition::Message) {
                Condition::Error => ERROR,
                Condition::Warning => WARNING,
                Condition::Message => MESSAGE,
            };
            self.line_raw |= self.sgr_active || piece.contains('\x1b');
            if self.line_raw {
                self.sgr_active = sgr_active_after(piece, self.sgr_active);
                out.extend_from_slice(piece.as_bytes());
            } else {
                push_styled(out, color, piece);
            }
            self.at_line_start = piece.ends_with('\n');
            if self.at_line_start {
                self.line_raw = self.sgr_active;
            }
        }
    }
}

/// Whether `text` is nothing but CSI escape sequences, such as the bare
/// `ESC[?25h` (show cursor) some packages write after every top-level call.
/// Such a write has no text to style, so it must not mark the line it lands
/// on as package-coloured; only the SGR state it leaves behind matters.
fn escapes_only(text: &str) -> bool {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] != 0x1b || b.get(i + 1) != Some(&b'[') {
            return false;
        }
        i += 2;
        while i < b.len() && (0x20..0x40).contains(&b[i]) {
            i += 1;
        }
        if i >= b.len() || !(0x40..0x7f).contains(&b[i]) {
            return false;
        }
        i += 1;
    }
    !b.is_empty()
}

/// Whether a package's colour/attribute (SGR) style is still in effect after
/// `text`, given whether one was before. `ESC[m`, `ESC[0m` and the default
/// foreground/background codes (`39`, `49`) end it; any other SGR starts one.
/// Approximate by design: it only has to know when to leave output alone.
fn sgr_active_after(text: &str, mut active: bool) -> bool {
    let b = text.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == 0x1b && b[i + 1] == b'[' {
            let start = i + 2;
            let mut j = start;
            while j < b.len() && (b[j].is_ascii_digit() || b[j] == b';') {
                j += 1;
            }
            if j < b.len() && b[j] == b'm' {
                let params = &text[start..j];
                let ends = params.is_empty()
                    || params
                        .split(';')
                        .all(|p| matches!(p, "" | "0" | "39" | "49"));
                active = !ends;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    active
}

fn is_numbered_item(line: &str) -> bool {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && line[digits..].starts_with(": ")
}

/// Wrap `text` in `color`, keeping a trailing newline outside the styled span
/// and leaving text that already carries escapes untouched.
fn push_styled(out: &mut Vec<u8>, color: &str, text: &str) {
    if text.contains('\x1b') {
        out.extend_from_slice(text.as_bytes());
        return;
    }
    let (body, nl) = match text.strip_suffix('\n') {
        Some(b) => (b, "\n"),
        None => (text, ""),
    };
    if !body.is_empty() {
        out.extend_from_slice(color.as_bytes());
        out.extend_from_slice(body.as_bytes());
        out.extend_from_slice(RESET.as_bytes());
    }
    out.extend_from_slice(nl.as_bytes());
}

/// colorout-style value styling for stdout (opt-in, [`ColorMode::Values`]).
///
/// Styles `[n]` index prefixes, numbers, quoted strings, and the constants
/// `NA`, `NULL`, `NaN`, `Inf`, `TRUE`, `FALSE`. Unlike colorout, a token only
/// counts when it stands alone between delimiters, so `a1b2`, `3f2a9c`, and
/// `192.168.0.1` stay plain. Text containing escapes passes through. String
/// state never carries past a newline, so an apostrophe in prose cannot
/// colour the rest of the output.
#[derive(Debug, Default)]
pub struct ValueLexer {
    /// Last byte of the previous chunk on this line (for token boundaries).
    prev: Option<u8>,
    at_line_start: bool,
    /// See `StderrClassifier::line_raw`.
    line_raw: bool,
    /// See `StderrClassifier::sgr_active`.
    sgr_active: bool,
    /// The colour span currently open. Consecutive tokens of one colour
    /// separated only by spaces share a span — R prints `print(1:1e6)` one
    /// element per write, and a colour/reset pair per number would more than
    /// double the bytes the terminal has to parse.
    open: Option<&'static str>,
}

impl ValueLexer {
    pub fn new() -> Self {
        Self {
            prev: None,
            at_line_start: true,
            line_raw: false,
            sgr_active: false,
            open: None,
        }
    }

    pub fn reset(&mut self) {
        self.prev = None;
        self.at_line_start = true;
        self.line_raw = false;
        self.sgr_active = false;
    }

    /// Close an open colour span (before other output, a prompt, or a newline).
    pub fn close(&mut self, out: &mut Vec<u8>) {
        if self.open.take().is_some() {
            out.extend_from_slice(RESET.as_bytes());
        }
    }

    /// Append `gap` (plain text) then `tok` in `color`, reusing the open span
    /// when the gap is only spaces.
    fn emit(&mut self, out: &mut Vec<u8>, gap: &[u8], color: &'static str, tok: &[u8]) {
        if self.open == Some(color) && gap.iter().all(|c| *c == b' ') {
            out.extend_from_slice(gap);
        } else {
            self.close(out);
            out.extend_from_slice(gap);
            out.extend_from_slice(color.as_bytes());
            self.open = Some(color);
        }
        out.extend_from_slice(tok);
    }

    /// Append plain text. Text that is only spaces keeps the span open (a
    /// same-coloured token may follow in the next write); anything else,
    /// including a newline, closes it first.
    fn plain(&mut self, out: &mut Vec<u8>, text: &[u8]) {
        if !text.iter().all(|c| *c == b' ') {
            self.close(out);
        }
        out.extend_from_slice(text);
    }

    pub fn style(&mut self, text: &str, out: &mut Vec<u8>) {
        for line in text.split_inclusive('\n') {
            if escapes_only(line) {
                self.close(out);
                self.sgr_active = sgr_active_after(line, self.sgr_active);
                out.extend_from_slice(line.as_bytes());
                continue;
            }
            self.line_raw |=
                self.sgr_active || line.contains('\x1b') || line.len() > MAX_STYLED_LINE;
            if self.line_raw {
                self.close(out);
                self.sgr_active = sgr_active_after(line, self.sgr_active);
                out.extend_from_slice(line.as_bytes());
            } else {
                self.style_line(line, out);
            }
            if line.ends_with('\n') {
                self.prev = None;
                self.at_line_start = true;
                self.line_raw = self.sgr_active;
            } else {
                self.prev = line.as_bytes().last().copied();
                self.at_line_start = false;
            }
        }
    }

    fn style_line(&mut self, line: &str, out: &mut Vec<u8>) {
        let b = line.as_bytes();
        let mut i = 0;
        // `[123]` / `[1,]` / `[,1]` row/column index labels at line start.
        if self.at_line_start {
            let ws = b.iter().take_while(|c| **c == b' ').count();
            if let Some(len) = index_label_len(&b[ws..]) {
                self.emit(out, &b[..ws], V_INDEX, &b[ws..ws + len]);
                i = ws + len;
            }
        }
        let mut prev = if i > 0 { Some(b[i - 1]) } else { self.prev };
        let mut plain_start = i;
        while i < b.len() {
            let c = b[i];
            let boundary_before = prev.is_none_or(is_delim);
            let token = if (c == b'"' || c == b'\'') && boundary_before {
                string_len(&b[i..]).map(|n| (n, V_STRING))
            } else if boundary_before {
                let n = word_len(&b[i..]);
                let next = b.get(i + n).copied();
                if n > 0 && next.is_none_or(is_delim) {
                    let w = &line[i..i + n];
                    if is_constant(w) {
                        Some((n, V_CONST))
                    } else if is_number(w) {
                        Some((n, V_NUMBER))
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };
            match token {
                Some((n, color)) => {
                    self.emit(out, &b[plain_start..i], color, &b[i..i + n]);
                    i += n;
                    plain_start = i;
                    prev = Some(b[i - 1]);
                }
                None => {
                    // Skip the whole word so we never start a token mid-word.
                    let n = word_len(&b[i..]).max(1);
                    let n = n.min(b.len() - i);
                    // Keep UTF-8 boundaries: advance to the next char start.
                    let mut j = i + n;
                    while j < b.len() && !line.is_char_boundary(j) {
                        j += 1;
                    }
                    prev = Some(b[j - 1]);
                    i = j;
                }
            }
        }
        self.plain(out, &b[plain_start..]);
    }
}

fn is_delim(c: u8) -> bool {
    matches!(
        c,
        b' ' | b'\t'
            | b'\n'
            | b'\r'
            | b'('
            | b')'
            | b'['
            | b']'
            | b'{'
            | b'}'
            | b','
            | b'='
            | b':'
            | b';'
            | b'<'
            | b'>'
    )
}

/// Length of a run of "word" bytes: anything that is not a delimiter or quote.
fn word_len(b: &[u8]) -> usize {
    b.iter()
        .take_while(|c| !is_delim(**c) && **c != b'"' && **c != b'\'')
        .count()
}

fn index_label_len(b: &[u8]) -> Option<usize> {
    if b.first() != Some(&b'[') {
        return None;
    }
    let close = b.iter().position(|c| *c == b']')?;
    let inner = &b[1..close];
    let ok = !inner.is_empty()
        && inner.iter().all(|c| c.is_ascii_digit() || *c == b',')
        && inner.iter().any(u8::is_ascii_digit);
    ok.then_some(close + 1)
}

/// A complete quoted string on this line, honouring backslash escapes.
fn string_len(b: &[u8]) -> Option<usize> {
    let q = b[0];
    let mut i = 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'\n' => return None,
            c if c == q => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

fn is_constant(w: &str) -> bool {
    matches!(
        w,
        "NA" | "NULL" | "NaN" | "Inf" | "-Inf" | "TRUE" | "FALSE" | "<NA>"
    )
}

/// R's printed numeric forms: `-1`, `1.5`, `1e-10`, `1.2e+03`, `3L`, `1i`,
/// a trailing `%` (percentages). Rejects things with more than one dot.
fn is_number(w: &str) -> bool {
    let w = w.strip_suffix('%').unwrap_or(w);
    let w = w.strip_prefix(['-', '+']).unwrap_or(w);
    let w = w.strip_suffix(['L', 'i']).unwrap_or(w);
    let (mantissa, exp) = match w.find(['e', 'E']) {
        Some(p) => (&w[..p], Some(&w[p + 1..])),
        None => (w, None),
    };
    let mut dots = 0;
    let mut digits = 0;
    for c in mantissa.bytes() {
        match c {
            b'0'..=b'9' => digits += 1,
            b'.' => dots += 1,
            _ => return false,
        }
    }
    if digits == 0 || dots > 1 {
        return false;
    }
    match exp {
        None => true,
        Some(e) => {
            let e = e.strip_prefix(['-', '+']).unwrap_or(e);
            !e.is_empty() && e.bytes().all(|c| c.is_ascii_digit())
        }
    }
}

/// The process-wide writer. R calls [`Output::write`] from `WriteConsoleEx`
/// on the main thread; the flusher thread only drains the buffer.
pub struct Output {
    inner: Mutex<Inner>,
    /// Signalled when the buffer goes from empty to non-empty, so the flusher
    /// sleeps (no wakeups) while the console is idle.
    pending: std::sync::Condvar,
}

struct Inner {
    mode: ColorMode,
    /// stdout and stderr are the same terminal: merge into fd 1 in order.
    merged: bool,
    buf: Vec<u8>,
    stderr_class: StderrClassifier,
    values: ValueLexer,
    /// While the line editor owns the terminal (raw mode), output produced by
    /// R event handlers is routed through reedline's external printer so it
    /// appears above the prompt instead of corrupting it.
    editor_sink: Option<std::sync::mpsc::SyncSender<String>>,
    pending_editor_line: String,
    /// Trailing bytes of an incomplete UTF-8 character, per stream (R may
    /// split a character across writes).
    carry: [Vec<u8>; 2],
    /// When the last write arrived (burst detection).
    last_write: Option<std::time::Instant>,
    /// Complete lines for the editor's printer not yet accepted by its
    /// (bounded) channel, in order.
    editor_queue: std::collections::VecDeque<String>,
}

static OUTPUT: std::sync::OnceLock<Output> = std::sync::OnceLock::new();

pub fn get() -> &'static Output {
    OUTPUT.get().expect("console output not initialised")
}

pub fn init(mode: ColorMode, headers: Headers) -> &'static Output {
    // SAFETY: isatty only inspects the descriptor.
    let merged = unsafe { libc::isatty(1) == 1 && libc::isatty(2) == 1 };
    let out = OUTPUT.get_or_init(|| Output {
        inner: Mutex::new(Inner {
            mode,
            merged,
            buf: Vec::with_capacity(MAX_BUFFER),
            stderr_class: StderrClassifier::new(headers),
            values: ValueLexer::new(),
            editor_sink: None,
            pending_editor_line: String::new(),
            carry: [Vec::new(), Vec::new()],
            last_write: None,
            editor_queue: std::collections::VecDeque::new(),
        }),
        pending: std::sync::Condvar::new(),
    });
    std::thread::Builder::new()
        .name("raven-console-flush".into())
        .spawn(|| {
            let out = get();
            loop {
                {
                    let mut g = out.lock();
                    while g.buf.is_empty() {
                        g = out.pending.wait(g).unwrap_or_else(|e| e.into_inner());
                    }
                }
                // Let a burst of writes accumulate, then write it in one go.
                std::thread::sleep(FLUSH_INTERVAL);
                out.flush();
            }
        })
        .expect("spawn flusher");
    // R ends the process with exit() (`q()`); drain what is buffered then.
    // SAFETY: registering a plain extern "C" fn with atexit.
    unsafe { libc::atexit(flush_at_exit) };
    out
}

extern "C" fn flush_at_exit() {
    if let Some(out) = OUTPUT.get() {
        // try_lock: never deadlock if exit() interrupted a write.
        if let Ok(mut g) = out.inner.try_lock() {
            let inner = &mut *g;
            inner.values.close(&mut inner.buf);
            drain_editor_to_buf(inner);
            flush_inner(inner);
        }
    }
}

/// Hand queued editor lines to the printer channel, in order, as far as it
/// has room.
fn drain_editor_queue(inner: &mut Inner) {
    let Some(sink) = inner.editor_sink.as_ref() else {
        return;
    };
    while let Some(line) = inner.editor_queue.pop_front() {
        match sink.try_send(line) {
            Ok(()) => {}
            Err(std::sync::mpsc::TrySendError::Full(line)) => {
                inner.editor_queue.push_front(line);
                return;
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(line)) => {
                inner.editor_queue.push_front(line);
                inner.editor_sink = None;
                return;
            }
        }
    }
}

/// Move editor-bound output (queued lines, then a partial line) to the
/// ordinary buffer, in order.
fn drain_editor_to_buf(inner: &mut Inner) {
    for line in std::mem::take(&mut inner.editor_queue) {
        inner.buf.extend_from_slice(line.as_bytes());
        inner.buf.push(b'\n');
    }
    let rest = std::mem::take(&mut inner.pending_editor_line);
    inner.buf.extend_from_slice(rest.as_bytes());
}

impl Output {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_headers(&self, headers: Headers) {
        self.lock().stderr_class.headers = headers;
    }

    /// `otype` is R's: 0 = stdout, 1 = stderr.
    pub fn write(&self, bytes: &[u8], otype: i32) {
        let mut g = self.lock();
        let inner = &mut *g;
        let is_err = otype != 0;
        let text = decode_utf8(&mut inner.carry[usize::from(is_err)], bytes);
        if text.is_empty() {
            return;
        }
        let mut styled = Vec::with_capacity(text.len() + 16);
        match (inner.mode, is_err) {
            (ColorMode::Off, _) => styled.extend_from_slice(text.as_bytes()),
            (_, true) => {
                inner.values.close(&mut styled);
                inner.stderr_class.style(&text, &mut styled);
            }
            (ColorMode::Values, false) => {
                inner.stderr_class.reset();
                inner.values.style(&text, &mut styled);
            }
            (ColorMode::Streams, false) => {
                inner.stderr_class.reset();
                styled.extend_from_slice(text.as_bytes());
            }
        }
        if inner.editor_sink.is_some() {
            // Editor is active: hand complete lines to reedline, which prints
            // them above the prompt.
            inner
                .pending_editor_line
                .push_str(&String::from_utf8_lossy(&styled));
            while let Some(nl) = inner.pending_editor_line.find('\n') {
                let line: String = inner.pending_editor_line.drain(..=nl).collect();
                inner
                    .editor_queue
                    .push_back(line.trim_end_matches('\n').to_string());
            }
            // The editor drains its channel on this same thread, so never
            // block on it: whatever doesn't fit waits in `editor_queue`.
            drain_editor_queue(inner);
            return;
        }
        if !inner.merged && is_err {
            let _ = std::io::stderr().write_all(&styled);
            return;
        }
        let now = std::time::Instant::now();
        let after_pause = inner
            .last_write
            .is_none_or(|t| now.duration_since(t) > BURST_GAP);
        inner.last_write = Some(now);
        let was_empty = inner.buf.is_empty();
        inner.buf.extend_from_slice(&styled);
        if after_pause || inner.buf.len() >= MAX_BUFFER {
            flush_inner(inner);
        } else if was_empty && !inner.buf.is_empty() {
            self.pending.notify_one();
        }
    }

    /// `flush.console()`: write everything out now, including a partial line
    /// printed while the editor is showing (e.g. a progress bar in a
    /// `later()` callback).
    pub fn flush(&self) {
        let mut g = self.lock();
        let inner = &mut *g;
        if inner.editor_sink.is_some() && !inner.pending_editor_line.is_empty() {
            let partial = std::mem::take(&mut inner.pending_editor_line);
            inner.editor_queue.push_back(partial);
            drain_editor_queue(inner);
        }
        flush_inner(inner);
    }

    /// Give queued editor lines another chance at the printer's channel
    /// (called from the editor's idle loop, after reedline has drained it).
    pub fn pump_editor(&self) {
        drain_editor_queue(&mut self.lock());
    }

    /// A prompt is about to be shown: flush and reset condition state.
    pub fn at_prompt(&self) {
        let mut g = self.lock();
        let inner = &mut *g;
        inner.values.close(&mut inner.buf);
        inner.stderr_class.reset();
        inner.values.reset();
        flush_inner(&mut g);
    }

    /// Route output to the editor (Some) or back to the terminal (None).
    pub fn set_editor_sink(&self, sink: Option<std::sync::mpsc::SyncSender<String>>) {
        let mut g = self.lock();
        if sink.is_none() {
            // Output that arrived while editing but hasn't been printed yet
            // belongs before what comes next.
            drain_editor_to_buf(&mut g);
        }
        g.editor_sink = sink;
    }
}

/// Decode `bytes` after any `carry`-ed partial character; an incomplete
/// character at the end is carried to the next write. Invalid bytes become
/// U+FFFD, as before.
fn decode_utf8(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    let mut all = std::mem::take(carry);
    all.extend_from_slice(bytes);
    let keep = match std::str::from_utf8(&all) {
        Ok(_) => 0,
        // An incomplete sequence at the very end: hold it back.
        Err(e) if e.error_len().is_none() => all.len() - e.valid_up_to(),
        Err(_) => 0,
    };
    let tail = all.split_off(all.len() - keep);
    *carry = tail;
    String::from_utf8_lossy(&all).into_owned()
}

fn flush_inner(inner: &mut Inner) {
    if inner.buf.is_empty() {
        return;
    }
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&inner.buf);
    let _ = out.flush();
    inner.buf.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(s: &str) -> String {
        let mut out = Vec::new();
        ValueLexer::new().style(s, &mut out);
        String::from_utf8(out).unwrap()
    }

    fn stderr(chunks: &[&str]) -> String {
        let mut c = StderrClassifier::new(Headers::default());
        let mut out = Vec::new();
        for ch in chunks {
            c.style(ch, &mut out);
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn numbers_and_index_are_styled() {
        assert_eq!(
            values("[1] 1 2.5 NA\n"),
            format!("{V_INDEX}[1]{RESET} {V_NUMBER}1 2.5{RESET} {V_CONST}NA{RESET}\n")
        );
    }

    #[test]
    fn numbers_inside_words_stay_plain() {
        // colorout #37: hashes, hostnames, versions inside words.
        for s in [
            "a1b2\n",
            "3f2a9c\n",
            "192.168.0.1\n",
            "x86_64\n",
            "R-4.6.1\n",
        ] {
            assert_eq!(values(s), s, "{s:?}");
        }
    }

    #[test]
    fn strings_do_not_leak_past_newline() {
        let out = values("don't stop\nnext 1\n");
        assert!(out.starts_with("don't stop\n"), "{out:?}");
        assert!(
            out.ends_with(&format!("next {V_NUMBER}1{RESET}\n")),
            "{out:?}"
        );
    }

    #[test]
    fn quoted_strings_are_styled() {
        assert_eq!(
            values("[1] \"a b\" \"c\"\n"),
            format!("{V_INDEX}[1]{RESET} {V_STRING}\"a b\" \"c\"{RESET}\n")
        );
    }

    #[test]
    fn escapes_pass_through() {
        let s = "\x1b[1mbold 1\x1b[0m\n";
        assert_eq!(values(s), s);
    }

    #[test]
    fn data_frame_rows() {
        let out = values("  x  y\n1 1 NA\n");
        assert!(
            out.contains(&format!("{V_NUMBER}1 1{RESET} {V_CONST}NA{RESET}")),
            "{out:?}"
        );
    }

    #[test]
    fn one_span_per_run_across_writes() {
        // R writes `print(1:3)` element by element.
        let mut lx = ValueLexer::new();
        let mut out = Vec::new();
        for w in ["[1]", " 1", " 2", " 3", "\n"] {
            lx.style(w, &mut out);
        }
        assert_eq!(
            String::from_utf8(out).unwrap(),
            format!("{V_INDEX}[1]{RESET} {V_NUMBER}1 2 3{RESET}\n")
        );
    }

    #[test]
    fn split_chunks_keep_boundaries() {
        let mut lx = ValueLexer::new();
        let mut out = Vec::new();
        lx.style("abc", &mut out);
        lx.style("123\n", &mut out);
        assert_eq!(String::from_utf8(out).unwrap(), "abc123\n");
    }

    #[test]
    fn error_then_traceback_lines_share_style() {
        let out = stderr(&["Error in f() : boom\n", "Calls: g -> f\n"]);
        assert_eq!(
            out,
            format!("{ERROR}Error in f() : boom{RESET}\n{ERROR}Calls: g -> f{RESET}\n")
        );
    }

    #[test]
    fn deferred_warnings_block() {
        let out = stderr(&["Warning messages:\n", "1: In f() : a\n", "2: In f() : b\n"]);
        assert!(!out.contains(MESSAGE), "{out:?}");
        assert_eq!(out.matches(WARNING).count(), 3);
    }

    #[test]
    fn single_deferred_warning_block() {
        // `warning("careful")` at top level prints the header line, then the
        // message unindented.
        let out = stderr(&["Warning message:\n", "careful \n"]);
        assert!(!out.contains(MESSAGE), "{out:?}");
    }

    #[test]
    fn plain_stderr_is_a_message() {
        assert_eq!(
            stderr(&["Loading required package: x\n"]),
            format!("{MESSAGE}Loading required package: x{RESET}\n")
        );
    }

    #[test]
    fn message_after_warning_is_reclassified() {
        let out = stderr(&["Warning in f() : w\n", "hello\n"]);
        assert!(
            out.ends_with(&format!("{MESSAGE}hello{RESET}\n")),
            "{out:?}"
        );
    }

    #[test]
    fn partial_line_keeps_classification() {
        let out = stderr(&["Error in f() : ", "boom\n"]);
        assert_eq!(
            out,
            format!("{ERROR}Error in f() : {RESET}{ERROR}boom{RESET}\n")
        );
    }

    #[test]
    fn split_utf8_character_is_reassembled() {
        let mut carry = Vec::new();
        let e = "é".as_bytes();
        assert_eq!(decode_utf8(&mut carry, &[b'a', e[0]]), "a");
        assert_eq!(decode_utf8(&mut carry, &[e[1], b'b']), "éb");
        assert!(carry.is_empty());
    }

    #[test]
    fn split_escape_sequence_is_not_restyled() {
        let mut c = StderrClassifier::new(Headers::default());
        let mut out = Vec::new();
        c.style("Error in f() : \x1b[1", &mut out);
        c.style("mboom\x1b[0m\n", &mut out);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "Error in f() : \x1b[1mboom\x1b[0m\n"
        );
        let mut lx = ValueLexer::new();
        let mut out = Vec::new();
        lx.style("x \x1b[3", &mut out);
        lx.style("1m 42\n", &mut out);
        assert_eq!(String::from_utf8(out).unwrap(), "x \x1b[31m 42\n");
    }

    #[test]
    fn package_colour_spanning_lines_is_left_alone() {
        // e.g. crayon/cli styling a multi-line block with one escape pair.
        let mut lx = ValueLexer::new();
        let mut out = Vec::new();
        for w in ["\x1b[31mA 1\n", "B 2\n", "C 3\x1b[39m\n", "D 4\n"] {
            lx.style(w, &mut out);
        }
        let out = String::from_utf8(out).unwrap();
        assert!(
            out.starts_with("\x1b[31mA 1\nB 2\nC 3\x1b[39m\n"),
            "{out:?}"
        );
        assert!(out.ends_with(&format!("D {V_NUMBER}4{RESET}\n")), "{out:?}");

        let mut c = StderrClassifier::new(Headers::default());
        let mut out = Vec::new();
        c.style("\x1b[33mline one\n", &mut out);
        c.style("line two\x1b[0m\n", &mut out);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "\x1b[33mline one\nline two\x1b[0m\n"
        );
    }

    #[test]
    fn bare_cursor_escape_does_not_disable_styling() {
        // httpgd's session writes `ESC[?25h` to stdout after every top-level
        // call; the next result must still be styled.
        let mut lx = ValueLexer::new();
        let mut out = Vec::new();
        for w in ["[1]", " 1", "\n", "\x1b[?25h", "[1]", " 2", "\n"] {
            lx.style(w, &mut out);
        }
        let out = String::from_utf8(out).unwrap();
        assert!(
            out.ends_with(&format!(
                "\x1b[?25h{V_INDEX}[1]{RESET} {V_NUMBER}2{RESET}\n"
            )),
            "{out:?}"
        );

        let mut c = StderrClassifier::new(Headers::default());
        let mut out = Vec::new();
        c.style("\x1b[?25l", &mut out);
        c.style("note\n", &mut out);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            format!("\x1b[?25l{MESSAGE}note{RESET}\n")
        );
    }

    #[test]
    fn number_forms() {
        for n in [
            "1", "-1", "1.5", "1e-10", "2.5E+03", "3L", "1i", "50%", ".5",
        ] {
            assert!(is_number(n), "{n}");
        }
        for n in ["1.2.3", "e5", "-", "1e", "0x1F", "abc"] {
            assert!(!is_number(n), "{n}");
        }
    }
}
