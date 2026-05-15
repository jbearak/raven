//! Flag bare `T` / `F` identifiers used as references to `TRUE` / `FALSE`.
//!
//! Mirrors `lintr::T_and_F_symbol_linter`. `T` and `F` are normal identifiers
//! in R, not reserved words, so `T <- 0` silently flips the meaning of any
//! later code that reads `T`. Idiomatic R uses the reserved literals `TRUE`
//! and `FALSE` instead.
//!
//! The rule walks `identifier` nodes whose text is exactly `T` or `F` and
//! reports them, except in positions where the identifier doesn't actually
//! reference the value:
//!
//! * **Assignment targets** (`T <- 0`, `0 -> T`, top-level `T = 0`). The user
//!   is explicitly overwriting the name — that *is* the bug, but reporting it
//!   on the LHS would be redundant with the other reads we already flag, so
//!   matching lintr we skip the LHS itself.
//! * **`$` / `@` RHS** (`obj$T`, `obj@F`). These are field names, not symbol
//!   lookups in the calling scope.
//! * **Named arguments** (`foo(T = TRUE)`) and **formal parameters**
//!   (`function(T) ...`). The `T` here is a name in the local syntax, not a
//!   reference to the boolean.

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, Position, Range};
use tree_sitter::Node;

use crate::linting::nolint::Suppressions;
use crate::linting::LINT_SOURCE;
use crate::utf16::byte_offset_to_utf16_column;

pub(crate) fn collect(
    text: &str,
    root: Node<'_>,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    visit(root, text, severity, suppressions, out);
}

fn visit(
    node: Node<'_>,
    text: &str,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    if node.kind() == "identifier" {
        let name = text.get(node.start_byte()..node.end_byte()).unwrap_or("");
        if (name == "T" || name == "F") && !is_excluded_position(node) {
            emit(node, name, text, severity, suppressions, out);
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, text, severity, suppressions, out);
    }
}

/// True if the identifier is in a non-reference position — somewhere a `T`/`F`
/// spelling doesn't read the boolean value.
fn is_excluded_position(ident: Node<'_>) -> bool {
    let Some(parent) = ident.parent() else {
        return false;
    };
    match parent.kind() {
        "binary_operator" => is_assignment_target(parent, ident),
        "extract_operator" => {
            // `$` / `@`: skip the RHS field name; LHS is a real reference.
            parent
                .child_by_field_name("rhs")
                .is_some_and(|rhs| rhs.id() == ident.id())
        }
        "argument" => {
            // Named argument: `foo(T = TRUE)` — `T` here is a parameter label.
            parent
                .child_by_field_name("name")
                .is_some_and(|name| name.id() == ident.id())
        }
        "parameter" => {
            // Formal parameter name: `function(T) ...` — declaring, not reading.
            parent
                .child_by_field_name("name")
                .is_some_and(|name| name.id() == ident.id())
        }
        _ => false,
    }
}

/// True iff this identifier is the assignment-target side of `binop`.
fn is_assignment_target(binop: Node<'_>, ident: Node<'_>) -> bool {
    let Some(op) = binop.child_by_field_name("operator") else {
        return false;
    };
    let op_text = op.kind();
    let target = match op_text {
        "<-" | "<<-" | "=" => binop.child_by_field_name("lhs"),
        "->" | "->>" => binop.child_by_field_name("rhs"),
        _ => return false,
    };
    target.is_some_and(|t| t.id() == ident.id())
}

fn emit(
    node: Node<'_>,
    name: &str,
    text: &str,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    let line_no = node.start_position().row as u32;
    if suppressions.is_suppressed(line_no) {
        return;
    }
    let line_text = text.lines().nth(line_no as usize).unwrap_or("");
    let start_col = byte_offset_to_utf16_column(line_text, node.start_position().column);
    let end_col = byte_offset_to_utf16_column(line_text, node.end_position().column);
    let preferred = if name == "T" { "TRUE" } else { "FALSE" };
    out.push(Diagnostic {
        range: Range {
            start: Position::new(line_no, start_col),
            end: Position::new(node.end_position().row as u32, end_col),
        },
        severity: Some(severity),
        source: Some(LINT_SOURCE.to_string()),
        message: format!("Use `{preferred}` instead of the symbol `{name}`."),
        ..Default::default()
    });
}
