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
//! Same-line markers nested inside a commented-code line — `# x <- 1 # nolint`
//! — are also honoured via a parse-gated fallback (issue #242). The fallback
//! is motivated by and primarily benefits the `commented_code` rule, but is
//! deliberately rule-agnostic so suppression behaviour doesn't depend on
//! which lints happen to be enabled.
//!
//! Rule-name filters (the `: rule_a, rule_b` suffix on `# nolint`) are
//! recognised but ignored for now — line-level suppression applies to every
//! rule. The shape of `Suppressions` is intentionally rule-agnostic so a
//! future revision can match per rule without an API break.

use std::collections::HashSet;

use crate::linting::parse_gate::looks_like_code;

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

            // Collapsing these inner `if`s into match guards would force a
            // wildcard arm and lose exhaustiveness over `NolintMarker` variants.
            #[allow(clippy::collapsible_match)]
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
///
/// Falls back to [`find_inline_marker`] for the same-line-in-a-commented-code
/// shape (`# x <- 1 # nolint`).
fn find_marker(line: &str) -> Option<NolintMarker> {
    let (_, outer_body) = first_hash_body(line)?;
    if let Some(marker) = classify(outer_body) {
        return Some(marker);
    }
    find_inline_marker(outer_body)
}

/// Return the byte index of the first `#` outside any string literal and
/// the substring of `line` immediately after it. `None` if no such `#` exists.
fn first_hash_body(line: &str) -> Option<(usize, &str)> {
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
            return Some((i, &line[i + 1..]));
        }
        i += 1;
    }
    None
}

/// Fallback for the `# code-here # nolint` shape: a marker nested inside an
/// outer commented-code line. Issue #242.
///
/// Pipeline:
/// 1. **Substring pre-filter** — return immediately unless the outer body
///    contains `nolint` or `@lsp-ignore` as a literal substring. Short-circuits
///    the vast majority of prose comments before any parsing work.
/// 2. **Inner-`#` scan** — find the first `#` inside the outer body that is
///    not inside a string literal. The scan reuses the same single-/double-
///    quote bookkeeping as [`first_hash_body`].
/// 3. **Marker classify** — only treat the inner `#` as a marker if [`classify`]
///    recognises what follows it (`nolint`, `nolint start`, `nolint end`,
///    `@lsp-ignore`, optionally with a rule filter).
/// 4. **Parse-gate** — require the prefix of the outer body (everything
///    between the outer `#` and the inner `#`) to parse as real R code. This
///    is the same gate `commented_code` uses; reusing it avoids accidentally
///    swallowing suppression-like text in prose comments.
///
/// The scan stops at the first inner `#`: a further-nested inner-inner marker
/// (`# foo # bar # nolint`) is intentionally not honoured.
///
/// `# @lsp-ignore-next` in the inline position is **not** honoured: the
/// fallback exists for same-line suppression on commented-out code, so
/// silently mapping it to "suppress line N+1" would suppress an unrelated
/// neighbour while leaving the user's commented-code line still flagged. A
/// user who really wants next-line semantics should put the marker on its
/// own line.
fn find_inline_marker(body: &str) -> Option<NolintMarker> {
    if !body.contains("nolint") && !body.contains("@lsp-ignore") {
        return None;
    }

    let bytes = body.as_bytes();
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
            // First candidate inner `#`. Classify what follows, reject the
            // `NextLine` variant (see the doc comment above), parse-gate the
            // prefix, then commit — or give up.
            let marker = match classify(&body[i + 1..])? {
                NolintMarker::NextLine => return None,
                m => m,
            };
            let prefix = &body[..i];
            let prefix_code = prefix.trim_start_matches(|c: char| c == '#' || c.is_whitespace());
            if looks_like_code(prefix_code) {
                return Some(marker);
            }
            return None;
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

    if let Some(rest) = matches_keyword(&trimmed, "nolint") {
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

    if let Some(rest) = matches_keyword(&trimmed, "@lsp-ignore") {
        // Match `-next`, `:next`, or whitespace+`next` after the marker so
        // `@lsp-ignore-next`, `@lsp-ignore: next`, and `@lsp-ignore next`
        // all resolve to NextLine. Anything else on the same line is a
        // same-line ignore.
        let rest = rest.trim_start_matches(|c: char| c == ':' || c == '-' || c.is_whitespace());
        return if rest.starts_with("next") {
            Some(NolintMarker::NextLine)
        } else {
            Some(NolintMarker::Line)
        };
    }

    None
}

/// Match `keyword` as a word in `haystack`: the keyword must appear as a
/// prefix and the next character (if any) must be a non-identifier byte. This
/// prevents `nolinter` or `@lsp-ignored` from matching `nolint` /
/// `@lsp-ignore` — mirroring the strictness of the directive parser at
/// `cross_file/directive.rs` for `# @lsp-ignore`.
fn matches_keyword<'a>(haystack: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = haystack.strip_prefix(keyword)?;
    match rest.as_bytes().first() {
        // EOL, whitespace, colon, or `-` (used by `@lsp-ignore-next` and
        // `# nolint:`). Anything else means we matched the middle of an
        // unrelated word.
        None => Some(rest),
        Some(b) => {
            let c = *b as char;
            if c.is_whitespace() || c == ':' || c == '-' {
                Some(rest)
            } else {
                None
            }
        }
    }
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

    #[test]
    fn typo_lsp_ignored_does_not_suppress() {
        // `@lsp-ignored` must not be parsed as `@lsp-ignore` — otherwise a
        // typo silently swallows the lint instead of producing it.
        let s = Suppressions::from_text("x = 1 # @lsp-ignored\n");
        assert!(!s.is_suppressed(0));
    }

    #[test]
    fn typo_nolinter_does_not_suppress() {
        let s = Suppressions::from_text("x = 1 # nolinter\n");
        assert!(!s.is_suppressed(0));
    }

    #[test]
    fn inline_nolint_in_commented_code_line_suppresses() {
        // The body of the outer comment is `x <- 1 # nolint`. The interior
        // `# nolint` should be treated as a marker because the prefix `x <- 1`
        // parses as real R code (issue #242).
        let s = Suppressions::from_text("# x <- 1 # nolint\n");
        assert!(s.is_suppressed(0));
    }

    #[test]
    fn inline_nolint_with_rule_filter_suppresses() {
        let s = Suppressions::from_text("# x <- 1 # nolint: commented_code\n");
        assert!(s.is_suppressed(0));
    }

    #[test]
    fn inline_nolint_start_end_brackets_block() {
        let src = "# x <- 1 # nolint start\n# y <- 2\n# z <- 3 # nolint end\n";
        let s = Suppressions::from_text(src);
        assert!(s.is_suppressed(0));
        assert!(s.is_suppressed(1));
        assert!(s.is_suppressed(2));
    }

    #[test]
    fn inline_lsp_ignore_in_commented_code_line_suppresses() {
        let s = Suppressions::from_text("# x <- 1 # @lsp-ignore\n");
        assert!(s.is_suppressed(0));
    }

    #[test]
    fn inline_marker_inside_string_literal_does_not_suppress() {
        // The interior `# nolint` is inside a string in the commented-out
        // code, so it must NOT be treated as a marker.
        let s = Suppressions::from_text("# x <- \"# nolint\"\n");
        assert!(!s.is_suppressed(0));
    }

    #[test]
    fn inline_marker_inside_prose_comment_does_not_suppress() {
        // The prefix `talking about nolint here` is prose, not code, so the
        // parse-gate should reject the fallback and leave the line unsuppressed.
        let s = Suppressions::from_text("# talking about nolint here # nolint\n");
        assert!(!s.is_suppressed(0));
    }

    #[test]
    fn prose_comment_mentioning_nolint_without_inner_hash_does_not_suppress() {
        let s = Suppressions::from_text("# this comment mentions nolint but no second hash\n");
        assert!(!s.is_suppressed(0));
    }

    // Issue #346: a raw leading U+FEFF (BOM) must not hide a first-line nolint
    // marker. This already holds because `first_hash_body` scans bytes for the
    // first `#` and skips the BOM's bytes, but the marker scan is column-0
    // sensitive in spirit, so guard it against regression.
    #[test]
    fn bom_prefixed_nolint_marker_on_first_line_suppresses() {
        let s = Suppressions::from_text("\u{FEFF}x = 1 # nolint\n");
        assert!(s.is_suppressed(0));
    }

    #[test]
    fn bom_prefixed_nolint_start_on_first_line_opens_block() {
        let s = Suppressions::from_text("\u{FEFF}# nolint start\nx = 1\n# nolint end\n");
        assert!(s.is_suppressed(0));
        assert!(s.is_suppressed(1));
        assert!(s.is_suppressed(2));
    }

    #[test]
    fn inline_lsp_ignore_next_is_not_honoured() {
        // `@lsp-ignore-next` semantically points at the *following* line.
        // Honouring it inline would silently suppress a neighbouring line
        // while leaving the user's commented-code line still flagged — worse
        // than not honouring it at all. The inline fallback is for same-line
        // markers only.
        let s = Suppressions::from_text("# x <- 1 # @lsp-ignore-next\ny <- 2\n");
        assert!(!s.is_suppressed(0));
        assert!(!s.is_suppressed(1));
    }
}
