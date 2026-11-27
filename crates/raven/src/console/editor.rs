//! The line editor: reedline configured for R.
//!
//! Everything here runs on the R (main) thread, inside `ReadConsole`, while R
//! is idle. The validator and completer call into R, always through `shim.c`.

use std::borrow::Cow;
use std::cell::RefCell;
use std::ffi::CString;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use nu_ansi_term::{Color, Style};
use reedline::{
    ColumnarMenu, Completer, CompletionResult, DefaultHinter, EditCommand, Editor, Emacs,
    FileBackedHistory, Highlighter, Hinter, History, IdeMenu, KeyCode, KeyModifiers, Keybindings,
    Menu, MenuBuilder, MenuEvent, MenuSettings, Painter, Prompt, PromptEditMode,
    PromptHistorySearch, PromptHistorySearchStatus, Reedline, ReedlineEvent, ReedlineMenu,
    SimpleMatchHighlighter, Span, StyledText, Suggestion, ValidationResult, Validator, Vi,
    default_emacs_keybindings, default_vi_insert_keybindings, default_vi_normal_keybindings,
    default_vi_visual_keybindings,
};

use super::folder_history::{self, FolderStore, KeyCache, RecordingHistory};
use super::lexer::{self, Scan};
use super::libr::{self, Sexp};

/// Input larger than this is not highlighted (keeps keystrokes cheap on huge
/// pastes, like Julia's highlight budget).
const MAX_HIGHLIGHT: usize = 64 * 1024;
/// Input larger than this skips R's parse probe and is submitted as-is.
const MAX_PARSE_PROBE: usize = 1024 * 1024;
const INDENT: &str = "  ";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditMode {
    Emacs,
    Vi,
}

/// State shared between the validator (which decides an Enter continues the
/// input) and the read loop (which inserts the new line's indentation).
#[derive(Default)]
pub struct IndentRequest(Mutex<Option<String>>);

impl IndentRequest {
    pub fn take(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
    fn set(&self, indent: String) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(indent);
    }
}

pub struct EditorConfig {
    pub mode: EditMode,
    pub history_file: Option<std::path::PathBuf>,
    pub complete_fn: Sexp,
    pub break_flag: Arc<AtomicBool>,
    pub indent: Arc<IndentRequest>,
    pub printer: reedline::ExternalPrinter<String>,
}

pub fn build(cfg: EditorConfig) -> Reedline {
    let completion_menu = IdeMenu::default()
        .with_name("completion_menu")
        .with_marker("")
        .with_min_completion_width(12)
        .with_max_completion_height(10)
        .with_text_style(Style::new())
        .with_selected_text_style(Style::new().reverse())
        .with_match_text_style(Style::new().bold())
        // reedline's default adds green, which reversed is a green background.
        .with_selected_match_text_style(Style::new().bold().underline().reverse());
    let history_menu = ColumnarMenu::default().with_name("history_menu");

    let edit: Box<dyn reedline::EditMode> = match cfg.mode {
        EditMode::Emacs => {
            let mut kb = default_emacs_keybindings();
            add_common_keybindings(&mut kb);
            Box::new(Emacs::new(kb))
        }
        EditMode::Vi => {
            let mut insert = default_vi_insert_keybindings();
            add_common_keybindings(&mut insert);
            Box::new(Vi::new(
                insert,
                default_vi_normal_keybindings(),
                default_vi_visual_keybindings(),
            ))
        }
    };

    let in_memory = || FileBackedHistory::new(folder_history::MAIN_CAPACITY).expect("in-memory");
    let (main, folders) = match cfg.history_file.and_then(|p| {
        FileBackedHistory::with_file(folder_history::MAIN_CAPACITY, p.clone())
            .ok()
            .map(|h| (h, p))
    }) {
        Some((h, p)) => (h, FolderStore::beside(&p)),
        None => (in_memory(), FolderStore::in_memory()),
    };

    Reedline::create()
        .with_history(Box::new(RecordingHistory::new(main, folders.clone())))
        .with_hinter(Box::new(LineHinter::new(folders)))
        .with_highlighter(Box::new(RHighlighter::new()))
        .with_validator(Box::new(RValidator {
            indent: cfg.indent,
            break_flag: cfg.break_flag.clone(),
        }))
        .with_completer(Box::new(RCompleter {
            fun: cfg.complete_fn,
        }))
        .with_quick_completions(true)
        .with_partial_completions(true)
        .with_menu(ReedlineMenu::EngineCompleter(Box::new(QuietMenu(
            completion_menu,
        ))))
        .with_menu(ReedlineMenu::HistoryMenu(Box::new(history_menu)))
        .with_edit_mode(edit)
        .with_visual_selection_style(selection_style())
        .with_break_signal(cfg.break_flag)
        .with_external_printer(cfg.printer)
        .with_poll_interval(std::time::Duration::from_millis(33))
        .use_bracketed_paste(true)
}

/// The editor for `readline()`/`menu()`/`scan()` input: a bare line with the
/// usual editing keys and bracketed paste — no history, completion,
/// highlighting or pairing — read in raw mode, so it has no line-length cap
/// (a cooked terminal's line discipline truncates at ~1 KB on macOS).
///
/// The text is drawn unstyled: reedline's default highlighter paints it white,
/// which is invisible on a light background. A `SimpleMatchHighlighter` with
/// no query adds no style at all.
///
/// `abort` breaks the read (the debugger's Stop ending a program waiting here).
pub fn build_plain(idle: Box<dyn FnMut() + Send>, abort: Arc<AtomicBool>) -> Reedline {
    Reedline::create()
        .with_highlighter(Box::new(SimpleMatchHighlighter::default()))
        .with_visual_selection_style(selection_style())
        .use_bracketed_paste(true)
        .with_poll_interval(std::time::Duration::from_millis(33))
        .with_idle_callback(idle)
        .with_break_signal(abort)
}

/// Selected text in reverse video: the terminal's own text and background
/// colors swapped. reedline's default, a bright-white background under
/// unchanged text, is unreadable on a dark background.
fn selection_style() -> Style {
    Style::new().reverse()
}

fn add_common_keybindings(kb: &mut Keybindings) {
    kb.add_binding(
        KeyModifiers::NONE,
        KeyCode::Tab,
        ReedlineEvent::UntilFound(vec![
            ReedlineEvent::Menu("completion_menu".into()),
            ReedlineEvent::MenuNext,
        ]),
    );
    kb.add_binding(
        KeyModifiers::SHIFT,
        KeyCode::BackTab,
        ReedlineEvent::MenuPrevious,
    );
    // Alt-Enter always inserts a newline, even when the input is complete.
    kb.add_binding(
        KeyModifiers::ALT,
        KeyCode::Enter,
        ReedlineEvent::Edit(vec![EditCommand::InsertNewline]),
    );
}

// ---- history suggestion -----------------------------------------------------

/// Dim and underlined, in the terminal's own text color. Dim is what makes it
/// read as a suggestion: underlined at full strength, it was taken for text
/// the console had typed. The underline keeps it apart from typed text where
/// dim is not fainter (a light background in xterm or VTE). A grey is not
/// used because it can equal the background: bright black is the background
/// in Solarized.
fn st_suggestion() -> Style {
    Style::new().dimmed().underline()
}

/// The history suggestion, one line at a time, from the current folder's
/// entries only (see `folder_history`).
///
/// reedline's [`DefaultHinter`] suggests the rest of the newest history entry
/// that starts with the input; here it searches the folder store for the
/// input behind the folder's key. For a multi-line entry reedline draws the later
/// lines from column 0, without the `+ ` prompt, where they read as text the
/// console inserted. This hinter shows and accepts only the rest of the
/// current line. After Enter the entry's next line is suggested in turn, as
/// long as the input, with the indentation Enter added, still begins the entry.
struct LineHinter {
    inner: DefaultHinter,
    /// The suggestion on screen, unstyled: what accepting it inserts.
    shown: String,
    folders: FolderStore,
    keys: KeyCache,
}

impl LineHinter {
    fn new(folders: FolderStore) -> Self {
        Self {
            inner: DefaultHinter::default(),
            shown: String::new(),
            folders,
            keys: KeyCache::default(),
        }
    }

    /// The suggestion for `line` typed in folder `dir` (`None`: unknown).
    fn hint_in(&mut self, line: &str, dir: Option<&Path>, use_ansi_coloring: bool) -> String {
        let rest = match self.keys.key(dir) {
            Some(key) if !line.is_empty() => {
                let keyed = format!("{key}{line}");
                let inner = &mut self.inner;
                self.folders
                    .with_rows(|rows| inner.handle(&keyed, keyed.len(), rows, false, ""))
            }
            _ => {
                // Forget the last suggestion, or accepting a word would
                // still insert its first word.
                self.inner = DefaultHinter::default();
                String::new()
            }
        };
        self.shown = first_line(&rest).to_string();
        if use_ansi_coloring && !self.shown.is_empty() {
            st_suggestion().paint(&self.shown).to_string()
        } else {
            self.shown.clone()
        }
    }
}

impl Hinter for LineHinter {
    /// The suggestion comes from the folder store, not reedline's `history`,
    /// for the working directory now, not reedline's lossy `cwd` string.
    fn handle(
        &mut self,
        line: &str,
        _pos: usize,
        _history: &dyn History,
        use_ansi_coloring: bool,
        _cwd: &str,
    ) -> String {
        let dir = folder_history::current_folder();
        self.hint_in(line, dir.as_deref(), use_ansi_coloring)
    }

    fn complete_hint(&self) -> String {
        self.shown.clone()
    }

    fn next_hint_token(&self) -> String {
        first_line(&self.inner.next_hint_token()).to_string()
    }
}

/// `text` up to its first line break.
fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or_default()
}

// ---- highlighting -----------------------------------------------------------

fn st_keyword() -> Style {
    Style::new().fg(Color::Magenta).bold()
}
fn st_constant() -> Style {
    Style::new().fg(Color::Magenta)
}
fn st_string() -> Style {
    Style::new().fg(Color::Green)
}
/// Italic in the terminal's own text color: bright black, the usual comment
/// grey, is the background color in Solarized.
fn st_comment() -> Style {
    Style::new().italic()
}

struct RHighlighter {
    parser: RefCell<tree_sitter::Parser>,
}

// SAFETY: reedline requires `Send` but only ever calls the highlighter from
// the thread that runs `read_line` (the R thread).
unsafe impl Send for RHighlighter {}

impl RHighlighter {
    fn new() -> Self {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_r::LANGUAGE.into())
            .expect("tree-sitter-r language");
        Self {
            parser: RefCell::new(parser),
        }
    }

    fn spans(&self, line: &str) -> Vec<(usize, usize, Style)> {
        let Some(tree) = self.parser.borrow_mut().parse(line, None) else {
            return Vec::new();
        };
        let mut spans = Vec::new();
        let mut cursor = tree.walk();
        let mut descend = true;
        loop {
            let node = cursor.node();
            let style = if descend {
                match node.kind() {
                    "comment" => Some(st_comment()),
                    "string" => Some(st_string()),
                    "true" | "false" | "null" | "na" | "inf" | "nan" | "dots" | "dot_dot_i" => {
                        Some(st_constant())
                    }
                    "function" | "if" | "else" | "for" | "while" | "repeat" | "in" | "break"
                    | "next" | "\\" => Some(st_keyword()),
                    // Numbers (`integer`, `float`, `complex`) stay in the
                    // terminal's text color: blue is below 3:1 on several
                    // stock dark palettes.
                    _ => None,
                }
            } else {
                None
            };
            if let Some(s) = style {
                spans.push((node.start_byte(), node.end_byte(), s));
            }
            if descend && style.is_none() && cursor.goto_first_child() {
                continue;
            }
            if cursor.goto_next_sibling() {
                descend = true;
                continue;
            }
            // Climb until a sibling exists.
            loop {
                if !cursor.goto_parent() {
                    return spans;
                }
                if cursor.goto_next_sibling() {
                    descend = true;
                    break;
                }
            }
        }
    }
}

impl Highlighter for RHighlighter {
    fn highlight(&self, line: &str, cursor: usize) -> StyledText {
        let mut out = StyledText::new();
        if line.len() > MAX_HIGHLIGHT {
            out.push((Style::new(), line.to_string()));
            return out;
        }
        let mut spans = self.spans(line);
        // Matching bracket pair: underline both.
        let scan = lexer::scan(line);
        if let Some((a, b)) = scan.matching_bracket(cursor) {
            for p in [a, b] {
                spans.push((p, p + scan.bracket_len(p), Style::new().bold().underline()));
            }
        }
        spans.sort_by_key(|s| s.0);
        let mut pos = 0;
        for (start, end, style) in spans {
            if start < pos || end > line.len() {
                continue; // overlapping (bracket inside a styled span): keep the first
            }
            if start > pos {
                out.push((Style::new(), line[pos..start].to_string()));
            }
            out.push((style, line[start..end].to_string()));
            pos = end;
        }
        if pos < line.len() {
            out.push((Style::new(), line[pos..].to_string()));
        }
        out
    }
}

/// `line` with the editor's syntax highlighting, as ANSI text (for echoing
/// code that arrived over the socket exactly as if it had been typed).
pub fn highlight_ansi(line: &str) -> String {
    RHighlighter::new()
        .highlight(line, usize::MAX)
        .render_simple()
}

// ---- validation: R's own parser decides ------------------------------------

struct RValidator {
    indent: Arc<IndentRequest>,
    break_flag: Arc<AtomicBool>,
}

const PARSE_INCOMPLETE: i32 = 2;

/// R's own parser's verdict (see `raven_parse_status` in shim.c).
fn parse_status(code: &str) -> i32 {
    let Ok(c) = CString::new(code) else { return -1 };
    // SAFETY: on the R thread while R is idle; the shim guards jumps.
    unsafe { libr::raven_parse_status(c.as_ptr()) }
}

impl Validator for RValidator {
    fn validate(&self, line: &str) -> ValidationResult {
        if line.len() > MAX_PARSE_PROBE {
            return ValidationResult::Complete;
        }
        match continuation(line, parse_status) {
            None => ValidationResult::Complete,
            Some(indent) => {
                // reedline inserts the bare newline; ask the read loop to add
                // the indentation right after (it re-enters read_line in place).
                if !indent.is_empty() {
                    self.indent.set(indent);
                    self.break_flag.store(true, Ordering::Relaxed);
                }
                ValidationResult::Incomplete
            }
        }
    }
}

/// Decide what Enter does: `None` submits; `Some(indent)` continues on a new
/// line indented by `indent`. Only R's parser decides completeness — so an
/// invalid line is submitted (R reports the error) instead of trapping the
/// user in continuation lines.
pub fn continuation(line: &str, parse: impl Fn(&str) -> i32) -> Option<String> {
    if parse(line) != PARSE_INCOMPLETE {
        return None;
    }
    Some(continuation_indent(&lexer::scan(line)))
}

pub fn continuation_indent(scan: &Scan) -> String {
    // Never add spaces inside a multi-line string; a trailing comment is fine.
    if scan.in_string() {
        return String::new();
    }
    let levels = scan.open_depth() + usize::from(scan.ends_with_operator());
    INDENT.repeat(levels)
}

// ---- completion -------------------------------------------------------------

struct RCompleter {
    fun: Sexp,
}

// SAFETY: only used from the R thread inside read_line (see RHighlighter).
unsafe impl Send for RCompleter {}

impl Completer for RCompleter {
    fn complete(&mut self, line: &str, pos: usize) -> CompletionResult {
        if self.fun.is_null() {
            return CompletionResult::fresh(Vec::<Suggestion>::new());
        }
        let pos = pos.min(line.len());
        let head = &line[..pos];
        // Tab on a blank line (or before any code on it) indents, as in
        // Python's REPL. A lone suggestion is inserted without opening the menu.
        if is_blank_line_head(head) {
            return CompletionResult::fresh(vec![Suggestion {
                value: INDENT.to_string(),
                span: Span::new(pos, pos),
                append_whitespace: false,
                ..Default::default()
            }]);
        }
        let Ok(arg) = CString::new(head) else {
            return CompletionResult::fresh(Vec::<Suggestion>::new());
        };
        let args = [arg.as_ptr()];
        let mut out: Sexp = std::ptr::null_mut();
        // SAFETY: R thread, R idle; the shim guards jumps. Ctrl-C is live
        // during the call so a slow completion can be cancelled.
        let status = super::term::with_interrupt_key(|| unsafe {
            libr::raven_call(self.fun, 1, args.as_ptr(), &mut out)
        });
        if status != 0 || out.is_null() {
            return CompletionResult::fresh(Vec::<Suggestion>::new());
        }
        // SAFETY: `out` is a preserved SEXP returned by the shim.
        let values = unsafe { libr::strings(out) };
        // SAFETY: releases the reference the shim took.
        unsafe { libr::raven_release(out) };
        let Some((token, cands)) = values.split_first() else {
            return CompletionResult::fresh(Vec::<Suggestion>::new());
        };
        let start = if head.ends_with(token.as_str()) {
            pos - token.len()
        } else {
            pos
        };
        let suggestions: Vec<Suggestion> = rank(token, cands)
            .into_iter()
            .map(|value| Suggestion {
                value,
                span: Span::new(start, pos),
                append_whitespace: false,
                ..Default::default()
            })
            .collect();
        CompletionResult::fresh(suggestions)
    }
}

/// Whether the cursor's line has only whitespace before the cursor.
fn is_blank_line_head(head: &str) -> bool {
    head.rsplit('\n').next().is_none_or(|l| l.trim().is_empty())
}

/// The completion menu, closed instead of drawn when completion finds nothing.
///
/// reedline's [`IdeMenu`] paints "NO RECORDS FOUND" for an empty result and
/// stays active, so arrow keys would keep driving an empty menu instead of
/// history. Here a settled empty result deactivates the menu: Tab with no
/// matches does nothing, and narrowing an open menu to nothing closes it.
struct QuietMenu(IdeMenu);

impl QuietMenu {
    fn close_if_empty(&mut self) {
        if self.0.is_active() && self.0.get_values().is_empty() && !self.0.results_are_provisional()
        {
            self.0.handle_menu_event(&MenuEvent::Deactivate);
        }
    }
}

impl Menu for QuietMenu {
    fn settings(&self) -> &MenuSettings {
        self.0.settings()
    }
    fn is_active(&self) -> bool {
        self.0.is_active()
    }
    fn set_active(&mut self, active: bool) {
        self.0.set_active(active)
    }
    fn clear_input(&mut self) {
        self.0.clear_input()
    }
    fn on_activate(&mut self) {
        self.0.on_activate()
    }
    fn on_deactivate(&mut self) {
        self.0.on_deactivate()
    }
    fn menu_event(&mut self, event: MenuEvent) {
        self.0.menu_event(event)
    }
    fn can_quick_complete(&self) -> bool {
        self.0.can_quick_complete()
    }
    fn can_partially_complete(
        &mut self,
        values_updated: bool,
        editor: &mut Editor,
        completer: &mut dyn Completer,
    ) -> bool {
        self.0
            .can_partially_complete(values_updated, editor, completer)
    }
    fn update_values(&mut self, editor: &mut Editor, completer: &mut dyn Completer) {
        self.0.update_values(editor, completer);
        self.close_if_empty();
    }
    fn reset_position(&mut self) {
        self.0.reset_position()
    }
    fn update_working_details(
        &mut self,
        editor: &mut Editor,
        completer: &mut dyn Completer,
        painter: &Painter,
    ) {
        self.0.update_working_details(editor, completer, painter);
        self.close_if_empty();
    }
    fn replace_in_buffer(&self, editor: &mut Editor) {
        self.0.replace_in_buffer(editor)
    }
    fn menu_required_lines(&self, terminal_columns: u16) -> u16 {
        self.0.menu_required_lines(terminal_columns)
    }
    fn menu_string(&self, available_lines: u16, use_ansi_coloring: bool) -> String {
        self.0.menu_string(available_lines, use_ansi_coloring)
    }
    fn min_rows(&self) -> u16 {
        self.0.min_rows()
    }
    fn get_values(&self) -> &[Suggestion] {
        self.0.get_values()
    }
    fn results_are_provisional(&self) -> bool {
        self.0.results_are_provisional()
    }
    fn is_awaiting_first_answer(&self) -> bool {
        self.0.is_awaiting_first_answer()
    }
    fn is_visible(&self) -> bool {
        self.0.is_visible()
    }
    fn set_cursor_pos(&mut self, pos: (u16, u16)) {
        self.0.set_cursor_pos(pos)
    }
}

/// Exact-case prefix matches first, then the rest, keeping R's order within
/// each group (R lists arguments before other names).
pub fn rank(token: &str, cands: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let (mut first, mut rest): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    for c in cands {
        if c.is_empty() || !seen.insert(c.clone()) {
            continue;
        }
        if c.starts_with(token) {
            first.push(c.clone());
        } else {
            rest.push(c.clone());
        }
    }
    first.extend(rest);
    first
}

// ---- prompt -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptKind {
    TopLevel,
    Continuation,
    Browser,
    Other,
}

/// The color of a prompt of this kind, as the editor draws it and as an
/// echoed line repeats it: the terminal's own text color, except yellow for
/// `Browse[n]> ` so the debugger's prompt stands out.
pub fn prompt_color(kind: PromptKind) -> Color {
    match kind {
        PromptKind::Browser => Color::Yellow,
        PromptKind::TopLevel | PromptKind::Continuation | PromptKind::Other => Color::Default,
    }
}

pub struct RPrompt {
    pub text: String,
    pub kind: PromptKind,
}

impl Prompt for RPrompt {
    fn render_prompt_left(&self) -> Cow<'_, str> {
        Cow::Borrowed(&self.text)
    }
    fn render_prompt_right(&self) -> Cow<'_, str> {
        Cow::Borrowed("")
    }
    fn render_prompt_indicator(&self, _mode: PromptEditMode) -> Cow<'_, str> {
        Cow::Borrowed("")
    }
    fn render_prompt_multiline_indicator(&self) -> Cow<'_, str> {
        Cow::Borrowed("+ ")
    }
    /// The color of the Ctrl+R search prompt (reedline's default, bright
    /// cyan, is invisible on a light background).
    fn get_indicator_color(&self) -> Color {
        Color::Default
    }
    fn render_prompt_history_search_indicator(&self, search: PromptHistorySearch) -> Cow<'_, str> {
        let prefix = match search.status {
            PromptHistorySearchStatus::Passing => "",
            PromptHistorySearchStatus::Failing => "failing ",
        };
        Cow::Owned(format!("({prefix}search: {}) ", search.term))
    }
    fn get_prompt_color(&self) -> Color {
        prompt_color(self.kind)
    }
    fn get_prompt_multiline_color(&self) -> Color {
        Color::Default
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::console::folder_history::tests::{Dirs, dirs};

    #[test]
    fn indent_follows_open_brackets_and_operators() {
        assert_eq!(
            continuation_indent(&lexer::scan("f <- function(x) {")),
            "  "
        );
        assert_eq!(continuation_indent(&lexer::scan("f(a,")), "  ");
        assert_eq!(continuation_indent(&lexer::scan("df |>")), "  ");
        assert_eq!(
            continuation_indent(&lexer::scan("lapply(x, function(i) {")),
            "    "
        );
        assert_eq!(
            continuation_indent(&lexer::scan("f <- function(x) {  # setup")),
            "  "
        );
        assert_eq!(continuation_indent(&lexer::scan("x <- \"abc")), "");
    }

    fn fake_parse(code: &str) -> i32 {
        // Incomplete iff brackets are unbalanced (enough for these tests).
        if lexer::scan(code).open_depth() > 0 {
            PARSE_INCOMPLETE
        } else {
            1
        }
    }

    #[test]
    fn enter_continues_incomplete_input_with_indent() {
        assert_eq!(
            continuation("f <- function(a) {", fake_parse),
            Some("  ".into())
        );
        assert_eq!(
            continuation("data.frame(a = 1,", fake_parse),
            Some("  ".into())
        );
        assert_eq!(continuation("x <- c(1, 2", fake_parse), Some("  ".into()));
    }

    #[test]
    fn enter_submits_complete_or_invalid_input() {
        assert_eq!(continuation("f()", fake_parse), None);
        assert_eq!(continuation("f <- function(a) {}", fake_parse), None);
    }

    #[test]
    fn blank_line_head_is_whitespace_before_cursor_on_its_line() {
        assert!(is_blank_line_head(""));
        assert!(is_blank_line_head("   "));
        assert!(is_blank_line_head("f <- function(x) {\n  "));
        assert!(!is_blank_line_head("su"));
        assert!(!is_blank_line_head("f(x,\n  y"));
        assert!(!is_blank_line_head("f("));
    }

    #[test]
    fn numbers_are_unstyled_and_comments_italic() {
        assert_eq!(highlight_ansi("x <- 1 # c"), "x <- 1 \x1b[3m# c\x1b[0m");
        assert_eq!(highlight_ansi("2.5e3 + 1L + 3i"), "2.5e3 + 1L + 3i");
    }

    #[test]
    fn prompts_use_the_terminal_text_color_except_the_browser() {
        let prompt = |kind| RPrompt {
            text: String::new(),
            kind,
        };
        for kind in [
            PromptKind::TopLevel,
            PromptKind::Continuation,
            PromptKind::Other,
        ] {
            assert_eq!(prompt(kind).get_prompt_color(), Color::Default, "{kind:?}");
            assert_eq!(prompt(kind).get_prompt_multiline_color(), Color::Default);
        }
        assert_eq!(
            prompt(PromptKind::Browser).get_prompt_color(),
            Color::Yellow
        );
        assert_eq!(
            prompt(PromptKind::Browser).get_prompt_multiline_color(),
            Color::Default
        );
    }

    /// A hinter whose folder `a` holds `entries`, oldest first.
    fn hinter_with(entries: &[&str]) -> (LineHinter, Dirs) {
        let d = dirs();
        let folders = FolderStore::in_memory();
        for entry in entries {
            folders.record(Some(&d.a), entry);
        }
        (LineHinter::new(folders), d)
    }

    /// What the hinter shows and what accepting it inserts, for `input`
    /// typed in a folder whose history holds `entry`.
    fn suggest(entry: &str, input: &str) -> (String, String, String) {
        let (mut hinter, d) = hinter_with(&[entry]);
        let drawn = hinter.hint_in(input, Some(&d.a), false);
        (drawn, hinter.complete_hint(), hinter.next_hint_token())
    }

    #[test]
    fn suggestion_comes_from_the_current_folder_only() {
        let (mut hinter, d) = hinter_with(&["summary(x)"]);
        let a = Some(d.a.as_path());
        assert_eq!(hinter.hint_in("summ", a, false), "ary(x)");
        assert_eq!(hinter.next_hint_token(), "ary");
        // Elsewhere, with no folder, or with nothing typed: no suggestion,
        // and nothing left over for accepting a word.
        for (input, dir) in [("summ", Some(d.b.as_path())), ("summ", None), ("", a)] {
            assert_eq!(hinter.hint_in(input, dir, false), "", "{input:?} {dir:?}");
            assert_eq!(hinter.complete_hint(), "");
            assert_eq!(hinter.next_hint_token(), "");
            assert_eq!(hinter.hint_in("summ", a, false), "ary(x)");
        }
    }

    #[test]
    fn suggestion_stops_at_the_end_of_the_line() {
        let entry = "print(a(\n    ))";
        let rest = |s: &str| (s.to_string(), s.to_string());
        let (drawn, accepted, _) = suggest(entry, "p");
        assert_eq!((drawn, accepted), rest("rint(a("));
        // At the end of the entry's first line there is nothing to suggest.
        let (drawn, accepted, word) = suggest(entry, "print(a(");
        assert_eq!((drawn, accepted, word.as_str()), ("".into(), "".into(), ""));
        // On the next line, the entry's next line is suggested.
        let (drawn, accepted, _) = suggest(entry, "print(a(\n  ");
        assert_eq!((drawn, accepted), rest("  ))"));
        // A one-line entry is suggested whole, and word by word.
        let (drawn, accepted, word) = suggest("summary(x)  # note", "summ");
        assert_eq!((drawn, accepted), rest("ary(x)  # note"));
        assert_eq!(word, "ary");
        // Accepting a word never takes text from the next line.
        assert_eq!(suggest("x <- c(1,\n  2)", "x <- c(1").2, ",");
        assert_eq!(first_line("a\r\nb"), "a");
    }

    #[test]
    fn suggestion_is_styled_only_when_colors_are_on() {
        let (mut hinter, d) = hinter_with(&["summary(x)"]);
        assert_eq!(
            hinter.hint_in("summ", Some(&d.a), true),
            st_suggestion().paint("ary(x)").to_string()
        );
        assert_eq!(hinter.complete_hint(), "ary(x)");
    }

    #[test]
    fn rank_prefers_exact_prefix_and_dedups() {
        let c = vec![
            "Sum".to_string(),
            "sum".into(),
            "summary".into(),
            "sum".into(),
        ];
        assert_eq!(rank("sum", &c), vec!["sum", "summary", "Sum"]);
    }

    #[test]
    fn search_prompt_uses_the_terminal_text_color() {
        for kind in [
            PromptKind::TopLevel,
            PromptKind::Continuation,
            PromptKind::Browser,
            PromptKind::Other,
        ] {
            let prompt = RPrompt {
                text: String::new(),
                kind,
            };
            assert_eq!(prompt.get_indicator_color(), Color::Default, "{kind:?}");
        }
    }
}
