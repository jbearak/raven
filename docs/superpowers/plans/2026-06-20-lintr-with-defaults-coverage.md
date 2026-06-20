# `.lintr` `linters_with_defaults` Coverage & Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Raven's `.lintr` reader handle every entry in the user's example `linters_with_defaults(...)` block (and arbitrary valid combinations, plus the no-override case) the way `lintr` would, and lock that behavior in with comprehensive tests.

**Architecture:** The `.lintr` reader lives in `crates/raven/src/config_file/lintr_loader.rs`. It folds DCF fields, strips the `linters_with_defaults(...)` wrapper, splits top-level commas, and maps each recognized linter call (or `name = NULL` disable) into a `linting` JSON object that `backend::parse_lint_config` later turns into a `LintConfig`. Two gaps make the user's example silently mis-parse: `indentation_linter(N)` positional args are dropped, and `object_name_linter("...")` positional/single-string styles are dropped (and unrepresentable regex styles vanish without a warning). We fix both to match `lintr` semantics, introduce one shared source of truth for the valid object-name style set so the loader and `parse_lint_config` cannot drift, and then add unit tests at both the loader (JSON) layer and the end-to-end (`parse_lint_config` → `LintConfig`) layer.

**Tech Stack:** Rust (edition 2021, MSRV 1.96.0), `serde_json`, inline `#[cfg(test)]` unit tests. Gates: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --features test-support -- -D warnings`.

---

## Background: what "works as expected" means here

The user's example file. **Two DCF rules matter for the test fixtures** (see `dcf_fold`): `linters:` must be at **column 0** (the leading indentation in the prompt is cosmetic and would be treated as a dropped continuation line), and **every continuation line — including the closing `)` — must begin with whitespace**, or that line terminates the field and the value loses its closing paren (the existing `multi_line_dcf_field_is_folded` test indents its `)` for exactly this reason):

```r
linters: linters_with_defaults(
    line_length_linter(80),
    commented_code_linter(),
    object_length_linter(40),
    indentation_linter(4),
    object_name_linter("^[a-z][a-z0-9_]*(\\.([a-z][a-z0-9_]*))*$"),
    trailing_blank_lines_linter = NULL,
    trailing_whitespace_linter = NULL
    )
```

Decision (confirmed with user): **fix to match `lintr`.** Per-entry expected behavior:

| Entry | Expected result | Status before this plan |
|---|---|---|
| `line_length_linter(80)` | `lineLength = 80` | ✅ works (positional supported) |
| `commented_code_linter()` | recognized, no-op (default severity kept) | ✅ works |
| `object_length_linter(40)` | `objectLength = 40` | ✅ works (positional supported) |
| `indentation_linter(4)` | `indentationUnit = 4` | ❌ **bug**: positional dropped |
| `object_name_linter("^regex…")` | unrepresentable regex → **batch warning**, no style mapping | ❌ **bug**: silently dropped, no warning |
| `trailing_blank_lines_linter = NULL` | `trailingBlankLinesSeverity = "off"` | ✅ works |
| `trailing_whitespace_linter = NULL` | `trailingWhitespaceSeverity = "off"` | ✅ works |

Valid object-name styles are exactly `snake_case`, `camelCase`, `dotted.case`, `UPPER_CASE`, `lowercase`, `any` (the `ObjectNameStyle` enum in `crates/raven/src/linting/config.rs`). Raven represents **one** style per symbol kind, so the representable shape is a **single** style — positional or named, as a scalar or a one-element `c(...)` (e.g. `object_name_linter("camelCase")`, `object_name_linter(styles = c("snake_case"))`). The following are **unrepresentable** and must produce the batch warning without mapping anything:
- a raw regex string (e.g. the user's `"^[a-z]…$"`) — not a known style name;
- a **multi-style** vector like `c("snake_case", "camelCase")` — `lintr` accepts a symbol matching *any* listed style (OR-semantics), which Raven's single-style-per-kind model cannot express, so silently picking the first would be lossy and wrong.

A bare `object_name_linter()` (no styles) is a no-op that keeps Raven's defaults.

**Out of scope (deliberate non-goals):**
- `object_name_linter(regexes = ...)` with no `styles` arg → left as a silent no-op (keeps Raven defaults, which is safe). Adding `regexes`-detection is gold-plating; not in the user's example. Docs are written to match this (they do **not** claim `regexes =` warns).
- Adding positional support for `assignment_linter` / `quotes_linter` arguments beyond what already exists.

---

## File Structure

- **Add** to `crates/raven/src/linting/config.rs` — `ObjectNameStyle::from_config_name` as the single source of truth for the valid style-name set.
- **Refactor** `crates/raven/src/backend.rs` — `parse_object_name_style` to consume `from_config_name` (no behavior change).
- **Rework** `crates/raven/src/config_file/lintr_loader.rs` — fix `indentation_linter` positional, rewrite `object_name_linter` style resolution + warning, remove now-dead `parse_named_string_vec`, add all new tests.
- **Document** in `docs/linting.md` — positional acceptance and the unrepresentable-regex behavior.

---

## Task 1: Single source of truth for object-name style names

**Files:**
- Modify: `crates/raven/src/linting/config.rs` (add method after the `ObjectNameStyle` enum, around line 50)
- Modify: `crates/raven/src/backend.rs:955-971` (refactor `parse_object_name_style`)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)]` module at the bottom of `crates/raven/src/linting/config.rs` (create the module if none exists):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_config_name_maps_known_styles() {
        assert_eq!(
            ObjectNameStyle::from_config_name("snake_case"),
            Some(ObjectNameStyle::SnakeCase)
        );
        assert_eq!(
            ObjectNameStyle::from_config_name("camelCase"),
            Some(ObjectNameStyle::CamelCase)
        );
        assert_eq!(
            ObjectNameStyle::from_config_name("dotted.case"),
            Some(ObjectNameStyle::DottedCase)
        );
        assert_eq!(
            ObjectNameStyle::from_config_name("UPPER_CASE"),
            Some(ObjectNameStyle::UpperCase)
        );
        assert_eq!(
            ObjectNameStyle::from_config_name("lowercase"),
            Some(ObjectNameStyle::Lowercase)
        );
        assert_eq!(
            ObjectNameStyle::from_config_name("any"),
            Some(ObjectNameStyle::Any)
        );
    }

    #[test]
    fn from_config_name_rejects_unknown_and_regex() {
        assert_eq!(ObjectNameStyle::from_config_name("kebab-case"), None);
        assert_eq!(
            ObjectNameStyle::from_config_name("^[a-z][a-z0-9_]*$"),
            None
        );
        assert_eq!(ObjectNameStyle::from_config_name(""), None);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven --lib linting::config::tests::from_config_name`
Expected: FAIL to compile — `no function or associated item named from_config_name`.

- [ ] **Step 3: Write minimal implementation**

Add this `impl` block immediately after the `ObjectNameStyle` enum definition (after line 50) in `crates/raven/src/linting/config.rs`:

```rust
impl ObjectNameStyle {
    /// Parse an object-name style name (as written in `.lintr` or
    /// `raven.toml`) into the enum, returning `None` for any value Raven
    /// cannot represent (e.g. a raw regex passed to `object_name_linter`).
    ///
    /// This is the **single source of truth** for the set of style names
    /// Raven understands. Both `backend::parse_object_name_style` (the
    /// JSON/severity path) and the `.lintr` loader's `object_name_linter`
    /// handling consult it, so the recognized set cannot drift between them.
    pub fn from_config_name(value: &str) -> Option<Self> {
        match value {
            "snake_case" => Some(Self::SnakeCase),
            "camelCase" => Some(Self::CamelCase),
            "dotted.case" => Some(Self::DottedCase),
            "UPPER_CASE" => Some(Self::UpperCase),
            "lowercase" => Some(Self::Lowercase),
            "any" => Some(Self::Any),
            _ => None,
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p raven --lib linting::config::tests::from_config_name`
Expected: PASS (2 tests).

- [ ] **Step 5: Refactor `parse_object_name_style` to consume it (no behavior change)**

Replace the body of `parse_object_name_style` in `crates/raven/src/backend.rs:955-971` with:

```rust
fn parse_object_name_style(value: &str, setting_name: &str) -> crate::linting::ObjectNameStyle {
    use crate::linting::ObjectNameStyle;
    ObjectNameStyle::from_config_name(value).unwrap_or_else(|| {
        log::warn!(
            "Unrecognised linting.{setting_name} '{value}', disabling this kind (treating as 'any')."
        );
        ObjectNameStyle::Any
    })
}
```

- [ ] **Step 6: Run the existing object-name tests to confirm no regression**

Run: `cargo test -p raven --lib parse_lint_config` (runs the full `parse_lint_config` test group, including the two object-name-style tests)
Expected: PASS (all green — behavior is identical).

- [ ] **Step 7: Commit**

```bash
git add crates/raven/src/linting/config.rs crates/raven/src/backend.rs
git commit -m "refactor(linting): single source of truth for object-name style names"
```

---

## Task 2: `indentation_linter` accepts a positional indent

**Files:**
- Modify: `crates/raven/src/config_file/lintr_loader.rs:184-188` (the `indentation_linter` match arm)
- Test: `crates/raven/src/config_file/lintr_loader.rs` (tests module, ~line 385)

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/raven/src/config_file/lintr_loader.rs`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests::indentation_positional_param_maps`
Expected: FAIL — `indentationUnit` is absent (positional dropped), index panics / assertion fails.

- [ ] **Step 3: Write minimal implementation**

Replace the `indentation_linter` arm in `apply_linter_call` (`crates/raven/src/config_file/lintr_loader.rs:184-188`):

```rust
        "indentation_linter" => {
            // lintr's first positional formal is `indent`, so accept both the
            // named `indent = N` and the positional `N` form (mirroring
            // line_length_linter / object_length_linter).
            if let Some(n) = parse_named_int(args, "indent").or_else(|| parse_positional_int(args)) {
                linting.insert("indentationUnit".into(), json!(n));
            }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests::indentation`
Expected: PASS (2 tests — both `indentation_*` tests share the substring).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs
git commit -m "fix(lintr): accept positional indent in indentation_linter"
```

---

## Task 3: `object_name_linter` positional/single-string styles + warn on unrepresentable

**Files:**
- Modify: `crates/raven/src/config_file/lintr_loader.rs:194-202` (the `object_name_linter` match arm)
- Modify: `crates/raven/src/config_file/lintr_loader.rs:372-383` (remove `parse_named_string_vec`, add `parse_object_name_styles`)
- Test: `crates/raven/src/config_file/lintr_loader.rs` (tests module)

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/raven/src/config_file/lintr_loader.rs`:

```rust
#[test]
fn object_name_positional_single_style_maps() {
    let out = load_str("linters: linters_with_defaults(object_name_linter(\"camelCase\"))\n");
    assert_eq!(out.settings["linting"]["objectNameStyleFunction"], json!("camelCase"));
    assert_eq!(out.settings["linting"]["objectNameStyleVariable"], json!("camelCase"));
    assert_eq!(out.settings["linting"]["objectNameStyleArgument"], json!("camelCase"));
    assert!(out.warnings.is_empty());
}

#[test]
fn object_name_named_single_style_maps() {
    let out = load_str("linters: linters_with_defaults(object_name_linter(styles = \"UPPER_CASE\"))\n");
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
    let out = load_str("linters: linters_with_defaults(object_name_linter(c(\"lowercase\")))\n");
    let l = &out.settings["linting"];
    assert_eq!(l["objectNameStyleFunction"], json!("lowercase"));
    assert_eq!(l["objectNameStyleVariable"], json!("lowercase"));
    assert_eq!(l["objectNameStyleArgument"], json!("lowercase"));
    assert!(out.warnings.is_empty());
}

#[test]
fn object_name_multi_style_vector_is_unsupported() {
    // lintr's c("a", "b") is OR-semantics across styles; Raven has one style
    // per kind, so a multi-style vector is unrepresentable -> warn, no mapping.
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
            out.warnings.iter().any(|w| w.contains("unrecognized construct")),
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
        out.warnings.iter().any(|w| w.contains("unrecognized construct")),
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
    assert!(out.warnings.is_empty(), "the bare no-arg form must not warn");
}
```

Note on the regex test: the Rust string literal `\\\\.` produces the two bytes `\` `\` `.` in the parsed `.lintr` text, matching the user's `\\.`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests::object_name`
Expected: FAIL — positional/single-string forms don't map (only `styles = c(...)` was handled), and the regex form is silently dropped with no warning.

- [ ] **Step 3: Write minimal implementation**

(a) Replace the `object_name_linter` arm in `apply_linter_call` (`crates/raven/src/config_file/lintr_loader.rs:194-202`):

```rust
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
                            && crate::linting::ObjectNameStyle::from_config_name(only).is_some() =>
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
```

(b) Replace `parse_named_string_vec` (`crates/raven/src/config_file/lintr_loader.rs:372-383`) with `parse_object_name_styles`. The old helper is used only by the `object_name_linter` arm, so removing it avoids a dead-code clippy error:

```rust
/// Resolve the `styles` argument of `object_name_linter` into a list of style
/// names. Accepts the named form (`styles = ...`) and, failing that, the first
/// positional argument. Each accepts either a single quoted string or a
/// `c("a", "b")` vector. Returns `None` when there is no styles argument at
/// all (e.g. `object_name_linter()` or `object_name_linter(regexes = ...)`).
fn parse_object_name_styles(args: &str) -> Option<Vec<String>> {
    let raw = parse_named_arg(args, "styles").or_else(|| {
        let first = split_top_level_commas(args).into_iter().next()?.trim();
        if first.is_empty() || first.contains('=') {
            None
        } else {
            Some(first)
        }
    })?;
    let raw = raw.trim();
    if let Some(inner) = raw.strip_prefix("c(").and_then(|r| r.strip_suffix(')')) {
        Some(
            split_top_level_commas(inner)
                .into_iter()
                .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
                .filter(|s| !s.is_empty())
                .collect(),
        )
    } else {
        Some(vec![raw.trim_matches(|c| c == '"' || c == '\'').to_string()])
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests::object_name`
Expected: PASS (all 6 `object_name_*` tests).

- [ ] **Step 5: Confirm no dead code / clippy regressions in this file**

Run: `cargo clippy -p raven --lib --features test-support -- -D warnings`
Expected: no warnings (confirms `parse_named_string_vec` removal left nothing dangling).

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs
git commit -m "fix(lintr): map object_name_linter positional/single styles, warn on regex"
```

---

## Task 4: Full-example coverage test (loader JSON layer)

**Files:**
- Test: `crates/raven/src/config_file/lintr_loader.rs` (tests module)

- [ ] **Step 1: Write the test**

Add to the `tests` module. This is the user's exact example, verbatim per entry (with `linters:` at column 0 and DCF continuation lines indented):

```rust
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
    assert!(out.warnings.iter().any(|w| w.contains("1 unrecognized construct(s)")));
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests::user_example_full_block_maps_each_entry`
Expected: PASS (relies on Tasks 2 and 3).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs
git commit -m "test(lintr): cover the full user linters_with_defaults example"
```

---

## Task 5: Combination & no-override coverage (loader JSON layer)

**Files:**
- Test: `crates/raven/src/config_file/lintr_loader.rs` (tests module)

- [ ] **Step 1: Write the tests**

Add to the `tests` module:

```rust
#[test]
fn empty_linters_with_defaults_yields_no_settings_no_warnings() {
    let out = load_str("linters: linters_with_defaults()\n");
    assert!(
        out.settings.get("linting").is_none(),
        "no overrides means no linting object is contributed"
    );
    assert!(out.warnings.is_empty());
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
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests`
Expected: PASS (all loader tests, old and new).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs
git commit -m "test(lintr): cover positional/named/null/no-override combinations"
```

---

## Task 6: End-to-end coverage (`.lintr` JSON → `LintConfig`)

This proves the loader output actually drives `LintConfig` the way a user expects — not just that the intermediate JSON looks right.

**Files:**
- Test: `crates/raven/src/config_file/lintr_loader.rs` (tests module)

- [ ] **Step 1: Write the tests**

Add to the `tests` module. `parse_lint_config` is `pub(crate)`, reachable from inside the crate:

```rust
#[test]
fn empty_defaults_enable_all_defaults_when_discovered() {
    // `linters_with_defaults()` with no overrides + a discovered .lintr means
    // "linting on, every rule at its default" — verify the resolved LintConfig.
    let out = load_str("linters: linters_with_defaults()\n");
    let cfg = crate::backend::parse_lint_config(&out.settings, true).unwrap();
    let default = crate::linting::LintConfig::default();
    assert!(cfg.enabled, "a discovered .lintr resolves Auto -> on");
    assert_eq!(cfg.line_length, default.line_length);
    assert_eq!(cfg.object_length, default.object_length);
    assert_eq!(cfg.indentation_unit, default.indentation_unit);
    assert_eq!(cfg.commented_code_severity, default.commented_code_severity);
    assert_eq!(cfg.object_name_style_function, default.object_name_style_function);
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

    // commented_code stays at its default severity (recognized, not disabled).
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
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p raven --lib config_file::lintr_loader::tests` (runs the whole loader test module, including these three end-to-end tests)
Expected: PASS (the full loader test module is green).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs
git commit -m "test(lintr): end-to-end .lintr -> LintConfig coverage"
```

---

## Task 7: Documentation + full gate run

**Files:**
- Modify: `docs/linting.md:220-241` (mapping table + notes)

- [ ] **Step 1: Update the mapping-table notes in `docs/linting.md`**

Immediately after the mapping table (after line 239, before the `To disable a rule…` paragraph at line 241), add:

```markdown
Numeric-argument linters accept both the named and the first-positional form: `line_length_linter(80)` and `line_length_linter(length = 80)` are equivalent, as are `object_length_linter(40)` / `object_length_linter(length = 40)` and `indentation_linter(4)` / `indentation_linter(indent = 4)`.

`object_name_linter` accepts a **single** style name — positionally or via `styles =`, as a scalar or a one-element vector (e.g. `object_name_linter("camelCase")`, `object_name_linter(styles = c("snake_case"))`) — applied to functions, variables, and arguments. Style names must be one of `snake_case`, `camelCase`, `dotted.case`, `UPPER_CASE`, `lowercase`, or `any`. Forms Raven cannot represent — a raw regex style, or a multi-style vector such as `c("snake_case", "camelCase")` (which `lintr` treats as "matches any of these") — are reported in the batch warning and otherwise ignored, leaving the default `snake_case` checks in place. (`object_name_linter`'s `regexes =` argument is likewise unsupported; it is ignored.)
```

- [ ] **Step 2: Verify docs render / no broken table**

Run: `rg -n "positional|object_name_linter accepts" docs/linting.md`
Expected: the new lines appear.

- [ ] **Step 3: Run the full Rust gates (must be green before PR)**

```bash
cargo fmt --all
cargo fmt --all --check
cargo clippy --workspace --all-targets --features test-support -- -D warnings
cargo test -p raven --lib config_file::lintr_loader::tests
cargo test -p raven --lib linting::config::tests
cargo test -p raven --lib parse_lint_config
```
Expected: fmt clean, clippy zero warnings, all targeted tests PASS. (Run the test filters as three separate commands — one substring each — rather than relying on multiple positional filters.)

- [ ] **Step 4: Commit**

```bash
git add docs/linting.md
git commit -m "docs(linting): document positional args and object_name regex handling"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- "Cover this example" → Task 4 (loader) + Task 6 (end-to-end).
- "Any number and combination of valid settings overriding `linters_with_defaults`" → Task 5 (named/positional/NULL/mixed/bare-wrapper).
- "`linters_with_defaults()` without any overrides" → Task 5 (`empty_linters_with_defaults_*`) + Task 6 (`empty_defaults_enable_all_defaults_when_discovered`).
- "Each combination works as expected" → confirmed via both the JSON layer and the resolved `LintConfig` layer; two real bugs (positional indent, object_name styles) fixed in Tasks 2–3.

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `ObjectNameStyle::from_config_name` defined in Task 1 is used by name in Task 3 and Task 6; `parse_object_name_styles` defined and consumed within Task 3; `parse_lint_config` signature matches `backend.rs:686`. JSON keys (`indentationUnit`, `objectNameStyleFunction`, `trailingBlankLinesSeverity`, etc.) match the loader and `parse_lint_config`.

**Codex adversarial-review fixes folded in (2026-06-20):**
- **DCF closing-paren trap (BLOCKER):** multi-line fixtures must indent the closing `)` or `dcf_fold` drops it and nothing maps. All multi-line fixtures (Tasks 4, 6) and the Background example now use `\n    )\n`.
- **Multi-style vectors (MAJOR):** `c("snake_case", "camelCase")` is `lintr` OR-semantics, which Raven's one-style-per-kind model can't express; the arm now warns (unrepresentable) instead of silently mapping the first style. Tests and docs updated to match.
- **`regexes =` docs contradiction (MAJOR):** docs no longer claim `regexes =` warns; it is an ignored no-op, matching the code.
- **All-three style assertions (MINOR):** named and vector object-name tests now assert function, variable, and argument styles.
- **`cargo test` filters (MINOR):** every run uses a single substring/module filter, not multiple positional filters.

**Known risk for reviewer attention:** the unrepresentable-style → `unrecognized_constructs` choice (vs. a dedicated "no Raven equivalent" warning) follows the existing `quotes_linter(delimiter = …)` precedent. If the project prefers a specific message, Task 3 step 3(a) is the single edit point.
