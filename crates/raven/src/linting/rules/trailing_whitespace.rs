//! Flag trailing spaces/tabs at end of line.

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};

use crate::linting::nolint::Suppressions;
use crate::linting::rule_ids;
use crate::linting::LINT_SOURCE;
use crate::utf16::byte_offset_to_utf16_column;

pub(crate) fn collect(
    text: &str,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    for (idx, line) in text.lines().enumerate() {
        let line_no = idx as u32;
        if suppressions.is_suppressed(line_no) {
            continue;
        }
        let trimmed = line.trim_end_matches([' ', '\t']);
        if trimmed.len() == line.len() {
            continue;
        }
        let start_col = byte_offset_to_utf16_column(line, trimmed.len());
        let end_col = byte_offset_to_utf16_column(line, line.len());
        out.push(Diagnostic {
            range: Range {
                start: Position::new(line_no, start_col),
                end: Position::new(line_no, end_col),
            },
            severity: Some(severity),
            source: Some(LINT_SOURCE.to_string()),
            code: Some(NumberOrString::String(
                rule_ids::TRAILING_WHITESPACE.to_string(),
            )),
            message: "Trailing whitespace.".to_string(),
            ..Default::default()
        });
    }
}
