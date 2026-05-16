# Design: Portable lint settings (`raven.toml` + `raven lint` CLI)

**Date:** 2026-05-16
**Status:** Approved, ready for implementation

## Overview

Raven's linting configuration is currently reachable only through VS Code's `raven.linting.*` settings. The language server is editor-agnostic — Zed, Neovim, Claude Code, OpenCode, Kiro, and Crush all launch `raven --stdio` — but only the VS Code extension knows how to translate user settings into the LSP `initializationOptions` payload the server expects. Every other client uses Raven's built-in defaults regardless of what the project wants, and CI tooling has no way to run the linter at all.

This design adds two parallel paths:

1. **`raven.toml`** at the project root, read by both the LSP server and the CLI. The file overrides any key it specifies; keys it does not specify continue to come from the client's LSP `initializationOptions` (or from `did_change_configuration` updates). VS Code settings remain a valid input — they just lose any contest with the project file on a per-key basis.
2. **`raven lint`** subcommand that walks one or more paths, runs the native style linter against each `.R` / `.r` file, and prints diagnostics in text / JSON / SARIF format with an exit code suitable for CI gating. R Markdown / Quarto files are excluded by default in v1 because the tree-sitter R parser treats prose and YAML as syntax errors — the LSP already gates them out via `chunk_kind` (`handlers.rs:331`) and the CLI follows the same rule.

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
- Replacing VS Code settings. They remain a valid configuration path and continue to round-trip through the existing `editors/vscode/src/initializationOptions.ts` factory. Per-key, project-file values win when both are set.
- Linting R chunks embedded in `.Rmd` / `.qmd` files in v1. The chunk-extraction story lives with the broader chunk-LSP work referenced in `docs/chunks.md`; the CLI scopes itself to plain R source for now.
- Multi-root workspaces with distinct configs per folder. v1 picks the first workspace folder (matching the existing convention in `backend.rs:1889`); see "Multi-root workspaces" below.

## Precedence

For each settings key, the server resolves a value by merging three raw JSON layers and then parsing the merged result through the existing `parse_*_config` functions. Layers are merged with later layers overwriting earlier ones at the leaf level:

1. **Built-in defaults** (`{}` — the existing `parse_*_config` functions fall back to struct defaults for any absent key).
2. **Raw client settings** — the latest LSP `initializationOptions` plus any subsequent `did_change_configuration` payload, stored verbatim on `state` as a `serde_json::Value`. This is what VS Code currently sends.
3. **Raw project config** — `raven.toml` decoded into a `serde_json::Value` with the same shape. Stored verbatim on `state` so we can re-merge on either side changing.

`.lintr` is consulted only when no `raven.toml` is found. It maps into the same project-config JSON shape (linting keys only) and becomes the layer-3 input.

Concretely: if `raven.toml` sets `linting.lineLength = 100`, that key wins over a client-supplied `100`-or-anything-else. If `raven.toml` is silent on `linting.objectLength` and the client sent `40`, the merged value is `40`. If neither sets it, the parser returns the struct default. Per-key fallback works in every direction — including when the user clears a setting in VS Code, because layer 2 is re-stored verbatim on every `did_change_configuration`.

A merged-settings change is detected by comparing the previous parsed configs to the freshly parsed configs after re-merging; the existing `lint_config_changed`-style guards in `backend.rs:3915` move from comparing init-option-derived parses to comparing post-merge parses.

## Files

```text
crates/raven/src/
  config_file/
    mod.rs                          # new — public entry: load_project_config(), recompute_parsed_configs()
    discovery.rs                    # new — walk up from workspace root, find raven.toml
    toml_loader.rs                  # new — TOML → serde_json::Value, validate, warn on unknown keys
    lintr_loader.rs                 # new — .lintr DCF fold + token recognizer
    merge.rs                        # new — layer-merge raw client settings + raw project settings
    overrides.rs                    # new — per-glob LintConfig resolution + URI → relative path
    tests.rs                        # new — unit + golden tests
  cli/
    lint.rs                         # new — `raven lint` subcommand
    analysis_stats.rs               # existing — referenced as the pattern to follow
  linting/
    rule_ids.rs                     # new — const taxonomy of rule IDs
    rules/*.rs                      # modify — each `collect(...)` sets Diagnostic.code
  backend.rs                        # modify — initialize(), did_change_configuration(),
                                    # dynamic registration of workspace/didChangeWatchedFiles
  handlers.rs                       # modify — resolve effective LintConfig per-document
  main.rs                           # modify — add `lint` subcommand alongside `analysis-stats`
  state.rs                          # modify — add raw_client_settings, raw_project_settings,
                                    # project_config_path, lint_overrides

editors/vscode/
  package.json                      # modify — add `Raven: Create raven.toml` command
  src/extension.ts                  # modify — extend synchronize.fileEvents glob to include
                                    # raven.toml and .lintr; register new scaffold command;
                                    # handle raven/projectConfigLoaded notification

docs/
  configuration.md                  # modify — document raven.toml schema, precedence
  linting.md                        # modify — point to raven.toml as recommended path;
                                    # update `.lintr` section to describe the runtime reader
  editor-integrations.md            # modify — note that all editors now honor raven.toml
  cli.md                            # new — raven lint flags, output, exit codes, CI examples

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
- **Untitled / non-`file://` URIs.** Globs match only `file://` URIs that resolve to a path under the project root. Untitled buffers, in-memory `git:` URIs, and anything else that doesn't resolve to a project-relative path skip all overrides and use the base `[linting]` config. The CLI never sees these URIs.

### Schema is exactly what the server parses

The `raven.toml` schema covers exactly the sections the server parses today: `linting`, `crossFile`, `packages`, `diagnostics`, `indentation`, `symbols`, `completion`. Client-only knobs that have no server effect (e.g. VS Code's `helpViewer.viewColumn`) are not part of the file schema — they remain VS Code-only settings. This keeps the schema honest: every key in `raven.toml` corresponds to actual server behavior.

### Multi-root workspaces

v1 picks the first workspace folder for project-config discovery (matching the existing convention in `backend.rs:1889`). If multiple folders are open, each opens its own VS Code window's config blob in client memory, but the server reads `raven.toml` from one root. This is consistent with the rest of `WorldState`, which already holds single global configs for cross-file, packages, etc. (`state.rs:528`). Users who need per-folder configs should open the subfolder directly. A multi-root mode is a possible follow-up; flagging it explicitly here so the implementer doesn't over-engineer state.

## `.lintr` subset reader

Invoked only when no `raven.toml` is found. `.lintr` is a DCF (Debian Control Format)-style file: each field begins with `Name:` at column zero and continues across subsequent lines that begin with whitespace. The reader is a two-step process:

1. **DCF fold** — walk the file line by line; whenever a line starts with whitespace (or is a continuation of an unterminated parenthesis from the previous physical line), append it to the current field's accumulated value. Produces a `(key, value)` list, where `value` is a single logical string per field.
2. **Token recognizer** on the folded `linters:` and `exclusions:` values — a small scanner that walks the assembled string skipping balanced parens / brackets / quotes, identifying top-level call expressions and bare-name assignments. It does **not** evaluate R; it pattern-matches the documented forms below.

A simple line-by-line scan is not sufficient because `linters_with_defaults(...)` typically spans many lines with continuation indentation; the fold is mandatory.

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

- **Top-level recognized-shape calls with unknown names** (e.g. `cyclocomp_linter`, `seq_linter`, `pipe_continuation_linter` — the list in `docs/linting.md:189`) log one warning each at startup: `".lintr: cyclocomp_linter has no Raven equivalent; skipping"`. The recognizer picks these out reliably because they share the `name(...)` or `name = NULL` shape with the supported forms.
- **Forms outside the recognizer's grammar** — `linters_with_tags(...)`, `defaults = list(...)` argument substitution, custom `Linter(function(...) ...)` definitions, the `r:` cache key, and anything else the token scanner can't classify into "recognized shape" — log a single batch warning at startup: `".lintr: ignoring N unrecognized construct(s); see docs/linting.md for the supported subset"`. These are documented gaps, not silent failures.
- **Parse failure** (file present but the DCF fold itself doesn't yield a `linters:` field, or the recognizer hits a token-level error before any matching call) logs one warning and falls through to client settings or defaults. The LSP keeps starting.

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

- **Path walking.** Each `PATHS` entry is either a file (linted directly) or a directory (walked recursively). Files matching `*.R` and `*.r` are linted; `.Rmd` / `.qmd` files are skipped with a one-line note (and an empty list of diagnostics in JSON/SARIF) — the tree-sitter R parser treats prose and YAML as syntax errors, so the LSP gates them out and the CLI does the same (`handlers.rs:331`). Symlinks are not followed. The `.gitignore` is not honored in v1 — projects can pass explicit paths or set `[[linting.overrides]] enabled = false`.
- **Per-file resolution.** For each file, compute the effective `LintConfig` from `[linting]` + matching `[[linting.overrides]]` entries. Files matching an override with `enabled = false` are skipped without parsing.
- **Linting.** Parse with the existing tree-sitter pool (`parser_pool.rs`), then call `crate::linting::run_lints` — the same function `handlers.rs:347` calls. No cross-file scope, no undefined-variable check, no package diagnostics. Document this scope clearly in `docs/linting.md`.
- **Output.**
  - `text`: `path:line:col level: message [rule]`, one per line, with a trailing summary `N issues (X errors, Y warnings, Z hints)`. Colorized on TTY. The trailing `[rule]` is the rule identifier (see "Rule IDs" below).
  - `json`: array of `{ "path": "...", "diagnostic": { ... } }` objects. The `diagnostic` field is a verbatim LSP `Diagnostic` (same shape the server publishes, including the new `code` field); the `path` is workspace-relative when a project root is found, absolute otherwise. Schema is documented in `docs/cli.md` and considered stable.
  - `sarif`: SARIF 2.1.0 envelope suitable for GitHub Advanced Security code-scanning upload. Tool name `raven`; `ruleId` per result comes from `Diagnostic.code`.
- **Logs to stderr.** Output formats go to stdout; warnings (unknown config keys, unrecognized `.lintr` linters, malformed source files) go to stderr.
- **Exit code.**
  - `0` — no diagnostic exceeds `--max-severity`.
  - `1` — at least one diagnostic exceeds `--max-severity`. This is the CI-gating signal.
  - `2` — operator error (config parse failure, unreadable path, invalid flag combination). Not the same as "lint failed".
- **No per-rule CLI flags.** Severity, line length, naming style, etc. live in `raven.toml`. CI and editor agree by definition.

### Rule IDs

Current lint diagnostics set only `source = "raven (lint)"` and a free-form `message`; there is no `code` field (`linting/rules/*.rs`). The CLI's `[rule]` suffix and SARIF `ruleId` require a stable identifier per rule.

Add a small `linting/rule_ids.rs` module that owns the canonical taxonomy — one `pub const` per rule name (e.g. `LINE_LENGTH`, `OBJECT_NAME`, `COMMENTED_CODE`). Each rule's `collect(...)` function gets a matching `code: Some(NumberOrString::String(RULE_ID.to_string()))` on the `Diagnostic` it pushes. The ID strings match the `# nolint: <rule>` markers the suppression matrix already documents (`docs/linting.md:217`), so users can copy a CLI rule ID directly into a `# nolint:` suppression.

The LSP picks up the same `code` field for free — VS Code displays it in the Problems pane and quick-fix UX, which is a nice incidental win. Existing tests that assert on diagnostic shape (which currently ignore `code`) keep passing; a few golden tests that snapshot the full diagnostic gain the new field and need a one-line update.

### Default-quiet by default

`raven.linting.enabled` defaults to `false`. `raven lint` honors that — running it against a project with no `raven.toml` produces no diagnostics and exits 0. Users opt in by setting `enabled = true` in `raven.toml`. This means dropping a `raven lint .` step into CI for a project that hasn't adopted Raven yet is a no-op rather than a fire-hose of `hint`s.

## LSP integration

### Raw-layer state

`WorldState` (`state.rs:528`) gains four fields to support per-key fallback and override resolution:

```rust
pub struct WorldState {
    // existing parsed configs (kept; consumers read these)
    pub cross_file_config: ...,
    pub lint_config: ...,
    pub symbol_config: ...,
    // ...

    /// Last-seen client-supplied settings (LSP init options at first, then
    /// the latest `did_change_configuration` payload). Stored raw so we can
    /// re-merge with the project file on either side changing.
    pub raw_client_settings: serde_json::Value,

    /// Last-loaded `raven.toml` (or `.lintr`-derived JSON), or `None` if no
    /// project config file is present. Stored raw for the same reason.
    pub raw_project_settings: Option<serde_json::Value>,

    /// Resolved path of the project config currently in effect, if any.
    /// Reported via `raven/projectConfigLoaded` to the client.
    pub project_config_path: Option<PathBuf>,

    /// Compiled `[[linting.overrides]]` entries. Empty when no overrides
    /// are configured. Per-document resolution scans this list.
    pub lint_overrides: Vec<CompiledLintOverride>,
}
```

The parsed configs (`lint_config`, `cross_file_config`, etc.) become a function of `(raw_client_settings, raw_project_settings)`: a helper `recompute_parsed_configs(&mut state)` performs the merge then runs every `parse_*_config` over the merged JSON. Callers invoke it after mutating either raw layer.

### `initialize` (`backend.rs:1728`)

1. Store the incoming `InitializeParams::initialization_options` (or `Value::Null`) into `state.raw_client_settings`.
2. Pick the first workspace folder; run `config_file::discovery::find_config` to locate `raven.toml`. If found, load and validate it into a `serde_json::Value` of project-shape JSON plus a `Vec<CompiledLintOverride>`. Store in `state.raw_project_settings` and `state.lint_overrides`.
3. If no `raven.toml`, fall through to `.lintr` (linting-only).
4. Call `recompute_parsed_configs(&mut state)`. This is where the existing `parse_*_config` calls move to. The init-time `state.resize_caches(...)` ordering is preserved.
5. Send the custom notification `raven/projectConfigLoaded` (server → client, payload `{ path, source }`) if a project config was found.

### `did_change_watched_files`

VS Code currently watches only source files via `synchronize.fileEvents` in `extension.ts:183`. Two changes:

1. **VS Code extension** — extend the glob to include `**/raven.toml` and `**/.lintr` so edits to either file reach the server. The single-glob form in `extension.ts:188` becomes a list of globs.
2. **Other clients** — register a server-side dynamic capability for `workspace/didChangeWatchedFiles` against `**/raven.toml` and `**/.lintr` via `client/registerCapability`. Clients that honor dynamic registration (Neovim's `nvim-lsp`, Zed, etc.) start watching automatically; those that don't fall back to "reload on next `did_change_configuration`".

On a watched-file event for the project config:

1. Re-read the file (or clear `raw_project_settings` if it was deleted).
2. Re-parse `lint_overrides` from the new value.
3. Call `recompute_parsed_configs(&mut state)`.
4. Force-republish diagnostics for every open document via `CrossFileDiagnosticsGate::mark_force_republish`.

**v1 reload scope:** Live reload covers every key except `[packages].*`, `[crossFile].packageMode`, and the package-watcher knobs (`packagesWatchLibraryPaths`, `packagesWatchDebounceMs`). These require an R-subprocess rebuild and a libpath-watcher restart whose logic lives inside `did_change_configuration`; folding it into `did_change_watched_files` would either duplicate that logic or corrupt the raw-layer split. v1 detects such changes and surfaces a `window/showMessage` warning telling the user to restart Raven. A follow-up will extract the post-recompute reconciliation into a shared helper used by both call sites.

### `did_change_configuration` (`backend.rs:3817`)

Same shape, simpler body:

1. Store the incoming settings into `state.raw_client_settings`.
2. Call `recompute_parsed_configs(&mut state)`.
3. The existing change-detection at `backend.rs:3915` compares parsed configs *post-recompute* — exactly what it does today, but now both sides of the comparison reflect the merge. No new comparison logic; the existing diff-and-republish flow keeps working because it operates on the parsed structs, not on the raw settings.

### Per-document resolution (`handlers.rs:248`)

The current snapshot clones `state.lint_config` under the read lock. Change to:

```rust
let effective_lint = resolve_lint_for_document(
    &state.lint_config,
    &state.lint_overrides,
    document_uri,
);
```

`resolve_lint_for_document` resolves the document URI to a project-relative path (returning `None` for untitled / non-`file://` URIs, in which case the base config is used unchanged), walks the overrides in order, applies any whose compiled glob matches, and returns an owned `LintConfig`. Compiled globs and the base config are read under the state read lock; the result is owned and outlives the lock — preserving the locking discipline in CLAUDE.md.

## VS Code extension changes

1. **New scaffold command `Raven: Create raven.toml`.** Writes a starter `raven.toml` at the workspace root, populated from any currently-explicit `raven.*` settings (using the same `RavenConfigurationInspection` plumbing already in `initializationOptions.ts`). Keys the user hasn't set are emitted as commented-out lines prefaced by their default value, matching the style of the existing `Raven: Create linting settings` command so users discover the full schema by scrolling through the file. Prompts before overwriting an existing `raven.toml`. The original VS Code scaffold command keeps working for VS Code-only setups.
2. **Status notice.** When the server reports it loaded a project config — surfaced via a new custom LSP notification `raven/projectConfigLoaded` (server → client, payload `{ path: string, source: "raven.toml" | ".lintr" }`) — the extension shows a one-time toast and writes to the output channel: `"Raven: using config at /path/to/raven.toml"`. Users who suddenly see different lint behavior get a clue without spelunking. Non-VS Code clients can ignore the notification harmlessly; it carries information already discoverable via server logs.
3. **No init-options gating.** The extension keeps sending init options unconditionally. The server decides per-key whether they apply. This keeps `editors/vscode/src/initializationOptions.ts` unchanged for non-test code paths.
4. **Extend `synchronize.fileEvents`** in `extension.ts:183` to include `**/raven.toml` and `**/.lintr` alongside the existing source-file glob. This is the only client-side change needed to make `did_change_watched_files` fire for project-config edits. (Non-VS Code clients get the same behavior via the server's dynamic `registerCapability` call described above.)

## Testing

- **`config_file` unit tests** (`config_file/tests.rs`):
  - Valid TOML round-trip → expected `serde_json::Value`.
  - Unknown keys produce warnings, do not abort.
  - Malformed TOML logs and returns `None`.
  - Override ordering: later wins on key conflict.
  - Glob matching: relative paths anchored at project root; untitled / non-`file://` URIs skip overrides.
  - Layer merge (`merge.rs`): `(client, project)` cases — project key wins; missing-in-project falls to client; missing-in-both falls to default; clearing a project key restores client value on the next merge.
- **`.lintr` golden tests**: pairs of input `.lintr` and expected `LintConfig` JSON. One per row of the mapping table in `docs/linting.md:160`. Plus edge cases: empty `linters_with_defaults()`, `X_linter = NULL`, multi-line `linters:` field exercising the DCF fold (continuation lines starting with whitespace), one recognized-shape unknown linter (assert one warning), one unrecognized-shape construct (assert single batch warning).
- **CLI integration tests** (`tests/cli_lint/`): a fixture directory with `R/`, `tests/`, a `raven.toml` including overrides. Run `raven lint .`; assert text output structure, JSON shape, SARIF envelope, and exit codes for each `--max-severity` level. Reuse the existing test-harness pattern in `crates/raven/src/test_utils/fixture_workspace.rs`.
- **LSP integration**: extend the existing `did_change_watched_files` tests to cover `raven.toml` reloads. Add tests asserting per-document override resolution (open a `tests/` file and an `R/` file; check that diagnostics use different `LintConfig`s) and per-key fallback under `did_change_configuration` (project pins `lineLength`; client toggles `objectLength`; assert both are honored).
- **Lint rule-ID tests**: assert that each rule's emitted `Diagnostic.code` matches the `RULE_ID` constant exposed in `linting/rule_ids.rs`, and that the value is non-empty. Catches future rule additions that forget to wire the code field.
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
- **Non-VS Code clients that ignore dynamic capability registration** won't see `raven.toml` edits without restart. Mitigation: documented in `docs/editor-integrations.md` per client; LSP keeps working with whatever was loaded at `initialize`. Most modern LSP clients (Neovim's `nvim-lsp`, Zed) honor dynamic registration.
- **Diagnostic `code` field change is a wire-format addition** clients see for the first time. Mitigation: `Diagnostic.code` is part of the LSP spec; clients ignore it cleanly if they don't display it. The change is additive — no existing field is removed or repurposed.
