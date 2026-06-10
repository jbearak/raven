//
// cross_file/directive.rs
//
// Directive parsing for cross-file awareness
//

use regex::Regex;
use std::sync::OnceLock;

use super::types::{
    BackwardDirective, CallSiteSpec, CrossFileMetadata, DeclaredSymbol, ForwardSource,
    LineSuppression, SuppressionDirective, SuppressionFlavor, SuppressionRange,
};

/// Compiled regex patterns for directive parsing
struct DirectivePatterns {
    backward: Regex,
    forward: Regex,
    working_dir: Regex,
    ignore: Regex,
    ignore_next: Regex,
    raven_ignore: Regex,
    raven_ignore_next: Regex,
    raven_ignore_start: Regex,
    raven_ignore_end: Regex,
    raven_ignore_file: Regex,
    declare_var: Regex,
    declare_func: Regex,
}

/// Convert an optional `[code]` selector capture into a [`LineSuppression`].
///
/// `None` (no brackets) and an empty/blank bracket body both mean a blanket
/// ignore. Otherwise the body is split on commas and each code normalized to
/// its canonical kebab-case spelling (so `[line_length, undefined-variable]`
/// works).
fn parse_suppression_codes(raw: Option<&str>) -> LineSuppression {
    match raw {
        None => LineSuppression::All,
        Some(body) => {
            let codes: Vec<String> = body
                .split(',')
                .map(crate::diagnostic_code::normalize)
                .filter(|c| !c.is_empty())
                .collect();
            if codes.is_empty() {
                LineSuppression::All
            } else {
                LineSuppression::Codes(codes)
            }
        }
    }
}

/// Return the substring of `line` starting at the first `#` that is outside any
/// single- or double-quoted string literal, or `None` if no such `#` exists.
///
/// The same-line ignore regexes (`patterns.ignore`, `patterns.raven_ignore`) are
/// not start-anchored and have no string awareness, so a line that *opens* a
/// multi-line string and ends with the marker text inside that string —
/// `x <- foo + "abc # @lsp-ignore` — would otherwise match and silence a genuine
/// diagnostic. Gating those regexes on this comment region prevents that: a `#`
/// living inside an open string is not a comment start, so no marker is found.
///
/// This is a deliberate local copy of `linting::nolint::first_hash_body`; the two
/// must stay in parity (same single-/double-quote and backslash-escape
/// bookkeeping). It is copied rather than imported to avoid a cross-module
/// dependency between the analyzer and lint tracks for a few lines of byte scan.
fn comment_region_outside_strings(line: &str) -> Option<&str> {
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
            return Some(&line[i..]);
        }
        i += 1;
    }
    None
}

/// Map the flavor capture (`ignore` | `expect`) into a [`SuppressionFlavor`].
/// Defaults to [`SuppressionFlavor::Ignore`] when absent or unrecognized.
fn parse_flavor(raw: Option<&str>) -> SuppressionFlavor {
    match raw {
        Some("expect") => SuppressionFlavor::Expect,
        _ => SuppressionFlavor::Ignore,
    }
}

/// Insert a line→suppression mapping, merging with any existing entry so a line
/// carrying two directives accumulates both (and `All` stays absorbing).
fn insert_line_suppression(
    map: &mut std::collections::HashMap<u32, LineSuppression>,
    line: u32,
    what: LineSuppression,
) {
    map.entry(line)
        .and_modify(|existing| existing.merge(what.clone()))
        .or_insert(what);
}

/// Extract path from capture groups (double-quoted, single-quoted, or unquoted)
fn capture_path(caps: &regex::Captures, base_group: usize) -> Option<String> {
    // Try double-quoted (base_group)
    if let Some(m) = caps.get(base_group)
        && !m.as_str().is_empty()
    {
        return Some(m.as_str().to_string());
    }
    // Try single-quoted (base_group + 1)
    if let Some(m) = caps.get(base_group + 1)
        && !m.as_str().is_empty()
    {
        return Some(m.as_str().to_string());
    }
    // Try unquoted (base_group + 2)
    if let Some(m) = caps.get(base_group + 2)
        && !m.as_str().is_empty()
    {
        return Some(m.as_str().to_string());
    }
    None
}

/// Extract symbol name from capture groups (double-quoted, single-quoted, or unquoted).
/// Returns None if the symbol name is empty or whitespace-only.
/// Requirements: 1.4, 1.5, 2.4, 2.5, 3.4
fn capture_symbol_name(caps: &regex::Captures, base_group: usize) -> Option<String> {
    let name = capture_path(caps, base_group)?;
    // Skip empty or whitespace-only symbol names
    if name.trim().is_empty() {
        return None;
    }
    Some(name)
}

/// Keyword alternation for forward source directives: `@lsp-source`, `@lsp-run`,
/// `@lsp-include`. This is the inner body of the `@lsp-(?:…)` group only — the
/// surrounding regex (anchoring, separator, capture groups) is supplied by each
/// call site.
///
/// Single source of truth: the directive vocabulary is recognized by two
/// independent regex sets — the full parser in [`patterns`] (capture groups,
/// BOM-stripped input) and the column-aligned, BOM-tolerant prefix matchers in
/// `file_path_intellisense::directive_path_patterns`. Those sets differ
/// deliberately in everything *except* the keyword vocabulary, so only the
/// alternation bodies are shared here to keep the recognized keywords from
/// drifting between them.
pub(crate) const FORWARD_DIRECTIVE_KEYWORDS: &str = "source|run|include";

/// Keyword alternation for backward provenance directives: `@lsp-sourced-by`,
/// `@lsp-run-by`, `@lsp-included-by`. See [`FORWARD_DIRECTIVE_KEYWORDS`] for why
/// this is factored out.
pub(crate) const BACKWARD_DIRECTIVE_KEYWORDS: &str = "sourced-by|run-by|included-by";

fn patterns() -> &'static DirectivePatterns {
    static PATTERNS: OnceLock<DirectivePatterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        // Path pattern: "quoted with spaces" or 'single quoted' or unquoted
        // Groups: 1=double-quoted, 2=single-quoted, 3=unquoted
        // All directive regexes are anchored to start of line (^\s*) except
        // @lsp-ignore, which can appear as a trailing comment (e.g., x <- foo # @lsp-ignore).
        // The forward/backward keyword alternations are shared with
        // file_path_intellisense via {FORWARD,BACKWARD}_DIRECTIVE_KEYWORDS,
        // plugged into the middle of each pattern by concatenation.
        DirectivePatterns {
            backward: Regex::new(
                &[
                    r#"^\s*#\s*@lsp-(?:"#,
                    BACKWARD_DIRECTIVE_KEYWORDS,
                    r#")\s*:?\s*(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+line\s*=\s*(\d+|eof|end))?(?:\s+match\s*=\s*["']([^"']+)["'])?"#,
                ]
                .concat(),
            )
            .unwrap(),
            forward: Regex::new(
                &[
                    r#"^\s*#\s*@lsp-(?:"#,
                    FORWARD_DIRECTIVE_KEYWORDS,
                    r#")(?:\s+:?\s*|:\s*)(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+line\s*=\s*(\d+|eof|end))?"#,
                ]
                .concat(),
            )
            .unwrap(),
            working_dir: Regex::new(
                r#"^\s*#\s*@lsp-(?:working-directory|working-dir|current-directory|current-dir|cd|wd)\s*:?\s*(?:"([^"]+)"|'([^']+)'|(\S+))"#
            ).unwrap(),
            ignore: Regex::new(
                r"#\s*@lsp-(ignore|expect)(?:\[([^\]]*)\])?\s*:?\s*$"
            ).unwrap(),
            ignore_next: Regex::new(
                r"^\s*#\s*@lsp-(ignore|expect)-next(?:\[([^\]]*)\])?\s*:?\s*$"
            ).unwrap(),
            // `# raven:` is the primary suppression namespace (F2). For the
            // analyzer track it aliases the line / next-line ignore forms
            // (`@lsp-ignore` parity), plus block (`-start`/`-end`) and
            // file-level (`-file`) forms. Each form takes an optional `[code]`
            // selector (comma-separated codes) that targets specific diagnostic
            // codes; absent brackets mean a blanket ignore. Each form also
            // comes in two flavors — `ignore` (silent) and `expect` (asserts a
            // suppression, warns via `unused-suppression` if none occurred) —
            // captured as group 1; the `[code]` body is group 2. The same-line
            // form excludes `-next`/`-start`/`-end`/`-file` by requiring the
            // verb to be followed only by an optional `[code]` + EOL.
            raven_ignore: Regex::new(
                r"#\s*raven:\s*(ignore|expect)(?:\[([^\]]*)\])?\s*$"
            ).unwrap(),
            raven_ignore_next: Regex::new(
                r"^\s*#\s*raven:\s*(ignore|expect)-next(?:\[([^\]]*)\])?\s*$"
            ).unwrap(),
            raven_ignore_start: Regex::new(
                r"^\s*#\s*raven:\s*(ignore|expect)-start(?:\[([^\]]*)\])?\s*$"
            ).unwrap(),
            raven_ignore_end: Regex::new(
                r"^\s*#\s*raven:\s*(?:ignore|expect)-end\s*$"
            ).unwrap(),
            raven_ignore_file: Regex::new(
                r"^\s*#\s*raven:\s*(ignore|expect)-file(?:\[([^\]]*)\])?\s*$"
            ).unwrap(),
            // Declaration directives for variables
            // Synonyms: @lsp-declare-variable, @lsp-declare-var, @lsp-variable, @lsp-var
            // Groups: 1=double-quoted, 2=single-quoted, 3=unquoted
            // Requirements: 1.1, 1.2, 1.3
            declare_var: Regex::new(
                r#"^\s*#\s*@lsp-(?:declare-variable|declare-var|variable|var)\s*:?\s*(?:"([^"]+)"|'([^']+)'|(\S+))"#
            ).unwrap(),
            // Declaration directives for functions
            // Synonyms: @lsp-declare-function, @lsp-declare-func, @lsp-function, @lsp-func
            // Groups: 1=double-quoted, 2=single-quoted, 3=unquoted
            // Requirements: 2.1, 2.2, 2.3
            declare_func: Regex::new(
                r#"^\s*#\s*@lsp-(?:declare-function|declare-func|function|func)\s*:?\s*(?:"([^"]+)"|'([^']+)'|(\S+))"#
            ).unwrap(),
        }
    })
}

/// Parse directives from file content.
/// Extracts @lsp-* directives including sourced-by, source, working-directory, and ignore directives.
///
/// Backward directives (`@lsp-sourced-by`, `@lsp-run-by`, `@lsp-included-by`) and working
/// directory directives (`@lsp-cd`, etc.) are **header-only**: they must appear before any code.
/// The header is the region of consecutive blank and comment lines from the start of the file;
/// it ends at the first non-blank, non-comment line.
///
/// Forward, declaration, and ignore directives are recognized anywhere in the file.
pub fn parse_directives(content: &str) -> CrossFileMetadata {
    log::trace!("Starting directive parsing");
    let patterns = patterns();
    let mut meta = CrossFileMetadata::default();

    // BOM-tolerant scan anchor (see `strip_leading_bom_for_scan`). Directive
    // positions are line-based — column is always 0 — so this shifts nothing. #346.
    let content = crate::utf16::strip_leading_bom_for_scan(content);

    // Header tracking: backward and working-dir directives are only recognized
    // in the file header (consecutive blank/comment lines from the start).
    let mut in_header = true;

    // Open `# raven: ignore-start` block, if any: (start_line, what, flavor).
    // Closed by `# raven: ignore-end`; an unterminated block extends to EOF
    // (mirrors the lint track's `# nolint start` behavior).
    let mut open_block: Option<(u32, LineSuppression, SuppressionFlavor)> = None;
    let mut total_lines: u32 = 0;

    for (line_num, line) in content.lines().enumerate() {
        let line_num = line_num as u32;
        total_lines = line_num + 1;

        // Track header boundary before the @lsp- pre-filter so that code lines
        // without directives still end the header region.
        if in_header {
            let trimmed = line.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('#') {
                in_header = false;
            }
        }

        // Fast pre-filter: skip lines that can't contain any directive.
        // All directives require "@lsp-" (or the "raven:" suppression
        // namespace) so a cheap contains() check avoids running the regex
        // battery on the vast majority of lines.
        if !line.contains("@lsp-") && !line.contains("raven:") {
            continue;
        }

        // Header-only: backward directives
        if in_header && let Some(caps) = patterns.backward.captures(line) {
            let path = capture_path(&caps, 1).unwrap_or_default();
            let call_site = if let Some(line_match) = caps.get(4) {
                let line_str = line_match.as_str();
                if line_str == "eof" || line_str == "end" {
                    // Use u32::MAX as EOF sentinel
                    CallSiteSpec::Line(u32::MAX)
                } else {
                    // Convert 1-based user input to 0-based internal
                    let user_line: u32 = line_str.parse().unwrap_or(1);
                    CallSiteSpec::Line(user_line.saturating_sub(1))
                }
            } else if let Some(match_pattern) = caps.get(5) {
                CallSiteSpec::Match(match_pattern.as_str().to_string())
            } else {
                CallSiteSpec::Default
            };
            log::trace!(
                "  Parsed backward directive at line {}: path='{}' call_site={:?}",
                line_num,
                path,
                call_site
            );
            meta.sourced_by.push(BackwardDirective {
                path,
                call_site,
                directive_line: line_num,
            });
            continue;
        }

        // Header-only: working directory directive
        if in_header && let Some(caps) = patterns.working_dir.captures(line) {
            let path = capture_path(&caps, 1).unwrap_or_default();
            log::trace!(
                "  Parsed working directory directive at line {}: path='{}'",
                line_num,
                path
            );
            meta.working_directory = Some(path);
            continue;
        }

        // Full-file: forward directive
        if let Some(caps) = patterns.forward.captures(line) {
            let path = capture_path(&caps, 1).unwrap_or_default();
            // Parse line=N parameter from capture group 4 if present
            // Convert from 1-based user input to 0-based internal (N-1)
            // Use directive's own line when no line= parameter
            let (call_site_line, has_explicit_line, is_line_zero) =
                if let Some(line_match) = caps.get(4) {
                    let line_str = line_match.as_str();
                    if line_str == "eof" || line_str == "end" {
                        // Use u32::MAX as EOF sentinel
                        (u32::MAX, true, false)
                    } else {
                        let user_line: u32 = line_str.parse().unwrap_or(0);
                        let is_zero = user_line == 0;
                        // For line=0, treat as line=1 (internal 0) but flag it as invalid
                        let effective_line = if user_line == 0 {
                            0
                        } else {
                            user_line.saturating_sub(1)
                        };
                        (effective_line, true, is_zero)
                    }
                } else {
                    (line_num, false, false)
                };
            log::trace!(
                "  Parsed forward directive at line {}: path='{}' call_site_line={} explicit_line={} user_line_zero={}",
                line_num,
                path,
                call_site_line,
                has_explicit_line,
                is_line_zero
            );
            meta.sources.push(ForwardSource {
                path,
                line: call_site_line,
                column: 0, // Always 0 for directive-based sources
                is_directive: true,
                local: false,
                chdir: false,
                is_sys_source: false,
                sys_source_global_env: true,
                explicit_line: has_explicit_line,
                directive_line: line_num,
                user_line_zero: is_line_zero,
                // `@lsp-source` directives are treated as load-time sources
                // and are never function-scoped. Note: unlike backward
                // (`@lsp-sourced-by`) and working-directory (`@lsp-cd`)
                // directives, forward directives (`@lsp-source`,
                // `@lsp-run`, `@lsp-include`) are NOT strictly header-only
                // in this parser — see the parse_directives docstring above
                // and the "Backward directives and working directory
                // directives are header-only" learning in AGENTS.md. The
                // load-time semantics here come from the parser, not from
                // a header-only restriction: this branch runs in the full-
                // file pass, and `is_directive: true` (combined with this
                // `is_function_scoped: false`) is what tags the resulting
                // ForwardSource as a load-time ordering constraint.
                is_function_scoped: false,
                system_file: None,
                resolved_uri: None,
            });
            continue;
        }

        // Full-file: ignore directives. Each captures an optional flavor
        // (`ignore`|`expect`, group 1) and `[code]` selector (group 2) that
        // narrows what it suppresses. The same-line form is not start-anchored,
        // so it is matched only against the comment region (the substring from
        // the first `#` outside any string literal) — otherwise a marker that
        // lives inside an *open* multi-line string would wrongly suppress.
        if let Some(caps) = comment_region_outside_strings(line)
            .and_then(|comment| patterns.ignore.captures(comment))
        {
            log::trace!("  Parsed @lsp-ignore/expect directive at line {}", line_num);
            let flavor = parse_flavor(caps.get(1).map(|m| m.as_str()));
            let what = parse_suppression_codes(caps.get(2).map(|m| m.as_str()));
            insert_line_suppression(&mut meta.ignored_lines, line_num, what.clone());
            meta.suppression_directives.push(SuppressionDirective {
                directive_line: line_num,
                target_start: line_num,
                target_end: line_num,
                what,
                flavor,
            });
            continue;
        }

        if let Some(caps) = patterns.ignore_next.captures(line) {
            log::trace!(
                "  Parsed @lsp-ignore/expect-next directive at line {}",
                line_num
            );
            let flavor = parse_flavor(caps.get(1).map(|m| m.as_str()));
            let what = parse_suppression_codes(caps.get(2).map(|m| m.as_str()));
            insert_line_suppression(&mut meta.ignored_next_lines, line_num + 1, what.clone());
            meta.suppression_directives.push(SuppressionDirective {
                directive_line: line_num,
                target_start: line_num + 1,
                target_end: line_num + 1,
                what,
                flavor,
            });
            continue;
        }

        // Full-file: `# raven:` primary-namespace ignore aliases (F2). The
        // block (`-start`/`-end`) and file (`-file`) forms are checked first
        // since `raven_ignore` (the same-line form) does not match them.
        if let Some(caps) = patterns.raven_ignore_start.captures(line) {
            log::trace!(
                "  Parsed `# raven: ignore/expect-start` at line {}",
                line_num
            );
            // A nested start is ignored until the current block closes (mirrors
            // the lint track, which does not nest).
            if open_block.is_none() {
                let flavor = parse_flavor(caps.get(1).map(|m| m.as_str()));
                let what = parse_suppression_codes(caps.get(2).map(|m| m.as_str()));
                open_block = Some((line_num, what, flavor));
            }
            continue;
        }

        if patterns.raven_ignore_end.is_match(line) {
            log::trace!("  Parsed `# raven: ignore/expect-end` at line {}", line_num);
            if let Some((start, what, flavor)) = open_block.take() {
                meta.ignored_ranges.push(SuppressionRange {
                    start,
                    end: line_num,
                    what: what.clone(),
                });
                meta.suppression_directives.push(SuppressionDirective {
                    directive_line: start,
                    target_start: start,
                    target_end: line_num,
                    what,
                    flavor,
                });
            }
            continue;
        }

        if let Some(caps) = patterns.raven_ignore_file.captures(line) {
            log::trace!(
                "  Parsed `# raven: ignore/expect-file` at line {}",
                line_num
            );
            let flavor = parse_flavor(caps.get(1).map(|m| m.as_str()));
            let what = parse_suppression_codes(caps.get(2).map(|m| m.as_str()));
            match &mut meta.ignored_file {
                Some(existing) => existing.merge(what.clone()),
                None => meta.ignored_file = Some(what.clone()),
            }
            meta.suppression_directives.push(SuppressionDirective {
                directive_line: line_num,
                target_start: 0,
                target_end: u32::MAX,
                what,
                flavor,
            });
            continue;
        }

        if let Some(caps) = patterns.raven_ignore_next.captures(line) {
            log::trace!(
                "  Parsed `# raven: ignore/expect-next` directive at line {}",
                line_num
            );
            let flavor = parse_flavor(caps.get(1).map(|m| m.as_str()));
            let what = parse_suppression_codes(caps.get(2).map(|m| m.as_str()));
            insert_line_suppression(&mut meta.ignored_next_lines, line_num + 1, what.clone());
            meta.suppression_directives.push(SuppressionDirective {
                directive_line: line_num,
                target_start: line_num + 1,
                target_end: line_num + 1,
                what,
                flavor,
            });
            continue;
        }

        // Same-line form (not start-anchored); see `patterns.ignore` above for
        // why this is gated on the comment region rather than the raw line.
        if let Some(caps) = comment_region_outside_strings(line)
            .and_then(|comment| patterns.raven_ignore.captures(comment))
        {
            log::trace!(
                "  Parsed `# raven: ignore/expect` directive at line {}",
                line_num
            );
            let flavor = parse_flavor(caps.get(1).map(|m| m.as_str()));
            let what = parse_suppression_codes(caps.get(2).map(|m| m.as_str()));
            insert_line_suppression(&mut meta.ignored_lines, line_num, what.clone());
            meta.suppression_directives.push(SuppressionDirective {
                directive_line: line_num,
                target_start: line_num,
                target_end: line_num,
                what,
                flavor,
            });
            continue;
        }

        // Check variable declaration directives (@lsp-var, @lsp-variable, etc.)
        // Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
        if let Some(caps) = patterns.declare_var.captures(line) {
            if let Some(name) = capture_symbol_name(&caps, 1) {
                log::trace!(
                    "  Parsed variable declaration directive at line {}: name='{}'",
                    line_num,
                    name
                );
                meta.declared_variables.push(DeclaredSymbol {
                    name,
                    line: line_num,
                    is_function: false,
                });
            }
            continue;
        }

        // Check function declaration directives (@lsp-func, @lsp-function, etc.)
        // Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
        if let Some(caps) = patterns.declare_func.captures(line) {
            if let Some(name) = capture_symbol_name(&caps, 1) {
                log::trace!(
                    "  Parsed function declaration directive at line {}: name='{}'",
                    line_num,
                    name
                );
                meta.declared_functions.push(DeclaredSymbol {
                    name,
                    line: line_num,
                    is_function: true,
                });
            }
            continue;
        }
    }

    // An unterminated `# raven: ignore-start` extends to EOF (mirrors the lint
    // track's `# nolint start` behavior so a missing `-end` doesn't silently
    // lose coverage).
    if let Some((start, what, flavor)) = open_block.take() {
        let end = total_lines.saturating_sub(1);
        meta.ignored_ranges.push(SuppressionRange {
            start,
            end,
            what: what.clone(),
        });
        meta.suppression_directives.push(SuppressionDirective {
            directive_line: start,
            target_start: start,
            target_end: end,
            what,
            flavor,
        });
    }

    log::trace!(
        "Completed directive parsing: {} backward directives, {} forward directives, working_dir={:?}, {} ignored lines, {} declared vars, {} declared funcs",
        meta.sourced_by.len(),
        meta.sources.len(),
        meta.working_directory,
        meta.ignored_lines.len() + meta.ignored_next_lines.len(),
        meta.declared_variables.len(),
        meta.declared_functions.len()
    );

    meta
}

/// Check if a line should have a diagnostic with `code` suppressed.
///
/// Considers, in turn: a file-level ignore, a line-scoped ignore on `line`, a
/// next-line ignore targeting `line`, and any block range covering `line`. A
/// blanket directive (`LineSuppression::All`) covers any code; a code-scoped
/// directive covers only diagnostics whose code is
/// [`suppresses`](crate::diagnostic_code::suppresses)-covered by one of its
/// listed codes (and only when `code` is `Some`).
pub fn is_line_ignored_for_code(
    metadata: &CrossFileMetadata,
    line: u32,
    code: Option<&str>,
) -> bool {
    if let Some(file) = &metadata.ignored_file
        && file.covers(code)
    {
        return true;
    }
    if let Some(s) = metadata.ignored_lines.get(&line)
        && s.covers(code)
    {
        return true;
    }
    if let Some(s) = metadata.ignored_next_lines.get(&line)
        && s.covers(code)
    {
        return true;
    }
    metadata
        .ignored_ranges
        .iter()
        .any(|r| line >= r.start && line <= r.end && r.what.covers(code))
}

/// Check if a line carries a *blanket* ignore (covers any diagnostic code).
///
/// Equivalent to [`is_line_ignored_for_code`] with `code: None`: only
/// `LineSuppression::All` entries match, since a code-scoped directive cannot
/// suppress an unknown code. Retained for callers that have no diagnostic code
/// in hand.
pub fn is_line_ignored(metadata: &CrossFileMetadata, line: u32) -> bool {
    is_line_ignored_for_code(metadata, line, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backward_directive_basic() {
        let content = "# @lsp-sourced-by ../main.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
        assert_eq!(meta.sourced_by[0].call_site, CallSiteSpec::Default);
    }

    #[test]
    fn test_backward_directive_with_colon() {
        let content = "# @lsp-sourced-by: ../main.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
    }

    #[test]
    fn test_backward_directive_quoted() {
        let content = r#"# @lsp-sourced-by "../main.R""#;
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
    }

    #[test]
    fn test_backward_directive_single_quoted() {
        let content = "# @lsp-sourced-by '../main.R'";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
    }

    #[test]
    fn test_backward_directive_with_line() {
        let content = "# @lsp-sourced-by ../main.R line=15";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].call_site, CallSiteSpec::Line(14)); // 0-based
    }

    #[test]
    fn test_backward_directive_with_line_eof() {
        let content = "# @lsp-sourced-by ../main.R line=eof";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].call_site, CallSiteSpec::Line(u32::MAX));
    }

    #[test]
    fn test_backward_directive_with_line_end() {
        let content = "# @lsp-sourced-by ../main.R line=end";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].call_site, CallSiteSpec::Line(u32::MAX));
    }

    #[test]
    fn test_backward_directive_with_match() {
        let content = r#"# @lsp-sourced-by ../main.R match="source(""#;
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(
            meta.sourced_by[0].call_site,
            CallSiteSpec::Match("source(".to_string())
        );
    }

    #[test]
    fn test_backward_directive_synonyms() {
        let content = "# @lsp-run-by ../main.R\n# @lsp-included-by ../other.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 2);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
        assert_eq!(meta.sourced_by[1].path, "../other.R");
    }

    #[test]
    fn test_forward_directive() {
        let content = "# @lsp-source utils.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
        assert!(meta.sources[0].is_directive);
    }

    #[test]
    fn test_forward_directive_with_colon_and_quotes() {
        let content = r#"# @lsp-source: "utils/helpers.R""#;
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils/helpers.R");
    }

    #[test]
    fn test_working_directory_directive() {
        let content = "# @lsp-working-directory /data/scripts";
        let meta = parse_directives(content);
        assert_eq!(meta.working_directory, Some("/data/scripts".to_string()));
    }

    #[test]
    fn test_working_directory_synonyms() {
        for directive in [
            "@lsp-wd",
            "@lsp-cd",
            "@lsp-current-directory",
            "@lsp-current-dir",
            "@lsp-working-dir",
        ] {
            let content = format!("# {} /data", directive);
            let meta = parse_directives(&content);
            assert_eq!(
                meta.working_directory,
                Some("/data".to_string()),
                "Failed for {}",
                directive
            );
        }
    }

    #[test]
    fn test_ignore_directive() {
        let content = "x <- 1\n# @lsp-ignore\ny <- undefined";
        let meta = parse_directives(content);
        assert!(meta.ignored_lines.contains_key(&1));
    }

    #[test]
    fn test_ignore_next_directive() {
        let content = "# @lsp-ignore-next\ny <- undefined";
        let meta = parse_directives(content);
        assert!(meta.ignored_next_lines.contains_key(&1));
    }

    #[test]
    fn test_is_line_ignored() {
        let content = "# @lsp-ignore\nx <- 1\n# @lsp-ignore-next\ny <- 2";
        let meta = parse_directives(content);
        assert!(is_line_ignored(&meta, 0)); // @lsp-ignore line
        assert!(!is_line_ignored(&meta, 1)); // x <- 1
        assert!(!is_line_ignored(&meta, 2)); // @lsp-ignore-next line
        assert!(is_line_ignored(&meta, 3)); // y <- 2 (next line after ignore-next)
    }

    /// F2: `# raven: ignore` / `ignore-next` alias the analyzer-track ignore
    /// lines exactly like `@lsp-ignore` / `@lsp-ignore-next`.
    #[test]
    fn test_raven_ignore_aliases_analyzer_track() {
        let content =
            "x <- undefined # raven: ignore\n# raven: ignore-next\ny <- undefined2\nz <- ok";
        let meta = parse_directives(content);
        assert!(is_line_ignored(&meta, 0)); // trailing `# raven: ignore`
        assert!(!is_line_ignored(&meta, 1)); // the directive line itself
        assert!(is_line_ignored(&meta, 2)); // targeted by ignore-next
        assert!(!is_line_ignored(&meta, 3));
    }

    /// F2: a `[code]` selector on the analyzer-track alias targets only the
    /// listed code — it suppresses `undefined-variable` but not other codes,
    /// and is *not* a blanket ignore.
    #[test]
    fn test_raven_ignore_with_code_selector() {
        let content = "x <- undefined # raven: ignore[undefined-variable]";
        let meta = parse_directives(content);
        assert!(is_line_ignored_for_code(
            &meta,
            0,
            Some("undefined-variable")
        ));
        assert!(!is_line_ignored_for_code(
            &meta,
            0,
            Some("package-not-installed")
        ));
        // Not a blanket ignore: a code-less query does not match.
        assert!(!is_line_ignored(&meta, 0));
    }

    /// F2: a bare `# raven: ignore` (no `[code]`) is a blanket ignore that
    /// covers any code, including a code-less query.
    #[test]
    fn test_raven_ignore_blanket_covers_any_code() {
        let content = "x <- undefined # raven: ignore";
        let meta = parse_directives(content);
        assert!(is_line_ignored(&meta, 0));
        assert!(is_line_ignored_for_code(
            &meta,
            0,
            Some("undefined-variable")
        ));
        assert!(is_line_ignored_for_code(&meta, 0, Some("anything-at-all")));
    }

    /// F2: block and file forms on the analyzer track.
    #[test]
    fn test_raven_ignore_block_and_file_forms() {
        let block = "# raven: ignore-start\na <- b\nc <- d\n# raven: ignore-end\ne <- f";
        let meta = parse_directives(block);
        // Inclusive of the start/end directive lines, mirroring `# nolint
        // start`/`end`. The directive lines are comments, so this is harmless.
        assert!(is_line_ignored(&meta, 0));
        assert!(is_line_ignored(&meta, 1));
        assert!(is_line_ignored(&meta, 2));
        assert!(is_line_ignored(&meta, 3));
        assert!(!is_line_ignored(&meta, 4));

        let file = "# raven: ignore-file[undefined-variable]\nx <- undefined";
        let meta = parse_directives(file);
        assert!(is_line_ignored_for_code(
            &meta,
            1,
            Some("undefined-variable")
        ));
        assert!(!is_line_ignored_for_code(
            &meta,
            1,
            Some("package-not-installed")
        ));
    }

    /// F2 Step 3: `expect` is recognized as a suppressing directive on the
    /// analyzer track (suppresses identically to `ignore`) and is enumerated
    /// with `flavor = Expect`.
    #[test]
    fn test_raven_expect_suppresses_and_records_flavor() {
        let content = "x <- undefined # raven: expect[undefined-variable]";
        let meta = parse_directives(content);
        // Suppresses just like ignore.
        assert!(is_line_ignored_for_code(
            &meta,
            0,
            Some("undefined-variable")
        ));
        // Enumerated as an Expect directive at line 0.
        assert_eq!(meta.suppression_directives.len(), 1);
        let d = &meta.suppression_directives[0];
        assert_eq!(d.flavor, SuppressionFlavor::Expect);
        assert_eq!(d.directive_line, 0);
        assert_eq!(d.target_start, 0);
        assert_eq!(d.target_end, 0);
    }

    /// F2 Step 3: a plain `ignore` is enumerated with `flavor = Ignore`.
    #[test]
    fn test_raven_ignore_records_ignore_flavor() {
        let content = "x <- undefined # raven: ignore";
        let meta = parse_directives(content);
        assert_eq!(meta.suppression_directives.len(), 1);
        assert_eq!(
            meta.suppression_directives[0].flavor,
            SuppressionFlavor::Ignore
        );
    }

    /// F2 Step 3: `@lsp-expect` / `@lsp-expect-next` aliases.
    #[test]
    fn test_lsp_expect_aliases() {
        let meta = parse_directives("x <- undefined # @lsp-expect[undefined-variable]");
        assert_eq!(meta.suppression_directives.len(), 1);
        assert_eq!(
            meta.suppression_directives[0].flavor,
            SuppressionFlavor::Expect
        );
        assert!(is_line_ignored_for_code(
            &meta,
            0,
            Some("undefined-variable")
        ));

        let meta = parse_directives("# @lsp-expect-next\ny <- undefined");
        assert_eq!(meta.suppression_directives.len(), 1);
        let d = &meta.suppression_directives[0];
        assert_eq!(d.flavor, SuppressionFlavor::Expect);
        assert_eq!(d.directive_line, 0);
        assert_eq!(d.target_start, 1);
        assert_eq!(d.target_end, 1);
        assert!(is_line_ignored(&meta, 1));
    }

    /// F2 Step 3: `expect-start` … `ignore-end` forms a range directive with
    /// the start line as the hint anchor and the whole block as target.
    #[test]
    fn test_raven_expect_block_enumeration() {
        let content = "# raven: expect-start[undefined-variable]\na <- b\nc <- d\n# raven: ignore-end\ne <- f";
        let meta = parse_directives(content);
        let block: Vec<_> = meta
            .suppression_directives
            .iter()
            .filter(|d| d.target_start != d.target_end || d.target_start == 0)
            .collect();
        assert_eq!(block.len(), 1);
        let d = block[0];
        assert_eq!(d.flavor, SuppressionFlavor::Expect);
        assert_eq!(d.directive_line, 0);
        assert_eq!(d.target_start, 0);
        assert_eq!(d.target_end, 3);
    }

    /// F2 Step 3: `expect-file` covers every line (target_end = u32::MAX).
    #[test]
    fn test_raven_expect_file_enumeration() {
        let content = "# raven: expect-file[undefined-variable]\nx <- undefined";
        let meta = parse_directives(content);
        assert_eq!(meta.suppression_directives.len(), 1);
        let d = &meta.suppression_directives[0];
        assert_eq!(d.flavor, SuppressionFlavor::Expect);
        assert_eq!(d.target_start, 0);
        assert_eq!(d.target_end, u32::MAX);
    }

    #[test]
    fn test_multiple_directives() {
        let content = r#"# @lsp-sourced-by ../main.R line=10
# @lsp-working-directory /data
source("utils.R")
# @lsp-source helpers.R
# @lsp-ignore
x <- undefined"#;
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sources.len(), 1); // Only directive, not source() call
        assert_eq!(meta.working_directory, Some("/data".to_string()));
        assert!(meta.ignored_lines.contains_key(&4));
    }

    // Tests for quoted paths with spaces (Requirements 2.1-2.6)
    #[test]
    fn test_backward_directive_double_quoted_with_spaces() {
        let content = r#"# @lsp-sourced-by "path with spaces/main.R""#;
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "path with spaces/main.R");
    }

    #[test]
    fn test_backward_directive_single_quoted_with_spaces() {
        let content = "# @lsp-sourced-by 'path with spaces/main.R'";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "path with spaces/main.R");
    }

    #[test]
    fn test_backward_directive_with_colon_and_spaces() {
        let content = r#"# @lsp-sourced-by: "my folder/main.R""#;
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "my folder/main.R");
    }

    #[test]
    fn test_backward_directive_with_spaces_and_line() {
        let content = r#"# @lsp-sourced-by "path with spaces/main.R" line=15"#;
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "path with spaces/main.R");
        assert_eq!(meta.sourced_by[0].call_site, CallSiteSpec::Line(14));
    }

    #[test]
    fn test_forward_directive_double_quoted_with_spaces() {
        let content = r#"# @lsp-source "utils folder/helpers.R""#;
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils folder/helpers.R");
    }

    #[test]
    fn test_forward_directive_single_quoted_with_spaces() {
        let content = "# @lsp-source 'utils folder/helpers.R'";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils folder/helpers.R");
    }

    // Tests for forward directive synonyms (@lsp-run, @lsp-include)
    #[test]
    fn test_forward_directive_lsp_run_synonym() {
        let content = "# @lsp-run utils.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
        assert!(meta.sources[0].is_directive);
    }

    #[test]
    fn test_forward_directive_lsp_include_synonym() {
        let content = "# @lsp-include utils.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
        assert!(meta.sources[0].is_directive);
    }

    #[test]
    fn test_forward_directive_synonyms_all() {
        // Test all three synonyms produce identical results
        for directive in ["@lsp-source", "@lsp-run", "@lsp-include"] {
            let content = format!("# {} utils.R", directive);
            let meta = parse_directives(&content);
            assert_eq!(meta.sources.len(), 1, "Failed for {}", directive);
            assert_eq!(meta.sources[0].path, "utils.R", "Failed for {}", directive);
            assert!(meta.sources[0].is_directive, "Failed for {}", directive);
        }
    }

    #[test]
    fn test_forward_directive_synonyms_no_at_prefix_not_recognized() {
        for directive in ["lsp-source", "lsp-run", "lsp-include"] {
            let content = format!("# {} utils.R", directive);
            let meta = parse_directives(&content);
            assert_eq!(
                meta.sources.len(),
                0,
                "Should not recognize {} without @ prefix",
                directive
            );
        }
    }

    #[test]
    fn test_forward_directive_synonyms_with_colon() {
        for directive in ["@lsp-source:", "@lsp-run:", "@lsp-include:"] {
            let content = format!("# {} utils.R", directive);
            let meta = parse_directives(&content);
            assert_eq!(meta.sources.len(), 1, "Failed for {}", directive);
            assert_eq!(meta.sources[0].path, "utils.R", "Failed for {}", directive);
        }
    }

    #[test]
    fn test_forward_directive_synonyms_with_quotes() {
        for directive in ["@lsp-source", "@lsp-run", "@lsp-include"] {
            let content = format!(r#"# {} "path/to/file.R""#, directive);
            let meta = parse_directives(&content);
            assert_eq!(meta.sources.len(), 1, "Failed for {}", directive);
            assert_eq!(
                meta.sources[0].path, "path/to/file.R",
                "Failed for {}",
                directive
            );
        }
    }

    // Tests for forward directive line=N parameter (regex capture verification)
    #[test]
    fn test_forward_directive_line_param_regex_capture() {
        // Verify the regex correctly captures the line=N parameter
        // The actual parsing of line= is done in task 1.2, but we verify the regex here
        let patterns = patterns();

        // Test with line= parameter
        let line = "# @lsp-source utils.R line=15";
        let caps = patterns.forward.captures(line).expect("Should match");

        // Path should be in group 3 (unquoted)
        assert_eq!(caps.get(3).map(|m| m.as_str()), Some("utils.R"));
        // Line should be in group 4
        assert_eq!(caps.get(4).map(|m| m.as_str()), Some("15"));
    }

    #[test]
    fn test_forward_directive_line_param_regex_capture_all_synonyms() {
        let patterns = patterns();

        for directive in ["@lsp-source", "@lsp-run", "@lsp-include"] {
            let line = format!("# {} utils.R line=42", directive);
            let caps = patterns
                .forward
                .captures(&line)
                .unwrap_or_else(|| panic!("Should match for {}", directive));

            // Path should be in group 3 (unquoted)
            assert_eq!(
                caps.get(3).map(|m| m.as_str()),
                Some("utils.R"),
                "Path failed for {}",
                directive
            );
            // Line should be in group 4
            assert_eq!(
                caps.get(4).map(|m| m.as_str()),
                Some("42"),
                "Line failed for {}",
                directive
            );
        }
    }

    #[test]
    fn test_forward_directive_line_param_regex_capture_with_quotes() {
        let patterns = patterns();

        // Test with double-quoted path and line=
        let line = r#"# @lsp-source "path/to/file.R" line=10"#;
        let caps = patterns.forward.captures(line).expect("Should match");

        // Path should be in group 1 (double-quoted)
        assert_eq!(caps.get(1).map(|m| m.as_str()), Some("path/to/file.R"));
        // Line should be in group 4
        assert_eq!(caps.get(4).map(|m| m.as_str()), Some("10"));
    }

    #[test]
    fn test_forward_directive_line_param_regex_capture_with_colon() {
        let patterns = patterns();

        // Test with colon and line=
        let line = "# @lsp-source: utils.R line=5";
        let caps = patterns.forward.captures(line).expect("Should match");

        // Path should be in group 3 (unquoted)
        assert_eq!(caps.get(3).map(|m| m.as_str()), Some("utils.R"));
        // Line should be in group 4
        assert_eq!(caps.get(4).map(|m| m.as_str()), Some("5"));
    }

    #[test]
    fn test_forward_directive_line_param_regex_capture_without_line() {
        let patterns = patterns();

        // Test without line= parameter (should still match, group 4 should be None)
        let line = "# @lsp-source utils.R";
        let caps = patterns.forward.captures(line).expect("Should match");

        // Path should be in group 3 (unquoted)
        assert_eq!(caps.get(3).map(|m| m.as_str()), Some("utils.R"));
        // Line should be None (not present)
        assert_eq!(caps.get(4), None);
    }

    // Tests for forward directive line=N parameter parsing (Requirements 2.1, 2.2, 2.3, 2.4)
    #[test]
    fn test_forward_directive_line_param_parsing_basic() {
        // Requirement 2.1: Convert from 1-based user input to 0-based internal (N-1)
        let content = "# @lsp-source utils.R line=15";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
        assert_eq!(meta.sources[0].line, 14); // 15 - 1 = 14 (0-based)
        assert_eq!(meta.sources[0].column, 0); // Requirement 2.4: column=0 for directives
        assert!(meta.sources[0].is_directive);
    }

    #[test]
    fn test_forward_directive_line_param_parsing_line_1() {
        // Edge case: line=1 should become 0
        let content = "# @lsp-source utils.R line=1";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].line, 0); // 1 - 1 = 0
        assert!(meta.sources[0].explicit_line);
        assert!(!meta.sources[0].user_line_zero);
    }

    #[test]
    fn test_forward_directive_line_param_parsing_line_0() {
        // Edge case: line=0 is invalid (1-based numbering), should be flagged
        let content = "# @lsp-source utils.R line=0";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].line, 0); // Treated as line 1 (internal 0)
        assert!(meta.sources[0].explicit_line);
        assert!(meta.sources[0].user_line_zero); // Flag that line=0 was specified
        assert_eq!(meta.sources[0].directive_line, 0); // Directive is on line 0
    }

    #[test]
    fn test_forward_directive_without_line_param_uses_directive_line() {
        // Requirement 2.2: Use directive's own line when no line= parameter
        let content = "x <- 1\ny <- 2\n# @lsp-source utils.R\nz <- 3";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
        assert_eq!(meta.sources[0].line, 2); // Directive is on line 2 (0-based)
        assert_eq!(meta.sources[0].column, 0);
    }

    #[test]
    fn test_forward_directive_with_line_eof() {
        let content = "# @lsp-source utils.R line=eof";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
        assert_eq!(meta.sources[0].line, u32::MAX);
        assert!(meta.sources[0].explicit_line);
        assert!(!meta.sources[0].user_line_zero);
    }

    #[test]
    fn test_forward_directive_with_line_end() {
        let content = "# @lsp-source utils.R line=end";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
        assert_eq!(meta.sources[0].line, u32::MAX);
        assert!(meta.sources[0].explicit_line);
        assert!(!meta.sources[0].user_line_zero);
    }

    #[test]
    fn test_forward_directive_line_param_all_synonyms() {
        // Verify line= works with all synonyms
        for directive in ["@lsp-source", "@lsp-run", "@lsp-include"] {
            let content = format!("# {} utils.R line=10", directive);
            let meta = parse_directives(&content);
            assert_eq!(meta.sources.len(), 1, "Failed for {}", directive);
            assert_eq!(
                meta.sources[0].line,
                9, // 10 - 1 = 9 (0-based)
                "Line conversion failed for {}",
                directive
            );
            assert_eq!(
                meta.sources[0].column, 0,
                "Column should be 0 for {}",
                directive
            );
        }
    }

    #[test]
    fn test_forward_directive_line_param_with_quotes() {
        // Test line= with quoted path
        let content = r#"# @lsp-source "path/to/file.R" line=20"#;
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "path/to/file.R");
        assert_eq!(meta.sources[0].line, 19); // 20 - 1 = 19
        assert_eq!(meta.sources[0].column, 0);
    }

    #[test]
    fn test_forward_directive_line_param_with_colon() {
        // Test line= with colon separator
        let content = "# @lsp-source: utils.R line=5";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
        assert_eq!(meta.sources[0].line, 4); // 5 - 1 = 4
    }

    #[test]
    fn test_forward_directive_multiple_with_different_lines() {
        // Requirement 2.3: Multiple directives create separate ForwardSource entries
        let content = "# @lsp-source a.R line=10\n# @lsp-source b.R line=20\n# @lsp-source c.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 3);

        // First directive: explicit line=10 -> 9
        assert_eq!(meta.sources[0].path, "a.R");
        assert_eq!(meta.sources[0].line, 9);

        // Second directive: explicit line=20 -> 19
        assert_eq!(meta.sources[1].path, "b.R");
        assert_eq!(meta.sources[1].line, 19);

        // Third directive: no line=, uses directive's own line (2)
        assert_eq!(meta.sources[2].path, "c.R");
        assert_eq!(meta.sources[2].line, 2);
    }

    #[test]
    fn test_forward_directive_line_param_large_value() {
        // Test with a large line number
        let content = "# @lsp-source utils.R line=1000";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].line, 999); // 1000 - 1 = 999
    }

    #[test]
    fn test_forward_directive_column_always_zero() {
        // Requirement 2.4: column=0 for all directive-based sources
        let content = "    # @lsp-source utils.R line=5"; // Indented directive
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].column, 0); // Column is always 0, not the indentation
    }

    #[test]
    fn test_working_dir_double_quoted_with_spaces() {
        let content = r#"# @lsp-cd "/data/my project""#;
        let meta = parse_directives(content);
        assert_eq!(meta.working_directory, Some("/data/my project".to_string()));
    }

    #[test]
    fn test_working_dir_single_quoted_with_spaces() {
        let content = "# @lsp-wd '/data/my project'";
        let meta = parse_directives(content);
        assert_eq!(meta.working_directory, Some("/data/my project".to_string()));
    }

    // Tests that directives without '@' prefix are NOT recognized
    #[test]
    fn test_backward_directive_no_at_prefix_not_recognized() {
        let content = "# lsp-sourced-by ../main.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 0);
    }

    #[test]
    fn test_backward_directive_no_at_prefix_with_colon_not_recognized() {
        let content = "# lsp-sourced-by: ../main.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 0);
    }

    #[test]
    fn test_backward_directive_no_at_prefix_synonyms_not_recognized() {
        let content = "# lsp-run-by ../main.R\n# lsp-included-by ../other.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 0);
    }

    #[test]
    fn test_forward_directive_no_at_prefix_not_recognized() {
        let content = "# lsp-source utils.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 0);
    }

    #[test]
    fn test_working_dir_no_at_prefix_not_recognized() {
        let content = "# lsp-wd /data/scripts";
        let meta = parse_directives(content);
        assert_eq!(meta.working_directory, None);
    }

    #[test]
    fn test_working_dir_no_at_prefix_synonyms_not_recognized() {
        for directive in [
            "lsp-cd",
            "lsp-working-directory",
            "lsp-working-dir",
            "lsp-current-directory",
            "lsp-current-dir",
        ] {
            let content = format!("# {} /data", directive);
            let meta = parse_directives(&content);
            assert_eq!(
                meta.working_directory, None,
                "Should not recognize {} without @ prefix",
                directive
            );
        }
    }

    #[test]
    fn test_ignore_directive_no_at_prefix_not_recognized() {
        let content = "x <- 1\n# lsp-ignore\ny <- undefined";
        let meta = parse_directives(content);
        assert!(!meta.ignored_lines.contains_key(&1));
    }

    #[test]
    fn test_ignore_next_directive_no_at_prefix_not_recognized() {
        let content = "# lsp-ignore-next\ny <- undefined";
        let meta = parse_directives(content);
        assert!(!meta.ignored_next_lines.contains_key(&1));
    }

    // ============================================================================
    // Tests for start-of-line anchoring
    // Directives (except @lsp-ignore) must appear at the start of a line,
    // not as trailing comments.
    // ============================================================================

    #[test]
    fn test_trailing_comment_backward_not_recognized() {
        let content = r#"x <- 1 # @lsp-sourced-by ../main.R"#;
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 0);
    }

    #[test]
    fn test_trailing_comment_forward_not_recognized() {
        let content = "x <- 1 # @lsp-source utils.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 0);
    }

    #[test]
    fn test_trailing_comment_working_dir_not_recognized() {
        let content = "x <- 1 # @lsp-cd /data";
        let meta = parse_directives(content);
        assert_eq!(meta.working_directory, None);
    }

    #[test]
    fn test_trailing_comment_ignore_next_not_recognized() {
        let content = "x <- 1 # @lsp-ignore-next\ny <- undefined";
        let meta = parse_directives(content);
        assert!(!meta.ignored_next_lines.contains_key(&1));
    }

    #[test]
    fn test_trailing_comment_declare_var_not_recognized() {
        let content = "x <- 1 # @lsp-var myvar";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 0);
    }

    #[test]
    fn test_trailing_comment_declare_func_not_recognized() {
        let content = "x <- 1 # @lsp-func myfunc";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 0);
    }

    #[test]
    fn test_trailing_comment_ignore_is_recognized() {
        // @lsp-ignore is the exception: it works as a trailing comment
        // so you can write `x <- foo # @lsp-ignore` to suppress diagnostics on that line
        let content = "x <- foo # @lsp-ignore";
        let meta = parse_directives(content);
        assert!(meta.ignored_lines.contains_key(&0));
    }

    #[test]
    fn test_indented_directive_recognized() {
        // Directives with leading whitespace (indented code) should still work
        let content = "    # @lsp-source utils.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
    }

    // ============================================================================
    // Tests for header-only constraint
    // Backward directives and @lsp-cd must appear in the file header (before
    // any code). Forward, declaration, and ignore directives work anywhere.
    // ============================================================================

    #[test]
    fn test_backward_after_code_not_recognized() {
        let content = "x <- 1\n# @lsp-sourced-by ../main.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 0);
        assert_eq!(
            meta.sources.len(),
            0,
            "backward directive must not be misinterpreted as forward"
        );
    }

    #[test]
    fn test_working_dir_after_code_not_recognized() {
        let content = "x <- 1\n# @lsp-cd /data";
        let meta = parse_directives(content);
        assert_eq!(meta.working_directory, None);
    }

    #[test]
    fn test_backward_in_header_with_blanks_and_comments() {
        // Header can contain blank lines and comments before the directive
        let content = "\n# some comment\n\n# @lsp-sourced-by ../main.R\nx <- 1";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
    }

    #[test]
    fn test_working_dir_in_header_recognized() {
        let content = "# @lsp-cd /data\nx <- 1";
        let meta = parse_directives(content);
        assert_eq!(meta.working_directory, Some("/data".to_string()));
    }

    #[test]
    fn test_forward_after_code_still_recognized() {
        let content = "x <- 1\n# @lsp-source utils.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
    }

    #[test]
    fn test_declaration_after_code_still_recognized() {
        let content = "x <- 1\n# @lsp-var myvar";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 1);
        assert_eq!(meta.declared_variables[0].name, "myvar");
    }

    #[test]
    fn test_ignore_after_code_still_recognized() {
        let content = "x <- 1\n# @lsp-ignore\ny <- undefined";
        let meta = parse_directives(content);
        assert!(meta.ignored_lines.contains_key(&1));
    }

    #[test]
    fn test_backward_and_forward_mixed_header() {
        // Backward in header, forward after code — both recognized appropriately
        let content = "# @lsp-sourced-by ../main.R\nx <- 1\n# @lsp-source helpers.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sources.len(), 1);
    }

    #[test]
    fn test_backward_after_blank_line_before_code_recognized() {
        // Blank lines don't end the header
        let content = "\n\n# @lsp-sourced-by ../main.R\n\nx <- 1";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
    }

    // ============================================================================
    // Tests for declaration directives (@lsp-var, @lsp-func, etc.)
    // Requirements: 1.1-1.6, 2.1-2.6, 3.4
    // ============================================================================

    // Variable declaration directive tests
    #[test]
    fn test_declare_var_basic() {
        let content = "# @lsp-var myvar";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 1);
        assert_eq!(meta.declared_variables[0].name, "myvar");
        assert_eq!(meta.declared_variables[0].line, 0);
        assert!(!meta.declared_variables[0].is_function);
    }

    #[test]
    fn test_declare_var_with_colon() {
        let content = "# @lsp-var: myvar";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 1);
        assert_eq!(meta.declared_variables[0].name, "myvar");
    }

    #[test]
    fn test_declare_var_double_quoted() {
        let content = r#"# @lsp-var "my.var""#;
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 1);
        assert_eq!(meta.declared_variables[0].name, "my.var");
    }

    #[test]
    fn test_declare_var_single_quoted() {
        let content = "# @lsp-var 'my.var'";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 1);
        assert_eq!(meta.declared_variables[0].name, "my.var");
    }

    #[test]
    fn test_declare_var_all_synonyms() {
        // Test all 4 synonym forms: @lsp-declare-variable, @lsp-declare-var, @lsp-variable, @lsp-var
        for directive in [
            "@lsp-declare-variable",
            "@lsp-declare-var",
            "@lsp-variable",
            "@lsp-var",
        ] {
            let content = format!("# {} myvar", directive);
            let meta = parse_directives(&content);
            assert_eq!(meta.declared_variables.len(), 1, "Failed for {}", directive);
            assert_eq!(
                meta.declared_variables[0].name, "myvar",
                "Failed for {}",
                directive
            );
            assert!(
                !meta.declared_variables[0].is_function,
                "Should be variable for {}",
                directive
            );
        }
    }

    #[test]
    fn test_declare_var_line_number_recorded() {
        let content = "x <- 1\ny <- 2\n# @lsp-var myvar\nz <- 3";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 1);
        assert_eq!(meta.declared_variables[0].line, 2); // 0-based line number
    }

    #[test]
    fn test_declare_var_multiple() {
        let content = "# @lsp-var var1\n# @lsp-var var2\n# @lsp-var var3";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 3);
        assert_eq!(meta.declared_variables[0].name, "var1");
        assert_eq!(meta.declared_variables[0].line, 0);
        assert_eq!(meta.declared_variables[1].name, "var2");
        assert_eq!(meta.declared_variables[1].line, 1);
        assert_eq!(meta.declared_variables[2].name, "var3");
        assert_eq!(meta.declared_variables[2].line, 2);
    }

    #[test]
    fn test_declare_var_with_special_chars_quoted() {
        // R allows special characters in symbol names when quoted
        let content = r#"# @lsp-var "my.special_var""#;
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 1);
        assert_eq!(meta.declared_variables[0].name, "my.special_var");
    }

    #[test]
    fn test_declare_var_no_at_prefix_not_recognized() {
        // Requirement 1.6: Directives without @ prefix should NOT be recognized
        let content = "# lsp-var myvar";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 0);
    }

    // Function declaration directive tests
    #[test]
    fn test_declare_func_basic() {
        let content = "# @lsp-func myfunc";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 1);
        assert_eq!(meta.declared_functions[0].name, "myfunc");
        assert_eq!(meta.declared_functions[0].line, 0);
        assert!(meta.declared_functions[0].is_function);
    }

    #[test]
    fn test_declare_func_with_colon() {
        let content = "# @lsp-func: myfunc";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 1);
        assert_eq!(meta.declared_functions[0].name, "myfunc");
    }

    #[test]
    fn test_declare_func_double_quoted() {
        let content = r#"# @lsp-func "my.func""#;
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 1);
        assert_eq!(meta.declared_functions[0].name, "my.func");
    }

    #[test]
    fn test_declare_func_single_quoted() {
        let content = "# @lsp-func 'my.func'";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 1);
        assert_eq!(meta.declared_functions[0].name, "my.func");
    }

    #[test]
    fn test_declare_func_all_synonyms() {
        // Test all 4 synonym forms: @lsp-declare-function, @lsp-declare-func, @lsp-function, @lsp-func
        for directive in [
            "@lsp-declare-function",
            "@lsp-declare-func",
            "@lsp-function",
            "@lsp-func",
        ] {
            let content = format!("# {} myfunc", directive);
            let meta = parse_directives(&content);
            assert_eq!(meta.declared_functions.len(), 1, "Failed for {}", directive);
            assert_eq!(
                meta.declared_functions[0].name, "myfunc",
                "Failed for {}",
                directive
            );
            assert!(
                meta.declared_functions[0].is_function,
                "Should be function for {}",
                directive
            );
        }
    }

    #[test]
    fn test_declare_func_line_number_recorded() {
        let content = "x <- 1\ny <- 2\n# @lsp-func myfunc\nz <- 3";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 1);
        assert_eq!(meta.declared_functions[0].line, 2); // 0-based line number
    }

    #[test]
    fn test_declare_func_multiple() {
        let content = "# @lsp-func func1\n# @lsp-func func2\n# @lsp-func func3";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 3);
        assert_eq!(meta.declared_functions[0].name, "func1");
        assert_eq!(meta.declared_functions[0].line, 0);
        assert_eq!(meta.declared_functions[1].name, "func2");
        assert_eq!(meta.declared_functions[1].line, 1);
        assert_eq!(meta.declared_functions[2].name, "func3");
        assert_eq!(meta.declared_functions[2].line, 2);
    }

    #[test]
    fn test_declare_func_with_special_chars_quoted() {
        // R allows special characters in symbol names when quoted
        let content = r#"# @lsp-func "my.special_func""#;
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 1);
        assert_eq!(meta.declared_functions[0].name, "my.special_func");
    }

    #[test]
    fn test_declare_func_no_at_prefix_not_recognized() {
        // Requirement 2.6: Directives without @ prefix should NOT be recognized
        let content = "# lsp-func myfunc";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 0);
    }

    // Mixed declaration tests
    #[test]
    fn test_declare_mixed_vars_and_funcs() {
        let content = "# @lsp-var myvar\n# @lsp-func myfunc\n# @lsp-variable another_var\n# @lsp-function another_func";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 2);
        assert_eq!(meta.declared_functions.len(), 2);
        assert_eq!(meta.declared_variables[0].name, "myvar");
        assert_eq!(meta.declared_variables[1].name, "another_var");
        assert_eq!(meta.declared_functions[0].name, "myfunc");
        assert_eq!(meta.declared_functions[1].name, "another_func");
    }

    #[test]
    fn test_declare_with_other_directives() {
        let content = r#"# @lsp-sourced-by ../main.R
# @lsp-var myvar
# @lsp-cd /data
# @lsp-func myfunc
# @lsp-ignore"#;
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.declared_variables.len(), 1);
        assert_eq!(meta.declared_functions.len(), 1);
        assert_eq!(meta.working_directory, Some("/data".to_string()));
        assert!(meta.ignored_lines.contains_key(&4));
    }

    // Edge cases
    #[test]
    fn test_declare_var_empty_name_skipped() {
        // Empty symbol names should be skipped
        let content = "# @lsp-var ";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 0);
    }

    #[test]
    fn test_declare_func_empty_name_skipped() {
        // Empty symbol names should be skipped
        let content = "# @lsp-func ";
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 0);
    }

    #[test]
    fn test_declare_var_whitespace_only_quoted_skipped() {
        // Whitespace-only quoted names should be skipped
        let content = r#"# @lsp-var "   ""#;
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 0);
    }

    #[test]
    fn test_declare_func_whitespace_only_quoted_skipped() {
        // Whitespace-only quoted names should be skipped
        let content = r#"# @lsp-func "   ""#;
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 0);
    }

    #[test]
    fn test_declare_var_colon_and_quotes() {
        let content = r#"# @lsp-var: "my.var""#;
        let meta = parse_directives(content);
        assert_eq!(meta.declared_variables.len(), 1);
        assert_eq!(meta.declared_variables[0].name, "my.var");
    }

    #[test]
    fn test_declare_func_colon_and_quotes() {
        let content = r#"# @lsp-func: "my.func""#;
        let meta = parse_directives(content);
        assert_eq!(meta.declared_functions.len(), 1);
        assert_eq!(meta.declared_functions[0].name, "my.func");
    }

    // Issue #346: a raw leading U+FEFF (BOM) in in-memory text must not hide a
    // first-line directive. tree-sitter-r skips the BOM as whitespace, but
    // Rust's `\s`/`str::trim` follow Unicode `White_Space`, which excludes
    // U+FEFF, so the column-0 scan anchor here would otherwise miss the `#`.
    #[test]
    fn bom_prefixed_forward_directive_on_first_line_parses() {
        let content = "\u{FEFF}# @lsp-source utils.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
        assert_eq!(meta.sources[0].directive_line, 0);
    }

    #[test]
    fn bom_prefixed_backward_directive_on_first_line_parses() {
        let content = "\u{FEFF}# @lsp-sourced-by ../main.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
        assert_eq!(meta.sourced_by[0].call_site, CallSiteSpec::Default);
    }

    #[test]
    fn bom_on_first_line_does_not_prematurely_end_header() {
        // The BOM-prefixed first comment line must still count as header, so a
        // backward directive on the next line is still recognised.
        let content = "\u{FEFF}# a header comment\n# @lsp-sourced-by ../main.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
    }
}
