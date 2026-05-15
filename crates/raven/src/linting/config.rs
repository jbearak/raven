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

/// Preferred string-literal delimiter. Mirrors `lintr::quotes_linter` /
/// `lintr::single_quotes_linter` — the two map to the two enum variants here.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum StringDelimiter {
    /// Require `"..."` for string literals; flag `'...'`. Default.
    #[default]
    Double,
    /// Require `'...'` for string literals; flag `"..."`.
    Single,
}

/// Naming scheme used by the `object_name` lint.
///
/// Mirrors `lintr::object_name_linter` styles. `Any` disables the check for a
/// given symbol kind without disabling the rule entirely — useful when only
/// one of function/variable/argument naming should be enforced.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ObjectNameStyle {
    /// `snake_case` — lowercase with underscores (e.g. `my_function`).
    #[default]
    SnakeCase,
    /// `camelCase` — first letter lowercase, subsequent words capitalized.
    CamelCase,
    /// `dotted.case` — historical R convention (e.g. `my.function`).
    DottedCase,
    /// `UPPER_CASE` — typically reserved for constants.
    UpperCase,
    /// `lowercase` — a single all-lowercase word with no separators.
    Lowercase,
    /// `any` — disable the check for this kind of symbol.
    Any,
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
    /// Maximum allowed identifier length (object-length rule). Identifiers
    /// longer than this are flagged. Measured in characters of the name.
    pub object_length: u32,
    /// Preferred assignment operator style.
    pub assignment_operator_style: AssignmentOperatorStyle,
    /// Preferred string-literal delimiter (used by the `quotes` rule).
    pub string_delimiter: StringDelimiter,
    /// Required naming scheme for top-level functions (assignments whose RHS
    /// is a `function() ...` expression). Set to [`ObjectNameStyle::Any`] to
    /// disable just the function-name check while keeping variable and
    /// argument checks active.
    pub object_name_style_function: ObjectNameStyle,
    /// Required naming scheme for variable assignments (assignments whose RHS
    /// is not a function definition). Set to [`ObjectNameStyle::Any`] to
    /// disable just the variable-name check.
    pub object_name_style_variable: ObjectNameStyle,
    /// Required naming scheme for function formal arguments. Applies to all
    /// `function(...)` definitions, whether anonymous or assigned. Set to
    /// [`ObjectNameStyle::Any`] to disable just the argument-name check.
    pub object_name_style_argument: ObjectNameStyle,
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
    /// Severity for the object-name rule. `None` disables the rule entirely;
    /// per-kind `Any` styles disable individual checks while still running.
    pub object_name_severity: Option<DiagnosticSeverity>,
    /// Severity for the infix-spaces rule. `None` disables the rule.
    pub infix_spaces_severity: Option<DiagnosticSeverity>,
    /// Severity for the commented-code rule. `None` disables the rule.
    pub commented_code_severity: Option<DiagnosticSeverity>,
    /// Severity for the quotes rule (`lintr::quotes_linter`). `None` disables.
    pub quotes_severity: Option<DiagnosticSeverity>,
    /// Severity for the commas rule (`lintr::commas_linter`). `None` disables.
    pub commas_severity: Option<DiagnosticSeverity>,
    /// Severity for the `T`/`F` symbol rule (`lintr::T_and_F_symbol_linter`).
    pub t_and_f_symbol_severity: Option<DiagnosticSeverity>,
    /// Severity for the semicolon rule (`lintr::semicolon_linter`).
    pub semicolon_severity: Option<DiagnosticSeverity>,
    /// Severity for the `== NA` / `!= NA` rule (`lintr::equals_na_linter`).
    pub equals_na_severity: Option<DiagnosticSeverity>,
    /// Severity for the object-length rule (`lintr::object_length_linter`).
    pub object_length_severity: Option<DiagnosticSeverity>,
    /// Severity for the vector-logic rule (`lintr::vector_logic_linter`).
    pub vector_logic_severity: Option<DiagnosticSeverity>,
    /// Severity for the function-left-parentheses rule
    /// (`lintr::function_left_parentheses_linter`).
    pub function_left_parentheses_severity: Option<DiagnosticSeverity>,
    /// Severity for the spaces-inside rule (`lintr::spaces_inside_linter`).
    pub spaces_inside_severity: Option<DiagnosticSeverity>,
}

impl Default for LintConfig {
    fn default() -> Self {
        Self {
            // Conservative default: feature is opt-in until it stabilizes.
            enabled: false,
            line_length: 80,
            object_length: 30,
            assignment_operator_style: AssignmentOperatorStyle::default(),
            string_delimiter: StringDelimiter::default(),
            object_name_style_function: ObjectNameStyle::SnakeCase,
            object_name_style_variable: ObjectNameStyle::SnakeCase,
            object_name_style_argument: ObjectNameStyle::SnakeCase,
            // Default severities mirror lintr's "style" tier — surface as
            // hints so they don't crowd the Problems pane.
            line_length_severity: Some(DiagnosticSeverity::HINT),
            trailing_whitespace_severity: Some(DiagnosticSeverity::HINT),
            no_tab_severity: Some(DiagnosticSeverity::HINT),
            trailing_blank_lines_severity: Some(DiagnosticSeverity::HINT),
            assignment_operator_severity: Some(DiagnosticSeverity::HINT),
            object_name_severity: Some(DiagnosticSeverity::HINT),
            infix_spaces_severity: Some(DiagnosticSeverity::HINT),
            commented_code_severity: Some(DiagnosticSeverity::HINT),
            quotes_severity: Some(DiagnosticSeverity::HINT),
            commas_severity: Some(DiagnosticSeverity::HINT),
            t_and_f_symbol_severity: Some(DiagnosticSeverity::HINT),
            semicolon_severity: Some(DiagnosticSeverity::HINT),
            equals_na_severity: Some(DiagnosticSeverity::HINT),
            object_length_severity: Some(DiagnosticSeverity::HINT),
            vector_logic_severity: Some(DiagnosticSeverity::HINT),
            function_left_parentheses_severity: Some(DiagnosticSeverity::HINT),
            spaces_inside_severity: Some(DiagnosticSeverity::HINT),
        }
    }
}
