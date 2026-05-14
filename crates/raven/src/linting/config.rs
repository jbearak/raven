//! Configuration for the lint subsystem.
//!
//! Defaults follow `lintr`'s most common settings: 80-character lines, `<-` for
//! assignment, all rules disabled by default at the master switch so the
//! feature stays opt-in until it stabilizes (per upstream issue #211).

use tower_lsp::lsp_types::DiagnosticSeverity;

/// Preferred assignment operator. Mirrors `lintr::assignment_linter`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AssignmentOperatorStyle {
    /// Require `<-` for assignment; flag top-level `=` assignments.
    #[default]
    LeftArrow,
    /// Require `=` for assignment; flag top-level `<-` assignments.
    Equals,
}

/// Lint configuration.
///
/// `enabled` is the master switch (default off). Each rule has its own
/// `Option<DiagnosticSeverity>` so individual rules can also be disabled by
/// setting their severity to "off". `line_length` controls the threshold used
/// by the line-length rule.
#[derive(Debug, Clone, PartialEq)]
pub struct LintConfig {
    /// Master switch. When `false`, [`crate::linting::run_lints`] returns an
    /// empty vector regardless of per-rule severities.
    pub enabled: bool,
    /// Maximum allowed line length, measured in UTF-16 code units to align
    /// with how LSP positions are reported.
    pub line_length: u32,
    /// Preferred assignment operator style.
    pub assignment_operator_style: AssignmentOperatorStyle,
    /// Severity for the line-length rule. `None` disables the rule.
    pub line_length_severity: Option<DiagnosticSeverity>,
    /// Severity for the trailing-whitespace rule. `None` disables the rule.
    pub trailing_whitespace_severity: Option<DiagnosticSeverity>,
    /// Severity for the no-tab rule. `None` disables the rule.
    pub no_tab_severity: Option<DiagnosticSeverity>,
    /// Severity for the trailing-blank-lines rule. `None` disables the rule.
    pub trailing_blank_lines_severity: Option<DiagnosticSeverity>,
    /// Severity for the assignment-operator rule. `None` disables the rule.
    pub assignment_operator_severity: Option<DiagnosticSeverity>,
}

impl Default for LintConfig {
    fn default() -> Self {
        Self {
            // Conservative default: feature is opt-in until it stabilizes.
            enabled: false,
            line_length: 80,
            assignment_operator_style: AssignmentOperatorStyle::default(),
            // Default severities mirror lintr's "style" tier — surface as
            // hints so they don't crowd the Problems pane.
            line_length_severity: Some(DiagnosticSeverity::HINT),
            trailing_whitespace_severity: Some(DiagnosticSeverity::HINT),
            no_tab_severity: Some(DiagnosticSeverity::HINT),
            trailing_blank_lines_severity: Some(DiagnosticSeverity::HINT),
            assignment_operator_severity: Some(DiagnosticSeverity::HINT),
        }
    }
}
