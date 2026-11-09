# CLI

[Docs](README.md) › Reference

The `raven` binary checks R code from a terminal or CI job, manages the package databases that let it work without R, runs an R console, and serves the language server to your editor.

| You run | Raven does |
|---|---|
| [`raven check`](#raven-check) | Indexes the workspace and reports the full diagnostic set, the same diagnostics the editor publishes. |
| [`raven lint`](#raven-lint) | Runs only the native style linter. |
| [`raven graph`](#raven-graph) | Prints the links Raven found between files: `source()` calls, directives, and the rest of the cross-file graph. |
| [`raven parse`](#raven-parse) | Prints each R file's statements, comments, and syntax tree as JSON, for tools that read R code. |
| [`raven packages update`](#raven-packages-update) | Downloads CRAN/Bioconductor export names so `raven check` recognizes package functions without R. |
| [`raven packages freeze`](#raven-packages-freeze) | Writes a committed `.raven/packages.json` from your installed packages. |
| [`raven packages fetch`](#raven-packages-fetch) | Writes the same file from r-universe, with no R needed. |
| [`raven console`](#raven-console) | Starts an interactive R console. |
| [`raven --stdio`](#raven---stdio) | Starts the language server for an editor. |

Run `raven`, `raven --help`, or `raven help` for top-level usage. Every command with options accepts `--help`, including the package-database commands (`raven packages fetch --help`) and the top-level aliases (`raven fetch --help`, `raven freeze --help`). `raven --version` prints the version:

<!-- example: version -->
```console
$ raven --version
raven 0.23.8
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
raven check 0.23.8 — R and model diagnostics for CI

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

## `raven graph`

Print the cross-file graph Raven builds for a workspace: every link it stores between files, the call sites it found but didn't link, and why. Use it to see why a symbol is or isn't in scope, or to compare Raven's view of a project with another tool's.

```text
raven graph [--workspace DIR] [--config FILE | --no-config] [--format text|json]
```

`raven graph` indexes the workspace exactly as `raven check` does, with the same configuration, exclusions, and package handling, and prints the graph that indexing produced. In this example, `main.R` sources one helper inside `local()`, one at the top level with `local = TRUE`, and one that doesn't exist:

<!-- example: graph-text -->
```console
$ raven graph
main.R:2:3 -> R/clean.R (source, call, current_frame)
main.R:5:1 -> R/model.R (source, call, global)
main.R:6:1 -> R/report.R (source, call, global, missing, not portable from root)

3 edge(s), 0 dropped, 4 file(s)
```

The text format is for reading and may change between releases. For scripts, use `--format json`.

### Graph options

- `--workspace DIR`: the workspace root to index. The default is the current directory.
- `--config PATH`: explicit path to a `raven.toml` or `.lintr`. By default Raven walks upward from the workspace.
- `--no-config`: ignore `raven.toml` and `.lintr` and use Raven's built-in defaults.
- `--format text|json`: output format, default `text`. `sarif` isn't accepted, because the graph isn't a list of findings.

`raven graph` exits `0` once it prints the graph, even when some call sites were dropped or the graph is incomplete. An unknown flag exits `1`, and an operator error such as an unreadable config or a `--workspace` that isn't a directory exits `2`.

### Graph JSON

The JSON object has `schema_version` (currently `1`), `raven_version`, `root`, `package_mode`, `complete`, `warnings`, `files`, `edges`, and `dropped`. Adding a field or an enum value keeps `schema_version`; removing or renaming a field, or changing its meaning, increments it. Ignore fields you don't know and treat unknown enum values as "other".

Paths are relative to the canonical workspace root with `/` separators, or absolute outside it. A file reached through two spellings, such as a symlink, appears once per spelling. These paths are the same strings as [`raven parse`](#raven-parse)'s `path` values for the same workspace and configuration, so a graph row joins a parsed document by path.

Every line number is 0-based and every character counts UTF-16 code units, as in the editor protocol. That holds for `call_site.position`, `directive.line`, and `position` in `dropped`, so a directive on a file's first line has `line: 0`. A backward directive's `line=N` is 1-based as you write it: `# raven: sourced-by ../main.R line=3` gives a call site whose `position.line` is `2`.

- `package_mode`: Raven analyzed the workspace as an R package.
- `complete`: every file the workspace scan found went through graph building. When it's `false`, `warnings` says how many files couldn't be read or processed and how many the index's capacity evicted. An oversized file still counts.
- `warnings`: sentences for people, covering incomplete files, files without full text (backward call sites into them may be unfound), failed `list.files()` batches, and any mismatch between the graph and its records.
- `files`: every indexed file and every edge endpoint, each with `path`, `indexed`, `exists`, `self_contained`, `syntax_errors`, and `working_directory` (`null`, or `{"raw", "resolved"}` for a `# raven: cd`).

Each entry in `edges` is one stored link, including repeated calls and every file of a batch. Edges are sorted by `caller`, call-site position, `batch_ordinal`, `kind`, `origin`, and `target`:

| Field | Meaning |
|---|---|
| `caller`, `target` | The endpoints. For a backward directive, `caller` is the parent it names and `target` is the file containing it. |
| `kind` | `source`, `sys_source`, `tar_source`, `list_files`, `shiny_global`, `shiny`, `box`, or `tarchetypes_document`. |
| `origin` | `call`, `directive` (`# raven: source`, `run`, `include`), or `backward_directive` (`# raven: sourced-by`, `run-by`, `included-by`). |
| `call_site` | Where in `caller` scope treats the call as happening: `basis` (`call`, `directive`, `line`, `line_end`, `eof`, `match`, `inferred`, or `implicit` for Shiny), `position` (`null` for `eof` and for a backward call site that wasn't found; `character` is `null` for `line_end`), and `failure` (`null`, `not_found`, or `parent_content_unavailable`). |
| `directive` | For a directive, `{"file", "line"}` where it's written, with `line` 0-based; otherwise `null`. |
| `raw_path` | The path as Raven read it, for `source()` and `sys.source()` calls, directives, and report documents. `null` for `system.file()` calls, batches, and `box` modules. |
| `system_file` | For a `system.file()` call, `{"package", "parts"}`; otherwise `null`. |
| `batch_ordinal` | Order within a `tar_source`, `list_files`, `shiny_global`, or `shiny` batch. |
| `locality` | `global` (top level, including `local = TRUE` at a file's top level), `current_frame` (`local = TRUE` inside `local()` or a function), or `non_inheriting` (`local = <env>`, or `sys.source()` without a global `envir`). `null` for `box`, report, and backward edges. |
| `chdir`, `function_scoped` | As Raven stored them; `null` for backward directives. |
| `guarded_by_file_exists` | The call is the only consequence of an `if (file.exists(...))` naming the same path. |
| `resolution` | How the written path resolved: `endpoint` (`target`, or `caller` for backward directives), `exists`, `case` (`exact`, `filesystem_folds_case`, `raven_leniency`, or `null` when the file doesn't exist), `outside_root`, and `working_directory` (the base used when it wasn't the file's own directory). `null` for batches and `box` modules. |
| `portable_from_root` | `true` when `raw_path` has no leading `/` and resolves, with the same case, to an existing file at that path under the root, so the call works when R runs from the root. `null` without a `raw_path` and for backward directives. |

Each entry in `dropped` is a call site Raven found that produced no edge: `caller`, `position`, `kind`, `origin`, `raw_path`, `system_file`, `target`, and `reason`. In `dropped`, `caller` is always the file that holds the call or directive, so `position` is in that file. For a backward directive, `target` is the parent it names, the reverse of its row in `edges`. The reasons are:

- `excluded`: the target matches `[workspace].exclude` or `.gitignore`.
- `unresolvable`: the path couldn't be normalized.
- `system_file_unresolved`: a `system.file()` call that didn't resolve. A package that isn't installed and a run without R look the same.
- `superseded`: a forward directive stands in for the call. For example, a plain `# raven: source` directive followed by a `line=eof` directive for the same file covers a later call to that file.
- `duplicate`: merged with an identical edge, such as a repeated directive.
- `no_path_context`: Raven couldn't resolve any path in the file. It shouldn't happen for files on disk.

### Graph limits

- **One resolution per call.** A child reached under different working directories, through `chdir = TRUE`, an inherited `# raven: cd`, or `tar_source()` with `change_directory`, appears once.
- **Detected calls only.** A call Raven doesn't detect, such as a path built with `paste0()` or a call lost to a syntax error, is absent. `syntax_errors` flags files where that can happen.
- **The workspace graph only.** Links that `raven check FILE.Rmd` adds for a named report aren't shown, and `.Rmd` and `.qmd` files appear only as endpoints.
- **Implicit scope isn't an edge**: a package's `R/` namespace, testthat helpers, and `.Rprofile`.
- **Losses before the graph sees a call aren't listed.** Batch expansion drops excluded members, and a failed `list.files()` batch contributes no members; `warnings` names each failed batch and why. Raven also drops a `source()` call on the same line as a `line=N` forward directive's call site, whatever its target, so only the directive's edge appears.
- **Files indexed from outside the root contribute no edges of their own.**

## `raven parse`

Print what Raven parsed in each R file as JSON: every statement with its exact source text, range, and syntax tree, every comment, and what each call's function resolves to. A downstream tool, such as one that translates R code into another language, can use it to read the code as R parses it, keep its comments and layout, and know that `filter()` after `library(dplyr)` is dplyr's.

```text
raven parse [FILES...] [--workspace DIR] [--config FILE | --no-config] [--format json]
```

`raven parse` indexes the workspace exactly as `raven check` does, with the same configuration, exclusions, and package handling, then prints one document per file:

<!-- example: parse-json -->
```console
$ raven parse clean.R
{"schema_version":1,"raven_version":"0.23.8","path":"clean.R","encoding":{"name":"UTF-8","bom":false,"line_endings":"lf"},"package_data":{"enabled":false,"r_found":false,"names_db":false,"frozen":false},"line_count":2,"statements":[{"text":"x <- 1","range":{"start":{"line":1,"character":0},"end":{"line":1,"character":6}},"blank_line_before":false,"comments":{"leading":[{"kind":"comment","text":"# One.","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":6}},"blank_line_before":false,"directive":null}],"trailing":[{"kind":"comment","text":"# two","range":{"start":{"line":1,"character":7},"end":{"line":1,"character":12}},"directive":null}],"interior":[]},"expression":{"kind":"assignment","range":{"start":{"line":1,"character":0},"end":{"line":1,"character":6}},"op":"<-","target":{"kind":"identifier","range":{"start":{"line":1,"character":0},"end":{"line":1,"character":1}},"text":"x","name":"x","form":"plain"},"value":{"kind":"number","range":{"start":{"line":1,"character":5},"end":{"line":1,"character":6}},"text":"1","type":"double","value":1}}}],"comments":[],"errors":[]}
```

### Parse options

- `FILES`: the files to print, in the order given. Relative paths resolve against the workspace root, as `raven check`'s do. A directory stands for the R files under it, sorted by path, with `.gitignore` and `[workspace].exclude` applied. With no `FILES`, Raven prints every `.R` and `.r` file in the workspace, sorted by `path` in byte order.
- `--workspace DIR`, `--config PATH`, `--no-config`: as for [`raven graph`](#graph-options).
- `--format json`: the default and, for now, the only format. Any other value is a usage error.

Only R scripts (`.R`, `.r`) are parsed. A named `.Rmd`, `.qmd`, Stan, or JAGS file gets the [error document](#parse-documents) with the message `only .R and .r files are supported`, so the output still lines up with the request. R Markdown and Quarto support may come later as an addition.

### Parse output and exit codes

The output is JSON Lines: one compact JSON document per line, each ending in a newline, in the order requested. Notes about the run, such as a degraded R environment, go to stderr.

- `0`: every requested file has a parsed document. A file with syntax errors still gets a full document.
- `3`: at least one file couldn't be read or decoded. Its error document is printed in its place, and every other document is still printed.
- `1`: a usage error, such as an unknown flag or a `--format` other than `json`.
- `2`: an operator error, such as a config file that fails to load or a `--workspace` that isn't a directory. Nothing is printed on stdout.

<!-- example: parse-unreadable -->
```console
$ raven parse clean.R gone.R
{"schema_version":1,"raven_version":"0.23.8","path":"clean.R","encoding":{"name":"UTF-8","bom":false,"line_endings":"lf"},"package_data":{"enabled":false,"r_found":false,"names_db":false,"frozen":false},"line_count":1,"statements":[{"text":"x <- 1","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":6}},"blank_line_before":false,"comments":{"leading":[],"trailing":[],"interior":[]},"expression":{"kind":"assignment","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":6}},"op":"<-","target":{"kind":"identifier","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"text":"x","name":"x","form":"plain"},"value":{"kind":"number","range":{"start":{"line":0,"character":5},"end":{"line":0,"character":6}},"text":"1","type":"double","value":1}}}],"comments":[],"errors":[]}
{"schema_version":1,"raven_version":"0.23.8","path":"gone.R","error":{"message":"No such file or directory (os error 2)"}}
```

That run exits `3`.

### Parse versioning

Every document has `schema_version` (currently `1`) and `raven_version`. Removing or renaming a field, changing a field's type, or changing what a field or a value means increments `schema_version`. Adding a field, a node kind, or a value to any enum-like field doesn't. The rule applies from the first release that includes `raven parse`.

Every enum-like field is open: node `kind`, operator `op`, literal `type`, name `form`, comment `kind`, the encoding `name`, `line_endings`, a directive's `kind`, `prefix`, `reason`, `call_type`, `family`, and `scope`, an error's `source`, `code`, and `severity`, and a resolution's `kind` and `reason`. When you meet a value you don't know, read it as "other" and carry on; never fail on it. Ignore fields you don't know. Every tree node has `kind` and `range`, so you can still show the source of a node whose kind you don't know.

### Parse positions

Every `range` has a `start` and an `end` position, and the end is exclusive. A position is a 0-based `line` and a `character` offset counted in UTF-16 code units, as in the editor protocol and [`raven graph`](#graph-json). The unit matters for non-ASCII text. In `größe <- "😀"`, the statement ends at character 13: `ö` and `ß` are one UTF-16 unit each but two UTF-8 bytes, and the emoji is two UTF-16 units, one code point, and four bytes. The same line is 12 code points and 17 bytes long.

`\n`, `\r\n`, and a lone `\r` each end a line, and the ending isn't part of the line's characters. Positions are into the decoded text with any byte-order mark removed, so a BOM doesn't shift line 0.

### Parse documents

A parsed document has `schema_version`, `raven_version`, `path`, `encoding`, `package_data`, `line_count`, `statements`, `comments`, and `errors`.

- `path`: the [graph's](#graph-json) path rule. It is relative to the canonical workspace root with `/` separators, or absolute outside it, and lexical: a file under a symlinked directory keeps the symlink's spelling. For the same workspace and configuration, a file's `path` equals its `files[].path` in `raven graph --format json`, byte for byte. One exception keeps that true: a `FILE` named through another spelling of the root itself, such as macOS's `/var` for `/private/var`, is printed under the canonical root.
- `encoding`: `name` (`UTF-8`, `UTF-16LE`, or `UTF-16BE`), `bom` (whether a byte-order mark was present and stripped), and `line_endings` (`lf`, `crlf`, `cr`, `mixed`, or `none` for a file without one). Raven reads files as `raven check` does, as described in [File encoding](#file-encoding). A file that isn't valid in its encoding gets the error document, with a message naming the first invalid byte's offset. Raven never substitutes replacement characters.
- `package_data`: which sources of package export names the run had. See [Package data](#package-data).
- `line_count`: the number of lines. A final line ending doesn't start another line, so `a\nb\n` has 2 lines and an empty file has 0.
- `statements`: the file's top-level statements. See [Statements and comments](#statements-and-comments).
- `comments`: the comments no statement owns: every comment in a file without statements, and own-line comments after the last top-level statement.
- `errors`: what R's parser would reject or warn about. See [Parse errors](#parse-errors).

A file Raven can't open or decode gets the error document instead: `schema_version`, `raven_version`, `path`, and `error` with a `message`. It has no statements. Tell the two shapes apart by the presence of `error`.

### Statements and comments

A statement is each expression in the file's top level and each expression directly inside a pair of braces, wherever they stand: a function body, an `if` or `else` branch, a loop body, a bare block, or a braced argument such as `local({ ... })`, `tryCatch({ ... })`, or `{{ x }}`. Top-level statements are in the document's `statements`; the statements inside braces are in that block node's `statements` in the tree. Both lists are in source order. Each statement has:

- `text`: the exact source of its range, comments and line endings included. `\r\n` stays `\r\n`.
- `range`: slicing the decoded text by it gives `text`.
- `blank_line_before`: `true` when a blank line separates the statement, or its first leading comment, from what comes before it in the same sequence: the previous statement, or the start of the block or file.
- `comments`: `leading`, `trailing`, and `interior` lists.
- `expression`: the statement's [syntax tree](#parse-syntax-tree).

Two statements on one line, separated by `;`, are two statements. Neither one's text includes the `;`.

Each comment has `kind` (`comment`, or `roxygen` for a `#'` comment), `text` with its `#`, `range`, and `directive`: the [directive](#parse-directives) it carries, or `null`. Comments on their own line (`leading`, `block_end`, and the file's `comments`) also have `blank_line_before`, measured from the previous comment in the list or from what precedes the list, so blank lines between comment groups are kept. Every comment in the file appears exactly once:

- `trailing`: a comment that starts on the line where a statement ends, after it. With two statements on the line, it is the last one's.
- `interior`: a comment inside a statement's range that no nested statement or block owns, such as one between two steps of a pipe or two arguments.
- `leading`: other comments before a statement and after the previous one in the same sequence. A comment after a block's `{`, on the same line, leads the block's first statement.
- `block_end`: comments in a block after its last statement, or in a block with no statements. They are on the block node, in `comments.block_end`, so each block of an `if ... else` has its own list.

### Parse syntax tree

Each statement's `expression` is a tree of nodes. Every node has `kind` and `range`, whatever its kind, so you can still show the source of a node whose kind you don't know. Every child's range lies inside its parent's. The tree is the source as written, not R's rewritten form: `x |> f()` stays a `pipe`, `x -> y` keeps its arrow, `2 ** 3` keeps `**`, and parentheses are a node of their own.

`kind`, `op`, `type`, and `form` are open enums, so read a value you don't know as "other". After `kind` and `range`, a node has the fields listed below, details before child nodes, and its child nodes are in source order. A field for an optional part, such as an `if` without `else`, is `null`.

Leaves have a `text`: the source as written, which slicing the file by the node's `range` gives.

| `kind` | What it is | Fields |
|---|---|---|
| `identifier` | A name | `text`, `name`, `form`, and `resolution` for a name that resolves to a package object |
| `placeholder` | The pipe placeholder `_` | `text` |
| `number` | A number literal | `text`, `type`, `value` |
| `string` | A string literal | `text`, `value`, `quote`, `raw`, `delimiters` |
| `constant` | `TRUE`, `FALSE`, `NULL`, `NA` and its typed forms, `Inf`, or `NaN` | `text`, `type` |
| `next`, `break` | Loop control | `text` |
| `unparsed` | A statement R can't parse; see [Parse errors](#parse-errors) | `text` |

The other nodes:

| `kind` | What it is | Fields |
|---|---|---|
| `call` | `f(...)`, where the function is any expression | `function`, `resolution`, `arguments` |
| `index` | `x[...]` or `x[[...]]` | `op` (`[` or `[[`), `target`, `arguments` |
| `extract` | `x$name` or `x@name` | `op` (`$` or `@`), `left`, `right` (an `identifier`) |
| `namespace` | `pkg::name` or `pkg:::name` | `op` (`::` or `:::`), `left`, `right` (both `identifier`) |
| `assignment` | `<-`, `<<-`, `=`, `->`, `->>`, or `:=` | `op`, `target`, `value` |
| `pipe` | `\|>` | `op`, `left`, `right` |
| `binary` | Any other binary operator | `op`, `left`, `right` |
| `formula` | `~`, with or without a left side | `op`, `left` (`null` when one-sided), `right` |
| `unary` | `-`, `+`, `!`, or unary `?` | `op`, `operand` |
| `parenthesized` | `( ... )` | `body` |
| `block` | `{ ... }` | `statements`, `comments` (`block_end`) |
| `function` | `function(...)` or `\(...)` | `keyword` (`function` or `\`), `parameters`, `body` |
| `if` | `if`, with an optional `else` | `condition`, `consequence`, `alternative` |
| `for` | `for (i in s)` | `variable` (an `identifier`), `sequence`, `body` |
| `while` | `while (c)` | `condition`, `body` |
| `repeat` | `repeat` | `body` |

#### Tree operators

`op` is the operator as written. On a `binary` node it is one of `+`, `-`, `*`, `/`, `^`, `**`, `:`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&`, `&&`, `|`, `||`, and `?`, or a `%...%` operator with its text, such as `%%`, `%/%`, `%in%`, or `%>%`.

An `assignment`'s `target` is what is assigned to, wherever it stands. `->` and `->>` keep their direction, so `x -> y` has `value` `x` and `target` `y`. `=` is an `assignment` only where R reads it as one, such as `x = 1` as a statement or `(x = 1)`. In `f(x = 1)` it names an argument. Control flow is an expression, so `y <- if (c) a else b` has an `if` as its `value`. An `else if` is an `alternative` that is itself an `if`.

R's parser has no negative literals, so `-1` is a `unary` `-` over the number `1`, and `-Inf` is one over the constant `Inf`. Nested operators stay nested: `!!x` is two `unary` `!` nodes, `!!!x` is three, and `!(!x)` has a `parenthesized` node between its two. `{{ x }}` is a `block` whose one statement is a `block`.

#### Tree names

An `identifier`'s `name` is the name as R reads it, and `form` says how it was written:

- `plain`: `x`, `...`, `..1`, `.`, `.data`, `T`, `F`. `T` and `F` are identifiers, not constants, because they can be reassigned.
- `backtick`: `` `größe` ``. The `name` drops the backticks and decodes backslash escapes as R does, so `` `a\`b` `` is the name ``a`b``.
- `string`: a string where R accepts one in a name's place. That is an argument name (`c("a" = "b")`, `f("msg" = e)`), either side of `::` (`"dplyr"::filter`), or the right side of `$` or `@` (`d$"x"`). The `name` is the string's value.

Names are reported as written, with no Unicode normalization. `NULL` as an argument name, as in `f(NULL = 1)`, which R allows, is the identifier `NULL` with form `plain`. A name R rejects, such as `` `\u{e9}` `` (R doesn't allow `\u` in backticks) or an empty argument name, is a parse error: its statement is `unparsed`, and `errors` says why.

A plain `_` is always a `placeholder`, because it is R's pipe placeholder. R accepts it as a named argument in a pipe step (`x |> f(y = _)`) and at the head of an extraction (`x |> _$a`). A backticked `` `_` `` is an identifier. `.` in a `%>%` step is an ordinary identifier, kept where it stands, so `f(a, .)` and `f(a, g(.))` differ.

#### Tree literals

A `number`'s `type` is the type R's parser gives it, which isn't always what its spelling suggests:

| Written | `type` |
|---|---|
| `1`, `1e3`, `0x10`, `0x1p3` | `double` |
| `1L`, `1e3L`, `0x10L`, and `1.0L`, which R warns about in `errors` | `integer` |
| `1.5L`, `1e-3L`, `100000000000L`: R can't make an integer of them, so it warns and uses the double | `double` |
| `1i`, `0x10i` | `complex` |

`value` is the number as a JSON number, in the shortest form that reads back as the same double: `16` for `0x10L`, `0.001` for `1e-3L`. R's numbers are doubles or 32-bit integers, so a JSON parser that reads numbers as doubles gets R's value exactly. A complex literal's `value` is its imaginary part. A literal too large for a double, such as `1e999`, is `Inf` in R and has `"value": null`.

A `constant`'s `type` is R's: `logical` for `TRUE`, `FALSE`, and `NA`, `integer` for `NA_integer_`, `double` for `NA_real_`, `Inf`, and `NaN`, `complex` for `NA_complex_`, `character` for `NA_character_`, and `NULL` for `NULL`.

A `string`'s `value` is the string R reads. Escapes are decoded as R decodes them, such as `\n`, `\"`, `\x41`, `\101`, `\u{00e9}`, and `\U{1F600}`, and a line ending inside the string reads as `\n`. `quote` is `"` or `'`. `raw` is `true` for a raw string, whose `value` is its content as written. `delimiters` has the `open` and `close` text around the content: `"` and `"`, or `r"---(` and `)---"` for `r"---(text)---"`.

A high and a low surrogate escape in a row, as in `"\u{d83d}\u{de00}"`, are one character, as R reads them. A `string` has no `value` when R's value isn't Unicode text: a lone byte that isn't UTF-8, as in `"\xe9"`, or an unpaired surrogate escape, as in `"\u{d800}"`, which R reads with a warning. An escape R rejects, such as `\q`, or `\u` and `\x` escapes mixed in one string, is a parse error, and its statement is `unparsed`.

#### Tree arguments and parameters

`arguments`, on `call` and `index`, and `parameters`, on `function`, are lists of entries. An entry isn't a node and has no `kind`, but it has the whole entry's `range`.

- An argument has `name`, an `identifier` or `null`, and `value`, a node or `null`. Arguments are in their original order, named and positional mixed as written. An empty argument, such as the second in `x[i, ]` or the first in `d[, y := e]`, has `null` for both, and an empty `range` just after the `(`, `[`, `[[`, or comma before it. As in R, `f()` has no arguments and `f(,)` has two empty ones. A named argument without a value, as in `alist(x = )`, has a `name` and a `null` `value`.
- A parameter has `name`, an `identifier` such as `x` or `...`, and `default`, a node or `null`.

### Parse directives

A comment's `directive` is the `# raven:` directive, `@lsp-` alias, or lintr `# nolint` marker it carries, or `null`. Raven reads it with the same code `raven check` uses, so the two agree on what a directive means and whether it applies. [Directives](directives.md) explains what each one does.

```json
{"kind": "backward", "prefix": "raven", "keyword": "run-by", "honored": true, "reason": null,
 "call_type": "run", "path": "../main.R", "line": 12, "match": null}
```

Every directive has these fields, then the fields for its `kind`:

- `kind`: `forward`, `backward`, `working_directory`, `self_contained`, `variable`, `function`, `nse`, `suppression`, or `unknown`.
- `prefix`: `raven` for `# raven:`, `lsp` for the `@lsp-` alias, or `nolint`.
- `keyword`: the directive word as written, such as `run-by`, `working-dir`, `ignore-next`, or `nolint`. Synonyms share a `kind` but keep their spelling here.
- `honored`: whether Raven acts on the directive where it stands.
- `reason`: why it doesn't, or a caveat, or `null`. See below.

| `kind` | `keyword` | Fields |
|---|---|---|
| `forward` | `source`, `run`, `include` | `call_type`, `path`, `line` |
| `backward` | `sourced-by`, `run-by`, `included-by` | `call_type`, `path`, `line`, `match` |
| `working_directory` | `cd`, `wd`, `working-directory`, `working-dir`, `current-directory`, `current-dir` | `path` |
| `self_contained` | `self-contained`, `standalone` | None |
| `variable` | `var`, `variable`, `declare-var`, `declare-variable` | `name` |
| `function` | `func`, `function`, `declare-func`, `declare-function` | `name`, `package`, `formals` |
| `nse` | `nse` | `declaration`, `name`, `package`, `formals` |
| `suppression` | `ignore` and `expect`, each with its `-next`, `-start`, `-end`, and `-file` forms, `ignore-chunk`, and `nolint` | `family`, `scope`, `codes`, `target` |
| `unknown` | Any other word after `# raven:` or `# @lsp-`, such as `sorce` | None |

The fields:

- `call_type`: `source`, `run`, or `include`, so `run-by` has `run`.
- `path`: the path as written, without quotes. Raven resolves it as described in [Path resolution](cross-file.md#path-resolution).
- `line`: `line=` as written: a number (1-based, as you write it), the string `eof` or `end`, or `null`. A backward directive with both `line=` and `match=` uses `line`.
- `match`: the `match=` pattern without its quotes, or `null`.
- `name` and `package`: the declared name without quotes. A `pkg::name` declaration has `package` `pkg`; otherwise `package` is `null`.
- `formals`: the formal names with their defaults dropped, or `null`. On `nse`, `null` means every argument is captured.
- `declaration`: what `nse` declares, as written, such as `helper(x)`.
- `family`: `ignore`, `expect`, or `nolint`. A `# nolint` marker silences only what lintr's markers cover in Raven; see [`# nolint`](diagnostics.md#-nolint-lintr-style).
- `scope`: `line` (its own line), `next` (the next line), `start` or `end` (a block), `file`, or `chunk`.
- `codes`: the codes listed, in Raven's kebab-case spelling, so `line_length` is `line-length`. An empty list means every code.
- `target`: the lines the directive covers, as a range from the first line's start to the last line's end. A block's `-start` and `-end` both have the block, from the `-start` line through the `-end` line. `null` when it covers nothing.

`reason` is one of these:

- `outside_header`: a backward, working-directory, or self-contained directive after the first line of code, which Raven ignores.
- `not_own_line`: a directive written after code on its line, which Raven ignores. Only `ignore`, `expect`, and `# nolint` work there.
- `malformed`: Raven rejects what follows the directive word, as in `# raven: func some-func`, whose name needs quotes, or `# raven: nse f(x,,y)`.
- `nested`: a `-start` while another block is open, which Raven ignores.
- `unpaired`: an `-end` with no open block, which does nothing, or a `-start` that nothing closes. Raven honors that `-start` through the last line.
- `chunk_only`: `# raven: ignore-chunk`, which works only in R Markdown and Quarto chunks.

An `unknown` directive has `honored` `false` and `reason` `null`. `# raven:` and `@lsp-` blocks pair with each other, and `# nolint start` and `# nolint end` with each other.

### Name resolution

Every `call` node has a `resolution`: what the call's function resolves to at the call. Calls nested anywhere have one too, inside other calls' arguments, inside formulas, and inside function bodies, so a missing `resolution` never stands for "not resolved". An `identifier` used as a value has a `resolution` only when it resolves to a package object, such as `T`, `F`, `pi`, `letters`, or `mean` in `lapply(x, mean)`. Other names, such as `x` in `filter(d, x > 1)`, have none, and that isn't an error.

```json
{"kind": "package", "package": "dplyr"}
```

`kind` is an open enum, so read a value you don't know as "other":

| `kind` | What the name is | Fields |
|---|---|---|
| `package` | A package's object. For `pkg::f` and `pkg:::f`, the package as written | `package` |
| `workspace` | A definition in a workspace file: this one, a file it sources, or a file that sources it | `path`, `range` |
| `local` | A parameter or a variable of an enclosing function | `range` |
| `declared` | A `# raven: func` or `# raven: var` declaration, or an `exists()` call Raven reads as one | `path`, `line` |
| `unresolved` | Nothing Raven can see binds it | `reason`, and `packages` for `no_package_data` |
| `dynamic` | The function isn't a name or a namespace access: `f()(x)`, `(\(x) x)(1)`, `x$f(1)` | None |
| `ambiguous` | The file's callers disagree | `candidates` |

- `path` is the defining file's [path](#parse-documents), and `range` is the defined name's range in it, as go-to-definition highlights it. A `local` binding's `range` is in this file.
- `line` is the declaration's 0-based line.
- `reason` is `not_found` (defined nowhere Raven can see), `defined_later` (defined only later at this file's top level), or `no_package_data`. That last one means a package attached here, listed in `packages`, is one Raven has no export names for, so it may define the name. See [Package data](#package-data).
- Each of the `candidates` has a caller's `path` and the `resolution` the name has with that caller alone.

For a package attached through another, as `dplyr` is through `library(tidyverse)`, `package` names the package that exports the name. Raven doesn't report where a re-exported object comes from.

<!-- example: parse-resolution file=resolve.R -->
```r
helper <- function(x) x + 1
helper(T)
f()(1)
```

<!-- example: parse-resolution -->
```console
$ raven parse resolve.R
{"schema_version":1,"raven_version":"0.23.8","path":"resolve.R","encoding":{"name":"UTF-8","bom":false,"line_endings":"lf"},"package_data":{"enabled":false,"r_found":false,"names_db":false,"frozen":false},"line_count":3,"statements":[{"text":"helper <- function(x) x + 1","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":27}},"blank_line_before":false,"comments":{"leading":[],"trailing":[],"interior":[]},"expression":{"kind":"assignment","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":27}},"op":"<-","target":{"kind":"identifier","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":6}},"text":"helper","name":"helper","form":"plain"},"value":{"kind":"function","range":{"start":{"line":0,"character":10},"end":{"line":0,"character":27}},"keyword":"function","parameters":[{"range":{"start":{"line":0,"character":19},"end":{"line":0,"character":20}},"name":{"kind":"identifier","range":{"start":{"line":0,"character":19},"end":{"line":0,"character":20}},"text":"x","name":"x","form":"plain"},"default":null}],"body":{"kind":"binary","range":{"start":{"line":0,"character":22},"end":{"line":0,"character":27}},"op":"+","left":{"kind":"identifier","range":{"start":{"line":0,"character":22},"end":{"line":0,"character":23}},"text":"x","name":"x","form":"plain"},"right":{"kind":"number","range":{"start":{"line":0,"character":26},"end":{"line":0,"character":27}},"text":"1","type":"double","value":1}}}}},{"text":"helper(T)","range":{"start":{"line":1,"character":0},"end":{"line":1,"character":9}},"blank_line_before":false,"comments":{"leading":[],"trailing":[],"interior":[]},"expression":{"kind":"call","range":{"start":{"line":1,"character":0},"end":{"line":1,"character":9}},"function":{"kind":"identifier","range":{"start":{"line":1,"character":0},"end":{"line":1,"character":6}},"text":"helper","name":"helper","form":"plain"},"resolution":{"kind":"workspace","path":"resolve.R","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":6}}},"arguments":[{"range":{"start":{"line":1,"character":7},"end":{"line":1,"character":8}},"name":null,"value":{"kind":"identifier","range":{"start":{"line":1,"character":7},"end":{"line":1,"character":8}},"text":"T","name":"T","form":"plain","resolution":{"kind":"package","package":"base"}}}]}},{"text":"f()(1)","range":{"start":{"line":2,"character":0},"end":{"line":2,"character":6}},"blank_line_before":false,"comments":{"leading":[],"trailing":[],"interior":[]},"expression":{"kind":"call","range":{"start":{"line":2,"character":0},"end":{"line":2,"character":6}},"function":{"kind":"call","range":{"start":{"line":2,"character":0},"end":{"line":2,"character":3}},"function":{"kind":"identifier","range":{"start":{"line":2,"character":0},"end":{"line":2,"character":1}},"text":"f","name":"f","form":"plain"},"resolution":{"kind":"unresolved","reason":"not_found"},"arguments":[]},"resolution":{"kind":"dynamic"},"arguments":[{"range":{"start":{"line":2,"character":4},"end":{"line":2,"character":5}},"name":null,"value":{"kind":"number","range":{"start":{"line":2,"character":4},"end":{"line":2,"character":5}},"text":"1","type":"double","value":1}}]}}],"comments":[],"errors":[]}
```

`helper(T)` resolves to the definition on line 0 and its `T` to base. The outer call of `f()(1)` is `dynamic`, and the inner `f()` is a call of its own, defined nowhere.

#### How a name resolves

Raven resolves a name with the scope `raven check` uses for its undefined-variable findings, so the two agree on what is defined where. It looks in R's order, and the first match wins:

1. An enclosing function's parameters and variables, as `local`.
2. The global environment, as `workspace`: definitions in this file before the call, in the files it sources before it, and in its callers before their `source()` call.
3. Attached packages, the most recently attached first, so a later `library()` masks an earlier one. Attaching a package again doesn't move it, as in R. Packages a caller attached before its `source()` call come after this file's own.
4. The packages R attaches at startup: base, stats, graphics, grDevices, utils, datasets, and methods. So `filter()` is stats' until `library(dplyr)` and dplyr's after it.
5. R's builtin functions and `T` and `F`, which Raven knows without any package data.

Every loader `raven check` reads counts as an attach; see [Package awareness](cross-file.md#package-awareness). A namespace access such as `dplyr::filter()` is the package as written, whatever is attached.

#### `library()` in a function or a branch

Resolution follows `raven check`'s scope, which reads a `library()` call by where it stands:

- **In a function body**, a package is attached from the call to the end of that function. It isn't attached after the function at the top level, even after a call to it.
- **In a branch of a top-level `if`**, a package is attached after the branch, whether or not the branch runs.
- **A function body sees its file's whole top level**, as R does when the function runs later: every top-level `library()` call and definition, later ones included. It also sees its callers' whole top level. This follows [global symbol hoisting](cross-file.md#global-symbol-hoisting), which is on by default.

#### Callers that disagree

A caller is a file that sources this one, through a `source()` call or a directive. When a caller's definition or attachment decides a name and the file has callers, Raven resolves the name as each caller alone would leave it, reading that caller at its `source()` call. If they agree, that is the resolution. Otherwise it is `ambiguous`, with one candidate per caller, sorted by path:

```json
{"kind": "ambiguous", "candidates": [
  {"path": "a.R", "resolution": {"kind": "package", "package": "dplyr"}},
  {"path": "b.R", "resolution": {"kind": "package", "package": "stats"}}]}
```

#### Resolution limits

- **Only the exports Raven has data for.** A name that a package without data might export resolves as if the package didn't, so check `package_data` and the `no_package_data` reason.
- **Data columns.** In a data-masking argument such as `filter(d, x > 1)`, a name may be a column of the data. A resolved name there, such as `T`, is what R finds when the data has no column of that name.
- **Sourced files' packages.** A package attached by a file that a sourced file sources ranks as attached before this file's own packages.

### Package data

`package_data` says which sources of package export names the run had, so you can tell `unresolved` because no database knows a package from `unresolved` because nothing defines the name:

```json
{"enabled": true, "r_found": false, "names_db": false, "frozen": true}
```

- `enabled`: package awareness is on (`[packages].enabled`). When it's off, Raven reads no package data, and only R's builtins resolve to packages.
- `r_found`: Raven found R and read the installed packages from its library.
- `names_db`: the names database from `raven packages update` loaded.
- `frozen`: a `.raven/packages.json` from `raven packages freeze` or `raven packages fetch` loaded.

[Package database](package-database.md) explains each source. In CI without R, commit a frozen `.raven/packages.json` or run `raven packages update` before `raven parse`.

### Joining with `raven graph`

`raven graph --format json` stays the dependency graph, and `raven parse` repeats none of it. Run with the same workspace and configuration, the two join as follows, with every line 0-based in both:

- **Files.** A document's `path` equals the graph's `files[].path`. Join an edge's `caller` or `target` to its document by path.
- **Calls.** An edge whose `call_site.basis` is `call` came from a `source()` or `sys.source()` call (bare, or qualified with `base::` or `base:::`), and its `call_site.position` is that `call` node's `range.start` in the `caller`'s document. A call in the graph's `dropped` list follows the same rule with its `position`.
- **Directives.** An edge made by a directive has `directive.file` and `directive.line`. The directive's comment in that file's document has a `directive`, and its `range.start.line` equals `directive.line`.

### Parse errors

`errors` lists what R's parser would reject or warn about, in source order. A file with errors still gets a full document and exit code `0`. Each entry has `source`, `code`, `severity`, `message`, and `range`. `source` is `parser` or `lexer`, and `severity` is `error`, `warning`, `information`, or `hint`.

| `source` | `code` | `severity` | For |
|---|---|---|---|
| `parser` | [`syntax-error`](diagnostics.md#syntax-error), [`chained-comparison`](diagnostics.md#chained-comparison) | `error` | The parse errors `raven check` reports, with its codes and messages |
| `parser` | `pipe-rhs` | `error` | A right side of `\|>` that R rejects, as in `x \|> f` or `x \|> -1` |
| `parser` | `pipe-placeholder` | `error` | A `_` that R rejects: unnamed, used twice, in the called function, or outside a pipe step |
| `lexer` | `invalid-escape` | `error` | An escape R rejects, in a string or a backticked name |
| `lexer` | `zero-length-name` | `error` | ``` `` ``` or an empty argument name, as in `f("" = 1)` |
| `lexer` | `invalid-number` | `error` | A number R can't read, such as `1e` |
| `lexer` | `unpaired-surrogate` | `warning` | A surrogate escape without its pair, as in `"\u{d800}"` |
| `lexer` | `integer-literal-unnecessary-decimal` | `warning` | `1.0L` |
| `lexer` | `integer-literal-decimal` | `warning` | `1.5L` |
| `lexer` | `integer-literal-non-integer` | `warning` | `1e-3L`, `100000000000L` |

The `pipe-*` and `lexer` messages are R's own, without R's location suffix. Raven's parser accepts a few other things R rejects, so an empty `errors` list doesn't promise that R parses the file.

An `error` entry is one R's parser stops at. The statement holding it is a single `unparsed` node with its `text` and `range`, and the statements before and after it are reported as usual. Inside a block, the `unparsed` statement is the innermost one holding the error, so an enclosing function or `if` keeps its tree. Warnings leave the tree as it is. Comments inside an `unparsed` statement are its `interior` comments, and their directives are still parsed, so an `ignore` on a broken line is seen.

Raven's parser recovers from a syntax error by skipping to where it can read code again, and that recovery sets the statement's span. When it can't find where the statement ends, as after an unclosed `(` or `{`, the `unparsed` node runs on to where recovery resumed, which can be several lines or the rest of the file.

<!-- example: parse-errors file=broken.R -->
```r
# raven: source helpers.R
x <- c(1 2) # raven: ignore
y <- 1.0L
```

<!-- example: parse-errors -->
```console
$ raven parse broken.R
{"schema_version":1,"raven_version":"0.23.8","path":"broken.R","encoding":{"name":"UTF-8","bom":false,"line_endings":"lf"},"package_data":{"enabled":false,"r_found":false,"names_db":false,"frozen":false},"line_count":3,"statements":[{"text":"x <- c(1 2)","range":{"start":{"line":1,"character":0},"end":{"line":1,"character":11}},"blank_line_before":false,"comments":{"leading":[{"kind":"comment","text":"# raven: source helpers.R","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":25}},"blank_line_before":false,"directive":{"kind":"forward","prefix":"raven","keyword":"source","honored":true,"reason":null,"call_type":"source","path":"helpers.R","line":null}}],"trailing":[{"kind":"comment","text":"# raven: ignore","range":{"start":{"line":1,"character":12},"end":{"line":1,"character":27}},"directive":{"kind":"suppression","prefix":"raven","keyword":"ignore","honored":true,"reason":null,"family":"ignore","scope":"line","codes":[],"target":{"start":{"line":1,"character":0},"end":{"line":1,"character":27}}}}],"interior":[]},"expression":{"kind":"unparsed","range":{"start":{"line":1,"character":0},"end":{"line":1,"character":11}},"text":"x <- c(1 2)"}},{"text":"y <- 1.0L","range":{"start":{"line":2,"character":0},"end":{"line":2,"character":9}},"blank_line_before":false,"comments":{"leading":[],"trailing":[],"interior":[]},"expression":{"kind":"assignment","range":{"start":{"line":2,"character":0},"end":{"line":2,"character":9}},"op":"<-","target":{"kind":"identifier","range":{"start":{"line":2,"character":0},"end":{"line":2,"character":1}},"text":"y","name":"y","form":"plain"},"value":{"kind":"number","range":{"start":{"line":2,"character":5},"end":{"line":2,"character":9}},"text":"1.0L","type":"integer","value":1}}}],"comments":[],"errors":[{"source":"parser","code":"syntax-error","severity":"error","message":"R code could not be parsed here","range":{"start":{"line":1,"character":7},"end":{"line":1,"character":8}}},{"source":"lexer","code":"integer-literal-unnecessary-decimal","severity":"warning","message":"integer literal 1.0L contains unnecessary decimal point","range":{"start":{"line":2,"character":5},"end":{"line":2,"character":9}}}]}
```

## `raven console`

An R console with syntax highlighting, multi-line editing, Tab completion, and colored output. It runs the same R as typing `R` would (the `R` on your `PATH`, or `R_HOME`), embedded in its own process. It is the default R console in Raven's VS Code extension; see [R Console](r-console.md#ravens-console) for how it behaves. On Windows it needs R 4.2 or later, and also finds R through the registry.

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
| `--ipc PATH` | Also accept code from an editor on this local socket |
| `--dap PATH` | Serve the R [debugger](debugger.md) (Debug Adapter Protocol) on this local socket |

On Unix, `--ipc` and `--dap` sockets are Unix sockets at `PATH`. On Windows they are named pipes named after `PATH` (`\\.\pipe\raven-` followed by `PATH` with every character other than letters, digits, `.`, `_` and `-` replaced by `-`), and the console creates an empty file at `PATH` once the pipe is listening. A `PATH` that already starts with `\\.\pipe\` is used as the pipe name.

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
