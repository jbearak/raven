//! `.lintr` subset reader.
//!
//! `.lintr` is a DCF (Debian Control Format)-style file. Each field begins
//! with `Name:` at column zero; lines that begin with whitespace continue
//! the previous field's value. This reader:
//!
//! 1. Folds continuation lines into per-field values.
//! 2. Token-scans the folded `linters:` and `exclusions:` values, looking
//!    for the documented forms in `docs/linting.md`.
//!
//! Unrecognized linters log warnings; the rest of the file still applies.

use std::path::Path;

use serde_json::{Value, json};

pub struct LoadedLintr {
    pub settings: Value,
    pub warnings: Vec<String>,
}

pub fn load(path: &Path) -> Option<LoadedLintr> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            log::warn!(".lintr: cannot read {}: {}", path.display(), e);
            return None;
        }
    };
    Some(load_str(&text))
}

pub fn load_str(text: &str) -> LoadedLintr {
    let mut warnings = Vec::new();
    let fields = dcf_fold(text);
    let mut linting = serde_json::Map::new();
    let mut overrides: Vec<Value> = Vec::new();
    let mut unrecognized_constructs = 0usize;
    // Whether the file contained a recognized linting-config field (`linters:`
    // or `exclusions:`). This is the "expresses linting intent" signal that
    // gates auto-enable: a recognized field is present even for
    // `linters_with_defaults()`, which sets no individual keys, but NOT for a
    // blank/whitespace-only file or one with only unknown fields.
    let mut expresses_config = false;

    for (key, value) in fields {
        match key.as_str() {
            "linters" => {
                expresses_config = true;
                apply_linters(
                    &value,
                    &mut linting,
                    &mut warnings,
                    &mut unrecognized_constructs,
                );
            }
            "exclusions" => {
                expresses_config = true;
                apply_exclusions(&value, &mut overrides, &mut unrecognized_constructs);
            }
            other => {
                warnings.push(format!(".lintr: unknown field '{}'; ignoring", other));
            }
        }
    }
    if unrecognized_constructs > 0 {
        warnings.push(format!(
            ".lintr: ignoring {} unrecognized construct(s); see docs/linting.md for the supported subset",
            unrecognized_constructs
        ));
    }
    if !overrides.is_empty() {
        linting.insert("overrides".into(), Value::Array(overrides));
    }
    let mut settings = serde_json::Map::new();
    if !linting.is_empty() || expresses_config {
        // `.lintr` does not contribute the `enabled` master switch. The enable
        // signal is derived from discovery state (see #281): when
        // `parse_lint_config` is called with `lintr_discovered = true`, the
        // default `"auto"` resolves to on. This keeps "drop a configured .lintr
        // to opt in" working without overriding an explicit client `false`.
        //
        // We emit the `linting` object whenever the file expressed linting
        // config — even when that config sets no individual keys (a bare
        // `linters_with_defaults()`) — so the presence of this object is the
        // single signal callers use to tell a *configured* `.lintr` (which
        // opts in) from a blank/empty one (which must NOT). See
        // `config_file::lintr_expresses_linting`.
        settings.insert("linting".into(), Value::Object(linting));
    }
    LoadedLintr {
        settings: Value::Object(settings),
        warnings,
    }
}

/// DCF-style line folding: a field starts with `Name:` at column zero; any
/// following line beginning with whitespace continues the previous value.
fn dcf_fold(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut current: Option<(String, String)> = None;
    for raw_line in text.lines() {
        if raw_line.trim().is_empty() {
            continue;
        }
        if raw_line.starts_with(|c: char| c.is_whitespace()) {
            if let Some((_, v)) = current.as_mut() {
                v.push(' ');
                v.push_str(raw_line.trim());
            }
            continue;
        }
        if let Some((key, val)) = current.take() {
            out.push((key, val));
        }
        if let Some(colon) = raw_line.find(':') {
            let key = raw_line[..colon].trim().to_string();
            let val = raw_line[colon + 1..].trim().to_string();
            current = Some((key, val));
        }
    }
    if let Some((key, val)) = current.take() {
        out.push((key, val));
    }
    out
}

/// Scan the body of `linters: linters_with_defaults(...)` (or a bare expression).
/// Recognizes top-level calls of the shape `name(args)` or `name = NULL`.
fn apply_linters(
    body: &str,
    linting: &mut serde_json::Map<String, Value>,
    warnings: &mut Vec<String>,
    unrecognized_constructs: &mut usize,
) {
    let inner = strip_linters_with_defaults(body);
    let entries = split_top_level_commas(inner);
    for entry in entries {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        // Recognize the function-call shape FIRST so that named-arg linter
        // calls like `assignment_linter(operator = "<-")` aren't
        // misclassified as `name = rhs` and silently dropped. Only when
        // the entry isn't a `name(args)` call do we fall through to the
        // `name = NULL` (rule-disable) shape.
        if let Some(paren_idx) = entry.find('(') {
            if !entry.ends_with(')') {
                *unrecognized_constructs += 1;
                continue;
            }
            let name = entry[..paren_idx].trim();
            let args = &entry[paren_idx + 1..entry.len() - 1];
            apply_linter_call(name, args, linting, warnings, unrecognized_constructs);
            continue;
        }
        if let Some((name, rhs)) = entry.split_once('=') {
            let name = name.trim();
            let rhs = rhs.trim();
            if rhs == "NULL" {
                disable_rule(name, linting, warnings);
                continue;
            }
            *unrecognized_constructs += 1;
            continue;
        }
        // Bare name with no parens and no `= NULL`: not a known shape.
        *unrecognized_constructs += 1;
    }
}

fn strip_linters_with_defaults(body: &str) -> &str {
    let trimmed = body.trim();
    if let Some(rest) = trimmed.strip_prefix("linters_with_defaults(")
        && let Some(inner) = rest.strip_suffix(')')
    {
        return inner.trim();
    }
    trimmed
}

fn apply_linter_call(
    name: &str,
    args: &str,
    linting: &mut serde_json::Map<String, Value>,
    warnings: &mut Vec<String>,
    unrecognized_constructs: &mut usize,
) {
    match name {
        "line_length_linter" => {
            if let Some(n) = parse_named_int(args, "length").or_else(|| parse_positional_int(args))
            {
                linting.insert("lineLength".into(), json!(n));
            }
        }
        "object_length_linter" => {
            if let Some(n) = parse_named_int(args, "length").or_else(|| parse_positional_int(args))
            {
                linting.insert("objectLength".into(), json!(n));
            }
        }
        "indentation_linter" => {
            // lintr's first positional formal is `indent`, so accept both the
            // named `indent = N` and the positional `N` form (mirroring
            // line_length_linter / object_length_linter).
            if let Some(n) = parse_named_int(args, "indent").or_else(|| parse_positional_int(args))
            {
                linting.insert("indentationUnit".into(), json!(n));
            }
        }
        "assignment_linter" => {
            if let Some(op) = parse_named_string(args, "operator") {
                linting.insert("assignmentOperator".into(), json!(op));
            }
        }
        "object_name_linter" => {
            // lintr's first positional formal is `styles`; accept positional
            // and named, scalar and `c(...)` forms. Raven stores one style per
            // symbol kind, so only a *single* recognized style is
            // representable: map it to all three kinds. A raw regex, an unknown
            // name, or a multi-style vector (lintr's OR-semantics, which Raven
            // can't express) is unrepresentable -> surface it in the batch
            // warning. A bare `object_name_linter()` resolves to no styles and
            // keeps Raven's defaults.
            if let Some(styles) = parse_object_name_styles(args) {
                match styles.first() {
                    None => {}
                    Some(only)
                        if styles.len() == 1
                            && crate::linting::ObjectNameStyle::from_config_name(only)
                                .is_some() =>
                    {
                        linting.insert("objectNameStyleFunction".into(), json!(only));
                        linting.insert("objectNameStyleVariable".into(), json!(only));
                        linting.insert("objectNameStyleArgument".into(), json!(only));
                    }
                    Some(_) => {
                        *unrecognized_constructs += 1;
                    }
                }
            }
        }
        "quotes_linter" if args.trim().is_empty() => {
            linting.insert("stringDelimiter".into(), json!("\""));
        }
        "single_quotes_linter" if args.trim().is_empty() => {
            linting.insert("stringDelimiter".into(), json!("'"));
        }
        "quotes_linter" | "single_quotes_linter" => {
            *unrecognized_constructs += 1;
        }
        "trailing_whitespace_linter"
        | "whitespace_linter"
        | "trailing_blank_lines_linter"
        | "infix_spaces_linter"
        | "commented_code_linter"
        | "commas_linter"
        | "T_and_F_symbol_linter"
        | "semicolon_linter"
        | "equals_na_linter"
        | "vector_logic_linter"
        | "function_left_parentheses_linter"
        | "spaces_inside_linter" => {
            // Recognized rule, no parameters to capture; presence in
            // linters_with_defaults() means "leave default severity".
        }
        // Recognized shape, no Raven equivalent.
        _ if name.ends_with("_linter") => {
            warnings.push(format!(
                ".lintr: {} has no Raven equivalent; skipping",
                name
            ));
        }
        _ => {
            *unrecognized_constructs += 1;
        }
    }
}

fn disable_rule(
    name: &str,
    linting: &mut serde_json::Map<String, Value>,
    warnings: &mut Vec<String>,
) {
    let severity_key = match name {
        "line_length_linter" => "lineLengthSeverity",
        "trailing_whitespace_linter" => "trailingWhitespaceSeverity",
        "whitespace_linter" => "noTabSeverity",
        "trailing_blank_lines_linter" => "trailingBlankLinesSeverity",
        "assignment_linter" => "assignmentOperatorSeverity",
        "object_name_linter" => "objectNameSeverity",
        "infix_spaces_linter" => "infixSpacesSeverity",
        "commented_code_linter" => "commentedCodeSeverity",
        "quotes_linter" | "single_quotes_linter" => "quotesSeverity",
        "commas_linter" => "commasSeverity",
        "T_and_F_symbol_linter" => "tAndFSymbolSeverity",
        "semicolon_linter" => "semicolonSeverity",
        "equals_na_linter" => "equalsNaSeverity",
        "object_length_linter" => "objectLengthSeverity",
        "vector_logic_linter" => "vectorLogicSeverity",
        "function_left_parentheses_linter" => "functionLeftParenthesesSeverity",
        "spaces_inside_linter" => "spacesInsideSeverity",
        "indentation_linter" => "indentationSeverity",
        _ => {
            warnings.push(format!(
                ".lintr: cannot disable unknown linter '{}'; skipping",
                name
            ));
            return;
        }
    };
    linting.insert(severity_key.into(), json!("off"));
}

fn apply_exclusions(body: &str, overrides: &mut Vec<Value>, unrecognized_constructs: &mut usize) {
    let body = body.trim();
    let inner = body
        .strip_prefix("list(")
        .and_then(|r| r.strip_suffix(')'))
        .unwrap_or(body);
    let mut globs = Vec::new();
    for part in split_top_level_commas(inner) {
        let p = part.trim().trim_matches(|c| c == '"' || c == '\'');
        if p.is_empty() {
            continue;
        }
        if p.contains('=') {
            *unrecognized_constructs += 1;
            continue;
        }
        // Directories become recursive globs; files stay as-is.
        if p.ends_with('/') || !p.contains('.') {
            globs.push(json!(format!("{}/**", p.trim_end_matches('/'))));
        } else {
            globs.push(json!(p));
        }
    }
    if !globs.is_empty() {
        overrides.push(json!({
            "files": globs,
            "enabled": false,
        }));
    }
}

/// Shared lexical state for scanning a `.lintr` field value as R-ish text:
/// tracks whether we are inside a string literal (with backslash-escape
/// handling), inside a `#` comment, and the net bracket depth. One state
/// machine so `dcf_fold` (continuation detection), `split_top_level_commas`,
/// and `strip_comments` cannot drift on what counts as "inside a string /
/// comment / bracket".
#[derive(Default)]
struct ScanState {
    /// `Some(quote)` while inside a string literal opened by `quote`.
    in_str: Option<char>,
    /// Inside a string, `true` when the previous char was an unescaped `\`, so
    /// the current char is escaped (and a quote does not close the string).
    escaped: bool,
    /// `true` while inside a `#` comment (until the next newline).
    in_comment: bool,
    /// Net `(`/`[`/`{` minus `)`/`]`/`}`, floored at 0.
    depth: i32,
}

impl ScanState {
    /// Advance over one byte-as-char `c`. Returns `true` when `c` is a
    /// *structural* character — not inside a string or comment — so callers can
    /// act on `,` / brackets only when this is `true`. Escape state is tracked
    /// internally (no `prev` parameter needed), so a string ending in an
    /// escaped backslash (`"a\\"`) closes correctly.
    fn step(&mut self, c: char) -> bool {
        if self.in_comment {
            if c == '\n' {
                self.in_comment = false;
            }
            return false;
        }
        if let Some(q) = self.in_str {
            if self.escaped {
                self.escaped = false;
            } else if c == '\\' {
                self.escaped = true;
            } else if c == q {
                self.in_str = None;
            }
            return false;
        }
        match c {
            '"' | '\'' => {
                self.in_str = Some(c);
                false
            }
            '#' => {
                self.in_comment = true;
                false
            }
            '(' | '[' | '{' => {
                self.depth += 1;
                true
            }
            ')' | ']' | '}' => {
                self.depth = (self.depth - 1).max(0);
                true
            }
            _ => true,
        }
    }
}

/// Net bracket depth of `s`, ignoring brackets inside string literals and `#`
/// comments. `> 0` means an unclosed `(`/`[`/`{` — the value is a mid-flight R
/// expression that continues on the next physical line regardless of DCF
/// indentation rules.
fn net_bracket_depth(s: &str) -> i32 {
    let mut st = ScanState::default();
    for &b in s.as_bytes() {
        st.step(b as char);
    }
    st.depth
}

/// Split a token string on commas at depth 0 (ignoring parens / brackets /
/// quotes / `#` comments).
fn split_top_level_commas(input: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut st = ScanState::default();
    let mut start = 0usize;
    for (i, &b) in input.as_bytes().iter().enumerate() {
        let c = b as char;
        let structural = st.step(c);
        if structural && c == ',' && st.depth == 0 {
            out.push(&input[start..i]);
            start = i + 1;
        }
    }
    if start <= input.len() {
        out.push(&input[start..]);
    }
    out
}

fn parse_positional_int(args: &str) -> Option<u64> {
    let first = split_top_level_commas(args).into_iter().next()?.trim();
    if first.contains('=') {
        return None;
    }
    first.parse::<u64>().ok()
}

fn parse_named_int(args: &str, name: &str) -> Option<u64> {
    parse_named_arg(args, name)?.parse::<u64>().ok()
}

fn parse_named_arg<'a>(args: &'a str, name: &str) -> Option<&'a str> {
    for part in split_top_level_commas(args) {
        // `if let Some(...)` rather than `?` so a positional argument
        // earlier in the list (e.g. `indentation_linter(2, indent = 4)`)
        // doesn't short-circuit the whole search.
        if let Some((lhs, rhs)) = part.split_once('=')
            && lhs.trim() == name
        {
            return Some(rhs.trim());
        }
    }
    None
}

fn parse_named_string(args: &str, name: &str) -> Option<String> {
    Some(
        parse_named_arg(args, name)?
            .trim_matches(|c| c == '"' || c == '\'')
            .to_string(),
    )
}

/// Resolve the `styles` argument of `object_name_linter` into a list of style
/// names. Accepts the named form (`styles = ...`) and, failing that, the first
/// positional argument. Each accepts either a single quoted string or a
/// `c("a", "b")` vector. Returns `None` when there is no styles argument at
/// all (e.g. `object_name_linter()` or `object_name_linter(regexes = ...)`).
fn parse_object_name_styles(args: &str) -> Option<Vec<String>> {
    let raw = parse_named_arg(args, "styles").or_else(|| {
        let first = split_top_level_commas(args).into_iter().next()?.trim();
        if first.is_empty() {
            return None;
        }
        // A positional `styles` value is a quoted scalar or a `c(...)` vector;
        // accept those even when their contents contain `=` (e.g. a regex with
        // a `(?=...)` lookahead). A bare `name = value` token is a *different*
        // named argument (such as `regexes = ...`) that we don't map, so only
        // an unquoted, non-`c(...)` token containing `=` is rejected here.
        let is_quoted = first.starts_with('"') || first.starts_with('\'');
        let is_vector = strip_c_vector(first).is_some();
        if !is_quoted && !is_vector && first.contains('=') {
            return None;
        }
        Some(first)
    })?;
    let raw = raw.trim();
    if let Some(inner) = strip_c_vector(raw) {
        // Drop *syntactically* empty tokens (e.g. a trailing comma) before
        // stripping quotes, so a quoted-empty element `""` survives as a real
        // (degenerate) style that is later flagged unrepresentable rather than
        // silently vanishing — which would let `c("", "snake_case")` collapse
        // to a single recognized style and map instead of warning.
        Some(
            split_top_level_commas(inner)
                .into_iter()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_matches(|c| c == '"' || c == '\'').to_string())
                .collect(),
        )
    } else {
        Some(vec![
            raw.trim_matches(|c| c == '"' || c == '\'').to_string(),
        ])
    }
}

/// Strip a `c(...)` vector wrapper, tolerating optional whitespace between the
/// `c` and the `(` so valid R like `c ("snake_case")` parses identically to
/// `c("snake_case")`. Returns the inner argument text, or `None` if `s` is not
/// a `c(...)` call.
fn strip_c_vector(s: &str) -> Option<&str> {
    let after_c = s.strip_prefix('c')?.trim_start();
    after_c.strip_prefix('(').and_then(|r| r.strip_suffix(')'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn net_bracket_depth_respects_strings_and_comments() {
        assert_eq!(net_bracket_depth("f(a, b)"), 0);
        assert_eq!(net_bracket_depth("f("), 1);
        assert_eq!(net_bracket_depth("f(g("), 2);
        // Brackets inside a string literal are not structural.
        assert_eq!(net_bracket_depth("f(\"a (b\")"), 0);
        // Brackets inside a `#` comment are not structural; comment ends at \n.
        assert_eq!(net_bracket_depth("f( # )(\n)"), 0);
        // A `#` inside a string is not a comment.
        assert_eq!(net_bracket_depth("f(\"# (\")"), 0);
        // A string ending in an escaped backslash closes correctly: this is
        // R `f("a\\")` (one backslash in the string), so depth returns to 0.
        assert_eq!(net_bracket_depth("f(\"a\\\\\")"), 0);
        // An escaped quote does NOT close the string: R `f("a\")` leaves the
        // string (and thus the `(`) open, so the `)` is inside the string and
        // depth stays 1.
        assert_eq!(net_bracket_depth("f(\"a\\\")"), 1);
    }

    #[test]
    fn split_top_level_commas_ignores_commas_in_comments() {
        // The comma in the trailing comment must not create a phantom split.
        let parts = split_top_level_commas("a # x, y\nb");
        assert_eq!(parts, vec!["a # x, y\nb"]);
        // Real top-level comma still splits; nested + quoted commas do not.
        let parts = split_top_level_commas("f(1, 2), \"x,y\", g()");
        assert_eq!(parts, vec!["f(1, 2)", " \"x,y\"", " g()"]);
    }

    #[test]
    fn line_length_param_maps() {
        let out = load_str("linters: linters_with_defaults(line_length_linter(120))\n");
        assert_eq!(out.settings["linting"]["lineLength"], json!(120));
    }

    #[test]
    fn line_length_named_length_param_maps() {
        let out = load_str("linters: linters_with_defaults(line_length_linter(length = 120))\n");
        assert_eq!(out.settings["linting"]["lineLength"], json!(120));
    }

    #[test]
    fn object_length_named_length_param_maps() {
        let out = load_str("linters: linters_with_defaults(object_length_linter(length = 45))\n");
        assert_eq!(out.settings["linting"]["objectLength"], json!(45));
    }

    #[test]
    fn single_quotes_linter_maps_string_delimiter() {
        let out = load_str("linters: linters_with_defaults(single_quotes_linter())\n");
        assert_eq!(out.settings["linting"]["stringDelimiter"], json!("'"));
    }

    #[test]
    fn quotes_linter_maps_string_delimiter() {
        let out = load_str("linters: linters_with_defaults(quotes_linter())\n");
        assert_eq!(out.settings["linting"]["stringDelimiter"], json!("\""));
    }

    #[test]
    fn parameterized_quotes_linters_are_unsupported_not_misread() {
        let out = load_str("linters: linters_with_defaults(quotes_linter(delimiter = \"'\"))\n");
        assert!(
            out.settings
                .get("linting")
                .and_then(|linting| linting.get("stringDelimiter"))
                .is_none(),
            "unsupported quotes_linter args must not be mapped to double quotes"
        );
        assert!(
            out.warnings
                .iter()
                .any(|w| w.contains("unrecognized construct")),
            "unsupported quotes_linter args should produce the batch warning"
        );

        let out = load_str("linters: linters_with_defaults(single_quotes_linter(TRUE))\n");
        assert!(
            out.settings
                .get("linting")
                .and_then(|linting| linting.get("stringDelimiter"))
                .is_none(),
            "unsupported single_quotes_linter args must not be mapped to single quotes"
        );
        assert!(
            out.warnings
                .iter()
                .any(|w| w.contains("unrecognized construct")),
            "unsupported single_quotes_linter args should produce the batch warning"
        );
    }

    #[test]
    fn null_disables_rule() {
        let out = load_str("linters: linters_with_defaults(commented_code_linter = NULL)\n");
        assert_eq!(
            out.settings["linting"]["commentedCodeSeverity"],
            json!("off")
        );
    }

    #[test]
    fn multi_line_dcf_field_is_folded() {
        let input = "linters: linters_with_defaults(\n    line_length_linter(140),\n    semicolon_linter = NULL\n  )\n";
        let out = load_str(input);
        assert_eq!(out.settings["linting"]["lineLength"], json!(140));
        assert_eq!(out.settings["linting"]["semicolonSeverity"], json!("off"));
    }

    #[test]
    fn unknown_linter_warns_once() {
        let out = load_str("linters: linters_with_defaults(cyclocomp_linter())\n");
        assert!(out.warnings.iter().any(|w| w.contains("cyclocomp_linter")));
    }

    #[test]
    fn exclusions_become_disabled_overrides() {
        let out = load_str("exclusions: list(\"R/legacy.R\", \"tests/\")\n");
        let overrides = out.settings["linting"]["overrides"].as_array().unwrap();
        assert_eq!(overrides.len(), 1);
        let entry = &overrides[0];
        assert_eq!(entry["enabled"], json!(false));
        let files = entry["files"].as_array().unwrap();
        assert!(files.iter().any(|v| v == &json!("R/legacy.R")));
        assert!(files.iter().any(|v| v == &json!("tests/**")));
    }

    #[test]
    fn out_of_grammar_yields_batch_warning() {
        let out = load_str("linters: linters_with_defaults(linters_with_tags(\"default\"))\n");
        assert!(
            out.warnings
                .iter()
                .any(|w| w.contains("unrecognized construct"))
        );
    }

    // --- Task 2: indentation_linter positional support ---

    #[test]
    fn indentation_positional_param_maps() {
        let out = load_str("linters: linters_with_defaults(indentation_linter(4))\n");
        assert_eq!(out.settings["linting"]["indentationUnit"], json!(4));
        assert!(out.warnings.is_empty(), "positional indent must not warn");
    }

    #[test]
    fn indentation_named_param_still_maps() {
        let out = load_str("linters: linters_with_defaults(indentation_linter(indent = 4))\n");
        assert_eq!(out.settings["linting"]["indentationUnit"], json!(4));
    }

    // --- Task 3: object_name_linter positional/single styles + warn ---

    #[test]
    fn object_name_positional_single_style_maps() {
        let out = load_str("linters: linters_with_defaults(object_name_linter(\"camelCase\"))\n");
        let l = &out.settings["linting"];
        assert_eq!(l["objectNameStyleFunction"], json!("camelCase"));
        assert_eq!(l["objectNameStyleVariable"], json!("camelCase"));
        assert_eq!(l["objectNameStyleArgument"], json!("camelCase"));
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn object_name_named_single_style_maps() {
        let out = load_str(
            "linters: linters_with_defaults(object_name_linter(styles = \"UPPER_CASE\"))\n",
        );
        let l = &out.settings["linting"];
        assert_eq!(l["objectNameStyleFunction"], json!("UPPER_CASE"));
        assert_eq!(l["objectNameStyleVariable"], json!("UPPER_CASE"));
        assert_eq!(l["objectNameStyleArgument"], json!("UPPER_CASE"));
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn object_name_single_element_vector_maps_named_and_positional() {
        // Named single-element vector.
        let out = load_str(
            "linters: linters_with_defaults(object_name_linter(styles = c(\"dotted.case\")))\n",
        );
        let l = &out.settings["linting"];
        assert_eq!(l["objectNameStyleFunction"], json!("dotted.case"));
        assert_eq!(l["objectNameStyleVariable"], json!("dotted.case"));
        assert_eq!(l["objectNameStyleArgument"], json!("dotted.case"));
        assert!(out.warnings.is_empty());

        // Positional single-element vector.
        let out =
            load_str("linters: linters_with_defaults(object_name_linter(c(\"lowercase\")))\n");
        let l = &out.settings["linting"];
        assert_eq!(l["objectNameStyleFunction"], json!("lowercase"));
        assert_eq!(l["objectNameStyleVariable"], json!("lowercase"));
        assert_eq!(l["objectNameStyleArgument"], json!("lowercase"));
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn object_name_c_vector_tolerates_space_before_paren() {
        // Valid R allows whitespace between `c` and `(`.
        let out =
            load_str("linters: linters_with_defaults(object_name_linter(c (\"camelCase\")))\n");
        assert_eq!(
            out.settings["linting"]["objectNameStyleFunction"],
            json!("camelCase")
        );
        assert!(out.warnings.is_empty());

        // Same tolerance on the named-arg path.
        let out = load_str(
            "linters: linters_with_defaults(object_name_linter(styles = c (\"snake_case\")))\n",
        );
        assert_eq!(
            out.settings["linting"]["objectNameStyleFunction"],
            json!("snake_case")
        );
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn object_name_multi_style_vector_is_unsupported() {
        // lintr's c("a", "b") is OR-semantics across styles; Raven has one
        // style per kind, so a multi-style vector is unrepresentable -> warn,
        // no mapping.
        for body in [
            "object_name_linter(styles = c(\"dotted.case\", \"snake_case\"))",
            "object_name_linter(c(\"snake_case\", \"camelCase\"))",
        ] {
            let out = load_str(&format!("linters: linters_with_defaults({body})\n"));
            assert!(
                out.settings
                    .get("linting")
                    .and_then(|l| l.get("objectNameStyleFunction"))
                    .is_none(),
                "multi-style vector must not map a style ({body})"
            );
            assert!(
                out.warnings
                    .iter()
                    .any(|w| w.contains("unrecognized construct")),
                "multi-style vector must produce the batch warning ({body})"
            );
        }
    }

    #[test]
    fn object_name_regex_is_unsupported_not_misread() {
        let out = load_str(
            "linters: linters_with_defaults(object_name_linter(\"^[a-z][a-z0-9_]*(\\\\.([a-z][a-z0-9_]*))*$\"))\n",
        );
        assert!(
            out.settings
                .get("linting")
                .and_then(|l| l.get("objectNameStyleFunction"))
                .is_none(),
            "a raw regex style must not be mapped to an object-name style"
        );
        assert!(
            out.warnings
                .iter()
                .any(|w| w.contains("unrecognized construct")),
            "an unrepresentable object_name_linter style must produce the batch warning"
        );
    }

    #[test]
    fn object_name_no_args_keeps_defaults_silently() {
        let out = load_str("linters: linters_with_defaults(object_name_linter())\n");
        assert!(
            out.settings
                .get("linting")
                .and_then(|l| l.get("objectNameStyleFunction"))
                .is_none(),
            "object_name_linter() with no styles leaves Raven defaults in place"
        );
        assert!(
            out.warnings.is_empty(),
            "the bare no-arg form must not warn"
        );
    }

    /// Helper: did the load surface the batch warning for unrepresentable input?
    fn has_unrecognized_warning(out: &LoadedLintr) -> bool {
        out.warnings
            .iter()
            .any(|w| w.contains("unrecognized construct"))
    }

    /// Helper: did the load map any object-name style?
    fn mapped_object_name_style(out: &LoadedLintr) -> bool {
        out.settings
            .get("linting")
            .and_then(|l| l.get("objectNameStyleFunction"))
            .is_some()
    }

    #[test]
    fn object_name_positional_regex_with_equals_still_warns() {
        // A positional raw regex that contains '=' (e.g. a lookahead) must
        // still be flagged unrepresentable, not mistaken for a `name = value`
        // named argument and silently dropped.
        let out = load_str(
            "linters: linters_with_defaults(object_name_linter(\"^(?=.*[A-Z])[a-z]+$\"))\n",
        );
        assert!(!mapped_object_name_style(&out));
        assert!(
            has_unrecognized_warning(&out),
            "a positional regex containing '=' must produce the batch warning"
        );
    }

    #[test]
    fn object_name_positional_regex_with_comma_in_quotes_warns() {
        // The comma lives inside the quoted string, so split_top_level_commas
        // must keep it as one entry; the regex is still unrepresentable.
        let out = load_str("linters: linters_with_defaults(object_name_linter(\"^[a-z,]+$\"))\n");
        assert!(!mapped_object_name_style(&out));
        assert!(has_unrecognized_warning(&out));
    }

    #[test]
    fn object_name_regexes_named_arg_is_ignored_silently() {
        // `regexes =` has no Raven equivalent and is a no-op (documented as
        // ignored, not warned).
        let out =
            load_str("linters: linters_with_defaults(object_name_linter(regexes = \"^x$\"))\n");
        assert!(!mapped_object_name_style(&out));
        assert!(
            out.warnings.is_empty(),
            "regexes = is an ignored no-op, not a warning"
        );
    }

    #[test]
    fn object_name_empty_vector_is_noop() {
        let out = load_str("linters: linters_with_defaults(object_name_linter(c()))\n");
        assert!(!mapped_object_name_style(&out));
        assert!(out.warnings.is_empty(), "c() resolves to no styles: no-op");
    }

    #[test]
    fn object_name_quoted_empty_element_is_unrepresentable() {
        // A quoted-empty element is a real (degenerate) element: it must not
        // vanish. `c("")` -> one unrepresentable style -> warn; and
        // `c("", "snake_case")` must NOT collapse to a single mapped style.
        let out = load_str("linters: linters_with_defaults(object_name_linter(c(\"\")))\n");
        assert!(!mapped_object_name_style(&out));
        assert!(has_unrecognized_warning(&out));

        let out = load_str(
            "linters: linters_with_defaults(object_name_linter(c(\"\", \"snake_case\")))\n",
        );
        assert!(
            !mapped_object_name_style(&out),
            "an empty element must keep the vector multi-element so it warns, not map snake_case"
        );
        assert!(has_unrecognized_warning(&out));
    }

    // --- Task 4: the full user example (loader JSON layer) ---

    #[test]
    fn user_example_full_block_maps_each_entry() {
        let input = "linters: linters_with_defaults(\n    \
            line_length_linter(80),\n    \
            commented_code_linter(),\n    \
            object_length_linter(40),\n    \
            indentation_linter(4),\n    \
            object_name_linter(\"^[a-z][a-z0-9_]*(\\\\.([a-z][a-z0-9_]*))*$\"),\n    \
            trailing_blank_lines_linter = NULL,\n    \
            trailing_whitespace_linter = NULL\n    )\n";
        let out = load_str(input);
        let linting = &out.settings["linting"];

        // Positional numeric params.
        assert_eq!(linting["lineLength"], json!(80));
        assert_eq!(linting["objectLength"], json!(40));
        assert_eq!(linting["indentationUnit"], json!(4));

        // Recognized no-arg linter: default severity left intact (no "off").
        assert!(linting.get("commentedCodeSeverity").is_none());

        // Unrepresentable regex object-name style: not mapped.
        assert!(linting.get("objectNameStyleFunction").is_none());

        // `= NULL` disables.
        assert_eq!(linting["trailingBlankLinesSeverity"], json!("off"));
        assert_eq!(linting["trailingWhitespaceSeverity"], json!("off"));

        // Exactly one unrepresentable construct (the regex), surfaced once.
        let batch = out
            .warnings
            .iter()
            .filter(|w| w.contains("unrecognized construct"))
            .count();
        assert_eq!(batch, 1, "exactly one batch warning, for the regex style");
        assert!(
            out.warnings
                .iter()
                .any(|w| w.contains("1 unrecognized construct(s)"))
        );
    }

    // --- Task 5: combination & no-override coverage ---

    #[test]
    fn empty_linters_with_defaults_expresses_intent_via_empty_linting_object() {
        // `linters_with_defaults()` sets no individual keys, but it IS a
        // recognized `linters:` directive — so the loader emits an (empty)
        // `linting` object as the "expresses linting intent" marker that
        // distinguishes it from a blank file. See `config_file`.
        let out = load_str("linters: linters_with_defaults()\n");
        let linting = out
            .settings
            .get("linting")
            .expect("a linters: directive must contribute the intent marker");
        assert_eq!(linting, &json!({}), "no overrides means an empty object");
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn blank_lintr_contributes_no_linting_object() {
        // A blank / whitespace-only / unknown-fields-only file expresses no
        // linting intent, so no `linting` object is emitted (the signal a
        // discovered .lintr uses to decide auto-enable).
        assert!(load_str("").settings.get("linting").is_none());
        assert!(load_str("\n  \n").settings.get("linting").is_none());
        let unknown = load_str("encoding: UTF-8\n");
        assert!(unknown.settings.get("linting").is_none());
        assert!(
            unknown.warnings.iter().any(|w| w.contains("unknown field")),
            "an unknown field still warns, but does not express linting intent"
        );
    }

    #[test]
    fn all_named_numeric_params_map() {
        let out = load_str(
            "linters: linters_with_defaults(line_length_linter(length = 100), object_length_linter(length = 50), indentation_linter(indent = 8))\n",
        );
        let l = &out.settings["linting"];
        assert_eq!(l["lineLength"], json!(100));
        assert_eq!(l["objectLength"], json!(50));
        assert_eq!(l["indentationUnit"], json!(8));
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn all_positional_numeric_params_map() {
        let out = load_str(
            "linters: linters_with_defaults(line_length_linter(100), object_length_linter(50), indentation_linter(8))\n",
        );
        let l = &out.settings["linting"];
        assert_eq!(l["lineLength"], json!(100));
        assert_eq!(l["objectLength"], json!(50));
        assert_eq!(l["indentationUnit"], json!(8));
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn multiple_null_disables_map_each() {
        let out = load_str(
            "linters: linters_with_defaults(commented_code_linter = NULL, trailing_blank_lines_linter = NULL, object_name_linter = NULL)\n",
        );
        let l = &out.settings["linting"];
        assert_eq!(l["commentedCodeSeverity"], json!("off"));
        assert_eq!(l["trailingBlankLinesSeverity"], json!("off"));
        assert_eq!(l["objectNameSeverity"], json!("off"));
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn assignment_and_quotes_map() {
        let out = load_str(
            "linters: linters_with_defaults(assignment_linter(operator = \"=\"), single_quotes_linter())\n",
        );
        let l = &out.settings["linting"];
        assert_eq!(l["assignmentOperator"], json!("="));
        assert_eq!(l["stringDelimiter"], json!("'"));
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn mixed_combination_positional_named_null_and_noarg() {
        let out = load_str(
            "linters: linters_with_defaults(line_length_linter(120), object_name_linter(styles = \"snake_case\"), infix_spaces_linter(), semicolon_linter = NULL, indentation_linter(indent = 2))\n",
        );
        let l = &out.settings["linting"];
        assert_eq!(l["lineLength"], json!(120));
        assert_eq!(l["objectNameStyleFunction"], json!("snake_case"));
        assert_eq!(l["indentationUnit"], json!(2));
        assert_eq!(l["semicolonSeverity"], json!("off"));
        // infix_spaces_linter() is recognized no-arg: no severity override.
        assert!(l.get("infixSpacesSeverity").is_none());
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn bare_linters_with_defaults_without_wrapper_call_still_parses() {
        // A bare expression (no `linters_with_defaults(...)` wrapper) is also a
        // documented form; confirm a single linter call still maps.
        let out = load_str("linters: line_length_linter(90)\n");
        assert_eq!(out.settings["linting"]["lineLength"], json!(90));
    }

    // --- Task 6: end-to-end (.lintr JSON -> LintConfig) ---

    #[test]
    fn empty_defaults_enable_all_defaults_when_discovered() {
        // `linters_with_defaults()` with no overrides + a discovered .lintr
        // means "linting on, every rule at its default" — verify the resolved
        // LintConfig.
        let out = load_str("linters: linters_with_defaults()\n");
        let cfg = crate::backend::parse_lint_config(&out.settings, true).unwrap();
        let default = crate::linting::LintConfig::default();
        assert!(cfg.enabled, "a discovered .lintr resolves Auto -> on");
        assert_eq!(cfg.line_length, default.line_length);
        assert_eq!(cfg.object_length, default.object_length);
        assert_eq!(cfg.indentation_unit, default.indentation_unit);
        assert_eq!(cfg.commented_code_severity, default.commented_code_severity);
        assert_eq!(
            cfg.object_name_style_function,
            default.object_name_style_function
        );
    }

    #[test]
    fn user_example_resolves_to_expected_lint_config() {
        let input = "linters: linters_with_defaults(\n    \
            line_length_linter(80),\n    \
            commented_code_linter(),\n    \
            object_length_linter(40),\n    \
            indentation_linter(4),\n    \
            object_name_linter(\"^[a-z][a-z0-9_]*(\\\\.([a-z][a-z0-9_]*))*$\"),\n    \
            trailing_blank_lines_linter = NULL,\n    \
            trailing_whitespace_linter = NULL\n    )\n";
        let out = load_str(input);
        let cfg = crate::backend::parse_lint_config(&out.settings, true).unwrap();

        assert!(cfg.enabled);
        assert_eq!(cfg.line_length, 80);
        assert_eq!(cfg.object_length, 40);
        assert_eq!(cfg.indentation_unit, 4);

        // commented_code stays at its default severity (recognized, not
        // disabled).
        assert_eq!(
            cfg.commented_code_severity,
            Some(tower_lsp::lsp_types::DiagnosticSeverity::INFORMATION)
        );

        // regex object-name style ignored -> defaults retained.
        assert_eq!(
            cfg.object_name_style_function,
            crate::linting::ObjectNameStyle::SnakeCase
        );

        // `= NULL` rules disabled (severity None).
        assert_eq!(cfg.trailing_blank_lines_severity, None);
        assert_eq!(cfg.trailing_whitespace_severity, None);
    }

    #[test]
    fn valid_object_name_style_resolves_into_lint_config() {
        let out = load_str("linters: linters_with_defaults(object_name_linter(\"camelCase\"))\n");
        let cfg = crate::backend::parse_lint_config(&out.settings, true).unwrap();
        assert_eq!(
            cfg.object_name_style_function,
            crate::linting::ObjectNameStyle::CamelCase
        );
        assert_eq!(
            cfg.object_name_style_variable,
            crate::linting::ObjectNameStyle::CamelCase
        );
        assert_eq!(
            cfg.object_name_style_argument,
            crate::linting::ObjectNameStyle::CamelCase
        );
    }
}
