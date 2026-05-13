//! Lint suppression parsing.
//!
//! Recognised markers:
//! * `# nolint` (or `# nolint: rule_a, rule_b`) — lintr-style line-level
//!   suppression on the same source line.
//! * `# nolint start` / `# nolint end` — lintr-style block suppression,
//!   inclusive of the start and end lines.
//! * `# @lsp-ignore` — Raven's own line marker; behaves like `# nolint`.
//! * `# @lsp-ignore-next` — Raven's own marker that suppresses the *following*
//!   source line.
//!
//! Rule-name filters (the `: rule_a, rule_b` suffix on `# nolint`) are
//! recognised but ignored for now — line-level suppression applies to every
//! rule. The shape of `Suppressions` is intentionally rule-agnostic so a
//! future revision can match per rule without an API break.

use std::collections::HashSet;

/// Pre-computed line-suppression set for a document.
#[derive(Debug, Default)]
pub(crate) struct Suppressions {
    suppressed_lines: HashSet<u32>,
}

impl Suppressions {
    /// Parse `# nolint` markers out of `text`.
    pub(crate) fn from_text(text: &str) -> Self {
        let mut suppressed = HashSet::new();
        let mut in_block = false;
        let mut block_start: Option<u32> = None;

        for (idx, line) in text.lines().enumerate() {
            let line_no = idx as u32;
            let marker = find_marker(line);

            match marker {
                Some(NolintMarker::Start) => {
                    if !in_block {
                        in_block = true;
                        block_start = Some(line_no);
                    }
                }
                Some(NolintMarker::End) => {
                    if in_block {
                        let start = block_start.unwrap_or(line_no);
                        for l in start..=line_no {
                            suppressed.insert(l);
                        }
                        in_block = false;
                        block_start = None;
                    }
                }
                Some(NolintMarker::Line) => {
                    suppressed.insert(line_no);
                }
                Some(NolintMarker::NextLine) => {
                    suppressed.insert(line_no + 1);
                }
                None => {}
            }

            if in_block {
                suppressed.insert(line_no);
            }
        }

        // Unterminated `nolint start` — treat as suppressing to EOF, matching
        // lintr's behavior so a missing `end` doesn't silently lose coverage.
        if in_block {
            if let Some(start) = block_start {
                let total_lines = text.lines().count() as u32;
                for l in start..total_lines {
                    suppressed.insert(l);
                }
            }
        }

        Self {
            suppressed_lines: suppressed,
        }
    }

    /// Is the given zero-indexed line suppressed?
    pub(crate) fn is_suppressed(&self, line: u32) -> bool {
        self.suppressed_lines.contains(&line)
    }
}

enum NolintMarker {
    Line,
    Start,
    End,
    /// `# @lsp-ignore-next` — suppresses the line *after* the marker.
    NextLine,
}

/// Scan a line for a `# nolint` marker (with optional `start`/`end` suffix).
///
/// Returns `None` if the marker doesn't appear, or if the `#` is inside a
/// string literal. String detection is intentionally simple — it tracks
/// single and double quotes within the same line. R lacks multi-line strings
/// in the common case, so this is good enough for an unobtrusive linter.
fn find_marker(line: &str) -> Option<NolintMarker> {
    let bytes = line.as_bytes();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;

    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' && (in_single || in_double) {
            i += 2;
            continue;
        }
        if !in_single && b == b'"' {
            in_double = !in_double;
        } else if !in_double && b == b'\'' {
            in_single = !in_single;
        } else if !in_single && !in_double && b == b'#' {
            return classify(&line[i + 1..]);
        }
        i += 1;
    }
    None
}

fn classify(after_hash: &str) -> Option<NolintMarker> {
    // Strip an arbitrary run of leading whitespace and additional `#` chars
    // (people sometimes write `## nolint`).
    let trimmed = after_hash
        .trim_start_matches(|c: char| c == '#' || c.is_whitespace())
        .to_ascii_lowercase();

    if let Some(rest) = trimmed.strip_prefix("nolint") {
        let rest = rest.trim_start();
        return if rest.starts_with("start") {
            Some(NolintMarker::Start)
        } else if rest.starts_with("end") {
            Some(NolintMarker::End)
        } else {
            // Either bare `# nolint` or `# nolint: rule_a, rule_b`. Either way
            // it is a line-level suppression for now.
            Some(NolintMarker::Line)
        };
    }

    if let Some(rest) = trimmed.strip_prefix("@lsp-ignore") {
        // Match `-next`, `:next`, or bare `next` after the marker so all of
        // `@lsp-ignore-next`, `@lsp-ignore: next`, and `@lsp-ignore next`
        // resolve to NextLine. Anything else is a same-line ignore.
        let rest = rest
            .trim_start_matches(|c: char| c == ':' || c == '-' || c.is_whitespace());
        return if rest.starts_with("next") {
            Some(NolintMarker::NextLine)
        } else {
            Some(NolintMarker::Line)
        };
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_marker_suppresses_only_its_line() {
        let s = Suppressions::from_text("x = 1\ny = 2 # nolint\nz = 3\n");
        assert!(!s.is_suppressed(0));
        assert!(s.is_suppressed(1));
        assert!(!s.is_suppressed(2));
    }

    #[test]
    fn block_marker_suppresses_inclusive_range() {
        let s = Suppressions::from_text("a\n# nolint start\nb\nc\n# nolint end\nd\n");
        assert!(!s.is_suppressed(0));
        assert!(s.is_suppressed(1));
        assert!(s.is_suppressed(2));
        assert!(s.is_suppressed(3));
        assert!(s.is_suppressed(4));
        assert!(!s.is_suppressed(5));
    }

    #[test]
    fn unterminated_block_extends_to_eof() {
        let s = Suppressions::from_text("a\n# nolint start\nb\nc\n");
        assert!(!s.is_suppressed(0));
        assert!(s.is_suppressed(1));
        assert!(s.is_suppressed(2));
        assert!(s.is_suppressed(3));
    }

    #[test]
    fn marker_inside_string_does_not_suppress() {
        // `#` is inside a string literal — must not be parsed as a comment.
        let s = Suppressions::from_text("x <- \"# nolint\"\n");
        assert!(!s.is_suppressed(0));
    }

    #[test]
    fn rule_filter_suffix_is_recognized() {
        let s = Suppressions::from_text("x = 1 # nolint: line_length, no_tab\n");
        assert!(s.is_suppressed(0));
    }

    #[test]
    fn lsp_ignore_suppresses_current_line() {
        let s = Suppressions::from_text("x = 1 # @lsp-ignore\ny = 2\n");
        assert!(s.is_suppressed(0));
        assert!(!s.is_suppressed(1));
    }

    #[test]
    fn lsp_ignore_next_suppresses_following_line() {
        let s = Suppressions::from_text("# @lsp-ignore-next\nx = 1\ny = 2\n");
        assert!(!s.is_suppressed(0));
        assert!(s.is_suppressed(1));
        assert!(!s.is_suppressed(2));
    }
}
