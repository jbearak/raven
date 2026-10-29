# CLI

[Docs](README.md) › Reference

The `raven` binary checks R code from a terminal or CI job, manages the package databases that let it work without R, runs an R console, and serves the language server to your editor.

| You run | Raven does |
|---|---|
| [`raven check`](#raven-check) | Indexes the workspace and reports the full diagnostic set, the same diagnostics the editor publishes. |
| [`raven lint`](#raven-lint) | Runs only the native style linter. |
| [`raven packages update`](#raven-packages-update) | Downloads CRAN/Bioconductor export names so `raven check` recognizes package functions without R. |
| [`raven packages freeze`](#raven-packages-freeze) | Writes a committed `.raven/packages.json` from your installed packages. |
| [`raven packages fetch`](#raven-packages-fetch) | Writes the same file from r-universe, with no R needed. |
| [`raven console`](#raven-console) | Starts an interactive R console. |
| [`raven --stdio`](#raven---stdio) | Starts the language server for an editor. |

Run `raven`, `raven --help`, or `raven help` for top-level usage. Every command with options accepts `--help`, including the package-database commands (`raven packages fetch --help`) and the top-level aliases (`raven fetch --help`, `raven freeze --help`). `raven --version` prints the version:

<!-- example: version -->
```console
$ raven --version
raven 0.21.1
```

To run Raven on every pull request, start with [Automated checks in CI](ci.md). It explains what CI is and has copyable GitHub Actions and Bitbucket Pipelines files.

## Ubuntu installation

Raven's signed apt repository supplies the same CLI and language server for Ubuntu desktops, servers, and CI runners, with packages for amd64 and arm64. Set it up once:

```bash
(
  set -e
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  keyring=$(mktemp)
  trap 'rm -f "$keyring"' EXIT
  curl -fsSL https://jbearak.github.io/apt-raven/raven-archive-keyring.gpg -o "$keyring"
  echo "aaaee9d0c6d944091d1a78d8aeb4f93f59dc713ee1f218052add12b0d7c743cd  $keyring" | sha256sum -c -
  sudo install -d -m 0755 /etc/apt/keyrings
  sudo install -m 0644 "$keyring" /etc/apt/keyrings/raven-archive-keyring.gpg
  echo "deb [signed-by=/etc/apt/keyrings/raven-archive-keyring.gpg] https://jbearak.github.io/apt-raven stable main" | sudo tee /etc/apt/sources.list.d/raven.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y raven
)
```

The checksum verifies the downloaded keyring before apt trusts it. The package installs `raven` on your PATH for `raven check`, `raven lint`, and editor clients using `raven --stdio`. Future releases arrive through apt updates. To update Raven specifically, run `sudo apt-get update` followed by `sudo apt-get install --only-upgrade raven`.

For a CI configuration that runs these steps as root, see the [Bitbucket Pipelines template](ci.md#bitbucket-pipelines).

<a id="why-raven-analyzes-r-without-running-it"></a>

Why Raven checks R code without running it, and why that suits CI, is explained in [Automated checks in CI](ci.md#why-raven-check-belongs-in-ci).

## `raven check`

Index the workspace, then report the full diagnostic set for the requested files and exit with a code suitable for CI gating.

```text
raven check [OPTIONS] [PATHS...]
```

It reports the following, subject to configured severities (see [Diagnostics](diagnostics.md)):

- R syntax errors and semantic checks (for example assignment-in-condition and mixed logical operators). Standalone JAGS/BUGS and Stan diagnostics are available when you opt in with `[diagnostics] jags = "on"` and/or `stan = "on"` in `raven.toml`.
- The native style lints, when enabled through `raven.toml` or `.lintr`.
- Cross-file diagnostics: missing sourced files, circular dependencies, exceeded maximum source-chain depth, redundant directives, out-of-scope usage, and case-only path mismatches (in `source()` calls, forward directives, and backward `# raven: sourced-by`-style directives). On a case-sensitive CI filesystem a case-only mismatch (for example `source("scripts/templates.r")` for an on-disk `templates.R`) is a **warning**, so it exceeds the default `--max-severity info` and fails the build. For a forward `source()` that is also a bug that breaks the script at runtime on Linux. See [Source path case mismatch](diagnostics.md#source-path-case-mismatch).
- Static `{box}` and `{import}` selective-import scope, missing-module, package, and authoritative missing-export diagnostics, from the same analysis the language server uses.
- Missing-package warnings (`library(notInstalled)`). `raven check` suppresses these by default; see [Missing-package reporting in CI](#missing-package-reporting-in-ci).
- Undefined-variable diagnostics, accounting for cross-file and package scope.

The full `--help` text:

<details markdown="1">
<summary>Output of <code>raven check --help</code></summary>

<!-- example: check-help -->
```console
$ raven check --help
raven check 0.21.1 — R and model diagnostics for CI

Usage: raven check [OPTIONS] [PATHS...]

Indexes the workspace, then reports diagnostics for the requested files (or
every R / R Markdown / Quarto / JAGS / Stan file in the workspace when no PATHS
are given): syntax errors, semantic checks, style lints, cross-file diagnostics
(missing source files, circular dependencies, out-of-scope usage),
missing-package warnings, and undefined-variable diagnostics. For .Rmd /
.Rmarkdown / .qmd the R code inside chunks is analyzed; prose and non-R chunks
are ignored. JAGS `.jags` / `.bugs` / `.bug` and Stan `.stan` files are always
discovered, but their diagnostics are opt-in: set `jags = "on"` and/or `stan =
"on"` under `[diagnostics]` in raven.toml. JAGS receives native syntax checks;
complete Stan programs also receive conservative undeclared-variable checks.
`--no-config` therefore leaves model diagnostics disabled.
Honors raven.toml / .lintr.

Options:
  --workspace DIR             Workspace root to index (default: current directory)
  --config PATH               Path to raven.toml or .lintr (default: search upward from
                              --workspace, skipping literal ~/.lintr unless passed here)
  --no-config                 Use built-in defaults; ignore raven.toml/.lintr
  --format text|json|sarif    Output format (default: text)
  --max-severity LEVEL        Highest severity that does NOT fail the build
                              (off, hint, info, warning, error; default: info)
  --quiet                     Suppress summary line in text output
  --color auto|always|never   When to colorize text output (default: auto —
                              color when stdout is a terminal). Honors NO_COLOR
                              and FORCE_COLOR under auto; json/sarif are never
                              colorized.
  --no-color                  Alias for --color never

R / packages:
  raven check auto-detects R on PATH to resolve installed-package exports and
  base R symbols. If R is not found and no offline package data is present
  (`raven packages update`/`freeze`), package symbol resolution is limited to
  base R (still covered by the embedded database) and a note is printed to
  stderr; all other diagnostics still run.

  --report-uninstalled        Report packages from library() calls that are not
                              present in the local library paths. Disabled by
                              default; useful when the environment DID install
                              packages (e.g. renv::restore()) and you want to
                              catch failures.

Exit codes:
  0   No diagnostic exceeded --max-severity
  1   A diagnostic exceeded --max-severity, or a usage error (unknown flag / bad option value)
  2   Operator error while running (config parse failure, unreadable path)

```

</details>

<a id="options"></a>

### Check options

- `--workspace DIR`: workspace root to index (default: current directory).
- `--config PATH`: explicit path to a `raven.toml` or `.lintr`. By default Raven walks upward from the workspace root and uses the first `raven.toml` or non-home `.lintr`. The literal `~/.lintr` is never discovered automatically, but you can pass it with `--config ~/.lintr`.
- `--no-config`: ignore `raven.toml` and `.lintr` and use Raven's built-in defaults.
- `--format text|json|sarif`: output format, default `text`. See [Output formats](#output-formats).
- `--max-severity off|hint|info|warning|error`: the highest severity that does **not** fail the build (default `info`). With the built-in defaults, undefined-variable and missing-file diagnostics are `warning` and circular dependencies are `error`, so they fail the build at the default threshold. Native style lints default to `information`, so they pass at `info` but fail at `--max-severity hint` or `off`.
- `--report-uninstalled`: re-enable missing-package warnings, which `raven check` otherwise suppresses. See [Missing-package reporting in CI](#missing-package-reporting-in-ci).
- `--quiet`: suppress the trailing summary line.
- `--color auto|always|never`: when to colorize `text` output (default `auto`). See [Color output](#color-output).
- `--no-color`: alias for `--color never`.

With `--max-severity warning`, only `error` findings fail the run. This file has a typo that Raven reports as a warning:

<!-- example: exit-on-errors-only file=analysis.R -->
```r
scores <- c(82, 91, 77)
print(mean(scroes))
```

The warning is still printed, but `raven check` exits `0`:

<!-- example: exit-on-errors-only -->
```console
$ raven check --max-severity warning .
analysis.R:2:12 warning: scroes is not defined [undefined-variable]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

### Workspace and paths

Raven indexes the whole workspace, except automatically discovered paths ignored by `.gitignore` or `[workspace].exclude`, so cross-file resolution is accurate for included files. Directly resolved `source()` targets bypass `.gitignore`. The workspace root is `--workspace DIR`, defaulting to the current directory. `PATHS` only filter **which files have their diagnostics reported**:

- With no `PATHS`, every included R file and standalone `.jags`, `.bugs`, `.bug`, or `.stan` program in the workspace is reported.
- With `PATHS`, explicit files are reported as named, and directories are walked recursively for included R files and standalone `.jags`, `.bugs`, `.bug`, or `.stan` programs. Extension matching is case-insensitive. `.stanfunctions` files are excluded because they are include fragments, not standalone programs. Indexing still covers the included workspace, so a reported R file's `source()` targets resolve even when you don't name them.

Package definitions and testthat helpers remain available when the workspace exceeds the document-cache limit. Unrelated files in a large vendored tree do not remove those definitions from package scope.

`.gitignore` is respected by default for directory and default discovery in `check` and `lint`, and by `analysis-stats`. Explicit file arguments bypass this filter. `--no-config` still respects `.gitignore`; set `[workspace] respectGitignore = false` in `raven.toml` to turn it off. `analysis-stats` discovers project configuration from its target directory and honors both `workspace.respectGitignore` and `workspace.exclude`. Exclusion patterns are relative to the configuration file's directory; profiling still scans only the requested target.

`raven.toml` can exclude generated or vendored trees from discovery:

```toml
[workspace]
exclude = ["generated/**", "archive/**", "!generated/keep.R"]
```

Explicit file arguments bypass these exclusions: `raven check generated/one.R` still reports `generated/one.R` even if `generated/**` is excluded. Directory arguments are discovery walks, so exclusions apply inside them. Hidden directories (leading `.`) and the vendored or build directories `renv`, `packrat`, `node_modules`, and `target` are always skipped by discovery walks. Glob syntax, ordering, and re-includes are described in [Project exclusions](configuration.md#project-exclusions).

<details markdown="1">
<summary>How <code>[workspace].exclude</code> patterns match during <code>raven check</code></summary>

`[workspace].exclude` defaults to `[]`. Patterns are project-root-relative globs, matched against paths relative to the containing workspace root. `*` and `?` do not cross `/`; use `**` for recursive matches, such as `**/*.log` for `.log` files at any depth. They apply to the workspace index and to default `raven check` discovery.

Directory globs like `generated/**` prune whole directories before parsing and indexing. When any negated re-include pattern (`!pattern`) is present, Raven turns off directory pruning for the list so a re-included file is never skipped early. The full ordered pattern list still filters files, and the last matching pattern wins.

</details>

<details markdown="1">
<summary>JAGS, BUGS, and Stan files</summary>

Model files remain discoverable targets even though their diagnostics default to off. Enable `[diagnostics] jags = "on"` for syntax-only JAGS/BUGS checking and `[diagnostics] stan = "on"` for Stan syntax plus conservative undeclared-variable checking.

Stan semantic checking runs when the file contains at least one real top-level program block. A file with no real block, including an assembler fragment organized with `//--- data` or similar section comments, gets syntax diagnostics only. Missing one optional block does not suppress checking, so values supplied by R still require a Stan `data` declaration. Any `#include` suppresses Stan semantic findings for the whole file because Raven does not preprocess or resolve includes. Setting `undefinedVariableSeverity = "off"` suppresses only Stan semantic findings and leaves opted-in syntax diagnostics active.

Raven does not run JAGS or `stanc`, validate dimensions, types, or distribution signatures, or apply R lint, package, or cross-file analysis to model source. Stan and JAGS share the `[diagnostics] maxSyntaxDiagnosticsPerFile` setting in `raven.toml` (default `500`, `0` for unlimited); it is applied after exact deduplication and stable source ordering in `text`, `json`, and `sarif` output. The three JAGS suffixes select strict JAGS-dialect validation, not general OpenBUGS, WinBUGS, MultiBUGS, or NIMBLE compatibility. Stan undeclared-variable findings use a separate fixed bound of 500 per file and the configured undefined-variable severity; the syntax cap does not affect them.

</details>

<details markdown="1">
<summary><code>targets::tar_source()</code> batches</summary>

Static `targets::tar_source()` batches keep their ordered execution context during CLI analysis, including when the same script is selected more than once with different working-directory behavior. Scripts these batches load from outside the initial workspace scan are parsed and indexed before diagnostics run. This affects scope only: navigation, missing-file checks, and re-checking dependents after an edit still treat each source entry as one link.

</details>

<a id="scope"></a>

### R Markdown and Quarto files

`.R` and `.r` files and R Markdown / Quarto files (`.Rmd`, `.Rmarkdown`, `.qmd`) are all reported. Raven analyzes `.Rmd`, `.Rmarkdown`, and `.qmd` files the same way the editor does: every R chunk body is treated as R code at its document coordinates, and prose, YAML front matter, and non-R chunks (Python, Bash, and so on) are ignored. Line and column in `text`, `json`, and `sarif` output map directly to the document. A `source()` inside a chunk creates a real dependency edge, and missing-file and cross-file scope diagnostics are reported the same as from a `.R` file.

### R and packages

`raven check` auto-detects R on `PATH` to resolve installed-package exports and exact local metadata. It runs `.libPaths()` and parses package `NAMESPACE` files, the same as the language server. It honors the same `raven.toml` package settings the editor does:

- `packages.enabled = false` turns off R detection entirely: no R subprocess and no installed or local package diagnostics, matching the editor.
- `packages.rPath` selects the R binary instead of `PATH` auto-detection.
- `packages.additionalLibraryPaths` adds extra library directories to the search path.

If R is not found, `library()` calls aren't checked against installed packages, but base R symbols are embedded in the binary. Broad CRAN/Bioconductor coverage without R comes from Raven's `names.db` database, installed with `raven packages update`. A one-line note is printed to stderr when R is absent. All other diagnostics still run. See [Package database](package-database.md).

<details markdown="1">
<summary>Which packages <code>raven check</code> loads before reporting</summary>

Before reporting, `raven check` loads export lists for the packages each reported file attaches with `library()`, `require()`, or a static qualified `pacman::p_load()`. It also loads, permissively, the statically known targets of a bare `p_load()`, so it can decide whether `{pacman}` is attached at that call position. Bare calls contribute visible and reportable packages only when that prerequisite holds; locally shadowed calls and dynamic package arguments contribute no package metadata.

This loading also covers calls in R Markdown and Quarto chunks, follows static `{box}` and `{import}` local-module chains from both plain R and chunk targets, and includes packages contributed by the workspace `.Rprofile` or test preambles. In [R package workspaces](r-package-dev.md) it includes packages the `NAMESPACE` fully imports with `import(pkg)`. So a bare call into an attached package that isn't one of its exports fails the same way in the CLI and the editor, and full-import exports resolve in both call and value position.

Workspace and prelude discovery follow explicit `source()` relationships in execution order when deciding whether an inherited `pacman` attachment enables a bare `p_load()`.

One narrow gap remains: a package attached only *indirectly*, in an ordinary reported file's `source()` closure, is not always loaded ahead of time. Calls that could resolve to it are left unflagged rather than risk a false positive. Attach the package directly in the file, or rely on the editor, if you need those calls checked.

</details>

### Missing-package reporting in CI

`raven check` resolves package **export names** through an ordered fallback: installed packages, then a committed `.raven/packages.json`, then Raven's broad CRAN/Bioconductor metadata when available. So symbols from attached packages resolve even when no R is installed, which prevents a flood of undefined-variable findings in CI. The broad metadata isn't bundled with the binary; a CI job downloads it with `raven packages update`. Base R coverage is in the binary regardless. See [Package database](package-database.md).

Knowing a package's exports is **separate** from knowing whether it is installed. The **missing-package** diagnostic answers a different question: will `library(X)` succeed at runtime, that is, is `X` installed? It is driven solely by what is present in the local library paths, never by the package symbol database. Because CI usually skips package installation, `raven check` **suppresses generic missing-package warnings by default**.

`--report-uninstalled` turns them back on. Use it whenever a `library(X)` call must really succeed at runtime: a pipeline that *does* install packages (for example with `renv::restore()`) and should fail if any didn't, **or** any CI that **runs your R scripts** after `raven check` (for example R-package CI), where an uninstalled package is a real failure. Gate-only CI that never executes the scripts wants the default.

The flag reports `library()` calls **not present in the local library paths**, not relative to the package symbol databases (`.raven/packages.json` or `names.db`). One consequence: with the default, a genuine typo such as `library(dpylr)` is silent, because no database knows it and `raven check` isn't checking install status. It is reported only with `--report-uninstalled`. The language server is unchanged: it still reports missing packages whenever install state is known.

One subtype stays on even without the flag. `package-outside-active-library` means Raven activated the workspace's renv project, the referenced package is unavailable in its active library, and a valid package with that name exists in a system or user library that activation removed. That points to a project setup problem, not the ordinary "CI did not install dependencies" case. Run `renv::hydrate("package")` with the package named by the diagnostic. The named form also works for standalone scripts in projects that use explicit renv snapshots, where bare `renv::hydrate()` only considers `DESCRIPTION`. See [Diagnostics](diagnostics.md#package-names-vs-install-status) for the full model.

### File encoding

Source files must be UTF-8. Raven strips a UTF-8 byte-order mark and decodes BOM-marked UTF-16 (LE/BE), but anything else must already be valid UTF-8. Raven does not guess legacy single-byte encodings (Latin-1, Windows-1252), because guessing would silently mis-decode: a non-breaking space (`0xA0`) inside a string comparison would read as an ordinary space and change what your code matches.

A *reported* file that isn't valid UTF-8 is flagged as an **error diagnostic** (`File is not valid UTF-8: first invalid byte 0x… at offset …`) that fails the build like any other error finding. It is **not** an operator error. Re-save the file as UTF-8 to fix it. A file that is only *indexed* for cross-file resolution, not itself reported, and can't be decoded is silently skipped, matching the editor. `raven lint` reads through the same decoder.

### Exit codes

- `0`: no diagnostic exceeded `--max-severity`.
- `1`: at least one diagnostic exceeded `--max-severity`. An unknown flag or bad option value is a usage error and also exits `1`. A reported file that isn't valid UTF-8 is an error diagnostic, so it also exits `1`.
- `2`: operator error while running (config parse failure, an I/O failure reading a path, invalid workspace). A *readable* but mis-encoded file is a finding (exit `1`), not an operator error.

A usage error prints a message on stderr and exits `1`:

<!-- example: usage-error stream=stderr -->
```console
$ raven check --bogus
Error: raven check: unknown flag: --bogus
```

One exception to the I/O case: a named `.stan` or JAGS file whose language is switched off (`diagnostics.stan` and `diagnostics.jags`, both off by default; see [JAGS and Stan](diagnostics.md#jags-and-stan)) is skipped without being opened, so an unreadable one does not exit `2`. Raven reports nothing for a language you turned off, including not failing the run on a file it was told to ignore. Switching the language on restores the normal exit-`2` behavior. The global `diagnostics.enabled` switch does **not** do this: it suppresses findings, so an unreadable path still exits `2`.

<a id="ci-examples"></a>
<a id="github-actions-example"></a>
<a id="bitbucket-pipelines-example"></a>
<a id="package-metadata-strategies"></a>

CI templates and the package-metadata strategies for CI moved to [Automated checks in CI](ci.md): see [GitHub Actions](ci.md#github-actions), [Bitbucket Pipelines](ci.md#bitbucket-pipelines), and [Choose where package names come from](ci.md#choose-where-package-names-come-from).

## `raven lint`

Run the native style linter against one or more paths and exit with a code suitable for CI gating.

```text
raven lint [OPTIONS] [PATHS...]
```

`raven lint` runs only the style linter. Cross-file, undefined-variable, and package diagnostics need a workspace scan; use [`raven check`](#raven-check) for those.

<a id="options-1"></a>

### Lint options

- `--config PATH`: explicit path to a `raven.toml` or `.lintr`. By default Raven walks upward from the current directory and uses the first `raven.toml` or non-home `.lintr`. The literal `~/.lintr` is never discovered automatically, but you can pass it with `--config ~/.lintr`.
- `--no-config`: ignore `raven.toml` and `.lintr` and use Raven's built-in defaults.
- `--format text|json|sarif`: output format, default `text`.
- `--max-severity off|hint|info|warning|error`: the highest severity that does **not** fail the build (default `info`). Native style lints default to `information`, so they pass at the default threshold but fail at `--max-severity hint` or `off`. Pick a threshold below `info` only if you intend style findings to fail the build.
- `--quiet`: suppress the trailing summary line.
- `--color auto|always|never`: when to colorize `text` output (default `auto`). See [Color output](#color-output).
- `--no-color`: alias for `--color never`.

Invoking `raven lint` turns on the native linter, even when no config is discovered, under `--no-config`, or when the base `linting.enabled` setting is off. All other configuration still applies: per-file overrides and exclusions may turn linting off for some files, individual rule severities may be `off`, and custom rule values are kept.

<a id="scope-1"></a>

### Files `raven lint` reads

`.R` and `.r` files and R Markdown / Quarto files (`.Rmd`, `.Rmarkdown`, `.qmd`) are linted. Inside `.Rmd`, `.Rmarkdown`, and `.qmd` files, lint rules apply to R chunk bodies; prose, YAML front matter, and non-R chunks are ignored. `# nolint`, `# nolint start` / `# nolint end`, and `# raven: ignore` markers inside chunk bodies work as in plain R files. Other file types are ignored silently. Passing a directory walks it recursively for `.R`, `.r`, `.Rmd`, `.Rmarkdown`, and `.qmd` files.

<a id="file-encoding-1"></a>

### Lint file encoding

`raven lint` reads each file through the same BOM-aware decoder as `raven check` and the editor (see [File encoding](#file-encoding)). A file that isn't valid UTF-8 is reported as an **error diagnostic** (`File is not valid UTF-8: first invalid byte 0x… at offset …`) that fails the build (exit `1`) like any other error finding. It is **not** an operator error, so it does not exit `2`. Re-save the file as UTF-8 to fix it.

<a id="exit-codes-1"></a>

### Lint exit codes

- `0`: no diagnostic exceeded `--max-severity`.
- `1`: at least one diagnostic exceeded `--max-severity`. An unknown flag is a usage error and exits `1`. A file that isn't valid UTF-8 is an error diagnostic, so it also exits `1`.
- `2`: operator error while running (config parse failure, unreadable or missing path). A *readable* but mis-encoded file is a finding (exit `1`), not an operator error.

<a id="github-actions-example-1"></a>

To run `raven lint` in CI, see [Automated checks in CI](ci.md#gate-on-style).

## `raven console`

An R console with syntax highlighting, multi-line editing, Tab completion, and colored output. It runs the same R as typing `R` would (the `R` on your `PATH`, or `R_HOME`), embedded in its own process. It is the default R console in Raven's VS Code extension; see [R Console](r-console.md#ravens-console) for how it behaves. macOS and Linux only.

```sh
raven console                  # like `R`
raven console --no-save -q     # R's options pass through unchanged
```

| Option | Description |
|--------|-------------|
| `--r-home DIR` | Use the R installation at `DIR` instead of `$R_HOME` or `R RHOME` |
| `--edit-mode emacs\|vi` | Key bindings (default `emacs`) |
| `--color-output streams\|values\|off` | Output colors (default `streams`; `NO_COLOR` turns them off) |
| `--history-file PATH` | Where to keep input history |
| `--no-history` | Keep history in memory only |
| `--ipc PATH` | Also accept code from an editor on this Unix socket |
| `--dap PATH` | Serve the R [debugger](debugger.md) (Debug Adapter Protocol) on this Unix socket |

Every other argument goes to R. If stdin or stdout isn't a terminal, or the console can't embed your R (for example R built without `--enable-R-shlib`), it runs plain R with the same arguments instead.

## `raven --stdio`

`raven --stdio` starts the language server, speaking the Language Server Protocol over stdin and stdout. Editors launch it for you; you rarely run it by hand. The VS Code extension bundles its own binary. For Neovim, Zed, Helix, Emacs, and other LSP clients, see [Editor setup](editor-integrations.md). Running `raven` with no arguments prints usage instead of starting the server.

## `raven packages`

Commands for the databases Raven uses to resolve package symbols without installing packages. [Package database](package-database.md) explains how Raven chooses between them.

- `freeze` and `fetch` both **produce** `.raven/packages.json`. `freeze` captures exports from a local R install (version-exact, meant to be committed). `fetch` takes them from CRAN/Bioconductor r-universe (latest, regenerated each run).
- `update` downloads Raven's broad CRAN/Bioconductor metadata, which isn't bundled with the binary.

`raven freeze [ARGS]` is exactly equivalent to `raven packages freeze [ARGS]`, and `raven fetch [ARGS]` to `raven packages fetch [ARGS]`: same parsing, same handler, same help. Only `freeze` and `fetch` have top-level aliases; `update` stays nested.

### `raven packages fetch`

Produce a `.raven/packages.json` from CRAN/Bioconductor r-universe. It is the same file `freeze` produces, sourced from community infrastructure instead of a local R install. It needs no R, no installed packages, and no access to Raven's `names-db` GitHub Release. The file is a **temporary CI file** meant to be regenerated each run; gitignore it rather than committing it. For a committed, version-pinned file, use `freeze`.

```text
raven packages fetch [OPTIONS]
```

There are two modes:

- **Plain `raven packages fetch`** computes the used set without R (a scan of your sources, plus `DESCRIPTION` `Depends`/`Imports`, `renv.lock` names, and transitive `Depends` from r-universe), skips base and recommended packages (known offline from the embedded base set), and fetches the rest from r-universe.
- **`raven packages fetch --missing-only`** is an optimization. When R is present with a populated library, it skips packages that are already installed, since those resolve from your local R library in the same CI run. When R is absent or `.libPaths()` is empty, nothing is skipped and it fetches everything. Passing `--missing-only` without R is **never an error**.

<a id="options-2"></a>

#### Fetch options

- `--missing-only`: skip already-installed packages. Without R it fetches everything.
- `--fail-on-missing`: exit non-zero if any used package resolved nowhere (after writing the file). By default, unresolvable packages produce warnings and a success exit.
- `--output PATH`: where to write or merge (default: `.raven/packages.json` at the workspace root).
- `--workspace DIR`: workspace root to scan for usage and config (default: current directory).
- `--base-urls URL[,URL]`: override the ordered r-universe host list (for testing); each URL must include the scheme. Default: `https://cran.r-universe.dev,https://bioc.r-universe.dev`.
- `--help`: usage.

<a id="additive-merge--existing-records-always-win"></a>

#### Existing records always win

`fetch` reads any existing `.raven/packages.json` at the target path and **keeps every record in it untouched**, adding records only for used packages not already present. It does not refetch a package the existing file already covers. Run after `freeze`, it tops up coverage for whatever `freeze` missed (for example uninstalled packages) without changing any `freeze` row. When the merge produces content identical to the existing file, `fetch` leaves the file untouched and prints "no changes."

A corrupt or unsupported-schema existing file is reported as an error and the command stops rather than discard a file you may need. Delete it or point `--output` elsewhere.

#### Output and warnings

- An **inform** line names the packages about to be downloaded.
- Per-package **warnings** name packages that resolve nowhere on r-universe (GitHub-only, internal, not yet indexed, or typos like `library(dpylr)`).
- A **renv.lock version-skew warning** appears when the fetched record's version differs from the version `renv.lock` pins. r-universe serves only the latest version, so `fetch` cannot get the exact pinned one. The warning names both versions and points at `freeze` or `--missing-only` for a version-exact capture. Export names are usually stable across versions, so this is a heads-up, never an error, and never gated by `--fail-on-missing`.

#### `--fail-on-missing`

By default, packages that resolve nowhere produce warnings and a success exit. With `--fail-on-missing`, any resolved-nowhere package makes the command exit non-zero **after** writing the file, so partial results are still available. A way to suppress expected-missing private or internal packages is planned; for now they are warned about on every run.

#### Gitignore guidance

The fetched file is a temporary CI file, regenerated each run from the latest r-universe exports. **Gitignore it** (add `.raven/packages.json` to `.gitignore`). You *may* commit it, but it isn't designed for that: for a committed, version-pinned file, use `freeze`.

#### Network and atomicity

`fetch` downloads with curl, a few packages at a time, trying CRAN then Bioconductor for each package. It writes atomically (to a temporary file, then renames), so a failure mid-fetch cannot hand a half-written file to `raven check`. If every download fails at the transport level (network down, curl missing), the command reports the failure and writes nothing; any existing file is left intact. A partial failure writes what it got and warns about the rest.

#### Scope limits

1. `fetch` does **not** replace Raven's broad `names.db` metadata. It covers only packages the project references (the "used set").
2. `fetch` is **not** fully self-contained. Base and recommended packages are not on r-universe and still come from local R or the embedded fallback at analysis time.

### `raven packages freeze`

Generate a committed, repo-specific `.raven/packages.json`: a snapshot of your installed packages' export names, `Depends`, and datasets. This is Raven's reproducible CI path. Run it on a machine that has R and the project's packages installed, then commit the result so CI uses project-pinned package metadata. Raven's downloaded CRAN/Bioconductor metadata covers the broad ecosystem when present, but this snapshot is **more accurate** for packages that metadata doesn't cover (GitHub-only or internal packages) and for symbols newer than its snapshot. The file is generated, never hand-edited.

```text
raven packages freeze [OPTIONS]
```

<a id="options-3"></a>

#### Freeze options

- `--used` (default): capture only the packages the repo uses. The set is deliberately **broad**: packages referenced through `library`/`require`/`loadNamespace`/`requireNamespace`, the left-hand side of `::`/`:::`, everything in `renv.lock`, the repo's own `DESCRIPTION` `Depends`/`Imports`, and their transitive `Depends`. `LinkingTo` is excluded because it is C-level and has no R exports. For a `:::` reference, the package's exports are captured; its internal object names are not. Including too much costs nothing: the capture skips anything not installed.
- `--installed` / `--all`: capture every package across the renv and system libraries, not just the used set.
- `--output PATH`: where to write the file (default: `.raven/packages.json` at the workspace root).
- `--workspace DIR`: workspace root to scan for usage and config (default: current directory).

#### Base packages

`freeze` skips only the seven packages R attaches by default, the ones Raven treats as always in scope with no `library()` call. It may still write records for other base packages such as `grid`, `tools`, and `compiler` when your code uses them or when you choose `--installed` / `--all`. That is intentional: `freeze` captures your local R install, which may differ from the reference R used to build Raven's embedded fallback, and the file should match packages your scripts call explicitly.

#### Library order and renv

Generation resolves each package from a **renv-first** library order: the renv project library first, then system-wide libraries only for packages renv doesn't cover. A `renv.lock` only selects **which** packages to include (a locked package is included even if no script calls it), **not** which version to read; exports always come from the package installed locally. A locked package that isn't installed can't be captured and falls through to Raven's downloaded CRAN/Bioconductor metadata in CI. Best coverage comes from running `freeze` after `renv::restore()`, but nothing breaks otherwise.

#### No-op when content is unchanged

If a `.raven/packages.json` already exists, `freeze` compares **package content only**, ignoring provenance such as the generation timestamp. When the content is identical it leaves the file untouched and prints "no changes", so a regeneration that found nothing new produces a zero-line diff, and the timestamp moves only when the captured exports changed.

### `raven packages update`

Downloads the `names.db` database Raven uses to recognize package symbols when the packages are not installed. It comes from the `names-db` GitHub Release and goes into Raven's user data directory. Base R coverage is embedded in the binary and needs no download. `names.db` is **not** bundled with the `raven` binary, so run this whenever you want broad CRAN/Bioconductor coverage without a local R install. The VS Code extension doesn't need it: VS Code users resolve their installed packages through R.

This command is the only place package metadata is downloaded: `raven check`, language server startup, completion, hover, and normal package lookup never fetch it.

In GitHub Actions, install Raven with `jbearak/setup-raven@v1` and then run this as an explicit step before `raven check`. In Bitbucket Pipelines or other Ubuntu CI, install Raven from the signed apt repository first, then run the same steps:

```sh
apt-get install -y raven
raven packages update
raven check
```

`raven packages update` follows the moving `names-db` Release, so it isn't version-pinned by your project. For reproducible CI, commit a `.raven/packages.json` generated by `raven packages freeze`, or pin an immutable dated release:

```sh
raven packages update 2026-06-02
```

Each build also publishes an immutable `names-db-YYYY-MM-DD` Release alongside the rolling `names-db` one, and these dated snapshots are kept indefinitely. With no date argument, `update` pulls the latest (`names-db`).

Source builds with `cargo install --git https://github.com/jbearak/raven raven` are for Raven development or custom images, not hosted CI.

<a id="appendix-maintainer-and-advanced-topics"></a>

#### Self-hosting `names.db` with `--base-url`

`raven packages update --base-url URL` changes where the database comes from. The command downloads `{URL}/names.db` (a trailing slash on `URL` is trimmed), so an organization can host its own copy on an internal mirror:

```sh
raven packages update --base-url https://mirror.example.internal/raven
# fetches https://mirror.example.internal/raven/names.db
```

- The URL must be `http://` or `https://`; other schemes are refused. Redirects are followed. The download is capped at 200 MB, far beyond any real `names.db`, to guard against a misconfigured endpoint serving something much larger.
- Before it replaces the existing database file, `update` opens the download as a Raven database and checks the container header, format version, payload checksum, index bounds, and that every record decodes. This confirms the file is a well-formed `names.db`, **not** who produced it: there is no signature or provenance check, and the published `checksums.sha256` is not fetched. Trust rests on the transport (prefer HTTPS) plus that structural check.
- `--base-url` applies to one invocation; it isn't a persisted setting. (`RAVEN_NAMES_DB` is unrelated: it overrides where the database is *stored*, not where it is downloaded from.) Wrap it in a script or CI step for repeated use.
- `--base-url` replaces the whole URL, so it can't be combined with the `YYYY-MM-DD` dated-release argument; a self-hosted mirror defines its own layout.

<a id="raven-packages-build-shipped-db"></a>
<a id="raven-packages-validate-shipped-db"></a>
<a id="raven-packages-build-embedded-base"></a>

#### Maintainer commands

`raven packages build-shipped-db`, `validate-shipped-db`, and `build-embedded-base` build and check the databases Raven publishes and embeds. You never need them to use Raven. They are documented in the [development notes](https://github.com/jbearak/raven/blob/main/docs/development.md#tier-3-build-pipeline).

## Output formats

`check` and `lint` share the same output formats:

- `text`: `path:line:col level: message [rule]`, one per line.
- `json`: an array of `{ path, diagnostic }` objects, where `diagnostic` is an LSP `Diagnostic` as the editor receives it.
- `sarif`: a SARIF 2.1.0 document with tool name `raven` and `ruleId` taken from the diagnostic code.

<!-- example: check-json -->
```console
$ raven check --format json .
[
  {
    "path": "analysis.R",
    "diagnostic": {
      "range": {
        "start": {
          "line": 1,
          "character": 11
        },
        "end": {
          "line": 1,
          "character": 17
        }
      },
      "severity": 2,
      "code": "undefined-variable",
      "message": "scroes is not defined"
    }
  }
]
```

### Output streams

Diagnostics go to **stdout** for both commands. `raven check` may also print a few **context notes**: short text explaining *why* a result might be incomplete or how to act on it. `raven lint` prints none. Notes come in two groups:

- **Startup notes** are printed once, *before* any diagnostics, to **stderr**. They report a degraded environment that affects the whole run.
- **Footer notes** are printed once, *after* all diagnostics. For `text` they go to **stdout**, with the diagnostics; for `json` and `sarif` they go to **stderr**, so they can't corrupt the document on stdout. A blank line separates the footer from the summary line, and another separates each note when more than one fires. Footer notes have no header or per-line prefix.

For `text`, footer notes share stdout on purpose. A merged view of stdout and stderr (a terminal, `2>&1`, or a CI log viewer such as GitHub Actions, which timestamps each line as it reads it) can reorder the two streams and interleave a multi-line note with the findings it describes. One stream keeps them together and in order.

#### What `raven check` can print, and when

Each note is printed only when its condition holds. A clean run on a fully resolved workspace prints just the diagnostics and the summary line.

**Startup notes (stderr, before diagnostics).** One fires when R-backed package resolution is degraded **and** no offline package data covers for it, so undefined-variable findings for package symbols may be unreliable. The note depends on actual coverage, not just on R being absent. It is suppressed when offline package data loaded, either a downloaded `names.db` or a committed `.raven/packages.json` (see [Package database](package-database.md)), because that data resolves package symbols without a live R library. It fires only when coverage falls back to base R alone.

All three variants end the same way, ``package symbol resolution is limited to base R (covered by the embedded database). Run `raven packages update` for broad CRAN/Bioconductor coverage``, because the limitation and its remedy don't depend on *why* the R library was unavailable:

- R not found on `PATH`: ``R not found on PATH; package symbol resolution is limited to base R (covered by the embedded database). Run `raven packages update` for broad CRAN/Bioconductor coverage``.
- R found but its package library failed to initialize: ``R found but its package library failed to initialize (…); package symbol resolution is limited to base R (…). Run `raven packages update` …``.
- R found but no library paths were discovered: ``R found but no library paths were discovered; package symbol resolution is limited to base R (…). Run `raven packages update` …``.

**Footer notes (stdout for `text`, stderr for `json`/`sarif`, after diagnostics)**, in the order printed:

1. **Package-database load note.** Fires when a package symbol database is *present but unusable*, such as a malformed or unreadable committed `.raven/packages.json` or a corrupt `names.db`, and names the specific failure. The database wasn't searched, so some symbols may be unresolved; the note tells that apart from a genuine typo.
2. **Missing-export-metadata warning.** Fires when attached packages' exported symbols couldn't be loaded (`couldn't load exported symbols for <packages>. Some "Undefined variable" warnings above may be inaccurate …`), followed by a fix that depends on why the metadata was missing: install the package, run `raven packages freeze`, or run `raven packages update` in CI. Without a package's exports, calls into it can produce false undefined-variable findings.
3. **Cross-file traversal-budget note.** Fires when a cross-file traversal was cut short, by either the visited-file budget (`maxTransitiveDependentsVisited`) or the chain-depth limit (`maxChainDepth`), and names the limit and how to raise it in `raven.toml`. A truncated traversal stops following `source()` edges, so symbols defined across a dropped edge may appear as false undefined-variable warnings. The note lets you tell a budget-induced drop from a real undefined variable.
4. **NSE footer**, described next.

<a id="nse-discoverability-footer"></a>

#### NSE footer

When some undefined-variable findings sit inside call arguments Raven can't see into (a package function that *might* capture the argument through [non-standard evaluation](non-standard-evaluation.md)), the **`text`** report prints one footer after the findings, and **only** there. The footer never claims the call *is* NSE. It starts with the usual false-positive escape hatches (`# raven: ignore`, `# nolint`, `# raven: expect`) and presents NSE as the one R-specific extra cause. It then lists copy-pasteable directives, one per function however many findings it caused, and links [the directives reference](directives.md) and [handling false positives](diagnostics.md).

With concrete callees filled in, it reads:

<!-- example-exempt: callee names and counts come from the user's code; the corpus can't install a package to produce this footer -->
```
3 undefined-variable findings above sit inside calls to package functions
whose source raven can't see. If one is a false positive, you can suppress it as with any
linter (`# raven: ignore`, `# nolint`, or `# raven: expect`).
R has one extra cause: a function that captures an argument via non-standard
evaluation (NSE) — as `dplyr::filter(df, col > 0)` treats `col` as a column, not a
variable — makes a valid name look undefined. Raven already recognizes NSE in many
common packages (the tidyverse and more) but not all, so these findings come from
functions outside that built-in coverage. If that is the case here, declare the
function's NSE contract instead of suppressing:

  # raven: nse somepkg::my_filter(x)
  # raven: func somepkg::other(<formals>)
  # raven: nse somepkg::other(<nse-formals>)

The two-line `# raven: func …` / `# raven: nse …` pair is for an argument passed positionally:
raven needs the function's parameter list to know which formal the argument is, so fill
`<formals>` with the function's signature and `<nse-formals>` with the captured ones. Keep them
on separate lines — each `# raven:` directive must be the only one on its line. When
the argument is passed by name, naming that formal (`# raven: nse fn(x)`) is enough.

See https://github.com/jbearak/raven/blob/main/docs/directives.md for these directives and
https://github.com/jbearak/raven/blob/main/docs/diagnostics.md for handling false positives.
```

Named-formal suggestions are listed first, and the longer positional form, with its explanation, last.

The suggestion is **not** repeated on each finding and does **not** appear in any diagnostic message. The editor and the `json` and `sarif` formats carry no NSE text; their messages stay the bare "`x` is not defined". The editor has no per-finding hint or code action for it.

## Color output

`check` and `lint` color the **severity word** (`error`, `warning`, `info`, `hint`) in `text` output. The rest of the line stays plain so it is easy to grep. The `json` and `sarif` formats are **never** colored, whatever the flag or environment.

`--color auto|always|never` controls it (default `auto`), and `--no-color` is an alias for `--color never`. Precedence, highest first:

1. An explicit `--color always` or `--color never` (or `--no-color`, meaning `never`) always wins over the environment.
2. Otherwise (`auto`):
   - [`NO_COLOR`](https://no-color.org/) set and non-empty: **off**.
   - else [`FORCE_COLOR`](https://force-color.org/) set and non-empty: **on**.
   - else **on** when stdout is a terminal, **off** when piped or redirected.

So `--color always` forces color even through a pipe (for example into `less -R` or a CI log viewer), `--color never`, `--no-color`, and `NO_COLOR` turn it off, and the default follows whether you're looking at a terminal. With conflicting explicit flags the last one wins (`--no-color --color always` means color on).

## See also

- [Automated checks in CI](ci.md)
- [Package database](package-database.md)
- [Configuration](configuration.md)
- [Diagnostics](diagnostics.md)
- [Editor setup](editor-integrations.md)
