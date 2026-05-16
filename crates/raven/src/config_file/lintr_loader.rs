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

use serde_json::{json, Value};

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

    for (key, value) in fields {
        match key.as_str() {
            "linters" => apply_linters(&value, &mut linting, &mut warnings, &mut unrecognized_constructs),
            "exclusions" => apply_exclusions(&value, &mut overrides, &mut unrecognized_constructs),
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
    if !linting.is_empty() {
        // Default `enabled = true` so .lintr users get linting on without
        // having to opt in. (raven.toml users decide for themselves.)
        linting.entry("enabled").or_insert(json!(true));
        settings.insert("linting".into(), Value::Object(linting));
    }
    LoadedLintr { settings: Value::Object(settings), warnings }
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
        // Bare name with no parens and no `= NULL`: not a known shape.
        *unrecognized_constructs += 1;
    }
}

fn strip_linters_with_defaults(body: &str) -> &str {
    let trimmed = body.trim();
    if let Some(rest) = trimmed.strip_prefix("linters_with_defaults(") {
        if let Some(inner) = rest.strip_suffix(')') {
            return inner.trim();
        }
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
            if let Some(n) = parse_positional_int(args) {
                linting.insert("lineLength".into(), json!(n));
            }
        }
        "object_length_linter" => {
            if let Some(n) = parse_positional_int(args) {
                linting.insert("objectLength".into(), json!(n));
            }
        }
        "indentation_linter" => {
            if let Some(n) = parse_named_int(args, "indent") {
                linting.insert("indentationUnit".into(), json!(n));
            }
        }
        "assignment_linter" => {
            if let Some(op) = parse_named_string(args, "operator") {
                linting.insert("assignmentOperator".into(), json!(op));
            }
        }
        "object_name_linter" => {
            if let Some(styles) = parse_named_string_vec(args, "styles") {
                if let Some(first) = styles.first() {
                    linting.insert("objectNameStyleFunction".into(), json!(first));
                    linting.insert("objectNameStyleVariable".into(), json!(first));
                    linting.insert("objectNameStyleArgument".into(), json!(first));
                }
            }
        }
        "trailing_whitespace_linter"
        | "whitespace_linter"
        | "trailing_blank_lines_linter"
        | "infix_spaces_linter"
        | "commented_code_linter"
        | "quotes_linter"
        | "single_quotes_linter"
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

fn disable_rule(name: &str, linting: &mut serde_json::Map<String, Value>, warnings: &mut Vec<String>) {
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

/// Split a token string on commas at depth 0 (ignoring parens / brackets / quotes).
fn split_top_level_commas(input: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut in_str: Option<char> = None;
    let mut start = 0usize;
    let bytes = input.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        let c = b as char;
        if let Some(q) = in_str {
            if c == q && bytes.get(i.wrapping_sub(1)) != Some(&b'\\') {
                in_str = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => in_str = Some(c),
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1).max(0),
            ',' if depth == 0 => {
                out.push(&input[start..i]);
                start = i + 1;
            }
            _ => {}
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
    for part in split_top_level_commas(args) {
        let (lhs, rhs) = part.split_once('=')?;
        if lhs.trim() == name {
            return rhs.trim().parse::<u64>().ok();
        }
    }
    None
}

fn parse_named_string(args: &str, name: &str) -> Option<String> {
    for part in split_top_level_commas(args) {
        if let Some((lhs, rhs)) = part.split_once('=') {
            if lhs.trim() == name {
                let v = rhs.trim().trim_matches(|c| c == '"' || c == '\'');
                return Some(v.to_string());
            }
        }
    }
    None
}

fn parse_named_string_vec(args: &str, name: &str) -> Option<Vec<String>> {
    for part in split_top_level_commas(args) {
        if let Some((lhs, rhs)) = part.split_once('=') {
            if lhs.trim() == name {
                let rhs = rhs.trim();
                let inner = rhs
                    .strip_prefix("c(")
                    .and_then(|r| r.strip_suffix(')'))?;
                return Some(
                    split_top_level_commas(inner)
                        .into_iter()
                        .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
                        .filter(|s| !s.is_empty())
                        .collect(),
                );
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_length_param_maps() {
        let out = load_str("linters: linters_with_defaults(line_length_linter(120))\n");
        assert_eq!(out.settings["linting"]["lineLength"], json!(120));
    }

    #[test]
    fn null_disables_rule() {
        let out = load_str("linters: linters_with_defaults(commented_code_linter = NULL)\n");
        assert_eq!(out.settings["linting"]["commentedCodeSeverity"], json!("off"));
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
        assert!(out.warnings.iter().any(|w| w.contains("unrecognized construct")));
    }
}
