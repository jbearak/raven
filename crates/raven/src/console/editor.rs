//! The line editor: reedline configured for R.
//!
//! Everything here runs on the R (main) thread, inside `ReadConsole`, while R
//! is idle. The validator and completer call into R, always through `shim.c`.

use std::borrow::Cow;
use std::cell::RefCell;
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use nu_ansi_term::{Color, Style};
use reedline::{
    ColumnarMenu, Completer, CompletionResult, DefaultHinter, EditCommand, Editor, Emacs,
    FileBackedHistory, Highlighter, IdeMenu, KeyCode, KeyModifiers, Keybindings, Menu, MenuBuilder,
    MenuEvent, MenuSettings, Painter, Prompt, PromptEditMode, PromptHistorySearch,
    PromptHistorySearchStatus, Reedline, ReedlineEvent, ReedlineMenu, Span, StyledText, Suggestion,
    ValidationResult, Validator, Vi, default_emacs_keybindings, default_vi_insert_keybindings,
    default_vi_normal_keybindings, default_vi_visual_keybindings,
};

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
        .with_match_text_style(Style::new().bold());
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

    let history: Box<dyn reedline::History> = match cfg
        .history_file
        .and_then(|p| FileBackedHistory::with_file(10_000, p).ok())
    {
        Some(h) => Box::new(h),
        None => Box::new(FileBackedHistory::new(10_000).expect("in-memory history")),
    };

    Reedline::create()
        .with_history(history)
        .with_hinter(Box::new(
            DefaultHinter::default().with_style(Style::new().fg(Color::DarkGray)),
        ))
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
        .with_break_signal(cfg.break_flag)
        .with_external_printer(cfg.printer)
        .with_poll_interval(std::time::Duration::from_millis(33))
        .use_bracketed_paste(true)
}

/// The editor for `readline()`/`menu()`/`scan()` input: a bare line with the
/// usual editing keys and bracketed paste — no history, completion,
/// highlighting or pairing — read in raw mode, so it has no line-length cap
/// (a cooked terminal's line discipline truncates at ~1 KB on macOS).
pub fn build_plain(idle: Box<dyn FnMut() + Send>) -> Reedline {
    Reedline::create()
        .use_bracketed_paste(true)
        .with_poll_interval(std::time::Duration::from_millis(33))
        .with_idle_callback(idle)
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
fn st_number() -> Style {
    Style::new().fg(Color::Blue)
}
fn st_comment() -> Style {
    Style::new().fg(Color::DarkGray).italic()
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
                    "integer" | "float" | "complex" => Some(st_number()),
                    "true" | "false" | "null" | "na" | "inf" | "nan" | "dots" | "dot_dot_i" => {
                        Some(st_constant())
                    }
                    "function" | "if" | "else" | "for" | "while" | "repeat" | "in" | "break"
                    | "next" | "\\" => Some(st_keyword()),
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
    fn render_prompt_history_search_indicator(&self, search: PromptHistorySearch) -> Cow<'_, str> {
        let prefix = match search.status {
            PromptHistorySearchStatus::Passing => "",
            PromptHistorySearchStatus::Failing => "failing ",
        };
        Cow::Owned(format!("({prefix}search: {}) ", search.term))
    }
    fn get_prompt_color(&self) -> reedline::Color {
        match self.kind {
            PromptKind::Browser => reedline::Color::Yellow,
            PromptKind::Other => reedline::Color::Default,
            _ => reedline::Color::Blue,
        }
    }
    fn get_prompt_multiline_color(&self) -> nu_ansi_term::Color {
        nu_ansi_term::Color::DarkGray
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn rank_prefers_exact_prefix_and_dedups() {
        let c = vec![
            "Sum".to_string(),
            "sum".into(),
            "summary".into(),
            "sum".into(),
        ];
        assert_eq!(rank("sum", &c), vec!["sum", "summary", "Sum"]);
    }
}
