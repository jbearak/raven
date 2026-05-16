//! Flag lines wider than the configured maximum.
//!
//! Width is measured in UTF-16 code units to align with LSP positions. Tabs
//! count as one unit, matching `lintr::line_length_linter`'s convention.

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};

use crate::linting::nolint::Suppressions;
use crate::linting::rule_ids;
use crate::linting::LINT_SOURCE;

pub(crate) fn collect(
    text: &str,
    max_len: u32,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    for (idx, line) in text.lines().enumerate() {
        let line_no = idx as u32;
        if suppressions.is_suppressed(line_no) {
            continue;
        }
        let width: u32 = line.chars().map(|c| c.len_utf16() as u32).sum();
        if width <= max_len {
            continue;
        }
        out.push(Diagnostic {
            range: Range {
                start: Position::new(line_no, max_len),
                end: Position::new(line_no, width),
            },
            severity: Some(severity),
            source: Some(LINT_SOURCE.to_string()),
            code: Some(NumberOrString::String(rule_ids::LINE_LENGTH.to_string())),
            message: format!("Line is {width} characters long; limit is {max_len}."),
            ..Default::default()
        });
    }
}
