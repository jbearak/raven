//! Canonical, kebab-case diagnostic/suppression code namespace (F2).
//!
//! One unified namespace spans both analyzer diagnostics (undefined variables,
//! syntax errors, …) and the opt-in lint rules. Codes are kebab-case and
//! descriptive — never opaque numbers (the TypeScript `TS2304` style is the
//! anti-pattern). They are the spelling a user writes inside a suppression
//! directive, e.g. `# raven: ignore[undefined-variable]`.
//!
//! ## Lint-config compatibility (do not break)
//!
//! Lint *rule identifiers* are NOT purely internal: `.lintr` files and the
//! `raven.toml` / VS Code lint config enable and disable rules **by name**,
//! using lintr's `snake_case` (`object_name`, `line_length`). Those config keys
//! must keep working. Only the *suppression-code spelling* is free to be
//! kebab-case. The two spellings are a pure `_`/`-` transform of each other, so
//! [`normalize`] (→ kebab, for suppression matching) and [`to_lint_rule_id`]
//! (→ snake, for config / `Diagnostic.code` lookups) bridge them without a
//! brittle hand-maintained table. Suppression parsing accepts **either**
//! spelling so a user who writes `# raven: ignore[line_length]` is honored too.
//!
//! ## Cascading sub-kinds
//!
//! Following Pyrefly/rust-analyzer, a code may be a child of an umbrella code:
//! suppressing the parent suppresses its children. The canonical example is the
//! `syntax-error` umbrella over concrete parse failures (`unclosed-paren`, …).
//! [`suppresses`] walks the parent chain so `ignore[syntax-error]` covers them
//! all, while `ignore[unclosed-paren]` targets just the one.

// ---- Analyzer diagnostic codes -------------------------------------------

/// Undefined / used-before-defined variable.
pub const UNDEFINED_VARIABLE: &str = "undefined-variable";
/// Umbrella for parse failures; parent of the concrete `*-paren`/`*-brace`/… kinds.
pub const SYNTAX_ERROR: &str = "syntax-error";
/// A `source()` / `@lsp-source` path that does not resolve to a file.
pub const UNRESOLVED_SOURCE_PATH: &str = "unresolved-source-path";
/// Assignment whose target is a string literal (`"x" <- 1`) or other
/// almost-certainly-unintended target.
pub const ASSIGN_TO_STRING_LITERAL: &str = "assign-to-string-literal";
/// A `library()`/`require()` of a package that is not installed / not found.
pub const PACKAGE_NOT_INSTALLED: &str = "package-not-installed";
/// A `# raven: expect[...]` (or, under the global sweep, any suppression)
/// that suppressed nothing. Hint severity. F2.
pub const UNUSED_SUPPRESSION: &str = "unused-suppression";

/// Concrete `syntax-error` sub-kinds. Each maps to [`SYNTAX_ERROR`] as its
/// parent so suppressing the umbrella suppresses all of them.
pub const SYNTAX_ERROR_CHILDREN: &[&str] = &[
    "unclosed-paren",
    "unclosed-brace",
    "unclosed-bracket",
    "unexpected-token",
    "missing-brace",
];

/// All canonical analyzer codes (umbrella codes included, children excluded).
pub const ANALYZER_CODES: &[&str] = &[
    UNDEFINED_VARIABLE,
    SYNTAX_ERROR,
    UNRESOLVED_SOURCE_PATH,
    ASSIGN_TO_STRING_LITERAL,
    PACKAGE_NOT_INSTALLED,
    UNUSED_SUPPRESSION,
];

/// Canonical lint codes, kebab-case (the suppression spelling of the
/// `snake_case` rule identifiers in [`crate::linting::rule_ids`]).
pub const LINT_CODES: &[&str] = &[
    "line-length",
    "trailing-whitespace",
    "no-tab",
    "trailing-blank-lines",
    "assignment-operator",
    "object-name",
    "infix-spaces",
    "commented-code",
    "quotes",
    "commas",
    "t-and-f-symbol",
    "semicolon",
    "equals-na",
    "object-length",
    "vector-logic",
    "function-left-parentheses",
    "spaces-inside",
    "indentation",
    "mixed-logical",
    "condition-assignment",
];

/// Normalize a user-written suppression code to its canonical kebab-case
/// spelling: trim, lowercase, and map `_` → `-`. This accepts both the
/// kebab-case suppression spelling and the lintr `snake_case` rule-id spelling.
pub fn normalize(input: &str) -> String {
    input.trim().to_ascii_lowercase().replace('_', "-")
}

/// Map a (kebab-case) suppression code to the `snake_case` lint rule identifier
/// used by `.lintr`, `raven.toml`, the VS Code lint config, and the
/// `Diagnostic.code` emitted by lint rules. Inverse of the kebab spelling.
pub fn to_lint_rule_id(code: &str) -> String {
    normalize(code).replace('-', "_")
}

/// The umbrella parent of a (cascading) sub-kind code, if any.
pub fn parent(code: &str) -> Option<&'static str> {
    let norm = normalize(code);
    if SYNTAX_ERROR_CHILDREN.contains(&norm.as_str()) {
        return Some(SYNTAX_ERROR);
    }
    None
}

/// Does a suppression code written by the user cover a diagnostic's code?
///
/// True when the (normalized) codes are equal, or when the suppression code is
/// an ancestor of the diagnostic code via the cascading sub-kind chain
/// (`ignore[syntax-error]` covers `unclosed-paren`). Comparison is spelling-
/// agnostic (`line_length` and `line-length` match).
pub fn suppresses(suppression_code: &str, diagnostic_code: &str) -> bool {
    let want = normalize(suppression_code);
    let mut cur = normalize(diagnostic_code);
    if want == cur {
        return true;
    }
    while let Some(p) = parent(&cur) {
        if want == p {
            return true;
        }
        cur = p.to_string();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_accepts_both_spellings() {
        assert_eq!(normalize("line_length"), "line-length");
        assert_eq!(normalize("line-length"), "line-length");
        assert_eq!(normalize("  Line-Length  "), "line-length");
    }

    #[test]
    fn to_lint_rule_id_round_trips_to_snake_case() {
        assert_eq!(to_lint_rule_id("line-length"), "line_length");
        assert_eq!(to_lint_rule_id("line_length"), "line_length");
        assert_eq!(to_lint_rule_id("object-name"), "object_name");
    }

    #[test]
    fn every_lint_rule_id_has_a_kebab_code_and_round_trips() {
        use crate::linting::rule_ids;
        let rule_ids = [
            rule_ids::LINE_LENGTH,
            rule_ids::TRAILING_WHITESPACE,
            rule_ids::NO_TAB,
            rule_ids::TRAILING_BLANK_LINES,
            rule_ids::ASSIGNMENT_OPERATOR,
            rule_ids::OBJECT_NAME,
            rule_ids::INFIX_SPACES,
            rule_ids::COMMENTED_CODE,
            rule_ids::QUOTES,
            rule_ids::COMMAS,
            rule_ids::T_AND_F_SYMBOL,
            rule_ids::SEMICOLON,
            rule_ids::EQUALS_NA,
            rule_ids::OBJECT_LENGTH,
            rule_ids::VECTOR_LOGIC,
            rule_ids::FUNCTION_LEFT_PARENTHESES,
            rule_ids::SPACES_INSIDE,
            rule_ids::INDENTATION,
            rule_ids::MIXED_LOGICAL,
            rule_ids::CONDITION_ASSIGNMENT,
        ];
        for id in rule_ids {
            let code = normalize(id);
            assert!(
                LINT_CODES.contains(&code.as_str()),
                "rule id {id} → {code} must be in LINT_CODES"
            );
            assert_eq!(to_lint_rule_id(&code), id, "round trip for {id}");
        }
    }

    #[test]
    fn suppresses_exact_and_spelling_agnostic() {
        assert!(suppresses("undefined-variable", "undefined-variable"));
        assert!(suppresses("line_length", "line-length"));
        assert!(suppresses("line-length", "line_length"));
        assert!(!suppresses("line-length", "object-name"));
    }

    #[test]
    fn suppresses_cascades_from_umbrella_to_children() {
        for child in SYNTAX_ERROR_CHILDREN {
            assert!(
                suppresses(SYNTAX_ERROR, child),
                "syntax-error must cover {child}"
            );
            // The child does not cover the umbrella or its siblings.
            assert!(!suppresses(child, SYNTAX_ERROR));
        }
        assert!(suppresses("unclosed-paren", "unclosed-paren"));
        assert!(!suppresses("unclosed-paren", "unclosed-brace"));
    }
}
