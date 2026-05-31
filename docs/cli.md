# CLI

Raven ships a single binary that serves the LSP via stdio *and* exposes subcommands for use outside an editor:

- `raven check` — index a workspace and report the **full** diagnostic set (the same diagnostics the editor publishes), for CI gating.
- `raven lint` — run the native **style** linter only.
- `raven analysis-stats <path> [--csv] [--only <phase>]` — profile workspace analysis phases (`scan`, `parse`, `metadata`, `scope`, `packages`); see `raven --help`.

The difference between `check` and `lint` is **scope**: `lint` parses each file in isolation and runs only the style rules, so it needs no R installation and no workspace index — but it can't see relationships between files. `check` builds the same workspace index the language server builds (and, unless packages are disabled, runs R to resolve installed-package exports and base R symbols), so it additionally reports cross-file, undefined-variable, and package diagnostics. `lint` is therefore the cheaper, R-free option for pure style gating; `check` does more work per run in exchange for the editor's full analysis in CI.

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
- `--report-uninstalled` — report `library()` / `require()` calls for packages not present in local library paths. Off by default in CI (as CI environments often deliberately omit package installations). Note that this check only reports packages missing from the *local library paths* (Tier 1), not relative to the Tier 2 or Tier 3 metadata databases.
- `--color auto|always|never` — when to colorize `text` output (default `auto`). See [Color output](#color-output).
- `--no-color` — alias for `--color never`.

### R and packages

> **Status: planned — tracking [the CI package-exports DB work]. Not yet available in a released build.**

`raven check` auto-detects R on `PATH` to resolve installed-package exports and base R symbols (Tier 1: on-disk installed paths). If R or the package is not installed locally, Raven falls back to checking the repository-committed database `.raven/packages.json` (Tier 2), and then to the bundled CRAN/Bioconductor database `names.db` (Tier 3) to resolve package exports and prevent spurious undefined-variable diagnostics.

The missing-package diagnostic ("not installed") is **off by default in `raven check`** to prevent build failures in CI where package installation is skipped. To re-enable missing-package warnings, pass the `--report-uninstalled` flag (which reports `library()` calls absent from local library paths, independent of the Tier 2/3 metadata databases).

If R is not found and no package database is available, package and base-symbol diagnostics are limited, and undefined-variable detection falls back to a built-in symbol list, printing a one-line note on stderr. All other diagnostics still run.

Before reporting, `raven check` warms the export cache for the packages each reported file attaches with `library()` / `require()`, so a bare call into an attached package that isn't one of its exports is flagged the same way the editor flags it. One narrow gap remains: a package attached only *indirectly* — in a `source()`d file rather than in the reported file itself — is not pre-warmed, so calls that could resolve to such a package are left unflagged rather than risk a false positive. Attach the package directly in the file (or rely on the editor) if you need those calls checked.

### File encoding

Source files must be UTF-8. A UTF-8 byte-order mark is stripped and BOM-marked UTF-16 (LE/BE) is decoded, but anything else must already be valid UTF-8 — Raven does not guess legacy single-byte encodings (Latin-1 / Windows-1252). Guessing would silently mis-decode: a non-breaking space (`0xA0`) inside a string comparison, for instance, would read as an ordinary space and quietly change what your code matches. A *reported* file that isn't valid UTF-8 is therefore flagged as an **error diagnostic** (`File is not valid UTF-8: first invalid byte 0x… at offset …`) that fails the build like any other error finding — it is **not** an operator error. Re-save the file as UTF-8 to fix it. A file that is only *indexed* for cross-file resolution (not itself reported) and can't be decoded is silently skipped, matching the editor. `raven lint` and `analysis-stats` read through the same decoder, so encoding handling is uniform across the CLI.

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
- `--color auto|always|never` — when to colorize `text` output (default `auto`). See [Color output](#color-output).
- `--no-color` — alias for `--color never`.

### File encoding

`raven lint` reads each file through the same BOM-aware decoder as `raven check` and the editor: a UTF-8 byte-order mark is stripped and BOM-marked UTF-16 (LE/BE) is decoded, while legacy single-byte encodings (Latin-1 / Windows-1252) are never guessed — see [File encoding](#file-encoding) under `raven check` for the rationale. A file that isn't valid UTF-8 is reported as an **error diagnostic** (`File is not valid UTF-8: first invalid byte 0x… at offset …`) that fails the build (exit `1`) like any other error finding — it is **not** an operator error, so it no longer exits `2` with a cryptic decode message. Re-save the file as UTF-8 to fix it.

### Exit codes

- `0` — no diagnostic exceeded `--max-severity`.
- `1` — at least one diagnostic exceeded `--max-severity`. An unknown flag is a usage error and exits `1`. A file that isn't valid UTF-8 is an error diagnostic, so it also exits `1`.
- `2` — operator error detected while running (config parse failure, unreadable or missing path). A *readable* but mis-encoded file is a finding (exit `1`), not an operator error.

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

## `raven packages` subcommands

> **Status: planned — tracking [the CI package-exports DB work]. Not yet available in a released build.**

Raven provides a subcommand group `raven packages` to generate, build, and maintain offline package export databases.

### `raven packages freeze`

Generate a static, offline package export database for the current workspace. This captures the exported symbols, depends, and lazy-loaded datasets (Tier 2) from packages installed in the local environment and saves them to `.raven/packages.json`.

```text
raven packages freeze [OPTIONS]
```

This command should be run in an environment where your project's dependencies are fully installed (for example, on a developer machine or inside a provisioned container right after `renv::restore()`) to capture accurate exports.

Options:
- `--used` (default) — scan the workspace scripts for `library()`/`require()` calls, `::`/`:::` LHS references, `renv.lock` keys, and `DESCRIPTION` imports, then freeze only those packages (maximally-inclusive of all referenced dependencies).
- `--installed` | `--all` — freeze *every* package currently found in the active R library paths.
- `--output PATH` — path where the JSON file should be written (default: `.raven/packages.json`).
- `--workspace DIR` — workspace root to scan and use as base (default: current directory).

#### Key Invariants:
- **No-op when unchanged:** If the frozen output file already exists, Raven compares the newly computed package records to the existing ones (ignoring metadata like timestamps). If they are identical, the file is left completely untouched to prevent unnecessary git churn.
- **`renv.lock` as a Set Selector:** When `--used` is selected and `renv.lock` is present, the lockfile acts as a set selector (the list of packages to freeze), rather than a version oracle. Version information is omitted because Tier 2/3 metadata only tracks export names.

### `raven packages build-shipped-db`

Maintainer-only tool to compile the bundled Tier 3 binary database (`names.db`) and base-exports file (`base-exports.json`).

```text
raven packages build-shipped-db [OPTIONS]
```

This command merges a prior `names.db` seed (downloaded from the Release), a reference-R full-library capture of the build machine, and fetched API packages from CRAN and Bioconductor r-universe hosts.

*Note: The shipped binary and extension are completely network-free. This command is executed only in automated weekly CI jobs to compile and upload Release assets.*

## Output formats

Both `check` and `lint` share the same renderers:

- `text` — `path:line:col level: message [rule]`, one per line.
- `json` — array of `{ path, diagnostic }` objects (`diagnostic` is a verbatim LSP `Diagnostic`).
- `sarif` — SARIF 2.1.0 envelope. Tool name `raven`; `ruleId` from `Diagnostic.code`.

## Color output

Both `check` and `lint` colorize the **severity word** (`error`, `warning`, `info`, `hint`) in `text` output — the rest of the line stays uncolored so it remains easy to grep. The `json` and `sarif` formats are machine-readable and are **never** colorized regardless of the flag or environment.

`--color auto|always|never` controls it (default `auto`), and `--no-color` is a familiar alias for `--color never`. Resolution precedence, highest first:

1. An explicit `--color always` / `--color never` (or `--no-color` ⇒ `never`) always wins, overriding the environment.
2. Otherwise (`auto`):
   - [`NO_COLOR`](https://no-color.org/) set and non-empty ⇒ **off**.
   - else [`FORCE_COLOR`](https://force-color.org/) set and non-empty ⇒ **on**.
   - else **on** when stdout is a terminal, **off** when piped or redirected.

So `--color always` forces color even through a pipe (e.g. into `less -R` or a CI log viewer), `--color never` / `--no-color` / `NO_COLOR` suppress it, and the default tracks whether you're looking at a terminal. Conflicting explicit flags are last-one-wins (`--no-color --color always` ⇒ color on).
