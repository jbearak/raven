//! Namespace parsing for R package mode.
//!
//! Package-mode activation is derived in `package_state`: `Auto` mode requires
//! a workspace root plus a DESCRIPTION `Package:` field, `Enabled` mode allows
//! a workspace root without DESCRIPTION metadata, and `Disabled` mode never
//! activates package semantics. Roxygen tags are not an activation heuristic.
//! When package mode is active, namespace data is merged from NAMESPACE and
//! roxygen tags on source files so both generated and hand-written namespace
//! declarations contribute to diagnostic suppression and completion.

use std::collections::HashSet;
use std::path::PathBuf;

/// Metadata about the detected R package workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageWorkspace {
    /// Package name from DESCRIPTION `Package:` field.
    pub name: String,
    /// Absolute path to the workspace root (where DESCRIPTION lives).
    pub root: PathBuf,
}

/// Unified namespace model for an R package.
///
/// Built by reconciling the NAMESPACE file with roxygen namespace tags from
/// package source files. Duplicate imports are deduplicated during the merge,
/// while exports naturally collapse through the `HashSet`. Used to determine
/// which symbols the package exports and which external package symbols are
/// available without qualification.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackageNamespaceModel {
    /// Symbols this package exports (for informational purposes; mutual
    /// visibility means ALL top-level symbols are visible internally regardless).
    pub exports: HashSet<String>,
    /// `importFrom(pkg, sym)` pairs — only these specific symbols are available.
    pub imports: Vec<(String, String)>,
    /// Packages imported wholesale via `import(pkg)` — all their exports are available.
    pub full_imports: Vec<String>,
}

/// Parse NAMESPACE content into a `PackageNamespaceModel`.
pub fn namespace_model_from_content(content: &str) -> PackageNamespaceModel {
    let mut model = PackageNamespaceModel::default();
    // Normalize multiline directives (join lines ending with incomplete parens)
    let normalized = normalize_multiline(content);

    for line in normalized.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(args) = strip_directive(line, "export") {
            for name in split_args(args) {
                let name = unquote(name);
                if !name.is_empty() {
                    model.exports.insert(name);
                }
            }
        } else if let Some(args) = strip_directive(line, "exportPattern") {
            // Store pattern exports as-is (informational)
            for pat in split_args(args) {
                if !pat.is_empty() {
                    model.exports.insert(format!("__PATTERN__:{}", pat));
                }
            }
        } else if let Some(args) = strip_directive(line, "S3method") {
            let parts: Vec<&str> = split_args(args).collect();
            if parts.len() >= 2 {
                let generic = unquote(parts[0]);
                let class = unquote(parts[1]);
                model.exports.insert(format!("{}.{}", generic, class));
            }
        } else if let Some(args) = strip_directive(line, "importFrom") {
            let parts: Vec<&str> = split_args(args).collect();
            if parts.len() >= 2 {
                let pkg = unquote(parts[0]);
                for sym in &parts[1..] {
                    let sym = unquote(sym);
                    if !sym.is_empty() {
                        model.imports.push((pkg.clone(), sym));
                    }
                }
            }
        } else if let Some(args) = strip_directive(line, "importClassesFrom")
            .or_else(|| strip_directive(line, "importMethodsFrom"))
        {
            // S4 class / method imports — treated identically to `importFrom`
            // for diagnostic suppression and completion. Affects S4-heavy
            // packages (Matrix, methods, Biobase, most of Bioconductor).
            let parts: Vec<&str> = split_args(args).collect();
            if parts.len() >= 2 {
                let pkg = unquote(parts[0]);
                for sym in &parts[1..] {
                    let sym = unquote(sym);
                    if !sym.is_empty() {
                        model.imports.push((pkg.clone(), sym));
                    }
                }
            }
        } else if let Some(args) = strip_directive(line, "import") {
            for pkg in split_args(args) {
                let pkg = unquote(pkg);
                if !pkg.is_empty() {
                    model.full_imports.push(pkg);
                }
            }
        }
    }
    model
}

// --- helpers ---

/// Parse a DCF field value from DESCRIPTION content. Public for use by scan_workspace.
pub fn parse_dcf_field_pub(content: &str, field: &str) -> Option<String> {
    parse_dcf_field(content, field)
}

fn parse_dcf_field(content: &str, field: &str) -> Option<String> {
    let prefix = format!("{}:", field);
    let mut lines = content.lines();
    while let Some(line) = lines.next() {
        if let Some(rest) = line.strip_prefix(&prefix) {
            // Collect the value, including any continuation lines (leading whitespace).
            let mut val = rest.trim().to_string();
            for cont in lines.by_ref() {
                if cont.starts_with(' ') || cont.starts_with('\t') {
                    let trimmed = cont.trim();
                    if trimmed == "." {
                        // DCF uses a lone "." for blank paragraph separators; skip.
                        continue;
                    }
                    if val.is_empty() {
                        val = trimmed.to_string();
                    } else {
                        val.push(' ');
                        val.push_str(trimmed);
                    }
                } else {
                    break;
                }
            }
            if !val.is_empty() {
                return Some(val);
            }
        }
    }
    None
}

fn count_unquoted_parens(s: &str) -> (usize, usize) {
    let mut open = 0usize;
    let mut close = 0usize;
    let mut in_quote: Option<char> = None;
    let mut escape_next = false;
    for c in s.chars() {
        if escape_next {
            escape_next = false;
            continue;
        }
        match in_quote {
            // Backtick-quoted names don't support escape sequences in R
            Some('`') if c == '`' => {
                in_quote = None;
            }
            Some('`') => {}
            Some(_) if c == '\\' => {
                escape_next = true;
            }
            Some(q) if c == q => {
                in_quote = None;
            }
            Some(_) => {}
            None => match c {
                '"' | '\'' | '`' => {
                    in_quote = Some(c);
                }
                '(' => {
                    open += 1;
                }
                ')' => {
                    close += 1;
                }
                _ => {}
            },
        }
    }
    (open, close)
}

fn normalize_multiline(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut depth: usize = 0; // cumulative unbalanced open-paren depth
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if depth > 0 {
                // Inside unbalanced parens — skip blank line
                continue;
            }
            out.push('\n');
            continue;
        }
        // Strip trailing comments (# not inside quotes)
        let effective = strip_trailing_comment(trimmed);
        let effective = effective.trim();
        if effective.is_empty() || effective.starts_with('#') {
            if depth > 0 {
                // Inside unbalanced parens — skip comment line entirely
                continue;
            }
            out.push_str(trimmed);
            out.push('\n');
            continue;
        }
        // If we're inside unbalanced parens, join to previous line
        if depth > 0 {
            // Remove trailing newline and append this line
            if out.ends_with('\n') {
                out.pop();
            }
            out.push_str(effective);
            out.push('\n');
        } else {
            out.push_str(effective);
            out.push('\n');
        }
        // Update depth from the current accumulated last line
        let last_line_start = out[..out.len() - 1].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let last_line = &out[last_line_start..out.len() - 1];
        let (open, close) = count_unquoted_parens(last_line);
        depth = open.saturating_sub(close);
    }
    out
}

/// Strip trailing `# comment` from a NAMESPACE line, respecting quoted strings.
///
/// Backticks open/close a non-syntactic-identifier literal (e.g., `` `%>%` ``)
/// and R does NOT recognize `\` as an escape inside them — mirrors the
/// backtick handling in `count_unquoted_parens` and R's own parser, and
/// prevents `#` inside a backtick-quoted name from being mistaken for a
/// comment start.
fn strip_trailing_comment(line: &str) -> &str {
    let mut in_quote: Option<char> = None;
    let mut escape_next = false;
    for (i, c) in line.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }
        match in_quote {
            // Backticks don't honor `\` escapes in R.
            Some('`') if c == '`' => {
                in_quote = None;
            }
            Some('`') => {}
            Some(_) if c == '\\' => {
                escape_next = true;
            }
            Some(q) if c == q => {
                in_quote = None;
            }
            Some(_) => {}
            None => match c {
                '"' | '\'' | '`' => {
                    in_quote = Some(c);
                }
                '#' => return line[..i].trim_end(),
                _ => {}
            },
        }
    }
    line
}

fn strip_directive<'a>(line: &'a str, directive: &str) -> Option<&'a str> {
    let prefix = format!("{}(", directive);
    if line.starts_with(&prefix) && line.ends_with(')') {
        Some(&line[prefix.len()..line.len() - 1])
    } else {
        None
    }
}

fn split_args(args: &str) -> impl Iterator<Item = &str> {
    SplitArgs { s: args, pos: 0 }
}

/// Iterator that splits on commas outside of quoted strings.
struct SplitArgs<'a> {
    s: &'a str,
    pos: usize,
}

impl<'a> Iterator for SplitArgs<'a> {
    type Item = &'a str;
    fn next(&mut self) -> Option<Self::Item> {
        if self.pos > self.s.len() {
            return None;
        }
        let bytes = self.s.as_bytes();
        let start = self.pos;
        let mut i = start;
        let mut in_quote: Option<u8> = None;
        while i < bytes.len() {
            let b = bytes[i];
            match in_quote {
                Some(_q) if b == b'\\' => {
                    // Skip escaped char; guard against trailing backslash
                    // at end of input to avoid out-of-bounds access.
                    if i + 1 < bytes.len() {
                        i += 1;
                    }
                }
                Some(q) if b == q => {
                    in_quote = None;
                }
                Some(_) => {}
                None => match b {
                    b'"' | b'\'' => {
                        in_quote = Some(b);
                    }
                    b',' => {
                        let item = self.s[start..i].trim();
                        self.pos = i + 1;
                        return Some(item);
                    }
                    _ => {}
                },
            }
            i += 1;
        }
        self.pos = i + 1; // past end to signal done
        Some(self.s[start..i].trim())
    }
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 {
        // Handle ASCII double-, single-, and backtick-quoted names.
        // Backticks are used for non-syntactic identifiers like `%>%` or
        // `+.myclass` in NAMESPACE directives, e.g.
        // `importFrom(magrittr, `%>%`)` — without stripping, the stored
        // name would retain the backticks and fail to match bare tree-sitter
        // identifiers.
        let bytes = s.as_bytes();
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"')
            || (first == b'\'' && last == b'\'')
            || (first == b'`' && last == b'`')
        {
            return s[1..s.len() - 1].to_string();
        }
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_model_from_content_basic() {
        let content = r#"
export(foo)
export(bar, baz)
importFrom(dplyr, mutate, filter)
import(ggplot2)
S3method(print, myclass)
"#;
        let model = namespace_model_from_content(content);
        assert!(model.exports.contains("foo"));
        assert!(model.exports.contains("bar"));
        assert!(model.exports.contains("baz"));
        assert!(model.exports.contains("print.myclass"));
        assert_eq!(model.imports.len(), 2);
        assert!(model.imports.contains(&("dplyr".into(), "mutate".into())));
        assert!(model.imports.contains(&("dplyr".into(), "filter".into())));
        assert_eq!(model.full_imports, vec!["ggplot2"]);
    }

    #[test]
    fn namespace_model_from_content_multiline() {
        let content = "importFrom(dplyr,\n  mutate,\n  filter)\nexport(foo)\n";
        let model = namespace_model_from_content(content);
        assert!(model.imports.contains(&("dplyr".into(), "mutate".into())));
        assert!(model.imports.contains(&("dplyr".into(), "filter".into())));
        assert!(model.exports.contains("foo"));
    }

    #[test]
    fn namespace_trailing_comment() {
        let content = "importFrom(dplyr, mutate) # pipe-friendly\nexport(foo)\n";
        let model = namespace_model_from_content(content);
        assert!(model.imports.contains(&("dplyr".into(), "mutate".into())));
        assert!(model.exports.contains("foo"));
    }

    #[test]
    fn namespace_multiline_with_comment() {
        let content = "importFrom(dplyr,\n  # the main verb\n  mutate,\n  filter)\n";
        let model = namespace_model_from_content(content);
        assert!(model.imports.contains(&("dplyr".into(), "mutate".into())));
        assert!(model.imports.contains(&("dplyr".into(), "filter".into())));
    }

    #[test]
    fn normalize_multiline_quoted_parens() {
        let content = "exportPattern(\"^[^(]\")\nexport(foo)\n";
        let normalized = normalize_multiline(content);
        assert_eq!(normalized, "exportPattern(\"^[^(]\")\nexport(foo)\n");
    }

    #[test]
    fn strip_trailing_comment_respects_quoted_hash() {
        // # inside a quoted string should NOT be treated as a comment
        assert_eq!(
            strip_trailing_comment(r#"exportPattern("^[^#].*")"#),
            r#"exportPattern("^[^#].*")"#
        );
        assert_eq!(
            strip_trailing_comment(r#"export(foo) # comment"#),
            "export(foo)"
        );
        assert_eq!(
            strip_trailing_comment(r#"export("a#b")"#),
            r#"export("a#b")"#
        );
        // Single-quoted
        assert_eq!(strip_trailing_comment("export('a#b')"), "export('a#b')");
    }

    #[test]
    fn namespace_export_pattern_with_hash_in_regex() {
        // exportPattern with # in the regex should parse correctly
        let content = "exportPattern(\"^[^#].*\")\nexport(foo)\n";
        let model = namespace_model_from_content(content);
        assert!(model.exports.contains("__PATTERN__:\"^[^#].*\""));
        assert!(model.exports.contains("foo"));
    }

    #[test]
    fn namespace_export_unquotes_names() {
        // export() with quoted names should strip quotes
        let content = "export(\"%>%\")\nexport('my_func')\nexport(plain)\n";
        let model = namespace_model_from_content(content);
        assert!(
            model.exports.contains("%>%"),
            "should unquote double-quoted export"
        );
        assert!(
            model.exports.contains("my_func"),
            "should unquote single-quoted export"
        );
        assert!(
            model.exports.contains("plain"),
            "should keep unquoted export"
        );
        assert!(
            !model.exports.contains("\"%>%\""),
            "should NOT contain quoted form"
        );
    }

    #[test]
    fn namespace_s3method_unquotes_names() {
        // S3method() with quoted generic/class should strip quotes
        let content = "S3method(\"[\", myclass)\nS3method(print, \"my.class\")\n";
        let model = namespace_model_from_content(content);
        assert!(
            model.exports.contains("[.myclass"),
            "should unquote generic in S3method"
        );
        assert!(
            model.exports.contains("print.my.class"),
            "should unquote class in S3method"
        );
    }

    #[test]
    fn namespace_multiline_with_blank_line() {
        // Blank lines inside a multiline directive should not break joining
        let content = "importFrom(dplyr,\n\n  mutate,\n  filter)\nexport(foo)\n";
        let model = namespace_model_from_content(content);
        assert!(
            model.imports.contains(&("dplyr".into(), "mutate".into())),
            "blank line inside multiline directive should not break parsing"
        );
        assert!(model.imports.contains(&("dplyr".into(), "filter".into())));
        assert!(model.exports.contains("foo"));
    }

    #[test]
    fn namespace_multiline_with_multiple_blank_lines() {
        // Multiple blank lines inside a multiline directive
        let content = "importFrom(dplyr,\n\n\n  mutate)\n";
        let model = namespace_model_from_content(content);
        assert!(model.imports.contains(&("dplyr".into(), "mutate".into())));
    }

    #[test]
    fn parse_dcf_field_simple() {
        let content = "Package: mypkg\nVersion: 1.0.0\n";
        assert_eq!(parse_dcf_field(content, "Package"), Some("mypkg".into()));
        assert_eq!(parse_dcf_field(content, "Version"), Some("1.0.0".into()));
    }

    #[test]
    fn parse_dcf_field_continuation_lines() {
        // Value entirely on continuation line
        let content = "Title:\n    My Package Title\nVersion: 1.0.0\n";
        assert_eq!(
            parse_dcf_field(content, "Title"),
            Some("My Package Title".into())
        );
    }

    #[test]
    fn parse_dcf_field_multiline_value() {
        // Value split across multiple continuation lines
        let content =
            "Description: A package\n    that does things\n    and more things\nVersion: 1.0.0\n";
        assert_eq!(
            parse_dcf_field(content, "Description"),
            Some("A package that does things and more things".into())
        );
    }

    #[test]
    fn parse_dcf_field_tab_continuation() {
        let content = "Title:\n\tMy Package\nVersion: 1.0.0\n";
        assert_eq!(parse_dcf_field(content, "Title"), Some("My Package".into()));
    }

    #[test]
    fn split_args_respects_quoted_commas() {
        // Comma inside quotes should NOT split
        let args = r#""a,b", foo, "c,d""#;
        let result: Vec<&str> = split_args(args).collect();
        assert_eq!(result, vec![r#""a,b""#, "foo", r#""c,d""#]);
    }

    #[test]
    fn split_args_respects_escaped_quotes() {
        // Escaped quote inside a string should not end the string
        let args = r#""foo\"bar", baz"#;
        let result: Vec<&str> = split_args(args).collect();
        assert_eq!(result, vec![r#""foo\"bar""#, "baz"]);
    }

    #[test]
    fn count_unquoted_parens_handles_escaped_quotes() {
        // Escaped quote should not exit quote mode
        assert_eq!(count_unquoted_parens(r#""foo\")" bar"#), (0, 0));
        // Unescaped paren outside quotes
        assert_eq!(count_unquoted_parens(r#""foo" (bar)"#), (1, 1));
    }

    #[test]
    fn count_unquoted_parens_handles_backtick_quoted() {
        // Parens inside backtick-quoted names should not be counted
        assert_eq!(count_unquoted_parens("`foo(`"), (0, 0));
        assert_eq!(count_unquoted_parens("`[<-(`"), (0, 0));
        // Backtick-quoted name followed by real paren
        assert_eq!(count_unquoted_parens("export(`foo(`, bar)"), (1, 1));
    }

    #[test]
    fn strip_trailing_comment_handles_escaped_quotes() {
        // Escaped quote inside string should not end the string
        assert_eq!(
            strip_trailing_comment(r#"export("a\"b") # comment"#),
            r#"export("a\"b")"#
        );
    }

    #[test]
    fn split_args_trailing_backslash_no_panic() {
        // Trailing backslash inside an unterminated quote must not panic
        let args = r#""foo\"#;
        let result: Vec<&str> = split_args(args).collect();
        assert_eq!(result, vec![r#""foo\"#]);
    }

    #[test]
    fn split_args_trailing_backslash_in_terminated_quote() {
        // Backslash as last char of a terminated quoted string (edge case)
        let args = r#""foo\\", bar"#;
        let result: Vec<&str> = split_args(args).collect();
        assert_eq!(result, vec![r#""foo\\""#, "bar"]);
    }

    #[test]
    fn namespace_model_quoted_comma_in_export() {
        // An export with a comma in the quoted name should parse as one symbol
        let content = "export(\"a,b\")\nexport(foo)\n";
        let model = namespace_model_from_content(content);
        assert!(
            model.exports.contains("a,b"),
            "quoted comma should not split"
        );
        assert!(model.exports.contains("foo"));
        assert_eq!(model.exports.len(), 2);
    }

    #[test]
    #[allow(non_snake_case)]
    fn namespace_model_importClassesFrom_adds_to_imports() {
        // S4 class imports are semantically equivalent to `importFrom` for
        // diagnostic suppression and completion. Without this, S4-heavy
        // packages (Matrix, methods, Bioconductor) get false-positive
        // undefined-variable diagnostics for their imported classes.
        let content = "importClassesFrom(Matrix, dgCMatrix, dgTMatrix)\n";
        let model = namespace_model_from_content(content);
        assert!(
            model
                .imports
                .contains(&("Matrix".to_string(), "dgCMatrix".to_string())),
            "importClassesFrom must populate imports: {:?}",
            model.imports,
        );
        assert!(
            model
                .imports
                .contains(&("Matrix".to_string(), "dgTMatrix".to_string())),
            "multiple class args must all be added: {:?}",
            model.imports,
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn namespace_model_importMethodsFrom_adds_to_imports() {
        // S4 method imports — same treatment as importFrom.
        let content = "importMethodsFrom(methods, show, initialize)\n";
        let model = namespace_model_from_content(content);
        assert!(
            model
                .imports
                .contains(&("methods".to_string(), "show".to_string())),
            "importMethodsFrom must populate imports: {:?}",
            model.imports,
        );
        assert!(
            model
                .imports
                .contains(&("methods".to_string(), "initialize".to_string())),
            "multiple method args must all be added: {:?}",
            model.imports,
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn namespace_model_importFrom_backtick_quoted_symbol() {
        // Non-syntactic names in NAMESPACE are typically backtick-quoted,
        // e.g. `importFrom(magrittr, \`%>%\`)`. Previously the backticks were
        // retained in the imported symbol key, causing the stored name
        // (`\`%>%\``) to never match the bare tree-sitter identifier (`%>%`).
        let content = "importFrom(magrittr, `%>%`)\n";
        let model = namespace_model_from_content(content);
        assert!(
            model
                .imports
                .contains(&("magrittr".to_string(), "%>%".to_string())),
            "backtick-quoted `%>%` must be unquoted in imports: {:?}",
            model.imports,
        );
    }

    #[test]
    fn strip_trailing_comment_handles_backtick_hash() {
        // Backtick-quoted names may contain `#`. Without backtick tracking,
        // the comment scanner truncates `export(\`%#%\`)` to `export(\`%`,
        // which then fails `strip_directive` and silently drops the export,
        // and also leaves `normalize_multiline`'s paren counter unbalanced.
        assert_eq!(
            strip_trailing_comment("export(`%#%`) # op export"),
            "export(`%#%`)"
        );
        assert_eq!(strip_trailing_comment("export(`%#%`)"), "export(`%#%`)");
    }

    #[test]
    fn namespace_model_backtick_name_with_hash_not_dropped() {
        // End-to-end: a backtick-quoted name containing `#` must round-trip
        // through the parser without being lost to the comment scanner.
        let content = "export(`%#%`)\nexport(foo)\n";
        let model = namespace_model_from_content(content);
        assert!(
            model.exports.contains("%#%"),
            "backtick-quoted `%#%` must survive parse: {:?}",
            model.exports,
        );
        assert!(model.exports.contains("foo"));
    }
}
