//! Flag tab characters in source.
//!
//! Reports one diagnostic per line that contains a tab, anchored at the first
//! tab on that line. The diagnostic range covers the contiguous run of tabs
//! so that "fix" actions or selection-aware tooling can target it cleanly.

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};

use crate::linting::LINT_SOURCE;
use crate::linting::nolint::Suppressions;
use crate::linting::rule_ids;
use crate::utf16::byte_offset_to_utf16_column;

pub(crate) fn collect(
    text: &str,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    for (idx, line) in text.lines().enumerate() {
        let line_no = idx as u32;
        if suppressions.is_suppressed_code(line_no, rule_ids::NO_TAB) {
            continue;
        }
        let bytes = line.as_bytes();
        let Some(start) = bytes.iter().position(|&b| b == b'\t') else {
            continue;
        };
        let mut end = start;
        while end < bytes.len() && bytes[end] == b'\t' {
            end += 1;
        }
        let start_col = byte_offset_to_utf16_column(line, start);
        let end_col = byte_offset_to_utf16_column(line, end);
        out.push(Diagnostic {
            range: Range {
                start: Position::new(line_no, start_col),
                end: Position::new(line_no, end_col),
            },
            severity: Some(severity),
            source: Some(LINT_SOURCE.to_string()),
            code: Some(NumberOrString::String(rule_ids::NO_TAB.to_string())),
            message: "Tab character; use spaces.".to_string(),
            ..Default::default()
        });
    }
}
