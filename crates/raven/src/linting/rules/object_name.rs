//! Enforce a naming scheme on user-defined symbols.
//!
//! Walks the tree-sitter AST and flags assignment targets and function
//! parameters whose names don't match the configured [`ObjectNameStyle`].
//! Mirrors `lintr::object_name_linter` with three per-kind settings:
//! `function`, `variable`, and `argument`. Each kind defaults to `snake_case`
//! and can be independently disabled by setting its style to [`ObjectNameStyle::Any`].
//!
//! Carve-outs:
//!
//! * **Backtick-quoted names** (`` `with spaces` <- 1 ``, operator overloads
//!   like `` `+.foo` <- function(x, y) ... ``) are skipped, matching lintr.
//! * **S3 method dispatch**: a function definition whose name has the shape
//!   `<generic>.<class>` is exempt when `<generic>` is a known base R S3
//!   generic (see [`is_known_s3_generic`]). Every dot is tried as a possible
//!   split point so methods of generics that themselves contain dots
//!   (`as.Date.character`, `is.numeric.foo`) match; class names that contain
//!   dots (`print.data.frame`) also match because the leftmost generic wins.
//!   A leading `.` (hidden identifier convention) is stripped before the
//!   lookup so hidden methods like `.print.MyClass` are still recognized.
//!   Names with no recognized generic in any prefix (e.g. `foo.Bar`,
//!   `my.func`) are checked normally.
//! * **Leading-dot "hidden" names** (`.foo`, `.my_helper`, `.onLoad`) are
//!   accepted under every scheme — an optional leading dot is stripped before
//!   scheme classification, mirroring lintr.
//! * **Non-ASCII identifiers** are skipped — case is locale-dependent and a
//!   simple regex can't classify them.
//! * **Named-argument `=`** (`f(name = value)`) is never an assignment target,
//!   so it isn't checked. `=` elsewhere (top level, function bodies, braced
//!   blocks) *is* treated as assignment and the LHS is checked.
//! * **Compound LHS** (`obj$field <- ...`, `obj[[i]] <- ...`) is skipped: the
//!   assignment doesn't introduce a new symbol name.

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};
use tree_sitter::Node;

use crate::linting::LINT_SOURCE;
use crate::linting::config::ObjectNameStyle;
use crate::linting::nolint::Suppressions;
use crate::linting::rule_ids;
use crate::utf16::byte_offset_to_utf16_column;

/// Per-kind style configuration for the rule.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ObjectNameStyles {
    pub function: ObjectNameStyle,
    pub variable: ObjectNameStyle,
    pub argument: ObjectNameStyle,
}

pub(crate) fn collect(
    text: &str,
    root: Node<'_>,
    styles: ObjectNameStyles,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    visit(root, text, styles, severity, suppressions, out);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SymbolKind {
    Function,
    Variable,
    Argument,
}

fn visit(
    node: Node<'_>,
    text: &str,
    styles: ObjectNameStyles,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    match node.kind() {
        "binary_operator" => check_assignment(node, text, styles, severity, suppressions, out),
        "function_definition" => check_parameters(node, text, styles, severity, suppressions, out),
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, text, styles, severity, suppressions, out);
    }
}

/// Check the assignment target of a `binary_operator` node.
fn check_assignment(
    node: Node<'_>,
    text: &str,
    styles: ObjectNameStyles,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    let op_node = match node.child_by_field_name("operator") {
        Some(n) => n,
        None => return,
    };
    let op_text = node_text(op_node, text);

    let (target_node, value_node) = match op_text {
        "<-" | "<<-" | "=" => {
            let lhs = node.child_by_field_name("lhs");
            let rhs = node.child_by_field_name("rhs");
            (lhs, rhs)
        }
        "->" | "->>" => {
            let lhs = node.child_by_field_name("lhs");
            let rhs = node.child_by_field_name("rhs");
            (rhs, lhs)
        }
        _ => return,
    };

    let target = match target_node {
        Some(t) => t,
        None => return,
    };

    // `=` inside an argument list is a named argument, not an assignment.
    if op_text == "=" && node.parent().is_some_and(|p| p.kind() == "argument") {
        return;
    }

    if target.kind() != "identifier" {
        return;
    }

    let name = node_text(target, text);
    if name.is_empty() {
        return;
    }

    let kind = if value_node
        .map(|v| is_function_definition_after_parens(v))
        .unwrap_or(false)
    {
        SymbolKind::Function
    } else {
        SymbolKind::Variable
    };

    report_if_bad(
        target,
        name,
        kind,
        style_for(kind, styles),
        text,
        severity,
        suppressions,
        out,
    );
}

/// Check formal arguments of a `function_definition` node.
fn check_parameters(
    node: Node<'_>,
    text: &str,
    styles: ObjectNameStyles,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    if styles.argument == ObjectNameStyle::Any {
        return;
    }
    let params_node = node.child_by_field_name("parameters").or_else(|| {
        let mut cursor = node.walk();
        node.children(&mut cursor)
            .find(|c| c.is_named() && c.kind() == "parameters")
    });
    let params_node = match params_node {
        Some(n) => n,
        None => return,
    };

    let mut cursor = params_node.walk();
    for child in params_node.children(&mut cursor) {
        let ident = match child.kind() {
            "parameter" | "default_parameter" => {
                let mut name_node = None;
                for sub in child.children(&mut child.walk()) {
                    if sub.kind() == "identifier" {
                        name_node = Some(sub);
                        break;
                    }
                }
                name_node
            }
            "identifier" => Some(child),
            // `dots` (`...`) is a literal token, not a user-chosen name.
            _ => None,
        };
        if let Some(ident) = ident {
            let name = node_text(ident, text);
            if name.is_empty() {
                continue;
            }
            report_if_bad(
                ident,
                name,
                SymbolKind::Argument,
                style_for(SymbolKind::Argument, styles),
                text,
                severity,
                suppressions,
                out,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn report_if_bad(
    name_node: Node<'_>,
    name: &str,
    kind: SymbolKind,
    style: ObjectNameStyle,
    text: &str,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    if style == ObjectNameStyle::Any {
        return;
    }
    if should_skip_name(name, kind) {
        return;
    }
    if matches_scheme(name, style) {
        return;
    }
    let line_no = name_node.start_position().row as u32;
    if suppressions.is_suppressed_code(line_no, rule_ids::OBJECT_NAME) {
        return;
    }
    let line_text = text.lines().nth(line_no as usize).unwrap_or("");
    let start_col = byte_offset_to_utf16_column(line_text, name_node.start_position().column);
    let end_col = byte_offset_to_utf16_column(line_text, name_node.end_position().column);
    let kind_label = match kind {
        SymbolKind::Function => "Function",
        SymbolKind::Variable => "Variable",
        SymbolKind::Argument => "Argument",
    };
    let scheme_label = scheme_label(style);
    out.push(Diagnostic {
        range: Range {
            start: Position::new(line_no, start_col),
            end: Position::new(name_node.end_position().row as u32, end_col),
        },
        severity: Some(severity),
        source: Some(LINT_SOURCE.to_string()),
        code: Some(NumberOrString::String(rule_ids::OBJECT_NAME.to_string())),
        message: format!(
            "{kind_label} name `{name}` does not match the {scheme_label} naming style."
        ),
        ..Default::default()
    });
}

/// Look up the configured style for a given symbol kind.
fn style_for(kind: SymbolKind, styles: ObjectNameStyles) -> ObjectNameStyle {
    match kind {
        SymbolKind::Function => styles.function,
        SymbolKind::Variable => styles.variable,
        SymbolKind::Argument => styles.argument,
    }
}

/// Names that should be skipped regardless of the configured scheme.
fn should_skip_name(name: &str, kind: SymbolKind) -> bool {
    // Backtick-quoted identifiers (operator overloads, names with spaces).
    if name.starts_with('`') {
        return true;
    }
    // Non-ASCII identifiers can't be classified by simple ASCII regex.
    if !name.is_ascii() {
        return true;
    }
    // S3 method dispatch: only relevant for function definitions. A name like
    // `print.MyClass` is `<generic>.<ClassName>` — exempt when some prefix
    // ending at a dot is a *known* base R S3 generic (see
    // [`is_known_s3_generic`]). Names whose prefix isn't a recognized generic
    // (e.g. `foo.Bar`) are still checked: there's no signal that they're
    // actually method dispatch rather than a quirky dotted name, and lintr
    // similarly requires evidence (a `UseMethod` call or a known generic)
    // before exempting.
    //
    // We scan *every* dot position rather than just the first because both
    // generics and class names can themselves contain dots:
    //
    //   * `as.Date.character` — method of generic `as.Date` for `character`.
    //     The first dot gives `as` (not a generic); the second gives the
    //     match.
    //   * `print.data.frame` — method of generic `print` for `data.frame`.
    //     The first dot gives `print` (match), so we exit early.
    //
    // We also strip an optional leading `.` so hidden S3 methods like
    // `.print.MyClass` resolve through `print`.
    if kind == SymbolKind::Function {
        let body = name.strip_prefix('.').unwrap_or(name);
        for (i, c) in body.char_indices() {
            if c == '.' && is_known_s3_generic(&body[..i]) {
                return true;
            }
        }
    }
    false
}

/// Base R S3 generics whose `<generic>.<class>` methods are conventionally
/// exempt from naming-style enforcement. The list is intentionally finite — if
/// users define their own generic and want methods exempt, they can suppress
/// the line with `# nolint` or `# raven: ignore` (alias `# @lsp-ignore`).
///
/// Sourced from base R's documented generics across `methods("...")` output
/// for typical interactive sessions: print/format/summary family,
/// statistical model accessors, coercion (`as.*`)/predicate (`is.*`) families,
/// the group generics (`Ops`, `Math`, `Summary`, `Complex`), and a handful of
/// commonly-extended utilities.
fn is_known_s3_generic(name: &str) -> bool {
    // Sorted alphabetically so `binary_search` works.
    const GENERICS: &[&str] = &[
        "AIC",
        "BIC",
        "Complex",
        "Math",
        "Ops",
        "Summary",
        "all.equal",
        "anova",
        "as.Date",
        "as.POSIXct",
        "as.POSIXlt",
        "as.character",
        "as.data.frame",
        "as.double",
        "as.environment",
        "as.factor",
        "as.function",
        "as.integer",
        "as.list",
        "as.logical",
        "as.matrix",
        "as.numeric",
        "as.vector",
        "c",
        "cbind",
        "coef",
        "coefficients",
        "confint",
        "deviance",
        "dim",
        "dimnames",
        "fitted",
        "fitted.values",
        "format",
        "formula",
        "head",
        "is.character",
        "is.data.frame",
        "is.double",
        "is.environment",
        "is.factor",
        "is.function",
        "is.integer",
        "is.list",
        "is.logical",
        "is.matrix",
        "is.numeric",
        "is.vector",
        "labels",
        "length",
        "levels",
        "logLik",
        "mean",
        "merge",
        "names",
        "nobs",
        "plot",
        "predict",
        "print",
        "range",
        "rbind",
        "residuals",
        "rev",
        "simulate",
        "sort",
        "split",
        "str",
        "subset",
        "summary",
        "t",
        "tail",
        "terms",
        "toString",
        "transform",
        "unique",
        "vcov",
        "with",
        "within",
    ];
    GENERICS.binary_search(&name).is_ok()
}

fn matches_scheme(name: &str, style: ObjectNameStyle) -> bool {
    if !name.is_ascii() {
        // Should already be handled by `should_skip_name`, but be defensive.
        return true;
    }
    // R treats a leading dot as the "hidden identifier" marker (e.g. `.foo`).
    // lintr accepts an optional leading dot for every scheme — match that so
    // common idioms like `.my_helper` aren't flagged as snake_case violations.
    // The body after the dot must still match the scheme's normal pattern,
    // and we reject a bare `.` or `..something` to avoid swallowing the
    // dots-in-name case.
    let body = match name.strip_prefix('.') {
        Some(rest) if !rest.starts_with('.') && !rest.is_empty() => rest,
        Some(_) => return false,
        None => name,
    };
    match style {
        ObjectNameStyle::Any => true,
        ObjectNameStyle::SnakeCase => is_snake_case(body),
        ObjectNameStyle::CamelCase => is_camel_case(body),
        ObjectNameStyle::DottedCase => is_dotted_case(body),
        ObjectNameStyle::UpperCase => is_upper_case(body),
        ObjectNameStyle::Lowercase => is_lowercase(body),
    }
}

fn is_snake_case(body: &str) -> bool {
    let bytes = body.as_bytes();
    bytes.first().is_some_and(|b| b.is_ascii_lowercase())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

fn is_camel_case(body: &str) -> bool {
    let bytes = body.as_bytes();
    bytes.first().is_some_and(|b| b.is_ascii_lowercase())
        && bytes.iter().all(|b| b.is_ascii_alphanumeric())
}

fn is_dotted_case(body: &str) -> bool {
    let bytes = body.as_bytes();
    bytes.first().is_some_and(|b| b.is_ascii_lowercase())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'.')
}

fn is_upper_case(body: &str) -> bool {
    let bytes = body.as_bytes();
    bytes.first().is_some_and(|b| b.is_ascii_uppercase())
        && bytes
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

fn is_lowercase(body: &str) -> bool {
    let bytes = body.as_bytes();
    bytes.first().is_some_and(|b| b.is_ascii_lowercase())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn scheme_label(style: ObjectNameStyle) -> &'static str {
    match style {
        ObjectNameStyle::SnakeCase => "snake_case",
        ObjectNameStyle::CamelCase => "camelCase",
        ObjectNameStyle::DottedCase => "dotted.case",
        ObjectNameStyle::UpperCase => "UPPER_CASE",
        ObjectNameStyle::Lowercase => "lowercase",
        ObjectNameStyle::Any => "any",
    }
}

/// Walk through `parenthesized_expression` wrappers and report whether the
/// inner node is a `function_definition`. Mirrors the helper in
/// `cross_file/scope.rs` so paren-wrapped functions still classify as such
/// for naming purposes: `foo <- (function() 1)` is still a function.
fn is_function_definition_after_parens(node: Node<'_>) -> bool {
    let mut current = node;
    loop {
        match current.kind() {
            "function_definition" => return true,
            "parenthesized_expression" => {
                let mut inner = None;
                for child in current.children(&mut current.walk()) {
                    if child.is_named() {
                        inner = Some(child);
                        break;
                    }
                }
                match inner {
                    Some(c) => current = c,
                    None => return false,
                }
            }
            _ => return false,
        }
    }
}

fn node_text<'a>(node: Node<'_>, text: &'a str) -> &'a str {
    let start = node.start_byte();
    let end = node.end_byte();
    text.get(start..end).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_case_classifier_accepts_common_names() {
        assert!(is_snake_case("foo"));
        assert!(is_snake_case("foo_bar"));
        assert!(is_snake_case("foo_bar_2"));
        assert!(is_snake_case("x"));
    }

    #[test]
    fn snake_case_classifier_rejects_other_styles() {
        assert!(!is_snake_case("FooBar"));
        assert!(!is_snake_case("fooBar"));
        assert!(!is_snake_case("foo.bar"));
        assert!(!is_snake_case("FOO"));
        assert!(!is_snake_case("_foo"));
        assert!(!is_snake_case(""));
        assert!(!is_snake_case("2foo"));
    }

    #[test]
    fn camel_case_classifier() {
        assert!(is_camel_case("fooBar"));
        assert!(is_camel_case("parseURL"));
        assert!(is_camel_case("foo2"));
        assert!(!is_camel_case("foo_bar"));
        assert!(!is_camel_case("FooBar"));
        assert!(!is_camel_case("foo.bar"));
    }

    #[test]
    fn dotted_case_classifier() {
        assert!(is_dotted_case("foo.bar"));
        assert!(is_dotted_case("data.frame"));
        assert!(!is_dotted_case("fooBar"));
        assert!(!is_dotted_case("foo_bar"));
    }

    #[test]
    fn upper_case_classifier() {
        assert!(is_upper_case("FOO"));
        assert!(is_upper_case("FOO_BAR"));
        assert!(is_upper_case("PI2"));
        assert!(!is_upper_case("Foo"));
        assert!(!is_upper_case("foo"));
    }

    #[test]
    fn s3_method_detected_for_function_kind_only() {
        // Prefix is a known base R generic — exempt.
        assert!(should_skip_name("print.MyClass", SymbolKind::Function));
        assert!(should_skip_name("format.Date", SymbolKind::Function));
        assert!(should_skip_name("summary.lm", SymbolKind::Function));
        // For variables, dotted names are checked normally — `print.MyClass`
        // isn't a method definition when bound to a non-function value.
        assert!(!should_skip_name("print.MyClass", SymbolKind::Variable));
        // All-lowercase dotted name with unknown prefix is still checked.
        assert!(!should_skip_name("my.func", SymbolKind::Function));
        // Unknown prefix + capitalized suffix (regression for over-broad
        // exemption): `foo` is not a known generic, so `foo.Bar` is checked.
        assert!(!should_skip_name("foo.Bar", SymbolKind::Function));
    }

    #[test]
    fn s3_method_detection_handles_dotted_generics() {
        // Regression: `as.Date.character` is a method of generic `as.Date`
        // for class `character`. Previously the prefix-before-first-dot
        // lookup gave `"as"` (not in the list), so the method was wrongly
        // flagged. The progressive-prefix scan tries `as`, then `as.Date`,
        // and exempts on the second.
        assert!(should_skip_name("as.Date.character", SymbolKind::Function));
        assert!(should_skip_name("as.numeric.foo", SymbolKind::Function));
        assert!(should_skip_name(
            "is.character.MyClass",
            SymbolKind::Function
        ));
        assert!(should_skip_name("all.equal.default", SymbolKind::Function));
        assert!(should_skip_name(
            "fitted.values.MyModel",
            SymbolKind::Function
        ));
        // Class names containing dots also work because the leftmost matching
        // generic wins.
        assert!(should_skip_name("print.data.frame", SymbolKind::Function));
        // Generic name itself (no class suffix) still requires at least one
        // dot to be considered S3 — bare `as.Date` defining the generic is
        // checked by the scheme (and would pass `dotted.case`).
    }

    #[test]
    fn s3_method_detection_handles_hidden_methods() {
        // Hidden S3 methods (`.print.MyClass`) — a leading `.` is stripped
        // before the generic lookup, so `.print.MyClass` still resolves
        // through `print`.
        assert!(should_skip_name(".print.MyClass", SymbolKind::Function));
        assert!(should_skip_name(".as.Date.character", SymbolKind::Function));
        // `.foo.Bar` — `foo` is not a generic, so still flagged.
        assert!(!should_skip_name(".foo.Bar", SymbolKind::Function));
    }

    #[test]
    fn known_s3_generic_recognizes_base_r_generics() {
        assert!(is_known_s3_generic("print"));
        assert!(is_known_s3_generic("format"));
        assert!(is_known_s3_generic("as.Date"));
        assert!(is_known_s3_generic("Ops"));
        assert!(!is_known_s3_generic("foo"));
        assert!(!is_known_s3_generic(""));
    }

    #[test]
    fn matches_scheme_accepts_leading_dot() {
        // R's "hidden identifier" convention: a single leading dot is
        // decorative, and the remainder must still match the scheme.
        assert!(matches_scheme(".foo", ObjectNameStyle::SnakeCase));
        assert!(matches_scheme(".foo_bar", ObjectNameStyle::SnakeCase));
        assert!(matches_scheme(".fooBar", ObjectNameStyle::CamelCase));
        assert!(matches_scheme(".FOO_BAR", ObjectNameStyle::UpperCase));
        // Body after the dot still must match — `.FooBar` is not snake_case.
        assert!(!matches_scheme(".FooBar", ObjectNameStyle::SnakeCase));
        // Two leading dots (or more) is not the hidden convention; reject so
        // we don't accidentally swallow ill-formed names.
        assert!(!matches_scheme("..foo", ObjectNameStyle::SnakeCase));
        assert!(!matches_scheme(".", ObjectNameStyle::SnakeCase));
    }

    #[test]
    fn backtick_quoted_names_are_skipped() {
        assert!(should_skip_name("`with spaces`", SymbolKind::Variable));
        assert!(should_skip_name("`+.foo`", SymbolKind::Function));
    }

    #[test]
    fn non_ascii_names_are_skipped() {
        assert!(should_skip_name("\u{03b1}", SymbolKind::Variable));
    }
}
