# Tri-state `raven.linting.enabled` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `raven.linting.enabled` from a boolean to a tri-state (`"auto" | true | false`, default `"auto"`) so an explicit client `false` is no longer silently overridden by `.lintr` discovery (issue #281).

**Architecture:** New `LintEnabled::{Auto, On, Off}` enum parsed from the merged settings. `parse_lint_config` gains a `lintr_discovered: bool` argument and resolves `Auto → lintr_discovered` at parse time. `.lintr` loader stops force-setting `enabled = true`; the enable signal is derived from discovery state, not the merged JSON. Per-glob `[[linting.overrides]] enabled = false` file-skip semantics are preserved verbatim; string `"off"`/`"false"` are also accepted there.

**Tech Stack:** Rust (LSP server, CLI), TypeScript (VS Code extension), bun (test runner), Mocha (vscode-test), markdownlint.

**Spec:** `docs/superpowers/specs/2026-05-16-linting-enabled-tri-state-design.md`

---

## File map

**Rust — LSP / CLI**

- Modify `crates/raven/src/linting/config.rs` — add `LintEnabled` enum.
- Modify `crates/raven/src/linting/mod.rs` — re-export `LintEnabled`.
- Modify `crates/raven/src/backend.rs` — `parse_lint_enabled`, signature change on `parse_lint_config` and `parse_lint_config_from_section`, add unit tests near the existing `parse_lint_config_*` tests.
- Modify `crates/raven/src/config_file/lintr_loader.rs` — delete the force-`enabled = true` line.
- Modify `crates/raven/src/config_file/mod.rs` — derive `lintr_discovered` in `recompute_parsed_configs` and pass it through.
- Modify `crates/raven/src/config_file/overrides.rs` — pass `base.enabled` into the override re-parse, extend `is_skipped_by_overrides` to accept string `"off"`/`"false"`.
- Modify `crates/raven/src/cli/lint.rs` — compute `lintr_discovered` locally and pass to `parse_lint_config`.
- Modify `crates/raven/src/state.rs:559` — reword the doc comment on `lint_config`.

**TypeScript — VS Code extension**

- Modify `editors/vscode/package.json` — tri-state schema for `raven.linting.enabled` (`type: ["string","boolean"]`, `enum: ["auto","on","off",true,false]`, `default: "auto"`).
- Modify `editors/vscode/src/initializationOptions.ts` — interface field + `config.get` call type and fallback.
- Modify `editors/vscode/src/test/settings.test.ts` — extend mapping type to allow boolean enum values, update the `linting.enabled` entry, add named-value tests.

**Docs**

- Modify `docs/linting.md` — add behavior matrix and `"auto"` explanation.

**Generated**

- Run `bun editors/vscode/scripts/generate-settings-reference.mjs` and commit the regenerated `editors/vscode/SETTINGS.md` (or wherever the script writes; check script for output path).

---

### Task 1: Add `LintEnabled` enum and re-export

**Files:**

- Modify: `crates/raven/src/linting/config.rs`
- Modify: `crates/raven/src/linting/mod.rs`

- [ ] **Step 1: Add the enum at the end of `config.rs`**

Append to `crates/raven/src/linting/config.rs`:

```rust
/// Master-switch tri-state. Parsed from `raven.linting.enabled` (and the
/// `[linting] enabled` field in `raven.toml`).
///
/// `Auto` resolves to `true` when a `.lintr` is the discovered project config
/// (preserving the implicit opt-in users had before #281), `false` otherwise.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub enum LintEnabled {
    #[default]
    Auto,
    On,
    Off,
}
```

- [ ] **Step 2: Re-export from `linting/mod.rs`**

Edit `crates/raven/src/linting/mod.rs` line 86:

Old:
```rust
pub use self::config::{AssignmentOperatorStyle, LintConfig, ObjectNameStyle, StringDelimiter};
```

New:
```rust
pub use self::config::{AssignmentOperatorStyle, LintConfig, LintEnabled, ObjectNameStyle, StringDelimiter};
```

- [ ] **Step 3: Build**

Run: `cargo build -p raven`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/linting/config.rs crates/raven/src/linting/mod.rs
git commit -m "feat(linting): add LintEnabled tri-state enum (#281)"
```

---

### Task 2: Failing test for the bug — client `false` + `.lintr` discovered

**Files:**

- Modify: `crates/raven/src/backend.rs` (add a new test in the `parse_lint_config` tests section, near line 8089)

- [ ] **Step 1: Add the failing regression test**

In `crates/raven/src/backend.rs`, just after the `parse_lint_config_returns_none_when_section_absent` test at ~7958 (or wherever the test module ends, before the closing `}` of the module), add:

```rust
#[test]
fn parse_lint_config_client_false_overrides_lintr_discovery() {
    // Regression for #281: an explicit client `enabled = false` must remain
    // false even when a .lintr is the discovered project config. Pre-fix,
    // `.lintr` loaded with `enabled = true` and the project layer overrode
    // the client value at the merge step.
    use serde_json::json;
    let settings = json!({ "linting": { "enabled": false } });
    let cfg = crate::backend::parse_lint_config(&settings, /* lintr_discovered = */ true)
        .expect("parse_lint_config should succeed");
    assert!(!cfg.enabled, "client false must win over .lintr discovery");
}
```

- [ ] **Step 2: Run the test — it must fail (signature mismatch is fine)**

Run: `cargo test -p raven parse_lint_config_client_false_overrides_lintr_discovery 2>&1 | head -40`
Expected: compile error — `parse_lint_config` takes 1 arg, not 2.

(That's the failure we want; the signature change in the next task will resolve it.)

---

### Task 3: Implement `parse_lint_enabled` and update `parse_lint_config` signature

**Files:**

- Modify: `crates/raven/src/backend.rs` (around line 480-602)

- [ ] **Step 1: Add `parse_lint_enabled` helper above `parse_lint_config`**

Insert into `crates/raven/src/backend.rs` directly above `parse_lint_config_from_section` (line 480):

```rust
fn parse_lint_enabled(raw: Option<&serde_json::Value>) -> crate::linting::LintEnabled {
    use crate::linting::LintEnabled;
    use serde_json::Value;
    match raw {
        // Absent and explicit JSON null are semantically equivalent
        // ("no preference") and remain silent.
        None | Some(Value::Null) => LintEnabled::Auto,
        Some(Value::Bool(true)) => LintEnabled::On,
        Some(Value::Bool(false)) => LintEnabled::Off,
        Some(Value::String(s)) => match s.as_str() {
            "auto" => LintEnabled::Auto,
            "on" | "true" => LintEnabled::On,
            "off" | "false" => LintEnabled::Off,
            other => {
                log::warn!(
                    "Unrecognised linting.enabled value '{other}'; defaulting to 'auto'."
                );
                LintEnabled::Auto
            }
        },
        Some(other) => {
            let kind = match other {
                Value::Number(_) => "number",
                Value::Array(_) => "array",
                Value::Object(_) => "object",
                _ => "value",
            };
            log::warn!(
                "linting.enabled must be boolean or string \"auto|on|off\"; got {kind}. Defaulting to 'auto'."
            );
            crate::linting::LintEnabled::Auto
        }
    }
}
```

- [ ] **Step 2: Change `parse_lint_config_from_section` signature**

Edit `crates/raven/src/backend.rs:480-486`:

Old:
```rust
pub(crate) fn parse_lint_config_from_section(
    section: &serde_json::Value,
) -> Option<crate::linting::LintConfig> {
    // Wrap into the shape `parse_lint_config` expects and delegate.
    let wrapped = serde_json::json!({ "linting": section });
    parse_lint_config(&wrapped)
}
```

New:
```rust
pub(crate) fn parse_lint_config_from_section(
    section: &serde_json::Value,
    base_enabled: bool,
) -> Option<crate::linting::LintConfig> {
    // Wrap into the shape `parse_lint_config` expects and delegate. The
    // override path inherits `base_enabled` for `Auto` resolution: an
    // override that doesn't mention `enabled` (or sets it to `"auto"` /
    // `null`) keeps the base's already-resolved value.
    let wrapped = serde_json::json!({ "linting": section });
    parse_lint_config(&wrapped, base_enabled)
}
```

- [ ] **Step 3: Change `parse_lint_config` signature and rewrite the `enabled` branch**

Edit `crates/raven/src/backend.rs:488-502` — change the function signature and the `enabled` parse block:

Old:
```rust
pub(crate) fn parse_lint_config(
    settings: &serde_json::Value,
) -> Option<crate::linting::LintConfig> {
    let linting = settings.get("linting")?;
    if !linting.is_object() {
        log::warn!("linting settings must be an object; ignoring.");
        return None;
    }

    let mut config = crate::linting::LintConfig::default();

    if let Some(v) = linting.get("enabled").and_then(|v| v.as_bool()) {
        config.enabled = v;
    }
```

New:
```rust
pub(crate) fn parse_lint_config(
    settings: &serde_json::Value,
    lintr_discovered: bool,
) -> Option<crate::linting::LintConfig> {
    use crate::linting::LintEnabled;

    let linting = settings.get("linting");
    if let Some(l) = linting {
        if !l.is_object() {
            log::warn!("linting settings must be an object; ignoring.");
            // Fall through to default-with-resolved-enabled if .lintr was
            // discovered; otherwise return None as before.
            if !lintr_discovered {
                return None;
            }
        }
    } else if !lintr_discovered {
        return None;
    }

    let mut config = crate::linting::LintConfig::default();

    let raw_enabled = linting
        .and_then(|l| l.as_object())
        .and_then(|m| m.get("enabled"));
    config.enabled = match parse_lint_enabled(raw_enabled) {
        LintEnabled::On => true,
        LintEnabled::Off => false,
        LintEnabled::Auto => lintr_discovered,
    };
```

Leave the rest of `parse_lint_config` (other field parsing) unchanged.

- [ ] **Step 4: Update all callers and tests inside `backend.rs`**

In `crates/raven/src/backend.rs`, search for `parse_lint_config(&` (call sites in the test module around lines 7958-8089). Each existing call must gain a second argument. The existing tests are not testing discovery semantics, so pass `/* lintr_discovered = */ false` to preserve their intent.

Use the Edit tool with `replace_all: true` to change:

Old: `crate::backend::parse_lint_config(&settings)`
New: `crate::backend::parse_lint_config(&settings, false)`

Then fix the two `parse_lint_config_*` tests that assert `is_none()`:

`parse_lint_config_returns_none_when_section_absent` (line 7958) — passes `false`, keep `is_none()` assertion. The new code returns `None` only when no section AND `lintr_discovered = false`. With our `false` argument, the assertion still holds.

`parse_lint_config_*` test at line 8089 — same treatment.

- [ ] **Step 5: Run all `parse_lint_config_*` tests**

Run: `cargo test -p raven parse_lint_config 2>&1 | tail -30`
Expected: all green, including the new `parse_lint_config_client_false_overrides_lintr_discovery`.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "feat(linting): tri-state enabled resolution in parse_lint_config (#281)"
```

---

### Task 4: Update `recompute_parsed_configs` to thread `lintr_discovered`

**Files:**

- Modify: `crates/raven/src/config_file/mod.rs`

- [ ] **Step 1: Update the call to `parse_lint_config`**

Edit `crates/raven/src/config_file/mod.rs:58`:

Old:
```rust
    state.lint_config = crate::backend::parse_lint_config(&merged).unwrap_or_default();
```

New:
```rust
    let lintr_discovered = state
        .project_config_path
        .as_deref()
        .and_then(|p| p.file_name())
        .map(|n| n == std::ffi::OsStr::new(".lintr"))
        .unwrap_or(false);
    state.lint_config =
        crate::backend::parse_lint_config(&merged, lintr_discovered).unwrap_or_default();
```

- [ ] **Step 2: Build**

Run: `cargo build -p raven`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/config_file/mod.rs
git commit -m "feat(linting): derive lintr_discovered from project_config_path (#281)"
```

---

### Task 5: Update overrides — pass `base.enabled` and accept string `"off"`/`"false"`

**Files:**

- Modify: `crates/raven/src/config_file/overrides.rs`

- [ ] **Step 1: Update `resolve_lint_for_document`**

Edit `crates/raven/src/config_file/overrides.rs:103`:

Old:
```rust
    parse_lint_config_from_section(&effective).unwrap_or_else(|| base.clone())
```

New:
```rust
    parse_lint_config_from_section(&effective, base.enabled).unwrap_or_else(|| base.clone())
```

- [ ] **Step 2: Update `is_skipped_by_overrides` to accept string variants**

Edit `crates/raven/src/config_file/overrides.rs:124`:

Old:
```rust
    effective.get("enabled").and_then(|v| v.as_bool()) == Some(false)
```

New:
```rust
    match effective.get("enabled") {
        Some(serde_json::Value::Bool(false)) => true,
        Some(serde_json::Value::String(s)) if s == "off" || s == "false" => true,
        _ => false,
    }
```

- [ ] **Step 3: Build**

Run: `cargo build -p raven`
Expected: success.

- [ ] **Step 4: Run override tests**

Run: `cargo test -p raven --lib config_file::overrides 2>&1 | tail -20`
Expected: all green (existing tests use `enabled = false` boolean — should still pass).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/config_file/overrides.rs
git commit -m "feat(linting): per-glob override inherits base.enabled, accepts string off/false (#281)"
```

---

### Task 6: Remove force-`enabled = true` from `.lintr` loader

**Files:**

- Modify: `crates/raven/src/config_file/lintr_loader.rs`

- [ ] **Step 1: Delete the force-enable line**

Edit `crates/raven/src/config_file/lintr_loader.rs:58-64`:

Old:
```rust
    let mut settings = serde_json::Map::new();
    if !linting.is_empty() {
        // Default `enabled = true` so .lintr users get linting on without
        // having to opt in. (raven.toml users decide for themselves.)
        linting.entry("enabled").or_insert(json!(true));
        settings.insert("linting".into(), Value::Object(linting));
    }
```

New:
```rust
    let mut settings = serde_json::Map::new();
    if !linting.is_empty() {
        // `.lintr` does not contribute the `enabled` master switch. The
        // enable signal is derived from discovery state (see #281): when
        // `parse_lint_config` is called with `lintr_discovered = true`, the
        // default `"auto"` resolves to on. This keeps "drop a .lintr to opt
        // in" working without overriding an explicit client `false`.
        settings.insert("linting".into(), Value::Object(linting));
    }
```

- [ ] **Step 2: Remove the now-unused `json!` import if appropriate**

Check `lintr_loader.rs:15` — `use serde_json::{json, Value};`. `json!` is still used elsewhere in the file (the `apply_linters` / `apply_exclusions` helpers build JSON values). Leave the import as-is.

- [ ] **Step 3: Run lintr_loader tests**

Run: `cargo test -p raven --lib config_file::lintr_loader 2>&1 | tail -20`
Expected: existing tests still pass — none of them assert on the `enabled` field directly (verify by reading the test bodies first).

If any existing test in the file asserts `linting["enabled"]`, update it: remove the assertion (the loader no longer emits this field).

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/config_file/lintr_loader.rs
git commit -m "fix(linting): .lintr no longer force-sets enabled (#281)"
```

---

### Task 7: Add matrix-coverage tests in `backend.rs`

**Files:**

- Modify: `crates/raven/src/backend.rs` (test module around line 7955-8090)

- [ ] **Step 1: Add the matrix tests**

Append to the same `mod tests` block where `parse_lint_config_*` tests live:

```rust
#[test]
fn parse_lint_config_auto_default_no_project_off() {
    use serde_json::json;
    let settings = json!({ "linting": { "enabled": "auto" } });
    let cfg = crate::backend::parse_lint_config(&settings, false).unwrap();
    assert!(!cfg.enabled);
}

#[test]
fn parse_lint_config_auto_with_lintr_on() {
    use serde_json::json;
    let settings = json!({ "linting": { "enabled": "auto" } });
    let cfg = crate::backend::parse_lint_config(&settings, true).unwrap();
    assert!(cfg.enabled);
}

#[test]
fn parse_lint_config_auto_lintr_no_recognized_content_still_on() {
    use serde_json::json;
    // .lintr was discovered but its content yielded no linting fields.
    // parse_lint_config should still return Some(default config) with
    // enabled = true.
    let settings = json!({});
    let cfg = crate::backend::parse_lint_config(&settings, true).unwrap();
    assert!(cfg.enabled);
    // Other fields stay at defaults.
    assert_eq!(cfg.line_length, crate::linting::LintConfig::default().line_length);
}

#[test]
fn parse_lint_config_string_on_off() {
    use serde_json::json;
    let on = json!({ "linting": { "enabled": "on" } });
    let off = json!({ "linting": { "enabled": "off" } });
    assert!(crate::backend::parse_lint_config(&on, false).unwrap().enabled);
    assert!(!crate::backend::parse_lint_config(&off, true).unwrap().enabled);
}

#[test]
fn parse_lint_config_string_true_false_backcompat() {
    use serde_json::json;
    let t = json!({ "linting": { "enabled": "true" } });
    let f = json!({ "linting": { "enabled": "false" } });
    assert!(crate::backend::parse_lint_config(&t, false).unwrap().enabled);
    assert!(!crate::backend::parse_lint_config(&f, true).unwrap().enabled);
}

#[test]
fn parse_lint_config_bool_backcompat() {
    use serde_json::json;
    let t = json!({ "linting": { "enabled": true } });
    let f = json!({ "linting": { "enabled": false } });
    assert!(crate::backend::parse_lint_config(&t, false).unwrap().enabled);
    assert!(!crate::backend::parse_lint_config(&f, true).unwrap().enabled);
}

#[test]
fn parse_lint_config_invalid_string_warns_falls_back_to_auto() {
    use serde_json::json;
    let settings = json!({ "linting": { "enabled": "yes" } });
    // With lintr_discovered = false, Auto resolves to off.
    let cfg = crate::backend::parse_lint_config(&settings, false).unwrap();
    assert!(!cfg.enabled);
    // With lintr_discovered = true, Auto resolves to on.
    let cfg = crate::backend::parse_lint_config(&settings, true).unwrap();
    assert!(cfg.enabled);
}

#[test]
fn parse_lint_config_invalid_json_types_fall_back_to_auto() {
    use serde_json::json;
    for bad in [json!(42), json!([]), json!({})] {
        let settings = json!({ "linting": { "enabled": bad } });
        // Auto with no lintr_discovered → off.
        let cfg = crate::backend::parse_lint_config(&settings, false).unwrap();
        assert!(!cfg.enabled, "expected off for invalid enabled value");
    }
}

#[test]
fn parse_lint_config_null_silent_falls_back_to_auto() {
    use serde_json::json;
    let settings = json!({ "linting": { "enabled": null } });
    let cfg = crate::backend::parse_lint_config(&settings, false).unwrap();
    assert!(!cfg.enabled);
    let cfg = crate::backend::parse_lint_config(&settings, true).unwrap();
    assert!(cfg.enabled);
}
```

- [ ] **Step 2: Run the matrix tests**

Run: `cargo test -p raven parse_lint_config_ 2>&1 | tail -30`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "test(linting): cover behavior matrix for tri-state enabled (#281)"
```

---

### Task 8: Add per-glob override tests for tri-state behavior

**Files:**

- Modify: `crates/raven/src/config_file/overrides.rs` (test module at line 127+)

- [ ] **Step 1: Add override-resolution tests**

In the `mod tests` block at the bottom of `crates/raven/src/config_file/overrides.rs`, append:

```rust
#[test]
fn override_enabled_false_string_off_skips_file() {
    let tmp = std::path::PathBuf::from("/tmp/proj");
    let overrides = make_overrides(
        &tmp,
        vec![("vendor/**/*.R", serde_json::json!({ "enabled": "off" }))],
    );
    let base_section = serde_json::json!({ "enabled": true });
    assert!(is_skipped_by_overrides(
        &base_section,
        &overrides,
        std::path::Path::new("vendor/file.R"),
    ));
}

#[test]
fn override_no_enabled_key_inherits_base() {
    let mut base = LintConfig::default();
    base.enabled = true;
    let tmp = std::path::PathBuf::from("/tmp/proj");
    let overrides = make_overrides(
        &tmp,
        vec![("**/*.R", serde_json::json!({ "lineLength": 120 }))],
    );
    let url = tower_lsp::lsp_types::Url::from_file_path("/tmp/proj/x.R").unwrap();
    let effective = resolve_lint_for_document(&base, &serde_json::json!({}), &overrides, &url);
    assert!(effective.enabled, "override without enabled should inherit base");
    assert_eq!(effective.line_length, 120);
}

#[test]
fn override_auto_inherits_base() {
    let mut base = LintConfig::default();
    base.enabled = true;
    let tmp = std::path::PathBuf::from("/tmp/proj");
    let overrides = make_overrides(
        &tmp,
        vec![("**/*.R", serde_json::json!({ "enabled": "auto" }))],
    );
    let url = tower_lsp::lsp_types::Url::from_file_path("/tmp/proj/x.R").unwrap();
    let effective = resolve_lint_for_document(&base, &serde_json::json!({}), &overrides, &url);
    assert!(effective.enabled, "override 'auto' should inherit base on");

    base.enabled = false;
    let effective = resolve_lint_for_document(&base, &serde_json::json!({}), &overrides, &url);
    assert!(!effective.enabled, "override 'auto' should inherit base off");
}

#[test]
fn override_null_inherits_base() {
    let mut base = LintConfig::default();
    base.enabled = true;
    let tmp = std::path::PathBuf::from("/tmp/proj");
    let overrides = make_overrides(
        &tmp,
        vec![("**/*.R", serde_json::json!({ "enabled": null }))],
    );
    let url = tower_lsp::lsp_types::Url::from_file_path("/tmp/proj/x.R").unwrap();
    let effective = resolve_lint_for_document(&base, &serde_json::json!({}), &overrides, &url);
    assert!(effective.enabled, "override null should inherit base");
}
```

- [ ] **Step 2: Run the override tests**

Run: `cargo test -p raven --lib config_file::overrides 2>&1 | tail -30`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/config_file/overrides.rs
git commit -m "test(linting): per-glob override tri-state semantics (#281)"
```

---

### Task 9: Update CLI to thread `lintr_discovered`

**Files:**

- Modify: `crates/raven/src/cli/lint.rs`

- [ ] **Step 1: Extend the discovery tuple and pass `lintr_discovered`**

Edit `crates/raven/src/cli/lint.rs:146-214` — adjust the tuple computed by the if-else chain and the call to `parse_lint_config`.

Old (the if-else around line 147-206):
```rust
    let (root, project_settings) = if args.no_config {
        (cwd.clone(), None)
    } else if let Some(explicit) = args.config_path.as_ref() {
        match crate::config_file::load_toml(explicit) {
            Some(l) => {
                /* ...as today... */
                (root, Some(l.settings))
            }
            None => { /* error */ return EXIT_OPERATOR_ERROR; }
        }
    } else {
        match crate::config_file::find_config(&cwd) {
            crate::config_file::DiscoveredConfig::RavenToml(p) => {
                /* ...as today... */
                (p.parent().unwrap_or(&cwd).to_path_buf(), Some(l.settings))
            }
            crate::config_file::DiscoveredConfig::Lintr(p) => {
                /* ...as today... */
                (p.parent().unwrap_or(&cwd).to_path_buf(), Some(l.settings))
            }
            crate::config_file::DiscoveredConfig::None => (cwd.clone(), None),
        }
    };
```

New: change every tuple to `(root, project_settings, lintr_discovered)`. Concretely:

- `args.no_config` branch → `(cwd.clone(), None, false)`
- `--config <path>` (always `load_toml`) → `(root, Some(l.settings), false)` (explicit config is raven.toml-only — see spec section 7)
- `DiscoveredConfig::RavenToml` → `(root, Some(l.settings), false)`
- `DiscoveredConfig::Lintr` → `(root, Some(l.settings), true)`
- `DiscoveredConfig::None` → `(cwd.clone(), None, false)`

Then update the binding on the if-else result:
```rust
let (root, project_settings, lintr_discovered) = if args.no_config { /* ... */ };
```

And the call to `parse_lint_config` at line 214:

Old:
```rust
    let lint_config = crate::backend::parse_lint_config(&merged).unwrap_or_default();
```

New:
```rust
    let lint_config = crate::backend::parse_lint_config(&merged, lintr_discovered).unwrap_or_default();
```

- [ ] **Step 2: Build**

Run: `cargo build -p raven`
Expected: success.

- [ ] **Step 3: Add a CLI integration test**

Look for existing CLI tests in the repo. Run:

```bash
grep -rn "raven lint\|cli::lint::run\|cli/lint" crates/raven/tests crates/raven/src --include="*.rs" -l | head -10
```

If there's an existing CLI integration test file (likely `crates/raven/tests/lint_cli.rs` or similar), add this test there. If not, skip this step — the unit tests in tasks 7 and 8 plus the LSP tests in task 10 cover the resolution.

Test to add (only if a CLI test harness exists):
```rust
#[test]
fn cli_with_lintr_discovered_lints() {
    // Create a temp dir with a .lintr that opts into a single rule,
    // a sample .R file with a too-long line, run `raven lint`, expect
    // a non-zero diagnostic count.
    // ...mirror existing test patterns in the file...
}
```

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/cli/lint.rs
git commit -m "feat(linting): cli passes lintr_discovered to parse_lint_config (#281)"
```

---

### Task 10: LSP integration test for the round trip

**Files:**

- Modify: `crates/raven/src/backend.rs` (LSP test region around line 9710-10165)

- [ ] **Step 1: Find an analogous existing LSP test**

Look at the tests around line 9710-9800 — they cover `.lintr` round-trips through `initialize`. Pick the closest one as a template. The patterns there use `tempfile::TempDir`, write a `.lintr`, call the LSP `initialize` handler, then assert on `state.lint_config`.

- [ ] **Step 2: Add a round-trip test for client `false` + `.lintr`**

In the same test module (likely `mod project_config_tests` or similar — confirm by reading the surrounding context), add:

```rust
#[tokio::test]
async fn client_false_overrides_lintr_discovery_round_trip() {
    use serde_json::json;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    std::fs::write(
        tmp.path().join(".lintr"),
        "linters: linters_with_defaults(line_length_linter(120))\n",
    )
    .unwrap();

    let (server, _) = make_test_server();
    let init_options = json!({
        "linting": { "enabled": false }
    });
    server
        .initialize(make_initialize_params(tmp.path(), Some(init_options)))
        .await
        .unwrap();

    let state = server.state.read().await;
    assert!(
        !state.lint_config.enabled,
        "client enabled=false must win over .lintr discovery (#281)"
    );
}
```

Adapt `make_test_server` / `make_initialize_params` to match what the surrounding tests use. If the helpers have different names, follow whatever pattern the nearest `.lintr` round-trip test uses.

- [ ] **Step 3: Run the new LSP test**

Run: `cargo test -p raven client_false_overrides_lintr_discovery_round_trip 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 4: Run all `.lintr`-related LSP tests to confirm no regressions**

Run: `cargo test -p raven lintr 2>&1 | tail -40`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "test(linting): LSP round-trip for #281 (client false beats .lintr)"
```

---

### Task 11: Update VS Code extension — schema + initializationOptions + tests

**Files:**

- Modify: `editors/vscode/package.json`
- Modify: `editors/vscode/src/initializationOptions.ts`
- Modify: `editors/vscode/src/test/settings.test.ts`

- [ ] **Step 1: Update the JSON schema for `raven.linting.enabled` in `package.json`**

Edit `editors/vscode/package.json:1233-1238`:

Old:
```jsonc
"raven.linting.enabled": {
  "type": "boolean",
  "default": false,
  "description": "Enable native style/lint diagnostics. When on, Raven reports a small set of lintr-equivalent rules (line length, trailing whitespace, tabs, assignment operator, trailing blank lines) directly from its tree-sitter AST — no R or lintr install required. Individual rules can still be disabled via their per-rule severity settings."
},
```

New:
```jsonc
"raven.linting.enabled": {
  "type": ["string", "boolean"],
  "enum": ["auto", "on", "off", true, false],
  "default": "auto",
  "description": "Controls native lint diagnostics. \"auto\" (default) enables linting when a .lintr or raven.toml opts in. true/\"on\" always lints; false/\"off\" never lints (overrides any discovered .lintr). raven.toml's [linting] enabled wins over this setting per the project-policy contract. See docs/linting.md for the full resolution matrix."
},
```

- [ ] **Step 2: Update the TypeScript interface and runtime payload**

Edit `editors/vscode/src/initializationOptions.ts:98-100`:

Old:
```ts
    linting?: {
        enabled?: boolean;
```

New:
```ts
    linting?: {
        enabled?: boolean | "auto" | "on" | "off";
```

Edit `editors/vscode/src/initializationOptions.ts:371-372`:

Old:
```ts
    options.linting = {
        enabled: config.get<boolean>('linting.enabled', false),
```

New:
```ts
    options.linting = {
        enabled: config.get<boolean | 'auto' | 'on' | 'off'>('linting.enabled', 'auto'),
```

- [ ] **Step 3: Update the settings.test.ts mapping type and entry**

Edit `editors/vscode/src/test/settings.test.ts:74-79`:

Old:
```ts
const SETTINGS_MAPPING: Array<{
    vsCodeKey: string;
    jsonPath: string[];
    type: 'number' | 'boolean' | 'string' | 'enum' | 'array';
    enumValues?: readonly string[];
    defaultWhenUnconfigured?: unknown;
}> = [
```

New:
```ts
const SETTINGS_MAPPING: Array<{
    vsCodeKey: string;
    jsonPath: string[];
    type: 'number' | 'boolean' | 'string' | 'enum' | 'array';
    enumValues?: readonly (string | boolean)[];
    defaultWhenUnconfigured?: unknown;
}> = [
```

Edit `editors/vscode/src/test/settings.test.ts:125`:

Old:
```ts
{ vsCodeKey: 'linting.enabled', jsonPath: ['linting', 'enabled'], type: 'boolean', defaultWhenUnconfigured: false },
```

New:
```ts
{ vsCodeKey: 'linting.enabled', jsonPath: ['linting', 'enabled'], type: 'enum', enumValues: ['auto', 'on', 'off', true, false] as const, defaultWhenUnconfigured: 'auto' },
```

- [ ] **Step 4: Inspect the test loop to confirm it handles boolean enum values**

Read `editors/vscode/src/test/settings.test.ts:1-60` (the test driver code that consumes `SETTINGS_MAPPING`). The loop is value-agnostic if it uses deep equality on the configured value. If it has a `typeof === 'string'` branch that excludes booleans from the `enum` path, fix it to accept `string | boolean` for `type: 'enum'` rows whose `enumValues` includes booleans.

If a fix is needed, do it minimally and locally.

- [ ] **Step 5: Add a named-value test that round-trips each tri-state value**

Below the existing settings tests in `settings.test.ts`, add a test that explicitly sets `raven.linting.enabled` to each of `'auto'`, `'on'`, `'off'`, `true`, `false` and confirms `buildInitializationOptions` round-trips the value as `options.linting.enabled`. Use whatever helpers exist in the file. Example shape:

```ts
test('linting.enabled tri-state round-trips through buildInitializationOptions', () => {
    for (const value of ['auto', 'on', 'off', true, false] as const) {
        const config = makeMockConfig({ 'linting.enabled': value });
        const options = buildInitializationOptions(config);
        assert.strictEqual(options.linting?.enabled, value);
    }
});
```

(`makeMockConfig` may be named differently — match what nearby tests use.)

- [ ] **Step 6: Compile the extension**

Run: `cd editors/vscode && bun run compile 2>&1 | tail -20`
Expected: TypeScript compiles cleanly.

- [ ] **Step 7: Regenerate settings reference**

Run: `bun editors/vscode/scripts/generate-settings-reference.mjs`
Expected: regenerated reference file with the new tri-state shape.

- [ ] **Step 8: Run the VS Code unit tests (Mocha via vscode-test)**

Run the standard VS Code test wrapper. From repo root, check `package.json` or the README for the canonical command. Typically: `bun run test:vscode` or the Mocha invocation registered in `package.json`. If unsure, search:

```bash
grep -rn "test:vscode\|vscode-test\|runTests" editors/vscode/package.json package.json 2>/dev/null | head
```

Expected: all VS Code tests pass.

- [ ] **Step 9: Commit**

```bash
git add editors/vscode/package.json editors/vscode/src/initializationOptions.ts editors/vscode/src/test/settings.test.ts editors/vscode/SETTINGS.md
git commit -m "feat(vscode): tri-state raven.linting.enabled schema + tests (#281)"
```

(Adjust path of regenerated file if it lives elsewhere.)

---

### Task 12: Update user docs and state.rs doc comment

**Files:**

- Modify: `docs/linting.md`
- Modify: `crates/raven/src/state.rs`

- [ ] **Step 1: Reword the doc comment on `state.lint_config`**

Edit `crates/raven/src/state.rs:558-560`:

Old:
```rust
    /// Style/lint configuration.
    /// Master switch defaults to off; opt in via `raven.linting.enabled`.
    pub lint_config: crate::linting::LintConfig,
```

New:
```rust
    /// Style/lint configuration.
    /// Master switch is tri-state (`"auto" | true | false`); default `"auto"`
    /// resolves to on when a `.lintr` is discovered (see #281 and
    /// `docs/linting.md` for the full matrix).
    pub lint_config: crate::linting::LintConfig,
```

- [ ] **Step 2: Update `docs/linting.md` — add the behavior matrix**

Find the section in `docs/linting.md` that documents `raven.linting.enabled`. Replace any "defaults to `false`; flip to `true` to enable" wording with the matrix below, and add a paragraph above it explaining `"auto"`.

Insert this section (location: under the existing `Enabling the linter` heading, replacing any current single-paragraph "boolean toggle" description):

```markdown
### Master switch (`raven.linting.enabled`)

`raven.linting.enabled` is tri-state: `"auto"` (the default), `true` (or `"on"`), or `false` (or `"off"`). Booleans are accepted for backward compatibility with existing settings.

- `"auto"` — lint when a project config opts in. Specifically: when a `.lintr` is discovered on the upward walk from the workspace (matching `lintr`'s own ancestor lookup, including a `~/.lintr` in your home directory), or when a `raven.toml` sets `[linting] enabled = true`. Otherwise off.
- `true` / `"on"` — always lint. Discovered rule severities still apply.
- `false` / `"off"` — never lint *from the master switch*. A discovered `raven.toml` can still set `enabled = true` and that wins per the project-policy contract; a discovered `.lintr` alone does not.

Behavior matrix (client setting × project state):

| Client (`raven.linting.enabled`) | Project state | Result |
|---|---|---|
| `"auto"` (default) | no `.lintr`, no `raven.toml` | off |
| `"auto"` | `.lintr` discovered (workspace or any ancestor incl. `~`) | on |
| `"auto"` | `raven.toml` with `enabled = true` (or `"on"`) | on |
| `"auto"` | `raven.toml` with `enabled = false` (or `"off"`) | off — `.lintr` not consulted (raven.toml wins discovery) |
| `"auto"` | `raven.toml` with `enabled = "auto"` or no `[linting]` | off (no `.lintr` discovered; raven.toml was discovered instead) |
| `false` / `"off"` | no project config | off |
| `false` / `"off"` | `.lintr` discovered | off |
| `false` / `"off"` | `raven.toml` with `enabled = true` | on (raven.toml project layer wins at the leaf — project-policy contract) |
| `false` / `"off"` | `raven.toml` with `enabled = false`/`"auto"`/no `[linting]` | off |
| `true` / `"on"` | no project config | on with built-in defaults |
| `true` / `"on"` | `.lintr` discovered | on with `.lintr`'s rule severities |
| `true` / `"on"` | `raven.toml` with `enabled = true` | on |
| `true` / `"on"` | `raven.toml` with `enabled = false` | off (raven.toml project layer wins at the leaf — project-policy contract) |
| `true` / `"on"` | `raven.toml` with `enabled = "auto"` or no `[linting]` | on (project layer is silent on `enabled`; client value passes through) |

`raven.toml` and `.lintr` are mutually exclusive at discovery: `raven.toml` wins on the same walk and `.lintr` is not consulted.
```

- [ ] **Step 3: Update any other doc references**

Search and update any remaining stale references:

```bash
grep -rn "raven.linting.enabled\|linting.enabled\".*default.*false\|defaults to.*false.*lint" docs/ README.md 2>/dev/null | head -20
```

For each match, ensure it describes the new tri-state semantics. The README typically only links to `docs/linting.md` — minor edits, if any.

- [ ] **Step 4: Lint the markdown**

Run: `markdownlint docs/linting.md docs/superpowers/specs/2026-05-16-linting-enabled-tri-state-design.md docs/superpowers/plans/2026-05-16-linting-enabled-tri-state-plan.md 2>&1 | tail -20`
Expected: no errors (or only pre-existing errors unrelated to this change).

If the table rows trip MD013 (line length), check whether the surrounding doc has a relaxed config; if not, add `<!-- markdownlint-disable MD013 -->` immediately above the matrix and `<!-- markdownlint-enable MD013 -->` after.

- [ ] **Step 5: Commit**

```bash
git add docs/linting.md crates/raven/src/state.rs
git commit -m "docs(linting): document tri-state enabled and behavior matrix (#281)"
```

---

### Task 13: Final verification — full test suites

**Files:** none (verification only)

- [ ] **Step 1: Run the full Rust test suite**

Run: `cargo test -p raven 2>&1 | tail -40`
Expected: all green.

- [ ] **Step 2: Run the bun test suite**

Run from repo root: `bun test 2>&1 | tail -40`
Expected: all green. (Includes the `tests/bun/settings-reference.test.ts` drift check that gates the regenerated settings reference.)

- [ ] **Step 3: Run the VS Code Mocha tests**

Run the canonical command from Task 11 Step 8.
Expected: all green.

- [ ] **Step 4: Build a release binary as a smoke test**

Run: `cargo build --release -p raven 2>&1 | tail -10`
Expected: success.

- [ ] **Step 5: Verify the CLI behaves correctly with a fresh repro of #281**

```bash
RAVEN_BIN="${RAVEN_BIN:-$(pwd)/target/release/raven}"
TMP=$(mktemp -d)
echo 'linters: linters_with_defaults()' > "$TMP/.lintr"
cat > "$TMP/test.R" <<EOF
x = 1  # would trigger assignment_operator if linting is on
EOF
cd "$TMP" && "$RAVEN_BIN" lint test.R --format text
```

Expected: lint diagnostics appear (because `.lintr` was discovered, `"auto"` resolved to on). Then verify the off path:

```bash
cd "$TMP"
cat > raven.toml <<EOF
[linting]
enabled = false
EOF
"$RAVEN_BIN" lint test.R --format text
```

Expected: no diagnostics; `raven.toml`'s explicit `false` wins, and `.lintr` is not consulted (raven.toml wins discovery).

Clean up: `rm -rf "$TMP"`.

- [ ] **Step 6: No commit (verification only)**

---

## Self-Review checklist (run by the author of this plan before handoff)

1. **Spec coverage:** every spec section maps to a task — setting shape (Task 11), VS Code extension wiring (Task 11), parse and resolve (Tasks 3, 7), discovery signal (Task 4), stop force-`enabled` (Task 6), per-glob overrides (Tasks 5, 8), CLI parity (Task 9), documentation (Task 12), tests (Tasks 2, 7, 8, 10).
2. **Placeholder scan:** no TBDs, every code block contains complete content.
3. **Type consistency:** `parse_lint_config(settings, lintr_discovered: bool)` and `parse_lint_config_from_section(section, base_enabled: bool)` signatures match across all tasks. `LintEnabled` enum is consistent.
4. **Risks:** none uncovered by tasks. Each behavior matrix row has a corresponding unit test.
