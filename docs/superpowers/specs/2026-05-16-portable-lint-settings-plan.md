# Portable Lint Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Raven's settings (linting and the rest) to non-VS Code editors and CI via a project-root `raven.toml`, a documented subset of `.lintr`, and a `raven lint` CLI subcommand.

**Architecture:** A `config_file` module reads `raven.toml` (or `.lintr` fallback) into a `serde_json::Value` shaped exactly like the LSP `initializationOptions` payload. `WorldState` stores both the raw client settings and the raw project settings; a `recompute_parsed_configs` helper merges them (project keys win) and feeds the existing `parse_*_config` functions. A new `linting/rule_ids.rs` taxonomy wires `Diagnostic.code` through every rule. A new `raven lint` CLI walks `.R` / `.r` files and prints diagnostics in text/JSON/SARIF.

**Tech Stack:** Rust (tower-lsp 0.20, serde, toml, globset), tree-sitter-r, TypeScript (VS Code extension API), Bun (test harness for VS Code).

**Spec:** [docs/superpowers/specs/2026-05-16-portable-lint-settings-design.md](2026-05-16-portable-lint-settings-design.md)

---

## File Structure

```text
crates/raven/src/
  config_file/
    mod.rs              # Public entry: load_project_config(), recompute_parsed_configs()
    discovery.rs        # Walk up from workspace root, find raven.toml or .lintr
    toml_loader.rs      # TOML → serde_json::Value, validate, warn on unknown keys
    lintr_loader.rs     # DCF fold + token recognizer → project-shape JSON (linting only)
    merge.rs            # Layer-merge raw_client_settings + raw_project_settings
    overrides.rs        # CompiledLintOverride + per-document LintConfig resolution
  cli/
    lint.rs             # `raven lint` subcommand: walk, lint, format, exit code
  linting/
    rule_ids.rs         # Const taxonomy of rule IDs (LINE_LENGTH, OBJECT_NAME, ...)
  state.rs              # Add raw_client_settings, raw_project_settings,
                        # project_config_path, lint_overrides
  backend.rs            # initialize(), did_change_configuration(),
                        # did_change_watched_files(), dynamic registration
  handlers.rs           # Use overrides::resolve_lint_for_document() in snapshot build
  main.rs               # Dispatch `lint` subcommand alongside `analysis-stats`
  lib.rs                # Re-declare new modules

editors/vscode/
  package.json          # Add `raven.createProjectConfig` command contribution
  src/extension.ts      # Extend synchronize.fileEvents glob; handle notification;
                        # register scaffold command

docs/
  configuration.md      # Document raven.toml schema, precedence
  linting.md            # Point to raven.toml as primary path; runtime .lintr reader
  editor-integrations.md# Note that all editors now honor raven.toml
  cli.md                # Document `raven lint` flags, output, CI examples

tests/                  # (existing Rust integration tests inside crate)
```

---

## Tasks at a glance

| # | Task                                       | Why this order                                                |
| - | ------------------------------------------ | ------------------------------------------------------------- |
| 1 | Rule-ID taxonomy + wire `Diagnostic.code`  | Foundation; CLI and tests depend on stable rule IDs           |
| 2 | `WorldState` raw-layer fields              | Foundation; everything else stores into / reads from these    |
| 3 | TOML loader + discovery                    | Pure functions, well-isolated, used by initialize             |
| 4 | Layer merge + `recompute_parsed_configs`   | Pure function, called from initialize / did_change_config     |
| 5 | Compiled overrides + per-document resolver | Pure function, used by handlers and CLI                       |
| 6 | Wire LSP `initialize`                      | First end-to-end "loads `raven.toml`" milestone               |
| 7 | Wire `did_change_configuration`            | Per-key fallback works under client setting changes           |
| 8 | Wire `did_change_watched_files` + dynamic registration | Live reload on `raven.toml` edits                  |
| 9 | Per-document override resolution in handlers | Editor honors `[[linting.overrides]]` for open documents    |
| 10 | `.lintr` reader (DCF fold + recognizer)   | Migration path; isolated; doesn't block other CI/editor work  |
| 11 | `raven lint` CLI                          | CI use case; reuses everything above                          |
| 12 | VS Code extension                         | Synchronize glob + scaffold command + notification handler    |
| 13 | Documentation                             | After the implementation lands and shapes are final           |

---

## Task 1: Rule-ID taxonomy + `Diagnostic.code`

**Files:**
- Create: `crates/raven/src/linting/rule_ids.rs`
- Modify: `crates/raven/src/linting/mod.rs` (re-export `rule_ids`)
- Modify: every file in `crates/raven/src/linting/rules/*.rs` (add `code` to each `Diagnostic`)
- Modify: any test under `crates/raven/src/linting/` that asserts a full `Diagnostic` struct (add `.code`)

- [ ] **Step 1: Write `rule_ids.rs` with the taxonomy and a unit test**

Create `crates/raven/src/linting/rule_ids.rs`:

```rust
//! Stable rule identifiers for lint diagnostics.
//!
//! Each constant matches the rule name accepted by `# nolint: <rule>` markers
//! (see `docs/linting.md`). The strings are emitted as `Diagnostic.code` so the
//! `raven lint` CLI and SARIF output can map diagnostics back to rules.

pub const LINE_LENGTH: &str = "line_length";
pub const TRAILING_WHITESPACE: &str = "trailing_whitespace";
pub const NO_TAB: &str = "no_tab";
pub const TRAILING_BLANK_LINES: &str = "trailing_blank_lines";
pub const ASSIGNMENT_OPERATOR: &str = "assignment_operator";
pub const OBJECT_NAME: &str = "object_name";
pub const INFIX_SPACES: &str = "infix_spaces";
pub const COMMENTED_CODE: &str = "commented_code";
pub const QUOTES: &str = "quotes";
pub const COMMAS: &str = "commas";
pub const T_AND_F_SYMBOL: &str = "t_and_f_symbol";
pub const SEMICOLON: &str = "semicolon";
pub const EQUALS_NA: &str = "equals_na";
pub const OBJECT_LENGTH: &str = "object_length";
pub const VECTOR_LOGIC: &str = "vector_logic";
pub const FUNCTION_LEFT_PARENTHESES: &str = "function_left_parentheses";
pub const SPACES_INSIDE: &str = "spaces_inside";
pub const INDENTATION: &str = "indentation";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_ids_are_non_empty_and_unique() {
        let ids = [
            LINE_LENGTH, TRAILING_WHITESPACE, NO_TAB, TRAILING_BLANK_LINES,
            ASSIGNMENT_OPERATOR, OBJECT_NAME, INFIX_SPACES, COMMENTED_CODE,
            QUOTES, COMMAS, T_AND_F_SYMBOL, SEMICOLON, EQUALS_NA,
            OBJECT_LENGTH, VECTOR_LOGIC, FUNCTION_LEFT_PARENTHESES,
            SPACES_INSIDE, INDENTATION,
        ];
        for id in ids {
            assert!(!id.is_empty(), "rule id must be non-empty");
        }
        let mut sorted: Vec<&str> = ids.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "rule ids must be unique");
    }
}
```

- [ ] **Step 2: Declare the module and re-export the IDs**

In `crates/raven/src/linting/mod.rs`, add to the `mod` declarations near the top:

```rust
pub mod rule_ids;
```

- [ ] **Step 3: Run the new test, expect PASS**

Run: `cargo test -p raven linting::rule_ids::tests`
Expected: `1 passed`.

- [ ] **Step 4: Add `Diagnostic.code` to every rule**

For each file in `crates/raven/src/linting/rules/*.rs` (18 files: see file list at top of task), replace the existing `Diagnostic { ... ..Default::default() }` constructor with one that also sets `code`. Pattern — using `line_length.rs` as the canonical example, change:

```rust
out.push(Diagnostic {
    range: Range {
        start: Position::new(line_no, max_len),
        end: Position::new(line_no, width),
    },
    severity: Some(severity),
    source: Some(LINT_SOURCE.to_string()),
    message: format!("Line is {width} characters long; limit is {max_len}."),
    ..Default::default()
});
```

to:

```rust
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
```

For each rule file, add at the top of the imports:

```rust
use tower_lsp::lsp_types::NumberOrString;

use crate::linting::rule_ids;
```

The constant to pass varies per rule (`rule_ids::LINE_LENGTH`, `rule_ids::OBJECT_NAME`, etc.). Map file → constant:

| File | Constant |
|---|---|
| `line_length.rs` | `LINE_LENGTH` |
| `trailing_whitespace.rs` | `TRAILING_WHITESPACE` |
| `no_tab.rs` | `NO_TAB` |
| `trailing_blank_lines.rs` | `TRAILING_BLANK_LINES` |
| `assignment_operator.rs` | `ASSIGNMENT_OPERATOR` |
| `object_name.rs` | `OBJECT_NAME` |
| `infix_spaces.rs` | `INFIX_SPACES` |
| `commented_code.rs` | `COMMENTED_CODE` |
| `quotes.rs` | `QUOTES` |
| `commas.rs` | `COMMAS` |
| `t_and_f_symbol.rs` | `T_AND_F_SYMBOL` |
| `semicolon.rs` | `SEMICOLON` |
| `equals_na.rs` | `EQUALS_NA` |
| `object_length.rs` | `OBJECT_LENGTH` |
| `vector_logic.rs` | `VECTOR_LOGIC` |
| `function_left_parentheses.rs` | `FUNCTION_LEFT_PARENTHESES` |
| `spaces_inside.rs` | `SPACES_INSIDE` |
| `indentation.rs` | `INDENTATION` |

Some rule files emit more than one `Diagnostic` (e.g. `object_name.rs` for function/variable/argument). All emissions in a single file use the same constant.

- [ ] **Step 5: Write a per-rule integration test**

Append to `crates/raven/src/linting/mod.rs` (under the existing `#[cfg(test)]` module, or add one if it doesn't exist). The test fires each rule against a fixture line known to trigger it, then asserts the produced diagnostic's `code` matches the corresponding `rule_ids::*` constant. Catches "added a new rule, forgot to wire `code`" mistakes.

```rust
#[cfg(test)]
mod code_field_tests {
    use super::*;
    use tower_lsp::lsp_types::{DiagnosticSeverity, NumberOrString};

    fn rule_id_of(d: &tower_lsp::lsp_types::Diagnostic) -> Option<&str> {
        match &d.code {
            Some(NumberOrString::String(s)) => Some(s.as_str()),
            _ => None,
        }
    }

    fn parse(text: &str) -> tree_sitter::Tree {
        let mut p = tree_sitter::Parser::new();
        p.set_language(&tree_sitter_r::LANGUAGE.into()).unwrap();
        p.parse(text, None).unwrap()
    }

    fn run_one(text: &str, configure: impl FnOnce(&mut LintConfig)) -> Vec<tower_lsp::lsp_types::Diagnostic> {
        let mut cfg = LintConfig::default();
        cfg.enabled = true;
        configure(&mut cfg);
        let tree = parse(text);
        run_lints(text, tree.root_node(), &cfg)
    }

    /// Each pair: (rule id, configure-LintConfig closure, fixture text known
    /// to trigger that rule). Every entry must produce ≥ 1 diagnostic whose
    /// `code` equals the rule id.
    #[test]
    fn every_rule_emits_its_id() {
        use super::rule_ids::*;

        // Helper to bump a Severity slot from Hint → Warning to make sure
        // the rule is on (LintConfig::default() already enables all of them
        // at Hint).
        fn warn(slot: &mut Option<DiagnosticSeverity>) {
            *slot = Some(DiagnosticSeverity::WARNING);
        }

        let cases: Vec<(&str, Box<dyn Fn(&mut LintConfig)>, &str)> = vec![
            (LINE_LENGTH, Box::new(|c| { c.line_length = 4; warn(&mut c.line_length_severity); }),
             "very_long_line\n"),
            (TRAILING_WHITESPACE, Box::new(|c| warn(&mut c.trailing_whitespace_severity)),
             "x <- 1   \n"),
            (NO_TAB, Box::new(|c| warn(&mut c.no_tab_severity)),
             "\tx <- 1\n"),
            (TRAILING_BLANK_LINES, Box::new(|c| warn(&mut c.trailing_blank_lines_severity)),
             "x <- 1\n\n\n"),
            (ASSIGNMENT_OPERATOR, Box::new(|c| warn(&mut c.assignment_operator_severity)),
             "x = 1\n"),
            (OBJECT_NAME, Box::new(|c| warn(&mut c.object_name_severity)),
             "BadName <- 1\n"),
            (INFIX_SPACES, Box::new(|c| warn(&mut c.infix_spaces_severity)),
             "x<-1+2\n"),
            (COMMENTED_CODE, Box::new(|c| warn(&mut c.commented_code_severity)),
             "# x <- 1\n"),
            (QUOTES, Box::new(|c| warn(&mut c.quotes_severity)),
             "x <- 'single'\n"),
            (COMMAS, Box::new(|c| warn(&mut c.commas_severity)),
             "f(a ,b)\n"),
            (T_AND_F_SYMBOL, Box::new(|c| warn(&mut c.t_and_f_symbol_severity)),
             "if (T) 1 else 2\n"),
            (SEMICOLON, Box::new(|c| warn(&mut c.semicolon_severity)),
             "x <- 1; y <- 2\n"),
            (EQUALS_NA, Box::new(|c| warn(&mut c.equals_na_severity)),
             "if (x == NA) 1\n"),
            (OBJECT_LENGTH, Box::new(|c| { c.object_length = 4; warn(&mut c.object_length_severity); }),
             "very_long_name <- 1\n"),
            (VECTOR_LOGIC, Box::new(|c| warn(&mut c.vector_logic_severity)),
             "if (x & y) 1\n"),
            (FUNCTION_LEFT_PARENTHESES, Box::new(|c| warn(&mut c.function_left_parentheses_severity)),
             "f <- function (x) x\n"),
            (SPACES_INSIDE, Box::new(|c| warn(&mut c.spaces_inside_severity)),
             "f( x )\n"),
            (INDENTATION, Box::new(|c| warn(&mut c.indentation_severity)),
             "if (x) {\n   y <- 1\n}\n"),
        ];

        for (expected_id, configure, fixture) in cases {
            let diags = run_one(fixture, |c| configure(c));
            let matched: Vec<_> = diags.iter()
                .filter(|d| rule_id_of(d) == Some(expected_id))
                .collect();
            assert!(
                !matched.is_empty(),
                "rule {} produced no diagnostic for fixture {:?}; emissions: {:?}",
                expected_id, fixture, diags
            );
        }
    }
}
```

If a particular fixture line doesn't trigger the rule (e.g. the parser changes a behavior over time), tighten that fixture rather than removing the assertion — the test is the contract.

- [ ] **Step 6: Run the full linting test suite**

Run: `cargo test -p raven linting`
Expected: all tests pass. If any existing snapshot test compares `Diagnostic` structs literally and now fails because of the new `code` field, update the snapshot to include the expected code.

- [ ] **Step 7: Commit**

```bash
git add crates/raven/src/linting/rule_ids.rs crates/raven/src/linting/mod.rs \
        crates/raven/src/linting/rules
git commit -m "feat(linting): add stable rule_ids taxonomy and emit Diagnostic.code

CLI [rule] suffix and SARIF ruleId need a stable identifier per rule;
LSP clients also display Diagnostic.code in the Problems pane."
```

---

## Task 2: `WorldState` raw-layer fields

**Files:**
- Modify: `crates/raven/src/state.rs:528-580` (struct), `:622-699` (constructor)

- [ ] **Step 1: Add the four new fields to the struct**

In `crates/raven/src/state.rs`, find the `WorldState` struct (line 528). After the existing config fields (`lint_config`), add:

```rust
    /// Last-seen client-supplied settings: LSP `initializationOptions` at
    /// startup, then the latest `did_change_configuration` payload. Stored
    /// raw so we can re-merge with the project file on either side changing.
    pub raw_client_settings: serde_json::Value,

    /// Last-loaded `raven.toml` (or `.lintr`-derived JSON), or `None` if no
    /// project config file is present. Stored raw for the same reason.
    pub raw_project_settings: Option<serde_json::Value>,

    /// Resolved path of the project config currently in effect, if any.
    /// Reported via `raven/projectConfigLoaded` to the client.
    pub project_config_path: Option<std::path::PathBuf>,

    /// Compiled `[[linting.overrides]]` entries. Empty when no overrides
    /// are configured. Per-document resolution scans this list.
    pub lint_overrides: Vec<crate::config_file::CompiledLintOverride>,
```

(This references `crate::config_file::CompiledLintOverride`, which is defined in Task 5. To keep this commit standalone, define a temporary placeholder now: see Step 2 below.)

- [ ] **Step 2: Create the placeholder `config_file` module so the type resolves**

Create `crates/raven/src/config_file/mod.rs`:

```rust
//! Project-level configuration loader (raven.toml, .lintr).
//!
//! This module is built out across tasks 3-5. For now it only exports the
//! `CompiledLintOverride` type referenced from `WorldState`.

#[derive(Debug, Clone)]
pub struct CompiledLintOverride {
    /// Placeholder. Real fields land in Task 5.
    pub _placeholder: (),
}
```

Declare the module in both `crates/raven/src/lib.rs` and `crates/raven/src/main.rs` (CLAUDE.md "Module declarations" Learning):

In `crates/raven/src/lib.rs` (alongside other `mod` lines):

```rust
pub mod config_file;
```

In `crates/raven/src/main.rs` (alongside other `mod` lines, currently lines 8-40):

```rust
mod config_file;
```

- [ ] **Step 3: Initialize the new fields in `WorldState::new`**

In `crates/raven/src/state.rs:657-698`, add to the struct literal returned by `new()`:

```rust
            raw_client_settings: serde_json::Value::Object(serde_json::Map::new()),
            raw_project_settings: None,
            project_config_path: None,
            lint_overrides: Vec::new(),
```

- [ ] **Step 4: Build**

Run: `cargo build -p raven`
Expected: success. Any test fixture that constructs `WorldState` via `WorldState::new` keeps working because the new fields take their defaults from `new()`.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/state.rs crates/raven/src/config_file/mod.rs \
        crates/raven/src/lib.rs crates/raven/src/main.rs
git commit -m "refactor(state): add raw-layer settings fields for per-key fallback

WorldState gains raw_client_settings, raw_project_settings,
project_config_path, and lint_overrides. The real config_file types
come in tasks 3-5; this commit just plumbs the placeholders."
```

---

## Task 3: TOML loader + discovery

**Files:**
- Create: `crates/raven/src/config_file/discovery.rs`
- Create: `crates/raven/src/config_file/toml_loader.rs`
- Modify: `crates/raven/src/config_file/mod.rs` (re-export)
- Modify: `crates/raven/Cargo.toml` (add `toml` dependency if not present)

- [ ] **Step 1: Add `toml` to Cargo.toml if needed**

Check `crates/raven/Cargo.toml`. If `toml = "..."` is not listed, add under `[dependencies]`:

```toml
toml = "0.8"
```

Run: `cargo build -p raven` to confirm the dep resolves.

- [ ] **Step 2: Write discovery test**

Create `crates/raven/src/config_file/discovery.rs` with this test stub at the bottom:

```rust
//! Walk upward from a starting directory looking for raven.toml or .lintr.

use std::path::{Path, PathBuf};

/// Result of a config-file discovery walk.
#[derive(Debug, Clone, PartialEq)]
pub enum DiscoveredConfig {
    RavenToml(PathBuf),
    Lintr(PathBuf),
    None,
}

/// Walk upward from `start` (inclusive) toward the filesystem root, returning
/// the first `raven.toml` found. If none is found, return the first `.lintr`
/// found on the same walk. Walks at most `MAX_DEPTH` levels.
const MAX_DEPTH: usize = 32;

pub fn find_config(start: &Path) -> DiscoveredConfig {
    let mut current: Option<&Path> = Some(start);
    let mut lintr_fallback: Option<PathBuf> = None;
    let mut depth = 0;

    while let Some(dir) = current {
        if depth > MAX_DEPTH {
            break;
        }
        let candidate = dir.join("raven.toml");
        if candidate.is_file() {
            return DiscoveredConfig::RavenToml(candidate);
        }
        if lintr_fallback.is_none() {
            let lintr = dir.join(".lintr");
            if lintr.is_file() {
                lintr_fallback = Some(lintr);
            }
        }
        current = dir.parent();
        depth += 1;
    }

    match lintr_fallback {
        Some(p) => DiscoveredConfig::Lintr(p),
        None => DiscoveredConfig::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn finds_raven_toml_in_start_dir() {
        let tmp = TempDir::new().unwrap();
        let toml = tmp.path().join("raven.toml");
        fs::write(&toml, "").unwrap();
        assert_eq!(find_config(tmp.path()), DiscoveredConfig::RavenToml(toml));
    }

    #[test]
    fn finds_raven_toml_in_parent_dir() {
        let tmp = TempDir::new().unwrap();
        let toml = tmp.path().join("raven.toml");
        fs::write(&toml, "").unwrap();
        let sub = tmp.path().join("src");
        fs::create_dir(&sub).unwrap();
        assert_eq!(find_config(&sub), DiscoveredConfig::RavenToml(toml));
    }

    #[test]
    fn falls_back_to_lintr_when_no_raven_toml() {
        let tmp = TempDir::new().unwrap();
        let lintr = tmp.path().join(".lintr");
        fs::write(&lintr, "linters: linters_with_defaults()\n").unwrap();
        assert_eq!(find_config(tmp.path()), DiscoveredConfig::Lintr(lintr));
    }

    #[test]
    fn raven_toml_wins_over_lintr_at_same_level() {
        let tmp = TempDir::new().unwrap();
        let toml = tmp.path().join("raven.toml");
        let lintr = tmp.path().join(".lintr");
        fs::write(&toml, "").unwrap();
        fs::write(&lintr, "linters: linters_with_defaults()\n").unwrap();
        assert_eq!(find_config(tmp.path()), DiscoveredConfig::RavenToml(toml));
    }

    #[test]
    fn returns_none_when_neither_present() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(find_config(tmp.path()), DiscoveredConfig::None);
    }
}
```

In `crates/raven/Cargo.toml`'s `[dev-dependencies]`, ensure `tempfile` is present (it almost certainly is — `cargo build -p raven --tests` will confirm).

- [ ] **Step 3: Run discovery tests**

Run: `cargo test -p raven config_file::discovery`
Expected: 5 passed.

- [ ] **Step 4: Write TOML loader test**

Create `crates/raven/src/config_file/toml_loader.rs`:

```rust
//! Load `raven.toml` into a `serde_json::Value` shaped exactly like the LSP
//! `initializationOptions` payload. Unknown keys produce a warning but do not
//! abort the load.

use std::path::Path;

use serde_json::Value;

/// Outcome of a TOML-load attempt.
pub struct LoadedToml {
    /// The decoded settings as JSON, ready to feed `parse_*_config` after
    /// merging with client settings.
    pub settings: Value,
    /// Warning messages collected during load. Caller should log each.
    pub warnings: Vec<String>,
}

/// Read `path` as TOML and convert into project-shape JSON. Returns `None`
/// if the file cannot be read or parsed; warnings are still collected when a
/// recoverable schema issue is encountered (unknown keys).
pub fn load(path: &Path) -> Option<LoadedToml> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("raven.toml: cannot read {}: {}", path.display(), e);
            return None;
        }
    };
    load_str(&text, &path.display().to_string())
}

/// Pure variant for testing.
pub fn load_str(text: &str, source_label: &str) -> Option<LoadedToml> {
    let toml_value: toml::Value = match toml::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("{source_label}: malformed TOML: {e}");
            return None;
        }
    };
    let json = toml_to_json(toml_value);
    let mut warnings = Vec::new();
    if let Value::Object(map) = &json {
        validate_top_level_keys(map, source_label, &mut warnings);
    } else {
        warnings.push(format!("{source_label}: top-level value must be a table"));
        return Some(LoadedToml { settings: Value::Object(serde_json::Map::new()), warnings });
    }
    Some(LoadedToml { settings: json, warnings })
}

/// Recursive TOML → JSON conversion. TOML's date/time types are stringified
/// (we don't expect them in Raven's schema; this keeps the loader total).
fn toml_to_json(value: toml::Value) -> Value {
    match value {
        toml::Value::String(s) => Value::String(s),
        toml::Value::Integer(i) => Value::Number(i.into()),
        toml::Value::Float(f) => {
            serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
        }
        toml::Value::Boolean(b) => Value::Bool(b),
        toml::Value::Datetime(dt) => Value::String(dt.to_string()),
        toml::Value::Array(arr) => Value::Array(arr.into_iter().map(toml_to_json).collect()),
        toml::Value::Table(table) => {
            let map: serde_json::Map<String, Value> =
                table.into_iter().map(|(k, v)| (k, toml_to_json(v))).collect();
            Value::Object(map)
        }
    }
}

const KNOWN_TOP_LEVEL: &[&str] = &[
    "linting",
    "crossFile",
    "packages",
    "diagnostics",
    "indentation",
    "symbols",
    "completion",
];

const KNOWN_LINTING_KEYS: &[&str] = &[
    "enabled", "lineLength", "objectLength", "indentationUnit",
    "assignmentOperator", "stringDelimiter",
    "objectNameStyleFunction", "objectNameStyleVariable", "objectNameStyleArgument",
    "lineLengthSeverity", "trailingWhitespaceSeverity", "noTabSeverity",
    "trailingBlankLinesSeverity", "assignmentOperatorSeverity", "objectNameSeverity",
    "infixSpacesSeverity", "commentedCodeSeverity", "quotesSeverity", "commasSeverity",
    "tAndFSymbolSeverity", "semicolonSeverity", "equalsNaSeverity", "objectLengthSeverity",
    "vectorLogicSeverity", "functionLeftParenthesesSeverity", "spacesInsideSeverity",
    "indentationSeverity", "overrides",
];

/// For nested validation we accept the existence of any key in a known
/// section but warn on unknown leaves. The exhaustive nested key lists live
/// at the call sites of `parse_*_config` in `backend.rs`; for v1 we validate
/// `[linting]` (the most user-facing section) and trust the parsers to
/// ignore unrecognized keys in the other sections quietly.
fn validate_top_level_keys(
    map: &serde_json::Map<String, Value>,
    source_label: &str,
    warnings: &mut Vec<String>,
) {
    for (key, value) in map {
        if !KNOWN_TOP_LEVEL.contains(&key.as_str()) {
            warnings.push(format!("{source_label}: unknown top-level key '{key}'; ignoring"));
            continue;
        }
        if key == "linting" {
            if let Value::Object(linting_map) = value {
                for nested in linting_map.keys() {
                    if !KNOWN_LINTING_KEYS.contains(&nested.as_str()) {
                        warnings.push(format!(
                            "{source_label}: unknown key 'linting.{nested}'; ignoring"
                        ));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linting_section() {
        let toml = r#"
[linting]
enabled = true
lineLength = 100
lineLengthSeverity = "warning"
"#;
        let out = load_str(toml, "test").unwrap();
        assert_eq!(out.warnings, Vec::<String>::new());
        let linting = out.settings.get("linting").unwrap();
        assert_eq!(linting["enabled"], serde_json::json!(true));
        assert_eq!(linting["lineLength"], serde_json::json!(100));
        assert_eq!(linting["lineLengthSeverity"], serde_json::json!("warning"));
    }

    #[test]
    fn parses_nested_crossfile_section() {
        let toml = r#"
[crossFile.onDemandIndexing]
enabled = true
maxTransitiveDepth = 5
"#;
        let out = load_str(toml, "test").unwrap();
        let on_demand = &out.settings["crossFile"]["onDemandIndexing"];
        assert_eq!(on_demand["enabled"], serde_json::json!(true));
        assert_eq!(on_demand["maxTransitiveDepth"], serde_json::json!(5));
    }

    #[test]
    fn parses_overrides_as_array() {
        let toml = r#"
[linting]
lineLength = 80

[[linting.overrides]]
files = ["tests/**/*.R"]
lineLength = 120

[[linting.overrides]]
files = ["R/legacy_*.R"]
enabled = false
"#;
        let out = load_str(toml, "test").unwrap();
        let overrides = out.settings["linting"]["overrides"].as_array().unwrap();
        assert_eq!(overrides.len(), 2);
        assert_eq!(overrides[0]["lineLength"], serde_json::json!(120));
        assert_eq!(overrides[1]["enabled"], serde_json::json!(false));
    }

    #[test]
    fn unknown_top_level_keys_produce_warning() {
        let toml = r#"
[linting]
enabled = true

[bogusSection]
foo = 1
"#;
        let out = load_str(toml, "test").unwrap();
        assert_eq!(out.warnings.len(), 1);
        assert!(out.warnings[0].contains("bogusSection"));
    }

    #[test]
    fn unknown_nested_linting_key_produces_warning() {
        let toml = r#"
[linting]
enabled = true
foo = 42
"#;
        let out = load_str(toml, "test").unwrap();
        assert_eq!(out.warnings.len(), 1);
        assert!(out.warnings[0].contains("linting.foo"));
    }

    #[test]
    fn malformed_toml_returns_none() {
        let toml = "this is not = valid = toml = at all";
        assert!(load_str(toml, "test").is_none());
    }
}
```

- [ ] **Step 5: Re-export from `config_file/mod.rs`**

Replace the placeholder content of `crates/raven/src/config_file/mod.rs` with:

```rust
//! Project-level configuration loader (raven.toml, .lintr).

pub mod discovery;
pub mod toml_loader;

pub use discovery::{find_config, DiscoveredConfig};
pub use toml_loader::{load as load_toml, load_str as load_toml_str, LoadedToml};

/// Placeholder until Task 5 lands the real type.
#[derive(Debug, Clone)]
pub struct CompiledLintOverride {
    pub _placeholder: (),
}
```

- [ ] **Step 6: Run all new tests**

Run: `cargo test -p raven config_file`
Expected: 11 passed (5 discovery + 6 toml_loader).

- [ ] **Step 7: Commit**

```bash
git add crates/raven/Cargo.toml crates/raven/src/config_file
git commit -m "feat(config_file): add raven.toml discovery and TOML→JSON loader

Walks up from a workspace folder looking for raven.toml (preferred) or
.lintr (fallback). TOML loader converts to serde_json::Value shaped to
match the LSP initializationOptions payload, with warnings on unknown
top-level keys."
```

---

## Task 4: Layer merge + `recompute_parsed_configs`

**Files:**
- Create: `crates/raven/src/config_file/merge.rs`
- Modify: `crates/raven/src/config_file/mod.rs` (re-export, add `recompute_parsed_configs`)

- [ ] **Step 1: Write merge tests**

Create `crates/raven/src/config_file/merge.rs`:

```rust
//! Layer-merge raw client settings + raw project settings into a single
//! JSON tree suitable for the existing `parse_*_config` functions.
//!
//! Merge semantics: deep-merge objects; project values overwrite client
//! values at the leaf level; arrays are taken whole (no element-level merge).

use serde_json::Value;

/// Merge `project` into a clone of `client`. The result has every key from
/// either layer; conflicting leaves prefer `project`. Arrays at the same
/// path are replaced by the project version (no concatenation).
pub fn merge(client: &Value, project: Option<&Value>) -> Value {
    let mut out = client.clone();
    if let Some(p) = project {
        merge_into(&mut out, p);
    }
    out
}

fn merge_into(dst: &mut Value, src: &Value) {
    match (dst, src) {
        (Value::Object(dst_map), Value::Object(src_map)) => {
            for (k, v) in src_map {
                match dst_map.get_mut(k) {
                    Some(existing) => merge_into(existing, v),
                    None => {
                        dst_map.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (slot, src_val) => {
            *slot = src_val.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_overrides_client_at_leaf() {
        let client = json!({ "linting": { "lineLength": 80 } });
        let project = json!({ "linting": { "lineLength": 120 } });
        assert_eq!(merge(&client, Some(&project)), json!({ "linting": { "lineLength": 120 } }));
    }

    #[test]
    fn client_key_passes_through_when_project_silent() {
        let client = json!({ "linting": { "objectLength": 40 } });
        let project = json!({ "linting": { "lineLength": 100 } });
        let merged = merge(&client, Some(&project));
        assert_eq!(merged["linting"]["objectLength"], json!(40));
        assert_eq!(merged["linting"]["lineLength"], json!(100));
    }

    #[test]
    fn unrelated_sections_coexist() {
        let client = json!({ "packages": { "rPath": "/usr/bin/R" } });
        let project = json!({ "linting": { "enabled": true } });
        let merged = merge(&client, Some(&project));
        assert_eq!(merged["packages"]["rPath"], json!("/usr/bin/R"));
        assert_eq!(merged["linting"]["enabled"], json!(true));
    }

    #[test]
    fn arrays_are_replaced_wholesale() {
        let client = json!({ "packages": { "additionalLibraryPaths": ["/a"] } });
        let project = json!({ "packages": { "additionalLibraryPaths": ["/b", "/c"] } });
        let merged = merge(&client, Some(&project));
        assert_eq!(merged["packages"]["additionalLibraryPaths"], json!(["/b", "/c"]));
    }

    #[test]
    fn project_none_yields_client_clone() {
        let client = json!({ "linting": { "enabled": true } });
        assert_eq!(merge(&client, None), client);
    }

    #[test]
    fn client_null_yields_project_clone() {
        let project = json!({ "linting": { "enabled": true } });
        assert_eq!(merge(&Value::Null, Some(&project)), project);
    }
}
```

- [ ] **Step 2: Run merge tests**

Run: `cargo test -p raven config_file::merge`
Expected: 6 passed.

- [ ] **Step 3: Add `recompute_parsed_configs` helper to `config_file/mod.rs`**

Append to `crates/raven/src/config_file/mod.rs`:

```rust
pub mod merge;
pub use merge::merge as merge_settings;

/// Re-run every `parse_*_config` over the merged `(client, project)` JSON
/// and overwrite the parsed configs on `state`. Idempotent.
///
/// Resets each parsed config to its struct default when the corresponding
/// section is absent in the merged JSON. This matches the spec's layered
/// precedence: built-in defaults are the floor; client-supplied settings
/// and project-supplied settings layer on top. Both layers being silent on
/// a section means "fall to default", not "preserve whatever was there".
///
/// One exception: `parse_cross_file_config` returns `Ok(None)` when ALL of
/// `crossFile`, `diagnostics`, `packages` are absent — in that case we still
/// overwrite with `CrossFileConfig::default()`. A validation error
/// (`Err(...)`) is logged and the existing config is preserved (best-effort
/// graceful degradation; same as the existing behavior at
/// `backend.rs:3819-3838`).
///
/// Callers: `backend::initialize`, `backend::did_change_configuration`,
/// `backend::did_change_watched_files` (project-config change).
pub fn recompute_parsed_configs(state: &mut crate::state::WorldState) {
    let merged = merge_settings(&state.raw_client_settings, state.raw_project_settings.as_ref());

    match crate::backend::parse_cross_file_config(&merged) {
        Ok(Some(cfg)) => {
            state.resize_caches(&cfg);
            state.cross_file_config = cfg;
        }
        Ok(None) => {
            let cfg = crate::cross_file::CrossFileConfig::default();
            state.resize_caches(&cfg);
            state.cross_file_config = cfg;
        }
        Err(err) => {
            log::warn!("recompute_parsed_configs: cross_file validation error: {err}");
        }
    }
    state.symbol_config = crate::backend::parse_symbol_config(&merged).unwrap_or_default();
    state.completion_config =
        crate::backend::parse_completion_config(&merged).unwrap_or_default();
    state.indentation_config =
        crate::backend::parse_indentation_config(&merged).unwrap_or_default();
    state.lint_config = crate::backend::parse_lint_config(&merged).unwrap_or_default();
}
```

(All five parser functions in `crates/raven/src/backend.rs` are already `pub(crate)`. Verify with `grep -n "fn parse_.*_config" crates/raven/src/backend.rs` before writing the call sites — every match should start `pub(crate) fn parse_...`.)

- [ ] **Step 4: Build**

Run: `cargo build -p raven`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/config_file
git commit -m "feat(config_file): add layer-merge helper and recompute hook

merge() deep-merges raw client settings with raw project settings,
producing the JSON the existing parse_*_config functions expect.
recompute_parsed_configs() is the single entry point for refreshing
WorldState's parsed configs after any layer changes."
```

---

## Task 5: Compiled overrides + per-document resolver

**Files:**
- Create: `crates/raven/src/config_file/overrides.rs`
- Modify: `crates/raven/src/config_file/mod.rs` (replace placeholder, re-export)
- Modify: `crates/raven/Cargo.toml` (add `globset` if not present)

- [ ] **Step 1: Add `globset` dependency**

Check `crates/raven/Cargo.toml`. If `globset = "..."` is not listed, add:

```toml
globset = "0.4"
```

- [ ] **Step 2: Write the override resolver**

Create `crates/raven/src/config_file/overrides.rs`:

```rust
//! Compiled per-glob lint overrides and per-document `LintConfig` resolution.

use std::path::{Path, PathBuf};

use globset::{Glob, GlobMatcher};
use serde_json::Value;
use tower_lsp::lsp_types::Url;

use crate::backend::parse_lint_config_from_section;
use crate::linting::LintConfig;

/// A single `[[linting.overrides]]` entry, compiled.
#[derive(Debug, Clone)]
pub struct CompiledLintOverride {
    /// Project root the globs are anchored at.
    pub root: PathBuf,
    /// Compiled glob matchers for `files = [...]`. An override matches when
    /// any of its globs match a document's project-relative path.
    pub matchers: Vec<GlobMatcher>,
    /// The override's body, stored as a partial JSON object that can be
    /// applied as a patch on top of the base `[linting]` JSON.
    pub patch: Value,
}

/// Build compiled overrides from the merged `[linting].overrides` array.
/// `root` is the directory containing `raven.toml`. Returns an empty vec if
/// no overrides are configured.
pub fn compile_from_settings(merged: &Value, root: &Path) -> Vec<CompiledLintOverride> {
    let Some(arr) = merged.get("linting").and_then(|v| v.get("overrides")).and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(arr.len());
    for (idx, entry) in arr.iter().enumerate() {
        let Some(obj) = entry.as_object() else {
            log::warn!("raven.toml: [[linting.overrides]] entry #{} is not a table; skipping", idx);
            continue;
        };
        let Some(files) = obj.get("files").and_then(|v| v.as_array()) else {
            log::warn!("raven.toml: [[linting.overrides]] entry #{} missing `files`; skipping", idx);
            continue;
        };
        let mut matchers = Vec::new();
        for f in files {
            let Some(s) = f.as_str() else { continue };
            match Glob::new(s) {
                Ok(g) => matchers.push(g.compile_matcher()),
                Err(e) => log::warn!(
                    "raven.toml: [[linting.overrides]] entry #{} has invalid glob {:?}: {}",
                    idx, s, e
                ),
            }
        }
        if matchers.is_empty() {
            continue;
        }
        // Drop `files`; everything else is the patch.
        let mut patch = entry.clone();
        if let Value::Object(map) = &mut patch {
            map.remove("files");
        }
        out.push(CompiledLintOverride { root: root.to_path_buf(), matchers, patch });
    }
    out
}

/// Resolve the effective `LintConfig` for a document. Walks `overrides` in
/// order, applying any whose glob matches `document_uri`'s project-relative
/// path. Returns the base `LintConfig` if no overrides match (or if the URI
/// can't be resolved to a project-relative path).
pub fn resolve_lint_for_document(
    base: &LintConfig,
    base_section: &Value,
    overrides: &[CompiledLintOverride],
    document_uri: &Url,
) -> LintConfig {
    if overrides.is_empty() {
        return base.clone();
    }
    let Some(file_path) = document_uri.to_file_path().ok() else {
        return base.clone();
    };
    let Some(root) = overrides.first().map(|o| o.root.as_path()) else {
        return base.clone();
    };
    let Ok(rel) = file_path.strip_prefix(root) else {
        return base.clone();
    };

    // Start with the base [linting] section JSON and layer matching overrides
    // on top, then re-parse. This keeps semantics identical to what the LSP
    // does at startup.
    let mut effective = base_section.clone();
    let mut matched_any = false;
    for ov in overrides {
        if ov.matchers.iter().any(|m| m.is_match(rel)) {
            matched_any = true;
            merge_in_place(&mut effective, &ov.patch);
        }
    }
    if !matched_any {
        return base.clone();
    }
    parse_lint_config_from_section(&effective).unwrap_or_else(|| base.clone())
}

/// Returns true if the override has `enabled = false` after applying patches;
/// callers (CLI) use this to short-circuit before parsing the file.
pub fn is_skipped_by_overrides(
    base_section: &Value,
    overrides: &[CompiledLintOverride],
    relative_path: &Path,
) -> bool {
    let mut effective = base_section.clone();
    let mut matched = false;
    for ov in overrides {
        if ov.matchers.iter().any(|m| m.is_match(relative_path)) {
            matched = true;
            merge_in_place(&mut effective, &ov.patch);
        }
    }
    if !matched {
        return false;
    }
    effective.get("enabled").and_then(|v| v.as_bool()) == Some(false)
}

fn merge_in_place(dst: &mut Value, src: &Value) {
    crate::config_file::merge::merge_in_place_pub(dst, src);
}
```

The helper `parse_lint_config_from_section` operates on a `[linting]` section object directly rather than the full settings JSON. Add it to `backend.rs` alongside `parse_lint_config` (Task 6 will deal with it; for now declare the function signature so this module compiles):

In `crates/raven/src/backend.rs`, near `parse_lint_config` (line 473), add:

```rust
/// Variant of `parse_lint_config` that takes the `[linting]` section directly
/// (not wrapped in a top-level object). Used by per-document override resolution
/// where we've already extracted the section.
pub(crate) fn parse_lint_config_from_section(
    section: &serde_json::Value,
) -> Option<crate::linting::LintConfig> {
    // Wrap into the shape `parse_lint_config` expects and delegate.
    let wrapped = serde_json::json!({ "linting": section });
    parse_lint_config(&wrapped)
}
```

And in `crates/raven/src/config_file/merge.rs`, expose the internal in-place merge so `overrides.rs` can use it without duplicating logic:

```rust
/// In-place variant used by callers that already own a mutable destination.
pub fn merge_in_place_pub(dst: &mut Value, src: &Value) {
    merge_into(dst, src);
}
```

- [ ] **Step 3: Test the resolver**

Append to `crates/raven/src/config_file/overrides.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tower_lsp::lsp_types::Url;

    fn make_overrides(root: &Path, patches: Vec<(&str, Value)>) -> Vec<CompiledLintOverride> {
        patches
            .into_iter()
            .map(|(glob, patch)| CompiledLintOverride {
                root: root.to_path_buf(),
                matchers: vec![Glob::new(glob).unwrap().compile_matcher()],
                patch,
            })
            .collect()
    }

    #[test]
    fn no_overrides_returns_base() {
        let base = LintConfig::default();
        let section = json!({});
        let uri = Url::parse("file:///proj/R/foo.R").unwrap();
        let out = resolve_lint_for_document(&base, &section, &[], &uri);
        assert_eq!(out.line_length, base.line_length);
    }

    #[test]
    fn matching_glob_applies_patch() {
        let mut base = LintConfig::default();
        base.line_length = 80;
        let section = json!({ "lineLength": 80, "enabled": true });
        let root = PathBuf::from("/proj");
        let overrides = make_overrides(
            &root,
            vec![("tests/**/*.R", json!({ "lineLength": 120 }))],
        );
        let uri = Url::parse("file:///proj/tests/test-foo.R").unwrap();
        let out = resolve_lint_for_document(&base, &section, &overrides, &uri);
        assert_eq!(out.line_length, 120);
    }

    #[test]
    fn non_matching_glob_returns_base() {
        let mut base = LintConfig::default();
        base.line_length = 80;
        let section = json!({ "lineLength": 80 });
        let root = PathBuf::from("/proj");
        let overrides = make_overrides(
            &root,
            vec![("tests/**/*.R", json!({ "lineLength": 120 }))],
        );
        let uri = Url::parse("file:///proj/R/foo.R").unwrap();
        let out = resolve_lint_for_document(&base, &section, &overrides, &uri);
        assert_eq!(out.line_length, 80);
    }

    #[test]
    fn later_override_wins_on_same_key() {
        let mut base = LintConfig::default();
        base.line_length = 80;
        let section = json!({ "lineLength": 80, "enabled": true });
        let root = PathBuf::from("/proj");
        let overrides = vec![
            CompiledLintOverride {
                root: root.clone(),
                matchers: vec![Glob::new("R/**/*.R").unwrap().compile_matcher()],
                patch: json!({ "lineLength": 100 }),
            },
            CompiledLintOverride {
                root: root.clone(),
                matchers: vec![Glob::new("R/legacy/**/*.R").unwrap().compile_matcher()],
                patch: json!({ "lineLength": 200 }),
            },
        ];
        let uri = Url::parse("file:///proj/R/legacy/old.R").unwrap();
        let out = resolve_lint_for_document(&base, &section, &overrides, &uri);
        assert_eq!(out.line_length, 200);
    }

    #[test]
    fn untitled_uri_falls_through_to_base() {
        let mut base = LintConfig::default();
        base.line_length = 80;
        let section = json!({ "lineLength": 80 });
        let root = PathBuf::from("/proj");
        let overrides = make_overrides(
            &root,
            vec![("**/*.R", json!({ "lineLength": 200 }))],
        );
        let uri = Url::parse("untitled:Untitled-1").unwrap();
        let out = resolve_lint_for_document(&base, &section, &overrides, &uri);
        assert_eq!(out.line_length, 80);
    }

    #[test]
    fn enabled_false_in_override_is_detected() {
        let section = json!({ "enabled": true });
        let root = PathBuf::from("/proj");
        let overrides = make_overrides(
            &root,
            vec![("R/legacy_*.R", json!({ "enabled": false }))],
        );
        assert!(is_skipped_by_overrides(
            &section, &overrides, Path::new("R/legacy_old.R")
        ));
        assert!(!is_skipped_by_overrides(
            &section, &overrides, Path::new("R/main.R")
        ));
    }
}
```

- [ ] **Step 4: Update `config_file/mod.rs` to expose the real type**

Replace the placeholder block in `crates/raven/src/config_file/mod.rs` with:

```rust
pub mod overrides;
pub use overrides::{
    compile_from_settings as compile_lint_overrides, is_skipped_by_overrides,
    resolve_lint_for_document, CompiledLintOverride,
};
```

(Remove the placeholder `CompiledLintOverride` struct from earlier; the real one lives in `overrides.rs`.)

- [ ] **Step 5: Run overrides tests**

Run: `cargo test -p raven config_file::overrides`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/Cargo.toml crates/raven/src/config_file \
        crates/raven/src/backend.rs
git commit -m "feat(config_file): per-document override resolution

CompiledLintOverride pairs compiled globs with a JSON patch. Resolver
walks overrides in order; later matches win. Untitled / non-file URIs
fall through to the base config."
```

---

## Task 6: Wire LSP `initialize`

**Files:**
- Modify: `crates/raven/src/backend.rs` around `initialize()` (line 1728-1840)
- Modify: `crates/raven/src/backend.rs` to make parser functions `pub(crate)` (lines 120, 240, 434, 627)

- [ ] **Step 1: Verify `parse_*_config` visibility**

Run: `grep -n "fn parse_.*_config" crates/raven/src/backend.rs | grep -v "_tests\|_returns_\|_reads_"`
Expected: each match starts `pub(crate) fn parse_...`. They already do — this is a sanity check only. If any are still private, add `pub(crate)`.

- [ ] **Step 2: Rewrite `initialize` to use raw layers**

In `crates/raven/src/backend.rs`, find `async fn initialize` (line 1728). Replace the block at lines 1743-1778 (parsing initialization options) with:

```rust
        // Store the raw init options on state and run the project-config
        // discovery walk against the first workspace folder. The merged result
        // feeds the existing parse_*_config functions via recompute.
        let raw_client = params
            .initialization_options
            .clone()
            .unwrap_or(serde_json::Value::Null);
        state.raw_client_settings = raw_client;

        let project_root: Option<std::path::PathBuf> = state
            .workspace_folders
            .first()
            .and_then(|u| u.to_file_path().ok());

        let mut loaded_path: Option<std::path::PathBuf> = None;
        if let Some(root) = &project_root {
            match crate::config_file::find_config(root) {
                crate::config_file::DiscoveredConfig::RavenToml(p) => {
                    if let Some(loaded) = crate::config_file::load_toml(&p) {
                        for w in &loaded.warnings {
                            log::warn!("{w}");
                        }
                        state.raw_project_settings = Some(loaded.settings);
                        state.project_config_path = Some(p.clone());
                        loaded_path = Some(p);
                    }
                }
                crate::config_file::DiscoveredConfig::Lintr(_p) => {
                    // .lintr loader lands in Task 10. For now, skip and warn.
                    log::warn!("found .lintr but loader not yet wired in initialize; using defaults");
                }
                crate::config_file::DiscoveredConfig::None => {}
            }
        }

        crate::config_file::recompute_parsed_configs(&mut state);

        // Compile any [[linting.overrides]] from the now-merged settings.
        if let Some(root) = &project_root {
            let merged = crate::config_file::merge_settings(
                &state.raw_client_settings,
                state.raw_project_settings.as_ref(),
            );
            state.lint_overrides = crate::config_file::compile_lint_overrides(&merged, root);
        }

        // Notify client when a project config is in effect.
        if let Some(path) = loaded_path {
            let client = self.client.clone();
            let path_str = path.display().to_string();
            tokio::spawn(async move {
                let payload = serde_json::json!({
                    "path": path_str,
                    "source": "raven.toml",
                });
                let _ = client
                    .send_notification::<RavenProjectConfigLoaded>(payload)
                    .await;
            });
        }
```

Add the custom-notification type declaration. Near the top of `backend.rs` (e.g. just before `impl LanguageServer for Backend`):

```rust
pub(crate) enum RavenProjectConfigLoaded {}

impl tower_lsp::lsp_types::notification::Notification for RavenProjectConfigLoaded {
    type Params = serde_json::Value;
    const METHOD: &'static str = "raven/projectConfigLoaded";
}
```

The notification's `Params` is `serde_json::Value`, so the payload passed to `send_notification` must also be a `serde_json::Value` — that's why the snippet above builds a `json!({...})` rather than a typed struct.

- [ ] **Step 3: Write an integration test**

Append to the existing test module in `crates/raven/src/backend.rs` (find `mod lint_config_parsing` or similar):

```rust
#[cfg(test)]
mod project_config_initialize_tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;
    use tower_lsp::lsp_types::{InitializeParams, Url, WorkspaceFolder};

    #[tokio::test]
    async fn initialize_loads_raven_toml_from_workspace_root() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("raven.toml"),
            "[linting]\nenabled = true\nlineLength = 123\n",
        )
        .unwrap();
        let root = Url::from_file_path(tmp.path()).unwrap();

        let (svc, _socket) = tower_lsp::LspService::new(Backend::new);
        let backend = svc.inner();
        let params = InitializeParams {
            workspace_folders: Some(vec![WorkspaceFolder {
                uri: root.clone(),
                name: "test".into(),
            }]),
            ..Default::default()
        };
        backend.initialize(params).await.unwrap();
        let state = backend.state.read().await;
        assert!(state.lint_config.enabled);
        assert_eq!(state.lint_config.line_length, 123);
        assert!(state.project_config_path.is_some());
    }

    #[tokio::test]
    async fn initialize_uses_init_options_when_no_project_config() {
        let tmp = TempDir::new().unwrap();
        let root = Url::from_file_path(tmp.path()).unwrap();

        let (svc, _socket) = tower_lsp::LspService::new(Backend::new);
        let backend = svc.inner();
        let params = InitializeParams {
            workspace_folders: Some(vec![WorkspaceFolder {
                uri: root.clone(),
                name: "test".into(),
            }]),
            initialization_options: Some(serde_json::json!({
                "linting": { "enabled": true, "lineLength": 90 }
            })),
            ..Default::default()
        };
        backend.initialize(params).await.unwrap();
        let state = backend.state.read().await;
        assert!(state.lint_config.enabled);
        assert_eq!(state.lint_config.line_length, 90);
        assert!(state.project_config_path.is_none());
    }
}
```

- [ ] **Step 4: Run the new tests**

Run: `cargo test -p raven project_config_initialize_tests`
Expected: 2 passed.

- [ ] **Step 5: Run the full crate tests to catch regressions**

Run: `cargo test -p raven`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "feat(backend): load raven.toml during LSP initialize

Stores raw init options + raw project settings on WorldState, merges
them via recompute_parsed_configs, compiles per-file overrides, and
emits raven/projectConfigLoaded when a project config is in effect."
```

---

## Task 7: Wire `did_change_configuration`

**Files:**
- Modify: `crates/raven/src/backend.rs` `did_change_configuration` (line 3817-3997)

- [ ] **Step 1: Replace the parse block while preserving all `*_changed` locals**

In `crates/raven/src/backend.rs`, find `async fn did_change_configuration` (around line 3817). The current body at lines 3819-3997 parses settings, computes a tuple of locals, and applies. Replace this whole block with one that captures `prev_*` snapshots, calls `recompute_parsed_configs`, and recomputes the same locals from `prev_*` vs the new `state.*` values.

The function header and the early return for "no settings" stay as-is. Replace the body from "Parse cross-file configuration if provided" (around line 3825) through the closing `};` of the tuple binding (around line 4032) with:

```rust
        let (
            open_uris,
            scope_changed,
            package_settings_changed,
            watch_settings_changed,
            only_watch_changed,
            diagnostics_enabled_changed,
            old_diagnostics_enabled,
            new_diagnostics_enabled,
            packages_enabled,
            trigger_on_open_paren_changed,
            new_trigger_on_open_paren,
            pkg_mode_io_needed,
        ) = {
            let mut state = self.state.write().await;

            // Snapshot the pre-change parsed configs so we can detect what
            // moved after the recompute.
            let prev_cross_file = state.cross_file_config.clone();
            let prev_lint = state.lint_config.clone();
            let prev_completion = state.completion_config.clone();
            let prev_hier_support = state.symbol_config.hierarchical_document_symbol_support;

            // Store the new raw client settings and re-merge with the project
            // file (if any). recompute_parsed_configs() overwrites every
            // parsed config; absent sections reset to defaults.
            state.raw_client_settings = params.settings.clone();
            crate::config_file::recompute_parsed_configs(&mut state);

            // Refresh compiled overrides from the merged settings.
            let project_root = state
                .workspace_folders
                .first()
                .and_then(|u| u.to_file_path().ok());
            if let Some(root) = &project_root {
                let merged = crate::config_file::merge_settings(
                    &state.raw_client_settings,
                    state.raw_project_settings.as_ref(),
                );
                state.lint_overrides = crate::config_file::compile_lint_overrides(&merged, root);
            }

            // --- Recompute each `*_changed` flag against the pre-recompute
            // snapshots. Logic is preserved from the original site at
            // `backend.rs:3863-4006`; the only change is the source of truth
            // (state.* now reflects the merged result, not parse_*_config
            // output applied to params.settings directly).
            let scope_changed =
                prev_cross_file.scope_settings_changed(&state.cross_file_config);

            let old_diagnostics_enabled = prev_cross_file.diagnostics_enabled;
            let new_diagnostics_enabled = state.cross_file_config.diagnostics_enabled;
            let diagnostics_enabled_changed =
                old_diagnostics_enabled != new_diagnostics_enabled;

            let package_settings_changed =
                state.cross_file_config.packages_enabled != prev_cross_file.packages_enabled
                    || state.cross_file_config.packages_r_path
                        != prev_cross_file.packages_r_path
                    || state.cross_file_config.packages_additional_library_paths
                        != prev_cross_file.packages_additional_library_paths;

            let watch_settings_changed = state.cross_file_config.packages_watch_library_paths
                != prev_cross_file.packages_watch_library_paths
                || state.cross_file_config.packages_watch_debounce_ms
                    != prev_cross_file.packages_watch_debounce_ms;

            let lint_config_changed = state.lint_config != prev_lint;

            // `only_watch_changed` is true when the watch fields are the only
            // differences across the entire `CrossFileConfig`.
            let only_watch_changed = watch_settings_changed
                && !lint_config_changed
                && {
                    let mut probe = state.cross_file_config.clone();
                    probe.packages_watch_library_paths =
                        prev_cross_file.packages_watch_library_paths;
                    probe.packages_watch_debounce_ms =
                        prev_cross_file.packages_watch_debounce_ms;
                    probe == prev_cross_file
                };

            let packages_enabled = state.cross_file_config.packages_enabled;

            // Trigger pkg-mode rebuild if mode flipped.
            let package_mode_changed =
                state.cross_file_config.package_mode != prev_cross_file.package_mode;
            let pkg_mode_io_needed: Option<std::path::PathBuf> = if package_mode_changed {
                use crate::cross_file::config::PackageMode;
                let mode = state.cross_file_config.package_mode;
                let event = crate::package_state::event::HandlerEvent::SettingChanged {
                    new_mode: mode,
                };
                if let Some(delta) = crate::package_state::event::translate(
                    &mut state.package_inputs,
                    event,
                ) {
                    if mode == PackageMode::Disabled {
                        state.apply_package_event(&delta);
                        None
                    } else {
                        state
                            .workspace_folders
                            .first()
                            .and_then(|u| u.to_file_path().ok())
                    }
                } else {
                    None
                }
            } else {
                None
            };

            // Recompute reset symbol_config to its default; restore the
            // hierarchical-symbol-support flag the client capabilities set at
            // initialize() time.
            state.symbol_config.hierarchical_document_symbol_support = prev_hier_support;

            let new_trigger_on_open_paren = state.completion_config.trigger_on_open_paren;
            let trigger_on_open_paren_changed =
                prev_completion.trigger_on_open_paren != new_trigger_on_open_paren;

            // Force-republish open documents (matches existing call site at
            // backend.rs:4011-4016).
            let open_uris: Vec<Url> = state.documents.keys().cloned().collect();
            if !only_watch_changed {
                state
                    .diagnostics_gate
                    .mark_force_republish_many(open_uris.iter());
            }

            (
                open_uris,
                scope_changed,
                package_settings_changed,
                watch_settings_changed,
                only_watch_changed,
                diagnostics_enabled_changed,
                old_diagnostics_enabled,
                new_diagnostics_enabled,
                packages_enabled,
                trigger_on_open_paren_changed,
                new_trigger_on_open_paren,
                pkg_mode_io_needed,
            )
        };
```

The downstream code after this block (package-mode rebuild, watch-restart, force-republish, completion-trigger update — the rest of `did_change_configuration` through ~line 4150) is unchanged.

- [ ] **Step 2: Write a per-key fallback regression test**

Append to the existing backend test module:

```rust
#[tokio::test]
async fn did_change_configuration_falls_back_to_project_when_client_clears() {
    let tmp = TempDir::new().unwrap();
    fs::write(
        tmp.path().join("raven.toml"),
        "[linting]\nenabled = true\nlineLength = 100\n",
    )
    .unwrap();
    let root = Url::from_file_path(tmp.path()).unwrap();

    let (svc, _socket) = tower_lsp::LspService::new(Backend::new);
    let backend = svc.inner();
    backend.initialize(InitializeParams {
        workspace_folders: Some(vec![WorkspaceFolder { uri: root, name: "t".into() }]),
        initialization_options: Some(serde_json::json!({
            "linting": { "enabled": true, "lineLength": 80, "objectLength": 40 }
        })),
        ..Default::default()
    }).await.unwrap();

    // Sanity: project file wins on lineLength; client wins on objectLength.
    {
        let state = backend.state.read().await;
        assert_eq!(state.lint_config.line_length, 100);
        assert_eq!(state.lint_config.object_length, 40);
    }

    // Client clears all linting settings (e.g. user "Reset Setting" in VS Code).
    backend.did_change_configuration(DidChangeConfigurationParams {
        settings: serde_json::json!({ "linting": {} }),
    }).await;

    let state = backend.state.read().await;
    // Project still pins lineLength; objectLength falls back to default (30).
    assert_eq!(state.lint_config.line_length, 100);
    assert_eq!(state.lint_config.object_length, 30);
}
```

- [ ] **Step 3: Run the new test and the existing did_change_configuration tests**

Run: `cargo test -p raven did_change_configuration`
Expected: all pass, including the new fallback test.

- [ ] **Step 4: Run full crate tests**

Run: `cargo test -p raven`
Expected: all pass. (The `package_settings_changed` branch is exercised by an existing test around `backend.rs:8828`; verify it still passes.)

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "feat(backend): did_change_configuration now drives raw-layer merge

Client settings are stored raw on WorldState then re-merged with the
project file via recompute_parsed_configs. Clearing a key in VS Code
correctly falls back to the project value or default."
```

---

## Task 8: Wire `did_change_watched_files` + dynamic registration

**Files:**
- Modify: `crates/raven/src/backend.rs` (`initialized` method, around line 1854; `did_change_watched_files` method)

- [ ] **Step 1: Register dynamic file watches in `initialized`**

In `crates/raven/src/backend.rs`, find `async fn initialized` (line 1854). After workspace folders are scanned and before the function returns, register dynamic watches:

```rust
        // Register dynamic file watches for raven.toml / .lintr. VS Code also
        // covers these via its synchronize.fileEvents glob, so this is a no-op
        // there; non-VS Code clients that honor dynamic registration pick up
        // live reload from here.
        use tower_lsp::lsp_types::{
            DidChangeWatchedFilesRegistrationOptions, FileSystemWatcher, GlobPattern,
            Registration, WatchKind,
        };
        let watchers = vec![
            FileSystemWatcher {
                glob_pattern: GlobPattern::String("**/raven.toml".into()),
                kind: Some(WatchKind::Create | WatchKind::Change | WatchKind::Delete),
            },
            FileSystemWatcher {
                glob_pattern: GlobPattern::String("**/.lintr".into()),
                kind: Some(WatchKind::Create | WatchKind::Change | WatchKind::Delete),
            },
        ];
        let reg = Registration {
            id: "raven-config-files".into(),
            method: "workspace/didChangeWatchedFiles".into(),
            register_options: Some(
                serde_json::to_value(DidChangeWatchedFilesRegistrationOptions { watchers })
                    .unwrap(),
            ),
        };
        let client = self.client.clone();
        tokio::spawn(async move {
            if let Err(e) = client.register_capability(vec![reg]).await {
                log::warn!("dynamic watch registration failed: {e}");
            }
        });
```

- [ ] **Step 2: Add a project-config branch at the *top* of `did_change_watched_files`**

`did_change_watched_files` already exists at `backend.rs:4203` and does significant work for source-file changes (cancel pending indexing, invalidate caches, schedule workspace updates, dependency revalidation, package-manifest deltas). The new behavior is an *addition*: detect raven.toml/.lintr events at the top, run the reload, and then continue to the existing logic for any remaining non-config events.

In `crates/raven/src/backend.rs`, find `async fn did_change_watched_files(&self, params: DidChangeWatchedFilesParams)` and modify in place. Immediately after the `log::trace!` call at the start (around line 4204-4207), and BEFORE the existing `deleted_uris` collection, insert:

```rust
        // Detect raven.toml / .lintr events. These are not part of the
        // source-file flow — they trigger a config-layer reload instead.
        let config_file_changes: Vec<&FileEvent> = params
            .changes
            .iter()
            .filter(|c| {
                let Ok(p) = c.uri.to_file_path() else { return false };
                matches!(
                    p.file_name().and_then(|n| n.to_str()),
                    Some("raven.toml") | Some(".lintr")
                )
            })
            .collect();

        if !config_file_changes.is_empty() {
            let open_uris: Vec<Url> = {
                let mut state = self.state.write().await;
                let project_root = state
                    .workspace_folders
                    .first()
                    .and_then(|u| u.to_file_path().ok());

                // Re-run discovery from the workspace root. Order matters:
                // raven.toml beats .lintr (DiscoveredConfig embodies that).
                state.raw_project_settings = None;
                state.project_config_path = None;
                if let Some(root) = &project_root {
                    match crate::config_file::find_config(root) {
                        crate::config_file::DiscoveredConfig::RavenToml(p) => {
                            if let Some(loaded) = crate::config_file::load_toml(&p) {
                                for w in &loaded.warnings { log::warn!("{w}"); }
                                state.raw_project_settings = Some(loaded.settings);
                                state.project_config_path = Some(p);
                            }
                        }
                        crate::config_file::DiscoveredConfig::Lintr(p) => {
                            if let Some(loaded) = crate::config_file::load_lintr(&p) {
                                for w in &loaded.warnings { log::warn!("{w}"); }
                                state.raw_project_settings = Some(loaded.settings);
                                state.project_config_path = Some(p);
                            }
                        }
                        crate::config_file::DiscoveredConfig::None => {}
                    }
                }

                crate::config_file::recompute_parsed_configs(&mut state);
                if let Some(root) = &project_root {
                    let merged = crate::config_file::merge_settings(
                        &state.raw_client_settings,
                        state.raw_project_settings.as_ref(),
                    );
                    state.lint_overrides =
                        crate::config_file::compile_lint_overrides(&merged, root);
                }

                let open: Vec<Url> = state.documents.keys().cloned().collect();
                state.diagnostics_gate.mark_force_republish_many(open.iter());
                open
            };

            // Re-publish diagnostics for every open document. The existing
            // revalidation pipeline picks up the force-republish marker on
            // the next `validate_and_publish` call for each URI; we trigger
            // those here. `compute_and_publish_diagnostics` is the canonical
            // single-URI republish (see e.g. backend.rs:6203).
            for uri in &open_uris {
                self.compute_and_publish_diagnostics(uri.clone()).await;
            }
        }

        // If every change was a config file, the source-file flow below has
        // nothing to do. Otherwise, build a filtered `params` containing only
        // the non-config events and continue.
        let remaining_changes: Vec<FileEvent> = params
            .changes
            .iter()
            .filter(|c| !config_file_changes.iter().any(|cc| cc.uri == c.uri))
            .cloned()
            .collect();
        if remaining_changes.is_empty() {
            return;
        }
        let params = DidChangeWatchedFilesParams { changes: remaining_changes };
```

The existing `did_change_watched_files` body continues below this block, now operating on the filtered `params`. The local rebinding (`let params = ...`) shadows the parameter so existing references keep working without further changes.

Verify the helper name `compute_and_publish_diagnostics` matches the actual single-URI republish entry point. Search: `grep -n "compute_and_publish_diagnostics\|pub.* async fn.*publish" crates/raven/src/backend.rs`. If the name differs (e.g. `validate_and_publish_diagnostics`), substitute the actual name.

- [ ] **Step 3: Test live reload**

Append to the backend test module:

```rust
#[tokio::test]
async fn watched_files_reload_picks_up_new_raven_toml() {
    let tmp = TempDir::new().unwrap();
    fs::write(tmp.path().join("raven.toml"), "[linting]\nenabled = true\nlineLength = 100\n").unwrap();
    let root = Url::from_file_path(tmp.path()).unwrap();

    let (svc, _socket) = tower_lsp::LspService::new(Backend::new);
    let backend = svc.inner();
    backend.initialize(InitializeParams {
        workspace_folders: Some(vec![WorkspaceFolder { uri: root.clone(), name: "t".into() }]),
        ..Default::default()
    }).await.unwrap();
    assert_eq!(backend.state.read().await.lint_config.line_length, 100);

    // Edit raven.toml on disk.
    fs::write(tmp.path().join("raven.toml"), "[linting]\nenabled = true\nlineLength = 140\n").unwrap();

    use tower_lsp::lsp_types::{DidChangeWatchedFilesParams, FileChangeType, FileEvent};
    backend.did_change_watched_files(DidChangeWatchedFilesParams {
        changes: vec![FileEvent {
            uri: Url::from_file_path(tmp.path().join("raven.toml")).unwrap(),
            typ: FileChangeType::CHANGED,
        }],
    }).await;

    assert_eq!(backend.state.read().await.lint_config.line_length, 140);
}
```

- [ ] **Step 4: Run new test**

Run: `cargo test -p raven watched_files_reload`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "feat(backend): live-reload on raven.toml / .lintr changes

initialized() registers dynamic watches for non-VS Code clients;
did_change_watched_files reloads project config and re-merges."
```

---

## Task 9: Per-document override resolution in handlers

**Files:**
- Modify: `crates/raven/src/handlers.rs` (`DiagnosticsSnapshot::build` around line 248)

- [ ] **Step 1: Replace the lint_config clone with a per-document resolve**

In `crates/raven/src/handlers.rs:248`, the snapshot currently clones `state.lint_config`. Capture the URI and overrides alongside, then resolve.

Find the existing snapshot-build site (around line 243-249). Replace the `lint_config: state.lint_config.clone()` line with:

```rust
            lint_config: {
                let base_section = serde_json::json!({}); // empty; resolver uses LintConfig directly
                let merged = crate::config_file::merge_settings(
                    &state.raw_client_settings,
                    state.raw_project_settings.as_ref(),
                );
                let section = merged.get("linting").cloned().unwrap_or(base_section);
                crate::config_file::resolve_lint_for_document(
                    &state.lint_config,
                    &section,
                    &state.lint_overrides,
                    uri, // the document URI being snapshotted
                )
            },
```

(`uri` is the parameter the snapshot-build function already receives — confirm by reading the surrounding signature in `handlers.rs`.)

- [ ] **Step 2: Test override resolution end-to-end through the snapshot path**

Append to backend tests. The test opens two documents (one in `R/`, one in `tests/`) via `did_open`, then triggers the diagnostics flow and verifies the published diagnostics reflect different effective `lineLength` values. This actually exercises the `handlers.rs` site, not just the pure resolver.

```rust
#[tokio::test]
async fn published_diagnostics_use_per_file_override() {
    let tmp = TempDir::new().unwrap();
    fs::write(
        tmp.path().join("raven.toml"),
        r#"
[linting]
enabled = true
lineLength = 30
lineLengthSeverity = "warning"

[[linting.overrides]]
files = ["tests/**/*.R"]
lineLength = 200
"#,
    ).unwrap();
    fs::create_dir_all(tmp.path().join("tests")).unwrap();
    fs::create_dir_all(tmp.path().join("R")).unwrap();
    let r_path = tmp.path().join("R/a.R");
    let test_path = tmp.path().join("tests/test-a.R");
    // 80-column line: triggers in R/ (line_length = 30), not in tests/ (200).
    let long_line = "x_long_identifier <- 'sample value with a longer literal string' ; cat('hi')\n";
    fs::write(&r_path, long_line).unwrap();
    fs::write(&test_path, long_line).unwrap();

    let (svc, _socket) = tower_lsp::LspService::new(Backend::new);
    let backend = svc.inner();
    backend.initialize(InitializeParams {
        workspace_folders: Some(vec![WorkspaceFolder {
            uri: Url::from_file_path(tmp.path()).unwrap(),
            name: "t".into(),
        }]),
        ..Default::default()
    }).await.unwrap();

    let r_uri = Url::from_file_path(&r_path).unwrap();
    let test_uri = Url::from_file_path(&test_path).unwrap();

    backend.did_open(DidOpenTextDocumentParams {
        text_document: TextDocumentItem {
            uri: r_uri.clone(), language_id: "r".into(),
            version: 1, text: long_line.into(),
        },
    }).await;
    backend.did_open(DidOpenTextDocumentParams {
        text_document: TextDocumentItem {
            uri: test_uri.clone(), language_id: "r".into(),
            version: 1, text: long_line.into(),
        },
    }).await;

    // Pull the snapshots that handlers.rs would build for each URI and assert
    // their effective LintConfig. This exercises DiagnosticsSnapshot::build
    // directly; the equivalent path is what handlers.rs:243-249 takes during
    // a diagnostics pass.
    let state = backend.state.read().await;
    let r_snap = crate::handlers::DiagnosticsSnapshot::build(&state, &r_uri).unwrap();
    let test_snap = crate::handlers::DiagnosticsSnapshot::build(&state, &test_uri).unwrap();
    assert_eq!(r_snap.lint_config.line_length, 30);
    assert_eq!(test_snap.lint_config.line_length, 200);
}
```

(Test imports near top of test module: `DidOpenTextDocumentParams`, `TextDocumentItem` from `tower_lsp::lsp_types`. The `DiagnosticsSnapshot::build` signature is the same one `handlers.rs` calls today; verify by running `grep -n "DiagnosticsSnapshot::build\|fn build" crates/raven/src/handlers.rs` and adjusting the call site if the signature differs.)

- [ ] **Step 3: Run the test**

Run: `cargo test -p raven open_document_in_tests_dir`
Expected: passes.

- [ ] **Step 4: Run full crate tests**

Run: `cargo test -p raven`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/handlers.rs crates/raven/src/backend.rs
git commit -m "feat(handlers): per-document lint config via override resolver

Diagnostics snapshot now resolves the effective LintConfig per URI,
applying any [[linting.overrides]] entries whose glob matches the
document's project-relative path."
```

---

## Task 10: `.lintr` reader

**Files:**
- Create: `crates/raven/src/config_file/lintr_loader.rs`
- Modify: `crates/raven/src/config_file/mod.rs` (re-export)
- Modify: `crates/raven/src/backend.rs` (handle `DiscoveredConfig::Lintr` in `initialize` and `did_change_watched_files`)

- [ ] **Step 1: Write the DCF fold + recognizer with tests**

Create `crates/raven/src/config_file/lintr_loader.rs`:

```rust
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
            ')' | ']' | '}' => depth -= 1,
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
```

- [ ] **Step 2: Re-export from `config_file/mod.rs`**

Append to `crates/raven/src/config_file/mod.rs`:

```rust
pub mod lintr_loader;
pub use lintr_loader::{load as load_lintr, load_str as load_lintr_str, LoadedLintr};
```

- [ ] **Step 3: Wire the `.lintr` branch in `initialize` and `did_change_watched_files`**

In `crates/raven/src/backend.rs::initialize`, replace the `DiscoveredConfig::Lintr` branch (currently logging "loader not yet wired") with:

```rust
                crate::config_file::DiscoveredConfig::Lintr(p) => {
                    if let Some(loaded) = crate::config_file::load_lintr(&p) {
                        for w in &loaded.warnings {
                            log::warn!("{w}");
                        }
                        state.raw_project_settings = Some(loaded.settings);
                        state.project_config_path = Some(p.clone());
                        loaded_path = Some(p);
                    }
                }
```

In `did_change_watched_files`, do the same replacement for the `Lintr` branch.

Update the `raven/projectConfigLoaded` notification call to set `source` based on the file extension:

```rust
let source = if loaded_path.as_ref().map_or(false, |p| p.file_name() == Some(std::ffi::OsStr::new(".lintr"))) {
    ".lintr"
} else {
    "raven.toml"
};
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p raven config_file::lintr_loader`
Expected: 6 passed.

Run: `cargo test -p raven`
Expected: full suite passes.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/config_file crates/raven/src/backend.rs
git commit -m "feat(config_file): add .lintr subset reader

DCF fold + token recognizer. Maps line_length_linter, assignment_linter,
object_name_linter, indentation_linter, object_length_linter, plus
X_linter = NULL forms. Exclusions become disabled overrides. Out-of-grammar
constructs collected into a single batch warning."
```

---

## Task 11: `raven lint` CLI

**Files:**
- Create: `crates/raven/src/cli/lint.rs`
- Modify: `crates/raven/src/cli/mod.rs` (declare module)
- Modify: `crates/raven/src/main.rs` (dispatch `lint` subcommand)

- [ ] **Step 1: Write argument-parsing tests**

Create `crates/raven/src/cli/lint.rs`:

```rust
//! `raven lint` subcommand: walk paths, run native lint rules, format output.

use std::path::{Path, PathBuf};

use serde_json::json;
use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString};

/// Exit codes are returned as plain `i32` so `main()` can pass them directly
/// to `std::process::exit`. Avoids the `ExitCode` cast trap (`ExitCode` is not
/// a primitive and cannot be cast with `as`).
pub const EXIT_OK: i32 = 0;
pub const EXIT_LINT_FAILED: i32 = 1;
pub const EXIT_OPERATOR_ERROR: i32 = 2;

#[derive(Debug, PartialEq, Clone)]
pub struct LintArgs {
    pub paths: Vec<PathBuf>,
    pub config_path: Option<PathBuf>,
    pub no_config: bool,
    pub format: OutputFormat,
    pub max_severity: SeverityLevel,
    pub quiet: bool,
    pub no_color: bool,
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum OutputFormat { Text, Json, Sarif }

#[derive(Debug, PartialEq, Clone, Copy, PartialOrd, Eq, Ord)]
pub enum SeverityLevel { Off, Hint, Info, Warning, Error }

impl SeverityLevel {
    fn from_diag(d: &Diagnostic) -> Self {
        match d.severity {
            Some(DiagnosticSeverity::ERROR) => SeverityLevel::Error,
            Some(DiagnosticSeverity::WARNING) => SeverityLevel::Warning,
            Some(DiagnosticSeverity::INFORMATION) => SeverityLevel::Info,
            Some(DiagnosticSeverity::HINT) => SeverityLevel::Hint,
            _ => SeverityLevel::Off,
        }
    }
}

pub fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<LintArgs, String> {
    let mut paths = Vec::new();
    let mut config_path = None;
    let mut no_config = false;
    let mut format = OutputFormat::Text;
    let mut max_severity = SeverityLevel::Info;
    let mut quiet = false;
    let mut no_color = false;

    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--config" => {
                config_path = Some(PathBuf::from(argv.next().ok_or("--config needs a path")?));
            }
            "--no-config" => no_config = true,
            "--format" => {
                let v = argv.next().ok_or("--format needs a value")?;
                format = match v.as_str() {
                    "text" => OutputFormat::Text,
                    "json" => OutputFormat::Json,
                    "sarif" => OutputFormat::Sarif,
                    other => return Err(format!("unknown --format value: {other}")),
                };
            }
            "--max-severity" => {
                let v = argv.next().ok_or("--max-severity needs a value")?;
                max_severity = match v.as_str() {
                    "off" => SeverityLevel::Off,
                    "hint" => SeverityLevel::Hint,
                    "info" => SeverityLevel::Info,
                    "warning" => SeverityLevel::Warning,
                    "error" => SeverityLevel::Error,
                    other => return Err(format!("unknown --max-severity value: {other}")),
                };
            }
            "--quiet" => quiet = true,
            "--no-color" => no_color = true,
            "--help" => return Err("HELP".into()),
            s if s.starts_with("--") => return Err(format!("unknown flag: {s}")),
            p => paths.push(PathBuf::from(p)),
        }
    }
    if paths.is_empty() {
        paths.push(PathBuf::from("."));
    }
    Ok(LintArgs { paths, config_path, no_config, format, max_severity, quiet, no_color })
}

pub fn run(args: LintArgs) -> i32 {
    let cwd = match std::env::current_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("raven lint: cannot read current directory: {e}");
            return EXIT_OPERATOR_ERROR;
        }
    };

    // Resolve project root + project settings.
    let (root, project_settings) = if args.no_config {
        (cwd.clone(), None)
    } else if let Some(explicit) = args.config_path.as_ref() {
        match crate::config_file::load_toml(explicit) {
            Some(l) => {
                for w in l.warnings { eprintln!("{w}"); }
                let root = explicit.parent().unwrap_or(&cwd).to_path_buf();
                (root, Some(l.settings))
            }
            None => {
                eprintln!("raven lint: failed to load --config {}", explicit.display());
                return EXIT_OPERATOR_ERROR;
            }
        }
    } else {
        match crate::config_file::find_config(&cwd) {
            crate::config_file::DiscoveredConfig::RavenToml(p) => {
                let l = match crate::config_file::load_toml(&p) {
                    Some(v) => v,
                    None => return EXIT_OPERATOR_ERROR,
                };
                for w in l.warnings { eprintln!("{w}"); }
                (p.parent().unwrap_or(&cwd).to_path_buf(), Some(l.settings))
            }
            crate::config_file::DiscoveredConfig::Lintr(p) => {
                let l = crate::config_file::load_lintr_str(
                    &std::fs::read_to_string(&p).unwrap_or_default()
                );
                for w in l.warnings { eprintln!("{w}"); }
                (p.parent().unwrap_or(&cwd).to_path_buf(), Some(l.settings))
            }
            crate::config_file::DiscoveredConfig::None => (cwd.clone(), None),
        }
    };

    // Parse the base lint config from the (project-only) settings, since the
    // CLI has no LSP client. Merge with an empty client layer for correctness.
    let merged = crate::config_file::merge_settings(
        &serde_json::Value::Object(Default::default()),
        project_settings.as_ref(),
    );
    let lint_config = crate::backend::parse_lint_config(&merged).unwrap_or_default();
    let base_section = merged.get("linting").cloned().unwrap_or(json!({}));
    let overrides = crate::config_file::compile_lint_overrides(&merged, &root);

    let mut diagnostics: Vec<(PathBuf, Diagnostic)> = Vec::new();
    let mut operator_error = false;
    for p in &args.paths {
        walk(p, &root, &base_section, &lint_config, &overrides, &mut diagnostics, &mut operator_error);
    }
    if operator_error {
        return EXIT_OPERATOR_ERROR;
    }

    let any_above_threshold = diagnostics.iter().any(|(_, d)|
        SeverityLevel::from_diag(d) > args.max_severity
    );

    match args.format {
        OutputFormat::Text => print_text(&diagnostics, &args, &root),
        OutputFormat::Json => print_json(&diagnostics, &root),
        OutputFormat::Sarif => print_sarif(&diagnostics, &root),
    }

    if any_above_threshold { EXIT_LINT_FAILED } else { EXIT_OK }
}

fn walk(
    path: &Path,
    root: &Path,
    base_section: &serde_json::Value,
    base_lint: &crate::linting::LintConfig,
    overrides: &[crate::config_file::CompiledLintOverride],
    out: &mut Vec<(PathBuf, Diagnostic)>,
    operator_error: &mut bool,
) {
    if path.is_file() {
        if !is_r_file(path) { return; }
        let rel = path.strip_prefix(root).unwrap_or(path);
        if crate::config_file::is_skipped_by_overrides(base_section, overrides, rel) {
            return;
        }
        let uri = tower_lsp::lsp_types::Url::from_file_path(path)
            .unwrap_or_else(|_| tower_lsp::lsp_types::Url::parse("file:///").unwrap());
        let effective = crate::config_file::resolve_lint_for_document(
            base_lint, base_section, overrides, &uri,
        );
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("raven lint: cannot read {}: {e}", path.display());
                *operator_error = true;
                return;
            }
        };
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&tree_sitter_r::LANGUAGE.into()).unwrap();
        let tree = match parser.parse(&text, None) {
            Some(t) => t,
            None => {
                eprintln!("raven lint: parse failed for {}", path.display());
                *operator_error = true;
                return;
            }
        };
        for d in crate::linting::run_lints(&text, tree.root_node(), &effective) {
            out.push((path.to_path_buf(), d));
        }
    } else if path.is_dir() {
        let entries = match std::fs::read_dir(path) {
            Ok(it) => it,
            Err(e) => {
                eprintln!("raven lint: cannot read dir {}: {e}", path.display());
                *operator_error = true;
                return;
            }
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_symlink() { continue; }
            walk(&p, root, base_section, base_lint, overrides, out, operator_error);
        }
    } else {
        eprintln!("raven lint: path does not exist: {}", path.display());
        *operator_error = true;
    }
}

fn is_r_file(p: &Path) -> bool {
    matches!(p.extension().and_then(|s| s.to_str()), Some("R") | Some("r"))
}

fn print_text(
    diags: &[(PathBuf, Diagnostic)],
    args: &LintArgs,
    root: &Path,
) {
    let mut errors = 0;
    let mut warnings = 0;
    let mut hints = 0;
    for (path, d) in diags {
        let rel = path.strip_prefix(root).unwrap_or(path);
        let level = match d.severity {
            Some(DiagnosticSeverity::ERROR) => { errors += 1; "error" }
            Some(DiagnosticSeverity::WARNING) => { warnings += 1; "warning" }
            Some(DiagnosticSeverity::INFORMATION) => { warnings += 1; "info" }
            Some(DiagnosticSeverity::HINT) => { hints += 1; "hint" }
            _ => "note",
        };
        let line = d.range.start.line + 1;
        let col = d.range.start.character + 1;
        let rule = match &d.code {
            Some(NumberOrString::String(s)) => s.as_str(),
            _ => "",
        };
        println!(
            "{}:{}:{} {}: {} [{}]",
            rel.display(), line, col, level, d.message, rule
        );
    }
    if !args.quiet {
        println!(
            "{} issues ({} errors, {} warnings, {} hints)",
            diags.len(), errors, warnings, hints
        );
    }
}

fn print_json(diags: &[(PathBuf, Diagnostic)], root: &Path) {
    let arr: Vec<_> = diags.iter().map(|(p, d)| {
        let rel = p.strip_prefix(root).unwrap_or(p);
        json!({ "path": rel.display().to_string(), "diagnostic": d })
    }).collect();
    println!("{}", serde_json::to_string_pretty(&json!(arr)).unwrap());
}

fn print_sarif(diags: &[(PathBuf, Diagnostic)], root: &Path) {
    use std::collections::BTreeSet;
    let rule_ids: BTreeSet<String> = diags.iter()
        .filter_map(|(_, d)| match &d.code {
            Some(NumberOrString::String(s)) => Some(s.clone()),
            _ => None,
        })
        .collect();
    let rules: Vec<_> = rule_ids.iter().map(|id| json!({
        "id": id, "name": id, "shortDescription": { "text": id }
    })).collect();
    let results: Vec<_> = diags.iter().map(|(p, d)| {
        let rel = p.strip_prefix(root).unwrap_or(p);
        let level = match d.severity {
            Some(DiagnosticSeverity::ERROR) => "error",
            Some(DiagnosticSeverity::WARNING) => "warning",
            _ => "note",
        };
        let rule_id = match &d.code {
            Some(NumberOrString::String(s)) => s.clone(),
            _ => String::new(),
        };
        json!({
            "ruleId": rule_id,
            "level": level,
            "message": { "text": d.message },
            "locations": [{
                "physicalLocation": {
                    "artifactLocation": { "uri": rel.display().to_string() },
                    "region": {
                        "startLine": d.range.start.line + 1,
                        "startColumn": d.range.start.character + 1,
                        "endLine": d.range.end.line + 1,
                        "endColumn": d.range.end.character + 1,
                    }
                }
            }]
        })
    }).collect();
    let sarif = json!({
        "version": "2.1.0",
        "$schema": "https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json",
        "runs": [{
            "tool": { "driver": { "name": "raven", "rules": rules } },
            "results": results
        }]
    });
    println!("{}", serde_json::to_string_pretty(&sarif).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_default_paths() {
        let args = parse_args(Vec::<String>::new().into_iter()).unwrap();
        assert_eq!(args.paths, vec![PathBuf::from(".")]);
        assert_eq!(args.format, OutputFormat::Text);
        assert_eq!(args.max_severity, SeverityLevel::Info);
    }

    #[test]
    fn parse_explicit_paths() {
        let args = parse_args(["R/", "scripts/foo.R"].iter().map(|s| s.to_string())).unwrap();
        assert_eq!(args.paths, vec![PathBuf::from("R/"), PathBuf::from("scripts/foo.R")]);
    }

    #[test]
    fn parse_format_json() {
        let args = parse_args(["--format", "json"].iter().map(|s| s.to_string())).unwrap();
        assert_eq!(args.format, OutputFormat::Json);
    }

    #[test]
    fn parse_max_severity_warning() {
        let args = parse_args(["--max-severity", "warning"].iter().map(|s| s.to_string())).unwrap();
        assert_eq!(args.max_severity, SeverityLevel::Warning);
    }

    #[test]
    fn unknown_flag_errors() {
        assert!(parse_args(["--bogus"].iter().map(|s| s.to_string())).is_err());
    }
}
```

- [ ] **Step 2: Declare the `lint` module in `cli/mod.rs`**

In `crates/raven/src/cli/mod.rs`, add `pub mod lint;` alongside `pub mod analysis_stats;`.

- [ ] **Step 3: Dispatch from `main.rs`**

In `crates/raven/src/main.rs`, add a branch alongside `analysis-stats` (~line 85). After the existing `if first == "analysis-stats"` block, add:

```rust
        if first == "lint" {
            env_logger::init();
            let rest = args.into_iter().skip(1);
            match cli::lint::parse_args(rest) {
                Ok(lint_args) => {
                    let code = cli::lint::run(lint_args);
                    std::process::exit(code);
                }
                Err(msg) if msg == "HELP" => {
                    cli::lint::print_help();
                    return Ok(());
                }
                Err(msg) => {
                    return Err(anyhow::anyhow!("raven lint: {}", msg));
                }
            }
        }
```

Add a `pub fn print_help()` to `cli/lint.rs`:

```rust
pub fn print_help() {
    println!(
        "raven lint {} — native R style linter

Usage: raven lint [OPTIONS] [PATHS...]

Lints each .R / .r file against the rules configured in raven.toml
(or .lintr) and prints diagnostics.

Options:
  --config PATH               Path to raven.toml (default: search upward)
  --no-config                 Use built-in defaults; ignore raven.toml/.lintr
  --format text|json|sarif    Output format (default: text)
  --max-severity LEVEL        Highest severity that does NOT fail the build
                              (off, hint, info, warning, error; default: info)
  --quiet                     Suppress summary line in text output
  --no-color                  Disable ANSI colors

Exit codes:
  0   No diagnostic exceeded --max-severity
  1   At least one diagnostic exceeded --max-severity
  2   Operator error (config / path / flag)
",
        env!("CARGO_PKG_VERSION")
    );
}
```

Update the top-level help in `crates/raven/src/main.rs::print_usage` (around line 50) to mention `lint`:

Replace:
```text
Subcommands:

analysis-stats <path>        Profile workspace analysis phases
```

with:
```text
Subcommands:

lint [PATHS...]              Run the native style linter on files / directories
analysis-stats <path>        Profile workspace analysis phases
```

- [ ] **Step 4: Add an end-to-end CLI test**

Append to `crates/raven/src/cli/lint.rs` tests:

```rust
#[test]
fn end_to_end_finds_line_length_violation() {
    use std::fs;
    use tempfile::TempDir;
    let tmp = TempDir::new().unwrap();
    fs::write(
        tmp.path().join("raven.toml"),
        "[linting]\nenabled = true\nlineLength = 20\nlineLengthSeverity = \"warning\"\n",
    ).unwrap();
    fs::write(
        tmp.path().join("over.R"),
        "x <- 'this line is intentionally way more than twenty characters wide'\n",
    ).unwrap();

    let prev = std::env::current_dir().unwrap();
    std::env::set_current_dir(tmp.path()).unwrap();
    let args = LintArgs {
        paths: vec![PathBuf::from(".")],
        config_path: None, no_config: false,
        format: OutputFormat::Json,
        max_severity: SeverityLevel::Info,
        quiet: true, no_color: true,
    };
    // Redirect stdout to a buffer is non-trivial; instead just call run() and
    // assert the exit code. Stdout assertions live in the integration test
    // suite that runs the binary.
    let code = run(args);
    std::env::set_current_dir(prev).unwrap();
    assert_eq!(code, EXIT_LINT_FAILED); // warning > info default
}
```

- [ ] **Step 5: Run tests**

Run: `cargo test -p raven cli::lint`
Expected: 6 passed.

Run: `cargo build -p raven --release && ./target/release/raven --help`
Expected: help output now mentions `lint`.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/cli crates/raven/src/main.rs
git commit -m "feat(cli): add 'raven lint' subcommand

Walks .R / .r files, resolves per-file LintConfig from raven.toml or
.lintr, prints diagnostics in text / json / sarif. Exit 0 / 1 / 2
matches the documented CI contract (info-or-below passes, warning+ fails)."
```

---

## Task 12: VS Code extension

**Files:**
- Modify: `editors/vscode/package.json` (add new command contribution)
- Modify: `editors/vscode/src/extension.ts` (extend synchronize.fileEvents, register command, handle notification)

- [ ] **Step 1: Extend `synchronize.fileEvents` glob**

In `editors/vscode/src/extension.ts:183`, the current single glob lives in `synchronize.fileEvents`. Change to an array of two watchers:

```ts
        synchronize: {
            fileEvents: [
                vscode.workspace.createFileSystemWatcher(
                    '**/*.{r,R,rmd,Rmd,RMD,qmd,Qmd,QMD,jags,Jags,JAGS,bugs,Bugs,BUGS,stan,Stan,STAN}',
                ),
                vscode.workspace.createFileSystemWatcher('**/raven.toml'),
                vscode.workspace.createFileSystemWatcher('**/.lintr'),
            ],
        },
```

- [ ] **Step 2: Add the new scaffold command contribution**

In `editors/vscode/package.json`, find the `contributes.commands` array. Add:

```json
        {
            "command": "raven.createProjectConfig",
            "title": "Raven: Create raven.toml",
            "category": "Raven"
        }
```

- [ ] **Step 3: Register the command handler in `extension.ts`**

In `editors/vscode/src/extension.ts` `activate(...)`, add (near the other `registerCommand` calls):

```ts
    context.subscriptions.push(
        vscode.commands.registerCommand('raven.createProjectConfig', async () => {
            await scaffoldProjectConfig();
        }),
    );
```

At the top of `extension.ts` ensure `getInitializationOptions` is imported (it is, today — the existing import line in `extension.ts` reads `import { getInitializationOptions } from './initializationOptions';`).

Add an implementation function (anywhere in the file):

```ts
async function scaffoldProjectConfig(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('Raven: open a workspace folder first.');
        return;
    }
    const target = vscode.Uri.joinPath(folders[0].uri, 'raven.toml');
    try {
        await vscode.workspace.fs.stat(target);
        const choice = await vscode.window.showWarningMessage(
            'raven.toml already exists. Overwrite?',
            { modal: true }, 'Overwrite', 'Cancel'
        );
        if (choice !== 'Overwrite') return;
    } catch {
        // not present — fall through
    }

    // Reuse the existing factory that converts VS Code's flat
    // `raven.linting.*` settings into the nested LSP init-options shape.
    // The TOML we render is the same shape Raven's server consumes.
    const config = vscode.workspace.getConfiguration('raven');
    const initOptions = getInitializationOptions(config);
    const body = renderRavenToml(initOptions.linting);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(target, encoder.encode(body));
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
}

function renderRavenToml(linting: Record<string, unknown> | undefined): string {
    const lines: string[] = ['# Generated by Raven: Create raven.toml', ''];
    lines.push('[linting]');
    const entries: [string, unknown, string][] = [
        ['enabled', false, 'master switch'],
        ['lineLength', 80, 'maximum line length (UTF-16 code units)'],
        ['objectLength', 30, 'maximum identifier length'],
        ['indentationUnit', 2, 'expected indent unit'],
        ['assignmentOperator', '<-', '"<-" or "="'],
        ['stringDelimiter', '"', '"\\"" or "\'"'],
        ['objectNameStyleFunction', 'snake_case', 'or camelCase, dotted.case, UPPER_CASE, lowercase, any'],
        ['objectNameStyleVariable', 'snake_case', 'as above'],
        ['objectNameStyleArgument', 'snake_case', 'as above'],
        ['lineLengthSeverity', 'hint', 'error | warning | information | hint | off'],
    ];
    const ravenDefaultEnabled = false; // mirror VS Code package.json default
    for (const [key, dflt, comment] of entries) {
        const fromUser = linting?.[key];
        // `enabled` is special: the init-options factory always emits it
        // (see initializationOptions.ts:367), so the "is this explicit?"
        // heuristic above doesn't apply. Treat enabled as explicit only when
        // it differs from the package.json default.
        const isExplicit = key === 'enabled'
            ? fromUser !== undefined && fromUser !== ravenDefaultEnabled
            : fromUser !== undefined;
        const value = isExplicit ? fromUser : dflt;
        const prefix = isExplicit ? '' : '# ';
        lines.push(`${prefix}${key} = ${toTomlScalar(value)}    # ${comment}`);
    }
    lines.push('');
    return lines.join('\n');
}

function toTomlScalar(v: unknown): string {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    return JSON.stringify(v);
}
```

- [ ] **Step 4: Handle the `raven/projectConfigLoaded` notification**

After the `LanguageClient` is created and started, register a notification handler. Find where the client is started (search `client.start()` in `extension.ts`). Right before `client.start()`, add:

```ts
    client.onNotification('raven/projectConfigLoaded', (params: { path: string; source: string }) => {
        outputChannel.appendLine(`Raven: using config at ${params.path} (${params.source})`);
        vscode.window.setStatusBarMessage(`$(check) Raven: using ${params.source}`, 5000);
    });
```

- [ ] **Step 5: Run VS Code extension tests**

Run from the repo root:

```bash
bun test editors/vscode/src/test/settings.test.ts
```

Expected: existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/package.json editors/vscode/src/extension.ts
git commit -m "feat(vscode): support raven.toml end-to-end

Synchronize.fileEvents now watches raven.toml and .lintr so edits reach
the server. Adds 'Raven: Create raven.toml' command that scaffolds from
current settings. Handles raven/projectConfigLoaded notification by
logging to the output channel and flashing the status bar."
```

---

## Task 13: Documentation

**Files:**
- Modify: `docs/configuration.md`
- Modify: `docs/linting.md`
- Modify: `docs/editor-integrations.md`
- Create: `docs/cli.md`

- [ ] **Step 1: Write `docs/cli.md`**

Create `docs/cli.md`:

```markdown
# CLI

Raven ships a single binary that serves the LSP via stdio *and* exposes a `lint` subcommand for use outside an editor.

## `raven lint`

Run the native style linter against one or more paths and exit with a code suitable for CI gating.

\`\`\`text
raven lint [OPTIONS] [PATHS...]
\`\`\`

### Options

- `--config PATH` — explicit path to a `raven.toml` (default: walk upward from CWD).
- `--no-config` — ignore `raven.toml` and `.lintr`; use Raven's built-in defaults.
- `--format text|json|sarif` — default `text`.
- `--max-severity off|hint|info|warning|error` — highest severity that does **not** fail the build (default `info`). With Raven's all-`hint` default severities, a vanilla `raven lint .` exits 0; raise rules to `warning` in `raven.toml` to gate CI.
- `--quiet` — suppress the trailing summary line.
- `--no-color` — disable ANSI colors (auto-detected on TTY).

### Exit codes

- `0` — no diagnostic exceeded `--max-severity`.
- `1` — at least one diagnostic exceeded `--max-severity`.
- `2` — operator error (config parse failure, unreadable path, invalid flag).

### Output formats

- `text` — `path:line:col level: message [rule]`, one per line.
- `json` — array of `{ path, diagnostic }` objects (`diagnostic` is a verbatim LSP `Diagnostic`).
- `sarif` — SARIF 2.1.0 envelope. Tool name `raven`; `ruleId` from `Diagnostic.code`.

### GitHub Actions example

\`\`\`yaml
- name: Lint R sources
  run: |
    cargo install --git https://github.com/jbearak/raven raven
    raven lint --format sarif R/ tests/ > raven.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: raven.sarif
\`\`\`

### Scope

`raven lint` runs the native style linter only. Cross-file, undefined-variable, and package diagnostics need a workspace scan and are LSP-only.
```

- [ ] **Step 2: Add a top-level `raven.toml` section to `docs/configuration.md`**

In `docs/configuration.md`, add near the top (after any TOC):

```markdown
## Project config: `raven.toml`

The recommended way to configure Raven is a `raven.toml` file at the project root. Every editor and the `raven lint` CLI read this file, so a single committed config governs both interactive editing and CI.

### Discovery

Raven walks upward from each workspace folder looking for `raven.toml`. If none is found, `.lintr` is read for linting settings only (subset; see [Linting](linting.md#migrating-from-lintr)).

### Precedence

Per-key. For each setting, project values win over the LSP client's `initializationOptions` / `did_change_configuration` payload. Keys not pinned by the project file continue to come from client settings (or Raven's defaults if neither layer specifies them).

### Schema

The TOML mirrors the LSP `initializationOptions` shape 1:1. The reference table below lists every key; the same key in `raven.toml` is at the path indicated.

\`\`\`toml
[linting]
enabled = true
lineLength = 100
lineLengthSeverity = "warning"

[[linting.overrides]]
files = ["tests/**/*.R"]
lineLength = 120

[crossFile]
maxChainDepth = 10

[packages]
enabled = true

[diagnostics]
undefinedVariableSeverity = "warning"
\`\`\`

### Per-file overrides

`[[linting.overrides]]` is an array of glob → patch entries. Globs are anchored at the project root. Order matters: later entries win on conflicts. Setting `enabled = false` in an override skips matching files entirely.
```

- [ ] **Step 3: Update `docs/linting.md`**

In `docs/linting.md`, replace the introduction's VS Code-only framing with a project-file-first framing. Find the "Quick start" section and add a `raven.toml` example alongside the `settings.json` one. Update the "Migrating from `.lintr`" section to describe the new runtime reader:

After the existing "Migrating from `.lintr`" introduction, append:

```markdown
> **Runtime support:** When no `raven.toml` is present at the project root, Raven reads a documented subset of `.lintr` at startup. The mapping table below is the supported surface. Forms outside the supported subset log a single batch warning and are otherwise ignored.
```

- [ ] **Step 4: Update `docs/editor-integrations.md`**

In `docs/editor-integrations.md`, after the editor-specific sections (Zed, Neovim, Generic LSP, etc.), add:

```markdown
## Project configuration

All editor integrations honor `raven.toml` at the project root automatically. See [Configuration § Project config](configuration.md#project-config-ravenstoml). Editor-specific settings (e.g. VS Code's `raven.linting.lineLength`) act as a fallback for keys the project file does not pin.
```

- [ ] **Step 5: Update `AGENTS.md` / `CLAUDE.md`**

In the repo root `CLAUDE.md`, under "Key invariants (do not regress)", add a new bullet:

```markdown
- **Project config layering**
  - `WorldState` stores both `raw_client_settings` and `raw_project_settings` as `serde_json::Value`s.
  - `config_file::recompute_parsed_configs(state)` is the only function that should write to `state.lint_config` / `cross_file_config` / etc. after a settings change.
  - Callers (`initialize`, `did_change_configuration`, `did_change_watched_files`) must mutate the raw layers and then call `recompute_parsed_configs`, never the parsers directly.
```

- [ ] **Step 6: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs: cover raven.toml schema, precedence, CLI, and migration

New docs/cli.md describes raven lint. docs/configuration.md gains a
top-level Project config section; docs/linting.md and
docs/editor-integrations.md point users to raven.toml as the primary
configuration path. CLAUDE.md gains a config-layering invariant."
```

---

## Self-Review Checklist

- [ ] **Spec coverage:** every section of `2026-05-16-portable-lint-settings-design.md` maps to one or more tasks.
  - Overview / Goals → Tasks 1-13 collectively.
  - Precedence → Tasks 2, 4, 6, 7.
  - File schema → Tasks 3, 5, 10.
  - `.lintr` subset reader → Task 10.
  - CLI → Task 11.
  - LSP integration (initialize, did_change_configuration, did_change_watched_files, per-document resolution) → Tasks 6, 7, 8, 9.
  - VS Code extension changes → Task 12.
  - Documentation → Task 13.
  - Rule IDs → Task 1.
  - Risks (watcher fallback, dynamic registration) → Task 8.

- [ ] **Placeholder scan:** No "TBD" / "TODO" / "implement later" anywhere in the plan. Each step shows the actual code or the actual command.

- [ ] **Type consistency:**
  - `CompiledLintOverride` defined in Task 5; placeholder in Task 2 replaced in Task 5.
  - `resolve_lint_for_document(&LintConfig, &Value, &[CompiledLintOverride], &Url)` — same signature used in handlers (Task 9) and CLI (Task 11).
  - `compile_lint_overrides(merged: &Value, root: &Path)` — same call shape in initialize (Task 6), did_change_configuration (Task 7), did_change_watched_files (Task 8), CLI (Task 11).
  - `recompute_parsed_configs(&mut WorldState)` — same signature in Tasks 4, 6, 7, 8.

- [ ] **Decomposition:** Each task produces a working, committable change. Tasks 1, 2, 3, 4, 5 are foundation; Task 6 is the first end-to-end visible behavior; Tasks 7-12 are independent vertical features building on the foundation; Task 13 lands docs after shapes are final.
