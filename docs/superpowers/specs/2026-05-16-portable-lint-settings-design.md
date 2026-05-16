# Design: Portable lint settings (`raven.toml` + `raven lint` CLI)

**Date:** 2026-05-16
**Status:** Approved, ready for implementation

## Overview

Raven's linting configuration is currently reachable only through VS Code's `raven.linting.*` settings. The language server is editor-agnostic — Zed, Neovim, Claude Code, OpenCode, Kiro, and Crush all launch `raven --stdio` — but only the VS Code extension knows how to translate user settings into the LSP `initializationOptions` payload the server expects. Every other client uses Raven's built-in defaults regardless of what the project wants, and CI tooling has no way to run the linter at all.

This design adds two parallel paths:

1. **`raven.toml`** at the project root, read by both the LSP server and the CLI. When present, it is the source of truth for Raven settings — VS Code settings become a fallback layer used only when no project file exists.
2. **`raven lint`** subcommand that walks one or more paths, runs the native style linter against each `.R` / `.r` / `.Rmd` / `.qmd` file, and prints diagnostics in text / JSON / SARIF format with an exit code suitable for CI gating.

A documented subset of `.lintr` is read at runtime when no `raven.toml` is present, easing migration for projects already using `lintr`.

The schema mirrors the existing LSP `initializationOptions` shape 1:1, so the existing `parse_cross_file_config` / `parse_lint_config` / `parse_*_config` functions in `crates/raven/src/backend.rs` can be reused without modification — the loader just deserializes TOML into the same `serde_json::Value` the server already accepts.

## Goals and non-goals

**Goals**

- Non-VS Code editors that wire up `raven --stdio` honor project-level Raven settings without each editor needing a Raven-specific plugin.
- CI / pre-commit can run `raven lint` against a directory and get a non-zero exit on policy violations.
- A single committed config file (`raven.toml`) is the shared source of truth across VS Code, other editors, and CI — so a developer's local choices don't drift from what CI enforces.
- Projects with an existing `.lintr` keep working with no manual conversion (subset).

**Non-goals**

- Replicating every `lintr` linter. Raven's existing native-rule subset (`docs/linting.md`) is unchanged.
- Running cross-file / undefined-variable / package diagnostics in `raven lint`. Those need a workspace scan and would slow CI; they remain LSP-only.
- A full R parser for `.lintr`. The reader recognizes the subset documented below; unknown calls are logged and skipped.
- Replacing VS Code settings. They remain a valid configuration path when no `raven.toml` is present, and they continue to round-trip through the existing `editors/vscode/src/initializationOptions.ts` factory.

## Precedence

For each settings key the server consults, in order:

1. **`raven.toml`** if present (project root, discovered by walking upward from each workspace folder).
2. **`.lintr`** if present and `raven.toml` is absent. Only contributes `[linting]` keys; other sections are ignored.
3. **LSP `initializationOptions`** sent by the client. This is how VS Code currently configures the server, and it remains the path for clients that want to override defaults without a committed file.
4. **Raven defaults** as defined in `crates/raven/src/linting/mod.rs` and the other config structs in `state.rs`.

The precedence is "whole config wins per-key": when `raven.toml` specifies `linting.lineLength`, the LSP init-option value for `linting.lineLength` is ignored, but unrelated keys (e.g. `packages.rPath`) still come from init options. This keeps the rule predictable for users and lets VS Code "Reset Setting" semantics work for keys the project file does not pin.

## Files

```text
crates/raven/src/
  config_file/
    mod.rs                          # new — public entry: load_project_config()
    discovery.rs                    # new — walk up from workspace root, find raven.toml
    toml_loader.rs                  # new — TOML → serde_json::Value, validate, warn on unknown keys
    lintr_loader.rs                 # new — .lintr subset reader (line-oriented, no R parser)
    overrides.rs                    # new — per-glob LintConfig resolution
    tests.rs                        # new — unit + golden tests
  cli/
    lint.rs                         # new — `raven lint` subcommand
    analysis_stats.rs               # existing — referenced as the pattern to follow
  backend.rs                        # modify — initialize() and did_change_configuration()
                                    # merge project config with init options (project wins per-key)
  handlers.rs                       # modify — resolve effective LintConfig per-document
  main.rs                           # modify — add `lint` subcommand alongside `analysis-stats`
  state.rs                          # modify — store parsed overrides alongside lint_config

editors/vscode/
  package.json                      # modify — add `Raven: Create raven.toml` command
  src/extension.ts                  # modify — register new scaffold command, surface
                                    # status notice when project config is in effect

docs/
  configuration.md                  # modify — document raven.toml schema, precedence
  linting.md                        # modify — point to raven.toml as recommended path;
                                    # update `.lintr` section to describe the runtime reader
  editor-integrations.md            # modify — note that all editors now honor raven.toml

tests/
  cli_lint/                         # new — CLI integration fixtures + assertions
  config_file/                      # new — golden files for .lintr ↔ TOML mapping
```

## `raven.toml` schema

The TOML file is a 1:1 mirror of the LSP `initializationOptions` JSON. Keys use the same camelCase as the existing JSON schema in `editors/vscode/src/initializationOptions.ts`, so the reference table in `docs/configuration.md` stays accurate verbatim.

```toml
[linting]
enabled = true
lineLength = 100
objectLength = 30
indentationUnit = 2
assignmentOperator = "<-"
stringDelimiter = "\""

objectNameStyleFunction = "snake_case"
objectNameStyleVariable = "snake_case"
objectNameStyleArgument = "any"

lineLengthSeverity = "warning"
trailingWhitespaceSeverity = "hint"
noTabSeverity = "warning"
commentedCodeSeverity = "off"

# Per-glob overrides. Apply top-to-bottom; later matches win.
[[linting.overrides]]
files = ["tests/**/*.R", "tests/**/*.r"]
lineLength = 120
objectNameSeverity = "off"

[[linting.overrides]]
files = ["R/legacy_*.R"]
enabled = false   # skip these files entirely

[crossFile]
maxChainDepth = 10
missingFileSeverity = "warning"

[crossFile.onDemandIndexing]
enabled = true
maxTransitiveDepth = 5

[packages]
enabled = true
additionalLibraryPaths = ["/opt/R/site-library"]

[diagnostics]
enabled = true
undefinedVariableSeverity = "warning"

[indentation]
style = "rstudio"

[symbols]
workspaceMaxResults = 1000

[completion]
triggerOnOpenParen = true
```

### Schema rules

- **camelCase keys** throughout, matching the LSP init JSON. No second naming convention.
- **Unknown keys log a warning, do not error.** Forward-compat: a config valid against a newer Raven still works on older Raven. The server logs `"raven.toml: unknown key 'linting.foo'; ignoring"` at load time, once per unknown key, then continues.
- **Validation errors are non-fatal.** Malformed TOML or out-of-range values (clamped already by `parse_*_config`) produce a warning and fall back to defaults / init options. The LSP never refuses to start because of a bad config file; the CLI exits 2 with a clear message.
- **Out of scope for v1:** top-level `exclude = [...]` (use `[[linting.overrides]] enabled = false` instead); environment variable interpolation; `extends = "..."` config inheritance; per-rule disable comments beyond the existing `# nolint` / `# @lsp-ignore` markers.

### Per-file overrides

Overrides are scoped to `[linting]` only — other sections (`crossFile`, `packages`, etc.) aren't meaningfully per-file.

- **Globs** are evaluated relative to `raven.toml`'s directory. Uses the `globset` crate; globs are compiled once at load time.
- **Order matters.** Later override entries win when multiple match a path. Same model as ESLint / Prettier overrides.
- **Inheritance.** An override specifies only the keys it changes; everything else falls through to `[linting]`.
- **`enabled = false`** in an override skips the file entirely. Honored by both the LSP and the CLI. This is the v1 escape hatch in lieu of a top-level `exclude`.
- **Resolution timing.** The CLI resolves per-path before running rules. The LSP resolves per-document during diagnostic computation in `handlers.rs:248` — the existing `snapshot.lint_config` becomes a function of `(state.lint_config, state.lint_overrides, document_uri)` instead of a single cloned value. Glob compilation happens once at config load; per-document resolution is a linear scan of compiled globs.

### LSP-only / VS Code-only keys

Some keys (e.g. `helpViewer.viewColumn`) only make sense in an interactive editor. They parse fine from `raven.toml`, are passed to the server, and are simply unused outside an LSP session. This keeps the schema uniform and avoids a per-key "where is this honored" table.

## `.lintr` subset reader

Invoked only when no `raven.toml` is found. The reader is line-oriented — it does not invoke a full R parser. It looks for the documented forms below and emits one warning per unrecognized call.

### Recognized forms

```r
linters: linters_with_defaults(
    line_length_linter(120),
    assignment_linter(operator = "<-"),
    object_name_linter(styles = c("snake_case")),
    object_length_linter(40),
    indentation_linter(indent = 4),
    commented_code_linter = NULL,
    semicolon_linter = NULL
)
exclusions: list("R/legacy.R", "tests/")
```

### Mapping rules

- **`linters_with_defaults(...)`** — start from Raven's defaults, then apply each item inside as a config patch. Severities remain at `hint` unless the user has set them (`.lintr` doesn't express severities — it expresses on/off).
- **`X_linter(arg = value)`** — set the parameterized key. `line_length_linter(120)` → `lineLength = 120`. `assignment_linter(operator = "<-")` → `assignmentOperator = "<-"`. The mapping uses the table in `docs/linting.md:160` as the canonical source.
- **`X_linter = NULL`** — set `XSeverity = "off"` for that rule.
- **`exclusions: list("path", "glob")`** — translates to one `[[linting.overrides]] enabled = false` block per entry. Paths are taken as-is; directory entries become `<dir>/**`.

### Unknown / unsupported

- Linters with no Raven equivalent (`cyclocomp_linter`, `seq_linter`, `pipe_continuation_linter`, etc. — the list in `docs/linting.md:189`) log one warning each at startup: `".lintr: cyclocomp_linter has no Raven equivalent; skipping"`. They are silently default-on in Raven (whatever the relevant rule default is).
- **Out of scope:** `linters_with_tags(...)`, `defaults = list(...)` argument, custom linter definitions (`Linter(function(source_expression) ...)`), the `r:` cache key, multi-line `#`-comments-as-config. Documented as known gaps in `docs/linting.md`.
- **Parse failure** (file present but unintelligible) logs one warning and falls through to LSP init options or defaults. The LSP keeps starting.

## `raven lint` CLI

```text
raven lint [OPTIONS] [PATHS...]

  PATHS                       Files or directories to lint. Default: "."

  --config PATH               Path to raven.toml (default: search upward from CWD)
  --no-config                 Ignore raven.toml and .lintr; use built-in defaults
  --format text|json|sarif    Output format (default: text)
  --max-severity off|hint|info|warning|error
                              Highest severity that does NOT fail the build (default: info).
                              I.e. warnings and errors fail; hints/info don't.
  --quiet                     Suppress per-file headers in text output
  --no-color                  Disable ANSI colors (auto-detected on TTY otherwise)
```

### Behavior

- **Path walking.** Each `PATHS` entry is either a file (linted directly) or a directory (walked recursively). Files matching `*.R`, `*.r`, `*.Rmd`, `*.qmd` are linted; others are skipped. Symlinks are not followed. The `.gitignore` is not honored in v1 — projects can pass explicit paths or set `[[linting.overrides]] enabled = false`.
- **Per-file resolution.** For each file, compute the effective `LintConfig` from `[linting]` + matching `[[linting.overrides]]` entries. Files matching an override with `enabled = false` are skipped without parsing.
- **Linting.** Parse with the existing tree-sitter pool (`parser_pool.rs`), then call `crate::linting::run_lints` — the same function `handlers.rs:347` calls. No cross-file scope, no undefined-variable check, no package diagnostics. Document this scope clearly in `docs/linting.md`.
- **Output.**
  - `text`: `path:line:col level: message [rule]`, one per line, with a trailing summary `N issues (X errors, Y warnings, Z hints)`. Colorized on TTY.
  - `json`: array of `{ "path": "...", "diagnostic": { ... } }` objects. The `diagnostic` field is a verbatim LSP `Diagnostic` (same shape the server publishes); the `path` is workspace-relative when a project root is found, absolute otherwise. Schema is documented in `docs/cli.md` and considered stable.
  - `sarif`: SARIF 2.1.0 envelope suitable for GitHub Advanced Security code-scanning upload. Tool name `raven`, rule IDs match the Raven rule names used in suppression markers.
- **Logs to stderr.** Output formats go to stdout; warnings (unknown config keys, unrecognized `.lintr` linters, malformed source files) go to stderr.
- **Exit code.**
  - `0` — no diagnostic exceeds `--max-severity`.
  - `1` — at least one diagnostic exceeds `--max-severity`. This is the CI-gating signal.
  - `2` — operator error (config parse failure, unreadable path, invalid flag combination). Not the same as "lint failed".
- **No per-rule CLI flags.** Severity, line length, naming style, etc. live in `raven.toml`. CI and editor agree by definition.

### Default-quiet by default

`raven.linting.enabled` defaults to `false`. `raven lint` honors that — running it against a project with no `raven.toml` produces no diagnostics and exits 0. Users opt in by setting `enabled = true` in `raven.toml`. This means dropping a `raven lint .` step into CI for a project that hasn't adopted Raven yet is a no-op rather than a fire-hose of `hint`s.

## LSP integration

### `initialize` (`backend.rs:1728`)

1. Existing flow: read `initializationOptions` from `InitializeParams`.
2. **New:** for each workspace folder, run `config_file::discovery::find_config` to locate `raven.toml`. The result is cached on `state` keyed by workspace root.
3. **New:** if found, load and validate. Produce a `serde_json::Value` shaped like init options plus a parsed `Vec<LintingOverride>`.
4. **Merge.** For every key the file specifies, replace the init-options value. Pass the merged value through the existing `parse_*_config` functions. Store overrides on `state` separately.
5. If no `raven.toml` but a `.lintr` is present at the same root, load it through the subset reader — its output contributes only to `state.lint_config` (no other sections).

### `did_change_watched_files`

Already part of Raven's wiring (`libpath_watcher.rs` registers file watches). Add `raven.toml` and `.lintr` to the watched-files registration so edits trigger reload without restart. On change: re-run the merge, re-resolve per-document `LintConfig`s, force-republish diagnostics via the existing `CrossFileDiagnosticsGate::mark_force_republish` mechanism.

### `did_change_configuration` (`backend.rs:3817`)

Unchanged in shape — init options can still update the server. **But:** when merging, project-config keys still win. The function already has a `lint_config_changed` check at `backend.rs:3915`; it now compares the merged (project + init-options) value, not the raw init-options value.

### Per-document resolution (`handlers.rs:248`)

The current snapshot clones `state.lint_config`. Change to:

```rust
let effective_lint = resolve_lint_for_document(
    &state.lint_config,
    &state.lint_overrides,
    document_uri,
);
```

`resolve_lint_for_document` walks the overrides in order, applies any whose compiled glob matches the document's project-relative path, and returns an owned `LintConfig`. Compiled globs and the base config are read under the state read lock; the result is owned and outlives the lock — preserving the locking discipline in CLAUDE.md.

## VS Code extension changes

1. **New scaffold command `Raven: Create raven.toml`.** Writes a starter `raven.toml` at the workspace root, populated from any currently-explicit `raven.*` settings (using the same `RavenConfigurationInspection` plumbing already in `initializationOptions.ts`). Keys the user hasn't set are emitted as commented-out lines prefaced by their default value, matching the style of the existing `Raven: Create linting settings` command so users discover the full schema by scrolling through the file. Prompts before overwriting an existing `raven.toml`. The original VS Code scaffold command keeps working for VS Code-only setups.
2. **Status notice.** When the server reports it loaded a project config — surfaced via a new custom LSP notification `raven/projectConfigLoaded` (server → client, payload `{ path: string, source: "raven.toml" | ".lintr" }`) — the extension shows a one-time toast and writes to the output channel: `"Raven: using config at /path/to/raven.toml"`. Users who suddenly see different lint behavior get a clue without spelunking. Non-VS Code clients can ignore the notification harmlessly; it carries information already discoverable via server logs.
3. **No init-options gating.** The extension keeps sending init options unconditionally. The server decides per-key whether they apply. This keeps `editors/vscode/src/initializationOptions.ts` unchanged for non-test code paths.

## Testing

- **`config_file` unit tests** (`config_file/tests.rs`):
  - Valid TOML round-trip → expected `serde_json::Value`.
  - Unknown keys produce warnings, do not abort.
  - Malformed TOML logs and returns `None`.
  - Override ordering: later wins on key conflict.
  - Glob matching: relative paths anchored at project root.
- **`.lintr` golden tests**: pairs of input `.lintr` and expected `LintConfig` JSON. One per row of the mapping table in `docs/linting.md:160`. Plus edge cases: empty `linters_with_defaults()`, `X_linter = NULL`, unrecognized linters (assert one warning per).
- **CLI integration tests** (`tests/cli_lint/`): a fixture directory with `R/`, `tests/`, a `raven.toml` including overrides. Run `raven lint .`; assert text output structure, JSON shape, SARIF envelope, and exit codes for each `--max-severity` level. Reuse the existing test-harness pattern in `crates/raven/src/test_utils/fixture_workspace.rs`.
- **LSP integration**: extend the existing `did_change_watched_files` tests to cover `raven.toml` reloads. Add one test asserting per-document override resolution (open a `tests/` file and an `R/` file; check that diagnostics use different `LintConfig`s).
- **VS Code tests** (`editors/vscode/src/test/`): existing `settings.test.ts` keeps passing — init options still ship. Add one structural test asserting the new scaffold command is registered. No new server-roundtrip test (logic lives Rust-side).

## Documentation

- **`docs/configuration.md`** — new top-level section describing `raven.toml`: discovery, schema, precedence, examples. The existing per-key reference table stays as the canonical key list; it gains a "TOML path" column or a note that keys match the JSON 1:1.
- **`docs/linting.md`** — recommend `raven.toml` as the primary configuration path. Update the "Migrating from `.lintr`" section: existing `.lintr` files are read at runtime (subset), and the new scaffold command can convert them. The hand-conversion table stays for users who want to write `raven.toml` directly.
- **`docs/editor-integrations.md`** — note that the Zed / Neovim / Claude Code / OpenCode / Kiro / Crush sections now pick up settings from `raven.toml` automatically; remove the "VS Code only" caveat where it appears.
- **New `docs/cli.md`** — document `raven lint` invocation, flags, output formats, exit codes, and a GitHub Actions example. Linked from `docs/linting.md` and the top of `README.md`.
- **CLAUDE.md** — add `raven.toml` to the "Path resolution" invariants ("project config discovery walks up from workspace folders; never assume CWD") and to the watched-files list under "Diagnostics publishing".

## Risks and mitigations

- **Per-document `LintConfig` resolution adds overhead.** Mitigation: globs are compiled once at load; per-document resolution is a short linear scan. Benchmark via the existing `cargo bench --bench startup` plus a new lint-resolution micro-bench.
- **Precedence confusion** when both `raven.toml` and VS Code settings exist. Mitigation: the toast in VS Code surfaces which file is in effect; `docs/configuration.md` calls out the rule prominently; the scaffold command writes current VS Code settings into `raven.toml` so migration is a single action.
- **`.lintr` reader misclassifies an unusual `.lintr` file** and silently drops rules the user expected. Mitigation: warning per unknown linter; document the supported subset; CLI flag `--no-config` provides a quick escape hatch.
- **CI exit-code default surprises adopters.** Default `--max-severity=info` plus Raven's all-`hint` severity defaults means `raven lint .` on a fresh project exits 0. Users opt into failure by raising severities in `raven.toml`. Document this contract clearly so nobody is surprised one way or the other.
- **Watcher coverage on Linux / macOS sandboxed environments** (already documented in `CLAUDE.md`'s Learnings). Same caveat applies to `raven.toml` watches; fall back to "reload on `did_change_configuration`" without errors.
