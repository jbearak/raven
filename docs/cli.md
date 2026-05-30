# CLI

Raven ships a single binary that serves the LSP via stdio *and* exposes subcommands for use outside an editor:

- `raven check` — index a workspace and report the **full** diagnostic set (the same diagnostics the editor publishes), for CI gating.
- `raven lint` — run the native **style** linter only.
- `raven analysis-stats <path> [--csv] [--only <phase>]` — profile workspace analysis phases (`scan`, `parse`, `metadata`, `scope`, `packages`); see `raven --help`.

The difference between `check` and `lint`: `lint` parses each file in isolation and runs only the style rules, so it is fast and needs no R installation, but it cannot see relationships between files. `check` builds the same workspace index the language server builds, so it additionally reports cross-file, undefined-variable, and package diagnostics. Reach for `lint` when you only want style gating; reach for `check` when you want the editor's full analysis in CI.

## `raven check`

Index the workspace, then report the full diagnostic set for the requested files and exit with a code suitable for CI gating.

```text
raven check [OPTIONS] [PATHS...]
```

Diagnostics reported (subject to configured severities — see [diagnostics.md](diagnostics.md)):

- Syntax errors and semantic checks (e.g. assignment-in-condition, mixed logical operators).
- The native style lints (when enabled via `raven.toml` / `.lintr`).
- Cross-file diagnostics: missing sourced files, circular dependencies, exceeded max source-chain depth, redundant directives, and out-of-scope usage.
- Missing-package warnings (`library(notInstalled)`).
- Undefined-variable diagnostics, accounting for cross-file and package scope.

### Workspace and paths

The whole workspace is always indexed so cross-file resolution is accurate. The workspace root is `--workspace DIR`, defaulting to the current directory. `PATHS` only filter **which files have their diagnostics reported**:

- With no `PATHS`, every R file in the workspace is reported.
- With `PATHS`, only those files are reported (directories are walked recursively for R files). Indexing still covers the whole workspace, so a reported file's `source()` targets resolve even when they aren't named.

### Options

- `--workspace DIR` — workspace root to index (default: current directory).
- `--config PATH` — explicit path to a `raven.toml` (default: walk upward from the workspace root, discovering a `raven.toml` or `.lintr`).
- `--no-config` — ignore `raven.toml` and `.lintr`; use Raven's built-in defaults.
- `--format text|json|sarif` — default `text`.
- `--max-severity off|hint|info|warning|error` — highest severity that does **not** fail the build (default `info`). With the built-in defaults, undefined-variable and missing-file diagnostics are `warning` and circular dependencies are `error`, so they fail the build at the default threshold.
- `--quiet` — suppress the trailing summary line.
- `--no-color` — accepted for forward compatibility. `text` output is currently uncolored regardless, so this flag has no visible effect yet.

### R and packages

`raven check` auto-detects R on `PATH` to resolve installed-package exports and base R symbols (it runs `.libPaths()` and parses package `NAMESPACE` files, the same as the language server). It honors the same `raven.toml` package settings the editor does: `packages.enabled = false` disables R detection entirely (no R subprocess, no package or base-symbol diagnostics — matching the editor), `packages.rPath` selects the R binary instead of `PATH` auto-detection, and `packages.additionalLibraryPaths` adds extra library directories to the search path. If R is not found, package and base-symbol diagnostics are limited — `library()` calls aren't checked against installed packages, and undefined-variable detection falls back to a built-in symbol list — and a one-line note is printed to stderr. All other diagnostics still run.

Before reporting, `raven check` warms the export cache for the packages each reported file attaches with `library()` / `require()`, so a bare call into an attached package that isn't one of its exports is flagged the same way the editor flags it. One narrow gap remains: a package attached only *indirectly* — in a `source()`d file rather than in the reported file itself — is not pre-warmed, so calls that could resolve to such a package are left unflagged rather than risk a false positive. Attach the package directly in the file (or rely on the editor) if you need those calls checked.

### File encoding

Source files must be UTF-8. A UTF-8 byte-order mark is stripped and BOM-marked UTF-16 (LE/BE) is decoded, but anything else must already be valid UTF-8 — Raven does not guess legacy single-byte encodings (Latin-1 / Windows-1252). Guessing would silently mis-decode: a non-breaking space (`0xA0`) inside a string comparison, for instance, would read as an ordinary space and quietly change what your code matches. A *reported* file that isn't valid UTF-8 is therefore flagged as an **error diagnostic** (`File is not valid UTF-8: first invalid byte 0x… at offset …`) that fails the build like any other error finding — it is **not** an operator error. Re-save the file as UTF-8 to fix it. A file that is only *indexed* for cross-file resolution (not itself reported) and can't be decoded is silently skipped, matching the editor.

### Exit codes

- `0` — no diagnostic exceeded `--max-severity`.
- `1` — at least one diagnostic exceeded `--max-severity`. An unknown flag is a usage error and also exits `1`. A reported file that isn't valid UTF-8 is an error diagnostic, so it also exits `1`.
- `2` — operator error detected while running (config parse failure, an I/O failure reading a path, invalid workspace). A *readable* but mis-encoded file is a finding (exit `1`), not an operator error.

### GitHub Actions example

```yaml
- name: Check R sources
  run: |
    cargo install --git https://github.com/jbearak/raven raven
    raven check --format sarif > raven.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: raven.sarif
```

To get installed-package and base-symbol awareness in CI, install R (e.g. `r-lib/actions/setup-r`) before running `raven check`. Without R, the command still runs and reports everything else.

### Scope

Only plain R files (`.R` / `.r`) are reported. R Markdown / Quarto files (`.Rmd` / `.qmd`) are skipped — chunk extraction isn't supported on the command line — with a one-line note on stderr when one is named explicitly.

## `raven lint`

Run the native style linter against one or more paths and exit with a code suitable for CI gating.

```text
raven lint [OPTIONS] [PATHS...]
```

### Options

- `--config PATH` — explicit path to a `raven.toml` (default: walk upward from CWD, discovering a `raven.toml` or `.lintr`).
- `--no-config` — ignore `raven.toml` and `.lintr`; use Raven's built-in defaults.
- `--format text|json|sarif` — default `text`.
- `--max-severity off|hint|info|warning|error` — highest severity that does **not** fail the build (default `info`). Linting is opt-in: with no `raven.toml` / `.lintr` discovered (or under `--no-config`) the linter is disabled and emits no diagnostics, so `raven lint .` exits 0. A discovered config enables rules; raising any to `warning` or `error` is what then gates CI.
- `--quiet` — suppress the trailing summary line.
- `--no-color` — accepted for forward compatibility. `text` output is currently uncolored regardless, so this flag has no visible effect yet.

### Exit codes

- `0` — no diagnostic exceeded `--max-severity`.
- `1` — at least one diagnostic exceeded `--max-severity`. An unknown flag is a usage error and exits `1`.
- `2` — operator error detected while running (config parse failure, unreadable or missing path).

### GitHub Actions example

```yaml
- name: Lint R sources
  run: |
    cargo install --git https://github.com/jbearak/raven raven
    raven lint --format sarif R/ tests/ > raven.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: raven.sarif
```

### Scope

`raven lint` runs the native style linter only. Cross-file, undefined-variable, and package diagnostics need a workspace scan; use [`raven check`](#raven-check) for those.

Only plain R files (`.R` / `.r`) are linted. R Markdown / Quarto files (`.Rmd` / `.qmd`) are skipped with a one-line note on stderr — chunk extraction isn't supported on the command line — and other file types are ignored silently. Passing a directory walks it recursively for R files.

## Output formats

Both `check` and `lint` share the same renderers:

- `text` — `path:line:col level: message [rule]`, one per line.
- `json` — array of `{ path, diagnostic }` objects (`diagnostic` is a verbatim LSP `Diagnostic`).
- `sarif` — SARIF 2.1.0 envelope. Tool name `raven`; `ruleId` from `Diagnostic.code`.
