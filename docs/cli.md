# CLI

Raven ships a single binary that serves the LSP via stdio *and* exposes subcommands for use outside an editor. The user-facing commands fall into two groups:

**Check code**

- `raven check` — index a workspace and report the **full** diagnostic set (the same diagnostics the editor publishes), for CI gating.
- `raven lint` — run the native **style** linter only.

The difference between `check` and `lint` is **scope**: `lint` parses each file in isolation and runs only the style rules, so it never needs R or a workspace index — but it can't see relationships between files. `check` builds the same workspace index the language server builds, so it additionally reports cross-file, undefined-variable, and package diagnostics. It can run without R, using embedded base/recommended coverage plus any package metadata files you provide; when R is available, it also reads the local R libraries for exact installed-package exports and base R symbols. `lint` is therefore the cheaper option for pure style gating; `check` does more work per run in exchange for the editor's full analysis in CI.

**Manage package metadata**

These commands make `raven check` easier to run in CI systems such as GitHub Actions or Bitbucket Pipelines when the job does not install R, or when R is present but some project packages are missing. They provide package export metadata outside the local R library, so automated pull-request checks can still recognize symbols from attached packages without paying the full package-install cost on every run.

- `raven packages freeze` — generate a committed `.raven/packages.json` export database. This is the reproducible, project-specific path for CI: it captures the exports your installed project dependencies expose and should be committed when you need version-pinned package metadata. Choose its scope with `--used` (default — only the packages the repo uses) or `--installed`/`--all` (every installed package). See [`raven packages freeze`](#raven-packages-freeze) and [Package database](package-database.md).
- `raven packages fetch` — produce the same `.raven/packages.json` from CRAN/Bioconductor r-universe instead of a local R install. Needs no R, no installed packages, and no dependency on the `names-db` Release. See [`raven packages fetch`](#raven-packages-fetch) and [Package database](package-database.md).
- `raven packages update` — download the CRAN/Bioconductor metadata Raven uses to recognize symbols from packages that are not installed. Useful after `cargo install --git` or a local source build, which install only the executable. See [`raven packages update`](#raven-packages-update).

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

`raven check` auto-detects R on `PATH` to resolve installed-package exports and exact local metadata (it runs `.libPaths()` and parses package `NAMESPACE` files, the same as the language server). It honors the same `raven.toml` package settings the editor does: `packages.enabled = false` disables R detection entirely (no R subprocess and no installed/local package diagnostics — matching the editor), `packages.rPath` selects the R binary instead of `PATH` auto-detection, and `packages.additionalLibraryPaths` adds extra library directories to the search path. If R is not found, `library()` calls aren't checked against installed packages, but base/recommended R platform symbols still have embedded fallback coverage. Broad CRAN/Bioconductor coverage without R comes from Raven's package metadata files (`names.db` and `base-exports.json`): release archives, VSIX installs, and package-manager builds ship them; installs that produce only the `raven` executable, such as `cargo install --git` or local source builds, need `raven packages update` or manually installed metadata files. A one-line note is printed to stderr when R is absent. All other diagnostics still run.

Before reporting, `raven check` warms the export cache for the packages each reported file attaches with `library()` / `require()`, so a bare call into an attached package that isn't one of its exports is flagged the same way the editor flags it. One narrow gap remains: a package attached only *indirectly* — in a `source()`d file rather than in the reported file itself — is not pre-warmed, so calls that could resolve to such a package are left unflagged rather than risk a false positive. Attach the package directly in the file (or rely on the editor) if you need those calls checked.

### Missing-package reporting in CI

`raven check` resolves package **export names** through an ordered three-tier fallback — installed packages, then a committed `.raven/packages.json`, then Raven's broad CRAN/Bioconductor metadata when available — so symbols from attached packages can resolve even when no R is installed. Release archives, VSIX installs, and package-manager builds ship that metadata next to the Raven executable. Installs that produce only the `raven` executable, such as `cargo install --git` or local source builds, need an explicit `raven packages update` step for broad CRAN/Bioconductor coverage, though they still include embedded base/recommended R platform coverage. This stops the undefined-variable storm that otherwise makes Raven unusable in CI. See [Package database](package-database.md).

Knowing a package's exports is **separate** from knowing whether it is installed. The **missing-package** diagnostic answers a different question — *"will `library(X)` succeed at runtime?"*, i.e. is `X` installed? — so it stays **Tier-1-only**: it is driven solely by what is present in the local library paths, never by the export database. Because CI deliberately omits package installation, `raven check` **suppresses missing-package warnings by default**.

`--report-uninstalled` re-enables them. Reach for it whenever a `library(X)` call must really succeed at runtime: a pipeline that *does* install packages (e.g. `renv::restore()`) and wants to fail if any didn't, **or** any CI that **actually runs your R scripts** after `raven check` (e.g. R-package CI), where an uninstalled package is a genuine failure rather than CI noise. Gate-only CI that never executes the scripts wants the default (suppressed). It reports `library()` calls **not present in the local library paths** — **not** relative to the Tier 2/Tier 3 export metadata. One consequence: with the default off, a genuine typo such as `library(dpylr)` is silent (no tier knows it, but `raven check` isn't checking install status); it is reported only with `--report-uninstalled`. The language server is unchanged — it still fires missing-package whenever install state is known. See [Diagnostics](diagnostics.md#package-names-vs-install-status) for the full model.

### Four ways to run `raven check` in CI

There are four strategies for giving `raven check` package-export coverage in CI. Each trades off differently on R requirements, network use, coverage breadth, and version fidelity:

1. **R + packages installed** — install R and the project's packages in CI (e.g. `renv::restore()`). Exact, full coverage; version-exact; no dependency on external databases.
2. **`raven packages update`** before `raven check` — downloads broad CRAN/Bioconductor metadata from the `names-db` GitHub Release. No R needed; broad coverage; but depends on a maintainer-owned Release and tracks latest (not pinned).
3. **`raven packages fetch [--missing-only]`** before `raven check` — fetches only the project's used packages from r-universe. No R needed; no dependency on the `names-db` Release; latest exports (installed rows are version-exact under `--missing-only`). If R is unavailable in CI, `--missing-only` is a no-op and this equals plain `raven packages fetch`.
4. **`raven packages freeze`** locally + commit `.raven/packages.json` — run on a machine with R and packages installed, commit the result. No R or network needed in CI; version-exact; project-pinned.

| Strategy | Needs R in CI | Network in CI | Coverage | Version fidelity | Committed | Depends on `names-db` Release |
|---|---|---|---|---|---|---|
| 1. R + packages installed | yes | (install) | exact, full | version-exact | no | no |
| 2. `packages update` | no | yes (2 files) | whole ecosystem | latest snapshot | no | **yes** |
| 3. `packages fetch [--missing-only]` | no | yes (per-pkg) | project's used set | latest (installed rows exact under `--missing-only`) | no (ephemeral) | no |
| 4. `freeze` + commit | no (in CI) | no | project's used set | version-exact | yes | no |

Strategies 3 and 4 can be combined: commit a `freeze` file for version-exact coverage of installed packages, then run `fetch` in CI to top up whatever `freeze` missed — `fetch`'s additive merge preserves every `freeze` row untouched.

See [`raven packages fetch`](#raven-packages-fetch), [`raven packages freeze`](#raven-packages-freeze), and [Package database](package-database.md) for details.

### File encoding

Source files must be UTF-8. A UTF-8 byte-order mark is stripped and BOM-marked UTF-16 (LE/BE) is decoded, but anything else must already be valid UTF-8 — Raven does not guess legacy single-byte encodings (Latin-1 / Windows-1252). Guessing would silently mis-decode: a non-breaking space (`0xA0`) inside a string comparison, for instance, would read as an ordinary space and quietly change what your code matches. A *reported* file that isn't valid UTF-8 is therefore flagged as an **error diagnostic** (`File is not valid UTF-8: first invalid byte 0x… at offset …`) that fails the build like any other error finding — it is **not** an operator error. Re-save the file as UTF-8 to fix it. A file that is only *indexed* for cross-file resolution (not itself reported) and can't be decoded is silently skipped, matching the editor. `raven lint` reads through the same decoder, so encoding handling is uniform across the user-facing CLI.

### Exit codes

- `0` — no diagnostic exceeded `--max-severity`.
- `1` — at least one diagnostic exceeded `--max-severity`. An unknown flag is a usage error and also exits `1`. A reported file that isn't valid UTF-8 is an error diagnostic, so it also exits `1`.
- `2` — operator error detected while running (config parse failure, an I/O failure reading a path, invalid workspace). A *readable* but mis-encoded file is a finding (exit `1`), not an operator error.

### GitHub Actions example

```yaml
- name: Check R sources
  run: |
    cargo install --git https://github.com/jbearak/raven raven
    raven packages update
    raven check --format sarif > raven.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: raven.sarif
```

For reproducible CI, commit `.raven/packages.json` generated by `raven packages freeze`. `raven packages update` restores broad CRAN/Bioconductor coverage for zero-adoption scans, but it follows the moving `names-db` Release and is not version-pinned by the project.

To get installed/local package awareness and exact local package metadata in CI, install R (e.g. `r-lib/actions/setup-r`) before running `raven check`. Base/recommended R platform symbols have embedded fallback coverage even without R. Broad CRAN/Bioconductor coverage requires Raven's package metadata files (`names.db` and `base-exports.json`), either shipped next to the executable or installed by `raven packages update`. If you installed Raven with `cargo install --git` or from a local source build, run that update during CI image setup or cache warmup so normal `raven check`, LSP startup, completion, hover, and package lookup stay network-free.

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

A command group for the export databases Raven uses to resolve package symbols without installing packages. See [Package database](package-database.md) for the full three-tier model. Both `freeze` and `fetch` are **producers** of the Tier 2 `.raven/packages.json` — `freeze` captures exports from a local R install (version-exact, committed), while `fetch` sources them from CRAN/Bioconductor r-universe (latest, ephemeral). `update` downloads broad CRAN/Bioconductor metadata for installs that did not bundle it, and `build-shipped-db` is the maintainer-only command that produces the bundled metadata.

**Top-level aliases.** `raven freeze [ARGS]` is exactly equivalent to `raven packages freeze [ARGS]`, and `raven fetch [ARGS]` to `raven packages fetch [ARGS]`. They are thin routing aliases — same parsing, same handler, same help. Only `freeze` and `fetch` are aliased; `update` and `build-shipped-db` stay nested.

### `raven packages fetch`

Produce a `.raven/packages.json` from CRAN/Bioconductor r-universe — the same Tier 2 artifact `freeze` produces, but sourced from community infrastructure instead of a local R install. It needs no R, no installed packages, and no dependency on the `names-db` GitHub Release. The file is an **ephemeral CI artifact** meant to be regenerated each run; gitignore it rather than committing it (contrast with `freeze`'s committed, version-pinned file).

```text
raven packages fetch [OPTIONS]
```

**Two modes:**

- **Plain `raven packages fetch`** — computes the used set (R-free: tree-sitter scan ∪ `DESCRIPTION` `Depends`/`Imports` ∪ `renv.lock` names ∪ transitive `Depends` from r-universe), skips base/recommended packages (known offline via the embedded base set), and fetches the rest from r-universe. No R required.
- **`raven packages fetch --missing-only`** — a pure optimization. When R is present with a populated library, it subtracts already-installed packages from the fetch set (they will resolve via Tier 1 in the same CI run). When R is absent or `.libPaths()` is empty, nothing is subtracted and `--missing-only` degrades to a full fetch. It is **never an error** to pass `--missing-only` without R.

#### Options

- `--missing-only` — subtract already-installed packages from the fetch set. No-op without R (degrades to a full fetch).
- `--fail-on-missing` — exit non-zero if any used package resolved nowhere (after writing the file). By default, unresolvable packages produce warnings and a success exit.
- `--output PATH` — where to write/merge (default: `.raven/packages.json` at the workspace root).
- `--workspace DIR` — workspace root to scan for usage and config (default: current directory).
- `--base-urls URL[,URL]` — override the ordered r-universe host list (for testing); each URL must include the scheme. Default: `https://cran.r-universe.dev,https://bioc.r-universe.dev`.
- `--help` — usage.

#### Additive merge — existing records always win

`fetch` reads any existing `.raven/packages.json` at the target path and **preserves every record in it untouched**, adding records only for used packages not already present. It does not even refetch a package the existing file already covers. Run after `freeze`, it tops up coverage for whatever `freeze` missed (e.g. uninstalled packages) without disturbing a single `freeze` row. When the merge produces content identical to the existing file, `fetch` leaves the file untouched and prints "no changes."

A corrupt or unsupported-schema existing file is surfaced as an error and the command refuses — it won't silently discard a file you may need. Delete it or point `--output` elsewhere.

#### Output and warnings

- An **inform** line names the packages about to be downloaded.
- Per-package **warnings** for packages that resolve nowhere on r-universe (GitHub-only, internal, not-yet-indexed, or typos like `library(dpylr)`).
- A **renv.lock version-skew warning** when the fetched record's version differs from the version `renv.lock` pins. r-universe serves latest only — it does not archive old versions — so `fetch` cannot pull the exact pinned version. The warning names both versions and points at `freeze` / `--missing-only` for a version-exact capture. Export names are usually stable across versions, so this is a soft heads-up, never an error, and never gated by `--fail-on-missing`.

#### `--fail-on-missing`

By default, packages that resolve nowhere produce warnings and a success exit. With `--fail-on-missing`, a non-empty resolved-nowhere set makes the command exit non-zero **after** writing the file (so partial results are still available). Suppression of expected-missing private/internal packages is a planned fast-follow; v1 warns them every run.

#### Gitignore guidance

The fetched file is an ephemeral CI artifact — regenerated each run from the latest r-universe exports. **Gitignore it** (add `.raven/packages.json` to `.gitignore`) rather than committing it. A user *may* commit it, but that is not the design target: for a committed, version-pinned artifact, use `freeze` instead.

#### Network and atomicity

Fetches via curl with bounded concurrency, trying CRAN then Bioconductor per package. Writes atomically (temp-then-rename) so a mid-fetch failure cannot feed a half-written file to `raven check`. If every fetch fails at the transport level (network down / curl missing), the command reports the failure and writes nothing — any existing file is left intact. A partial failure writes what it got and warns about the rest.

#### Scope limits

Two honest limits:

1. `fetch` does **not** replace Tier 3's zero-adoption, whole-ecosystem floor — it covers only packages the project references (the "used set").
2. `fetch` is **not** fully self-contained — base/recommended packages are not on r-universe and still come from local R or the embedded fallback at analysis time.

### `raven packages freeze`

Generate a committed, repo-specific `.raven/packages.json` — a "frozen Tier 1" snapshot of your installed packages' export names, `Depends`, and datasets. This is Raven's reproducible CI path: run it on a machine that has R and the project's packages installed, then commit the result so CI uses project-pinned package metadata. Raven's bundled or updated CRAN/Bioconductor metadata provides broad ecosystem coverage when available, but this committed snapshot **improves accuracy** for packages the broad metadata doesn't cover (GitHub-only or internal packages) and for symbols newer than the metadata snapshot. The file is generated, never hand-edited.

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

### `raven packages update`

Downloads the CRAN/Bioconductor metadata files Raven uses to recognize package symbols when the packages are not installed (`names.db` and `base-exports.json`) from the `names-db` GitHub Release into Raven's user data directory. Use this when your install only provided the `raven` executable, such as `cargo install --git` or a local source build. Release archives, VSIX installs, and package-manager builds normally ship these files next to the executable. This command is the explicit network boundary for package metadata: `raven check`, LSP startup, completion, hover, and normal package lookup do not fetch it.

Use it during CI image setup or cache warmup when installing Raven from source:

```sh
cargo install --git https://github.com/jbearak/raven raven
raven packages update
raven check --format sarif > raven.sarif
```

For reproducible CI, commit `.raven/packages.json` generated by `raven packages freeze`. `raven packages update` restores broad CRAN/Bioconductor coverage for zero-adoption scans, but it follows the moving `names-db` Release and is not version-pinned by the project.

### `raven packages build-shipped-db`

**Maintainer / CI-only — most users never run this.** Builds Raven's Tier 3 `names.db` sidecar (and its companion base-exports file). The shipped binary is **network-free**: this command transforms r-universe JSON that the build workflow has already downloaded with `curl`, merging it **append-only** over an authoritative reference-R capture of the build machine's installed library. The result is published to the `names-db` GitHub Release and bundled next to the binary and into the VSIX. See [Package database](package-database.md#tier-3--sidecar-namesdb) and [development.md](development.md#tier-3-build-pipeline) for the build pipeline.

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
