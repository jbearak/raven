# CLI

Raven ships a single binary that serves the LSP via stdio *and* exposes subcommands for use outside an editor:

- `raven check` — index a workspace and report the **full** diagnostic set (the same diagnostics the editor publishes), for CI gating.
- `raven lint` — run the native **style** linter only.
- `raven analysis-stats <path> [--csv] [--only <phase>]` — profile workspace analysis phases (`scan`, `parse`, `metadata`, `scope`, `packages`); see `raven --help`.
- `raven packages freeze` — generate a committed `.raven/packages.json` export database. `raven check` already resolves package symbols in CI without it, against Raven's bundled database (CRAN + Bioconductor + base R); `freeze` is for *accuracy* — it adds packages the bundled database doesn't cover (e.g. GitHub-only or internal packages) and symbols newer than the bundled snapshot, eliminating false positives in those cases. Choose its scope with `--used` (default — only the packages the repo uses) or `--installed`/`--all` (every installed package). See [`raven packages freeze`](#raven-packages-freeze) and [Package database](package-database.md).

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
- Missing-package warnings (`library(notInstalled)`) — see [Missing-package reporting in CI](#missing-package-reporting-in-ci); `raven check` suppresses these by default.
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
- `--report-uninstalled` (see [Missing-package reporting in CI](#missing-package-reporting-in-ci)) — re-enable missing-package warnings, which `raven check` otherwise suppresses by default.
- `--quiet` — suppress the trailing summary line.
- `--color auto|always|never` — when to colorize `text` output (default `auto`). See [Color output](#color-output).
- `--no-color` — alias for `--color never`.

### R and packages

`raven check` auto-detects R on `PATH` to resolve installed-package exports and base R symbols (it runs `.libPaths()` and parses package `NAMESPACE` files, the same as the language server). It honors the same `raven.toml` package settings the editor does: `packages.enabled = false` disables R detection entirely (no R subprocess, no package or base-symbol diagnostics — matching the editor), `packages.rPath` selects the R binary instead of `PATH` auto-detection, and `packages.additionalLibraryPaths` adds extra library directories to the search path. If R is not found, package and base-symbol diagnostics are limited — `library()` calls aren't checked against installed packages, and undefined-variable detection falls back to a built-in symbol list — and a one-line note is printed to stderr. All other diagnostics still run.

Before reporting, `raven check` warms the export cache for the packages each reported file attaches with `library()` / `require()`, so a bare call into an attached package that isn't one of its exports is flagged the same way the editor flags it. One narrow gap remains: a package attached only *indirectly* — in a `source()`d file rather than in the reported file itself — is not pre-warmed, so calls that could resolve to such a package are left unflagged rather than risk a false positive. Attach the package directly in the file (or rely on the editor) if you need those calls checked.

### Missing-package reporting in CI

`raven check` resolves package **export names** through an ordered three-tier fallback — installed packages, then a committed `.raven/packages.json`, then Raven's bundled `names.db` — so symbols from attached packages resolve even when no R is installed. This stops the undefined-variable storm that otherwise makes Raven unusable in CI. See [Package database](package-database.md).

Knowing a package's exports is **separate** from knowing whether it is installed. The **missing-package** diagnostic answers a different question — *"will `library(X)` succeed at runtime?"*, i.e. is `X` installed? — so it stays **Tier-1-only**: it is driven solely by what is present in the local library paths, never by the export database. Because CI deliberately omits package installation, `raven check` **suppresses missing-package warnings by default**.

`--report-uninstalled` re-enables them. Reach for it whenever a `library(X)` call must really succeed at runtime: a pipeline that *does* install packages (e.g. `renv::restore()`) and wants to fail if any didn't, **or** any CI that **actually runs your R scripts** after `raven check` (e.g. R-package CI), where an uninstalled package is a genuine failure rather than CI noise. Gate-only CI that never executes the scripts wants the default (suppressed). It reports `library()` calls **not present in the local library paths** — **not** relative to the Tier 2/Tier 3 export metadata. One consequence: with the default off, a genuine typo such as `library(dpylr)` is silent (no tier knows it, but `raven check` isn't checking install status); it is reported only with `--report-uninstalled`. The language server is unchanged — it still fires missing-package whenever install state is known. See [Diagnostics](diagnostics.md#package-names-vs-install-status) for the full model.

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

## `raven packages`

A command group for the export databases Raven uses to resolve package symbols without installing packages. See [Package database](package-database.md) for the full three-tier model; the two subcommands below build the user-generated (Tier 2) and Raven-bundled (Tier 3) databases respectively.

### `raven packages freeze`

Generate a committed, repo-specific `.raven/packages.json` — a "frozen Tier 1" snapshot of your installed packages' export names, `Depends`, and datasets. `raven check` and the editor already resolve symbols in CI (where no R or packages are present) against Raven's bundled database; this committed snapshot **improves accuracy** for packages the bundled database doesn't cover (GitHub-only or internal packages) and for symbols newer than the bundled snapshot. Run it on a machine that has R and the project's packages installed, then commit the result; it is generated, never hand-edited.

```text
raven packages freeze [OPTIONS]
```

#### Options

- `--used` (default) — capture only the packages the repo uses. The set is deliberately **maximally inclusive**: packages referenced via `library`/`require`/`loadNamespace`/`requireNamespace` ∪ the left-hand side of `::`/`:::` ∪ everything in `renv.lock` ∪ the repo's own `DESCRIPTION` `Depends`/`Imports` ∪ their transitive `Depends`. (`LinkingTo` is excluded — it is C-level and has no R exports.) Over-inclusion is free: the capture skips anything not actually installed.
- `--installed` / `--all` — capture every package across the renv and system libraries, not just the used set.
- `--output PATH` — where to write the file (default: `.raven/packages.json` at the workspace root).
- `--workspace DIR` — workspace root to scan for usage and config (default: current directory).

#### Library order and renv

Generation resolves each package from a **renv-first** library order: the renv project library first, system-wide libraries only for packages renv doesn't cover (renv wins, system fills the gaps). A `renv.lock` acts purely as a **set selector** — it decides *which* packages to include (a locked package is included even if no script ever calls it), **not** which version to read; the exports always come from the package actually installed locally. A locked package that isn't installed simply can't be captured and falls through to Tier 3 in CI. Best coverage therefore comes from running `freeze` after `renv::restore()`, but nothing breaks otherwise.

#### No-op when content is unchanged

If a `.raven/packages.json` already exists, `freeze` compares **package content only** (ignoring provenance such as the generation timestamp). When the content is identical it leaves the file untouched and prints "no changes" — so a regeneration that found nothing new produces a zero-line diff, and the provenance timestamp moves only when the captured exports actually changed.

### `raven packages build-shipped-db`

**Maintainer / CI-only — most users never run this.** Builds Raven's bundled Tier 3 `names.db` (and its companion base-exports file). The shipped binary is **network-free**: this command transforms r-universe JSON that the build workflow has already downloaded with `curl`, merging it **append-only** over an authoritative reference-R capture of the build machine's installed library. The result is published to the `names-db` GitHub Release and bundled next to the binary and into the VSIX. See [Package database](package-database.md#tier-3--bundled-namesdb) and [development.md](development.md#tier-3-build-pipeline) for the build pipeline.

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
