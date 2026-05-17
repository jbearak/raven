# Design: Tri-state `raven.linting.enabled` (`"auto" | true | false`)

**Date:** 2026-05-16
**Status:** Approved, ready for implementation
**Tracking issue:** [#281](https://github.com/jbearak/raven/issues/281)
**Adjacent spec:** [`2026-05-16-portable-lint-settings-design.md`](./2026-05-16-portable-lint-settings-design.md) — this design layers on top of the portable-settings work and preserves its `[[linting.overrides]] enabled = false` file-skip semantics.

## Overview

`raven.linting.enabled` is documented as the master switch for native style/lint diagnostics, defaulting to `false`. In practice, the default is misleading: `lintr_loader.rs:60-62` unconditionally inserts `enabled = true` into the parsed `.lintr` project layer, and the merge layer lets project values win at leaves. So an explicit `"raven.linting.enabled": false` in client settings gets silently flipped to `true` whenever a `.lintr` is discovered anywhere on the upward walk — including a global `~/.lintr`.

This design replaces the boolean setting with a tri-state, keeping backward compatibility:

- `"auto"` (new default) — lint when `.lintr` is discovered or `raven.toml`'s `[linting] enabled = true` opts in. Off otherwise.
- `true` / `"on"` — always lint. Discovered rule severities still apply.
- `false` / `"off"` — never lint *from the master switch*. Project layer's `raven.toml enabled = true` can still flip it on, because project precedence is unchanged.

The fix has two coordinated parts: (1) `.lintr` stops injecting `enabled = true` into the project layer — the enable signal is derived from discovery state, not embedded in the merged JSON; and (2) the parser resolves `"auto"` against the discovered-config kind.

The discovery walk in `crates/raven/src/config_file/discovery.rs::find_config` is **not** changed; `~/.lintr` continues to opt the user in under `"auto"`, matching `lintr`'s own semantics. Users who don't want that set `"raven.linting.enabled": false` once.

## Goals and non-goals

**Goals**

- A client `enabled = false` is no longer silently flipped to `true` by `.lintr` discovery. (The bug.)
- A client `enabled = true` lints unless a discovered `raven.toml` explicitly says `enabled = false` (project precedence — same contract as every other linting key).
- The default behavior under `"auto"` is documented and named, not implicit.
- No migration burden: existing boolean values in client settings and `raven.toml` continue to work identically to their string equivalents.
- The behavior matrix is published in `docs/linting.md` so the contract is discoverable.
- Layer precedence (client ⊕ project, project wins at leaves) is **unchanged**. `raven.toml`-level `enabled = true|false` continues to override the client master switch — this is the project-policy contract from the portable-settings design.

**Non-goals**

- Capping the discovery walk at the workspace root. Users adopt `"auto"` semantics and set `false` to opt out globally.
- Changing per-glob `[[linting.overrides]] enabled` semantics. The approved portable-settings design uses `enabled = false` in overrides as the **file-skip** mechanism (`overrides.rs:108-125`, `cli/lint.rs:274-276`). That semantic is preserved verbatim. See "Per-glob overrides" below.
- Changing rule severities, `.lintr` subset coverage, or any non-`enabled` linting setting.
- Reload/discovery on `workspace/didChangeWorkspaceFolders`. Existing code doesn't handle that event; tri-state resolution inherits the same limitation. Documented as out-of-scope.

## Behavior matrix

This table is the user-facing contract and must be reproduced verbatim in `docs/linting.md`.

| Client (`raven.linting.enabled`) | Project state | Result |
|---|---|---|
| `"auto"` (default) | no `.lintr`, no `raven.toml` | off |
| `"auto"` | `.lintr` discovered (workspace or any ancestor incl. `~`) | **on** |
| `"auto"` | `raven.toml` with `enabled = true` (or `"on"`) | on |
| `"auto"` | `raven.toml` with `enabled = false` (or `"off"`) | off — `.lintr` not consulted (raven.toml wins discovery) |
| `"auto"` | `raven.toml` with `enabled = "auto"` or no `[linting]` | off (no `.lintr` discovered; raven.toml was discovered instead) |
| `false` / `"off"` | no project config | off |
| `false` / `"off"` | `.lintr` discovered | **off** ← closes the bug |
| `false` / `"off"` | `raven.toml` with `enabled = true` | on (raven.toml project layer wins at the leaf — project-policy contract) |
| `false` / `"off"` | `raven.toml` with `enabled = false` or `"auto"` or no `[linting]` | off |
| `true` / `"on"` | no project config | on with built-in defaults |
| `true` / `"on"` | `.lintr` discovered | on with `.lintr`'s rule severities |
| `true` / `"on"` | `raven.toml` with `enabled = true` | on |
| `true` / `"on"` | `raven.toml` with `enabled = false` | off (raven.toml project layer wins at the leaf — project-policy contract) |
| `true` / `"on"` | `raven.toml` with `enabled = "auto"` or no `[linting]` | on (project layer is silent on `enabled`, client value passes through) |

Notes:

- `raven.toml` and `.lintr` are mutually exclusive at the discovery layer (`discovery::find_config` prefers `raven.toml` on the same walk and never returns both).
- Layer precedence (client ⊕ project, project wins at leaves) is unchanged. The `enabled` field obeys the same precedence as every other linting key. The reason `false` + `raven.toml enabled = true` resolves to `on` is identical to the reason `lineLength = 80` + `raven.toml lineLength = 120` resolves to `120`.
- The only behavioral change vs. today is that an explicit client `false` is no longer overridden by `.lintr` discovery, because `.lintr` no longer contributes an `enabled` value to the project layer.

## Design

### 1. Setting shape

`editors/vscode/package.json`:

```jsonc
"raven.linting.enabled": {
  "type": ["string", "boolean"],
  "enum": ["auto", "on", "off", true, false],
  "default": "auto",
  "description": "Controls native lint diagnostics. \"auto\" (default) enables linting when a .lintr or raven.toml opts in. true/\"on\" always lints; false/\"off\" never lints (overrides any discovered .lintr). raven.toml's [linting] enabled wins over this setting (project-policy contract). See docs/linting.md for the full resolution matrix."
}
```

`raven.toml`'s `[linting]` section accepts the same shape:

```toml
[linting]
enabled = "auto"   # or true / "on" / false / "off"
```

### 2. VS Code extension wiring (do not skip)

The runtime payload is built in `editors/vscode/src/initializationOptions.ts:371-380`, which currently always emits `enabled: config.get<boolean>('linting.enabled', false)`. With the new default `"auto"` in `package.json`, this still hard-codes `false` as the fallback when unset. **This must be updated** or the migration promise breaks for users with no setting + a discovered `.lintr`.

Required edits:

- `editors/vscode/src/initializationOptions.ts:98-100`: update the `InitializationOptions.linting` interface field:

  ```ts
  linting?: {
      enabled?: boolean | "auto" | "on" | "off";
      // ...rest unchanged
  };
  ```

- `editors/vscode/src/initializationOptions.ts:371-380`: change the `config.get` call's type and fallback:

  ```ts
  enabled: config.get<boolean | 'auto' | 'on' | 'off'>('linting.enabled', 'auto'),
  ```

  (No other linting key changes.)

- `editors/vscode/src/test/settings.test.ts`: this is the only setting in `SETTINGS_MAPPING` that accepts mixed string + boolean. Extend the mapping type so `enumValues` can carry booleans:

  ```ts
  const SETTINGS_MAPPING: Array<{
      vsCodeKey: string;
      jsonPath: string[];
      type: 'number' | 'boolean' | 'string' | 'enum' | 'array';
      enumValues?: readonly (string | boolean)[];
      defaultWhenUnconfigured?: unknown;
  }> = [ /* ... */ ];
  ```

  Replace the `linting.enabled` entry with:

  ```ts
  { vsCodeKey: 'linting.enabled', jsonPath: ['linting', 'enabled'], type: 'enum', enumValues: ['auto', 'on', 'off', true, false] as const, defaultWhenUnconfigured: 'auto' },
  ```

  Verify the test loop handles `boolean` values inside the enum (it currently asserts via deep-equal, which is value-agnostic, so this should just work — but eyeball the loop to confirm).

  Add named-value test cases that round-trip each of `"auto"`, `"on"`, `"off"`, `true`, and `false` through `buildInitializationOptions`.

- Regenerate `bun editors/vscode/scripts/generate-settings-reference.mjs`; the drift test at `tests/bun/settings-reference.test.ts` gates this.

### 3. Parse and resolve

New internal enum in `crates/raven/src/linting/mod.rs`:

```rust
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub enum LintEnabled {
    #[default]
    Auto,
    On,
    Off,
}
```

`LintConfig.enabled` stays `bool` so downstream consumers (publish gates, lint runner, override-file-skip) are untouched.

`crates/raven/src/backend.rs::parse_lint_config` gains a `lintr_discovered: bool` argument and resolves the tri-state at parse time:

```rust
fn parse_lint_enabled(raw: Option<&Value>) -> LintEnabled {
    match raw {
        // Absent and explicit JSON null are semantically equivalent
        // ("no preference") and remain silent — equivalent to default.
        None | Some(Value::Null) => LintEnabled::Auto,
        Some(Value::Bool(true))  => LintEnabled::On,
        Some(Value::Bool(false)) => LintEnabled::Off,
        Some(Value::String(s)) => match s.as_str() {
            "auto"           => LintEnabled::Auto,
            "on"  | "true"   => LintEnabled::On,
            "off" | "false"  => LintEnabled::Off,
            other => {
                log::warn!("Unrecognised linting.enabled value '{other}'; defaulting to 'auto'.");
                LintEnabled::Auto
            }
        },
        // Numbers, arrays, objects, etc. — invalid input. Warn and fall back.
        Some(other) => {
            log::warn!(
                "linting.enabled must be boolean or string \"auto|on|off\"; got {}. Defaulting to 'auto'.",
                other_type_label(other)
            );
            LintEnabled::Auto
        }
    }
}
```

Resolution:

```rust
let raw_enabled = linting.and_then(|l| l.get("enabled"));
let resolved = match parse_lint_enabled(raw_enabled) {
    LintEnabled::On  => true,
    LintEnabled::Off => false,
    LintEnabled::Auto => lintr_discovered,
};
config.enabled = resolved;
```

The function must produce a populated `LintConfig` even when the merged JSON has no `linting` section but `lintr_discovered = true` — otherwise a `.lintr` whose content is entirely unrecognized (the loader produces an empty settings object — `lintr_loader.rs:58-64`) would silently resolve to `off`. Change `parse_lint_config` to return `LintConfig::default()` (with the resolved `enabled` applied) instead of `None` whenever `lintr_discovered = true`. The `.unwrap_or_default()` fallback in callers is preserved for the (now unreachable in the discovered-`.lintr` path) absent-section case.

### 4. Discovery signal

`crates/raven/src/config_file/mod.rs::recompute_parsed_configs` derives `lintr_discovered` from the existing `state.project_config_path` (filename ends in `.lintr`) and passes it into `parse_lint_config`. No new state field required. The CLI computes its own equivalent — see "CLI parity" below.

### 5. Stop force-setting `enabled` from `.lintr`

`crates/raven/src/config_file/lintr_loader.rs:60-62` — delete the `linting.entry("enabled").or_insert(json!(true))` line and the accompanying comment. `.lintr` only contributes rule severities and `[[linting.overrides]]` exclusions to the project JSON. The enable flag is derived from the discovery signal, not embedded in the project layer.

### 6. Per-glob overrides

Per-glob `[[linting.overrides]] enabled = false` is the **file-skip mechanism** documented in the approved portable-settings design (`docs/superpowers/specs/2026-05-16-portable-lint-settings-design.md:124, 157, 166, 207`) and implemented in `is_skipped_by_overrides` (`overrides.rs:106-125`). It is preserved verbatim and is **out of scope for this design** — no warning, no removal, no rename.

The only override-resolution change required is to ensure tri-state semantics don't break the file-skip path:

- `is_skipped_by_overrides` already reads `effective.get("enabled").and_then(|v| v.as_bool()) == Some(false)`. After this design, an explicit `enabled = false` in an override entry continues to match. An override entry with `enabled = "off"` should also skip — extend the check to `as_bool() == Some(false)` OR `as_str() == Some("off") | Some("false")`. An override with `enabled = "auto"` is treated as "no override on the enable flag" (i.e., inherits the base).

- `resolve_lint_for_document` parses the merged effective section through `parse_lint_config_from_section`, which wraps in `{ "linting": <section> }` and calls `parse_lint_config`. Because the master switch is now tri-state, the override path must NOT re-run `Auto → lintr_discovered` resolution; the override is meant to operate on the *already-resolved* base. Concrete signature change:

  ```rust
  pub(crate) fn parse_lint_config_from_section(
      section: &serde_json::Value,
      base_enabled: bool,
  ) -> Option<crate::linting::LintConfig>;
  ```

  Caller `resolve_lint_for_document` passes `base.enabled` (already resolved). Inside, the wrapped call to `parse_lint_config` uses `base_enabled` as the value `Auto` resolves to (rather than `lintr_discovered`). Equivalent shape:

  ```rust
  let lintr_signal = base_enabled;  // overrides inherit base, not discovery
  parse_lint_config(&wrapped, /* lintr_discovered = */ lintr_signal)
  ```

  Effect, by override `enabled` value:
  - absent → `config.enabled = base_enabled`.
  - `false` / `"off"` → `config.enabled = false`.
  - `true` / `"on"` → `config.enabled = true`.
  - `"auto"` / `null` → `config.enabled = base_enabled` (inherit).

### 7. CLI parity

`crates/raven/src/cli/lint.rs:178-214` does its own discovery and config load — it does **not** use `WorldState.project_config_path`. The CLI must compute its own `lintr_discovered`:

```rust
let (root, project_settings, lintr_discovered) = match crate::config_file::find_config(&cwd) {
    DiscoveredConfig::RavenToml(p) => { /* ...as today... */ (root, Some(settings), false) }
    DiscoveredConfig::Lintr(p)     => { /* ...as today... */ (root, Some(settings), true)  }
    DiscoveredConfig::None         => (cwd.clone(), None, false),
};
let merged = merge_settings(&empty_client, project_settings.as_ref());
let lint_config = parse_lint_config(&merged, lintr_discovered).unwrap_or_default();
```

**`--config <path>` scope:** the explicit-config flag continues to accept `raven.toml`-shaped files only (current `load_toml` path at `cli/lint.rs:149-177`). Extending it to `.lintr` is out of scope for this design — users who want `.lintr` resolution should rely on discovery (drop `--config`). For the explicit-config path, `lintr_discovered = false`. If we later extend `--config` to recognize `.lintr`, we'll switch loaders by extension and set `lintr_discovered` accordingly — but that's a separate change.

If `lint_config.enabled == false` the CLI prints no diagnostics and exits 0, matching the LSP off-state.

### 8. Override of `is_skipped_by_overrides` for string values

Update `overrides.rs:124`:

```rust
let v = effective.get("enabled");
let skipped = match v {
    Some(Value::Bool(false)) => true,
    Some(Value::String(s)) if s == "off" || s == "false" => true,
    _ => false,
};
return skipped;
```

`"auto"` and `true`/`"on"` do not skip. Same semantics as the parser; consistent vocabulary.

### 9. Documentation

Update `docs/linting.md`:

- Add the **Behavior matrix** section verbatim from this spec.
- Add a paragraph explaining `"auto"`, why it's the default, and the layer-precedence rule that makes `raven.toml enabled = true|false` win over the client master switch.
- Update existing references to the boolean shape.
- Confirm the per-glob `[[linting.overrides]] enabled = false` doc already covers the file-skip mechanism (it does — `docs/linting.md` references the portable-settings spec).

Reword the doc comment at `crates/raven/src/state.rs:559` from "Master switch defaults to off" to "Master switch; default `\"auto\"` means on when a project config opts in. See docs/linting.md for the full matrix."

## Testing

Extend the existing tests in `crates/raven/src/backend.rs` (around lines 9710-10165, which already cover the `.lintr` and `raven.toml` round trips). Add coverage for each row of the behavior matrix:

1. `"auto"` + no project config → `enabled == false`
2. `"auto"` + `.lintr` discovered (with parsed `linters:`) → `enabled == true`
3. `"auto"` + `.lintr` discovered but no recognized content → `enabled == true` (defaulted config)
4. `"auto"` + `raven.toml` with `enabled = true` → `enabled == true`
5. `"auto"` + `raven.toml` with `enabled = false` → `enabled == false`
6. `"auto"` + `raven.toml` with `enabled = "auto"` and no `.lintr` → `enabled == false`
7. `false` client + `.lintr` discovered → `enabled == false` (regression test for #281)
8. `false` client + `raven.toml` with `enabled = true` → `enabled == true` (project precedence)
9. `false` client + `raven.toml` with `enabled = false` → `enabled == false`
10. `true` client + no project config → `enabled == true`
11. `true` client + `.lintr` → `enabled == true`, severities from `.lintr` applied
12. `true` client + `raven.toml` with `enabled = false` → `enabled == false` (project precedence)
13. Boolean back-compat: client `true` and client `false` parsed identically to `"on"` and `"off"`.
14. Invalid string (`"yes"`) → falls back to `Auto` with warning.
15. Non-string/non-bool JSON (`42`, `[]`, `{}`) → falls back to `Auto` with warning. Explicit `null` falls back to `Auto` silently (semantically equivalent to absent).
16. Per-glob `[[linting.overrides]] enabled = false` continues to skip files (regression test for the portable-settings contract).
17. Per-glob `[[linting.overrides]] enabled = "off"` also skips files.
18. Per-glob override with no `enabled` key + base `Auto + .lintr` → effective `enabled == true` (inherits base).
18a. Per-glob override with `enabled = null` + base on → effective `enabled == true` (inherits base; null treated as "no override" same as absent).
18b. Per-glob override with `enabled = "auto"` + base on → effective `enabled == true` (inherits base).
18c. Per-glob override with `enabled = "auto"` + base off → effective `enabled == false` (inherits base).
19. CLI: `raven lint` in a directory with `raven.toml enabled = false` → exit 0, no diagnostics.
20. CLI: `raven lint` in a directory with a `.lintr` but no `raven.toml` → linting runs (matches LSP `"auto"` behavior).

Also extend `editors/vscode/src/test/settings.test.ts` per section 2.

## Migration

None required for end users. Boolean values in existing client and `raven.toml` settings are accepted and map to the same `On`/`Off` resolution as before. The only observable behavior changes:

- A user who had `raven.linting.enabled: false` in VS Code *and* a `.lintr` somewhere on the discovery walk: linting now turns off as the user asked. (The bug fix.)
- A user with no setting at all and a discovered `.lintr`: continues to receive linting — the default `"auto"` preserves the implicit opt-in.
- A user with no setting at all and no `.lintr`: continues to see no diagnostics, same as before.

## Risks

- **Discovery-state coupling.** Resolving `Auto` requires the parse step to know whether the discovered config was `.lintr`. Deriving from the filename is brittle if we ever add more project-config sources; revisit then.
- **Layer precedence surprise.** A user who sets `false` in VS Code and `enabled = true` in `raven.toml` ends up with linting on. That's existing precedence (project beats client at the leaf) and is desirable for projects that want to enforce linting regardless of personal preference. Documented as a matrix row.
- **No walk cap.** A user with `~/.lintr` who hasn't set `false` continues to receive linting in every R project under `~`. Acceptable per the scope decision; revisited if it becomes a recurring complaint.
- **Workspace folder changes.** If the workspace root changes at runtime, `state.project_config_path` (and therefore `lintr_discovered`) can go stale. Existing code does not handle `workspace/didChangeWorkspaceFolders`; this design inherits the limitation. A reload requires the user to restart the LSP. Documented as out-of-scope.

## Out of scope (deferred)

- Capping the discovery walk at the workspace / `.git` boundary.
- `workspace/didChangeWorkspaceFolders` reload.
- Surfacing in the LSP status notification whether the project's enable state came from `.lintr` vs `raven.toml`.
