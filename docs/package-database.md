# Package-Export Database for CI

> **Status: planned.** Describes the CI package-exports database, in active development; not yet in a released build. Tracking: the package-database work (and prerequisite [raven#350](https://github.com/jbearak/raven/issues/350)).

Raven uses package export names to avoid false undefined-variable diagnostics after `library()` / `require()` calls. The planned package-export database lets `raven check` use that package knowledge in CI without compiling or installing the project's R packages.

The database is a names database. It helps answer "does this package export this symbol?" It does not answer "is this package installed?"

## Resolution tiers

Package export resolution uses three tiers, in order:

| Tier | Source | Fidelity | Notes |
|---|---|---|---|
| **1 — Installed** | Local R libraries and base packages | Authoritative, version-exact to the local install | Existing Raven behavior. Reads installed `NAMESPACE`, `Depends`, datasets, and uses R subprocesses only when needed for `exportPattern()`. |
| **2 — Repo DB** | Committed `.raven/packages.json` | Frozen Tier 1, version-exact to generation time | Generated locally with `raven packages freeze`; outranks the bundled DB. |
| **3 — Bundled DB** | Raven sidecar `names.db` | Latest CRAN/Bioc floor, append-only | Bundled with Raven from the `names-db` GitHub Release; used when no installed package or repo DB record is available. |

Tier 2 intentionally outranks Tier 3. If your project commits `.raven/packages.json`, Raven prefers that project-specific snapshot over the latest-only bundled floor.

## Names are not installation status

The package database suppresses undefined-variable noise by providing export names. It never makes a package count as installed.

- **Export resolution:** installed packages → `.raven/packages.json` → bundled `names.db`.
- **Install status:** Tier 1 only, based on local library paths and base packages.

This distinction matters most in CI:

- The language server still reports a missing-package diagnostic when install state is known and the package is absent, even if Tier 2 or Tier 3 knows the package's exports.
- `raven check` suppresses missing-package diagnostics by default, because many CI jobs intentionally skip package installation.
- `raven check --report-uninstalled` re-enables missing-package diagnostics and reports `library()` calls whose packages are not present in the **local library paths**. It is not relative to `.raven/packages.json` or `names.db`.

Accepted gap: with missing-package diagnostics off by default in `raven check`, a typo such as `library(dpylr)` is silent unless `--report-uninstalled` is passed. A future mode may report packages unknown to every tier by default, but v1 documents and accepts this tradeoff.

## Committed repo database: `.raven/packages.json`

Use `raven packages freeze` on a machine that has the project packages installed:

```text
raven packages freeze [--used|--installed|--all] [--output PATH] [--workspace DIR]
```

The default output is `.raven/packages.json` at the workspace root. Commit it to the repo so CI can resolve package exports before falling back to the bundled database. The file is generated, sorted, deterministic, and intended to be reviewable in PRs; do not hand-edit it. It carries a `schema_version` so newer incompatible files can be explained instead of silently ignored.

Regeneration is a no-op when package content is unchanged. Raven compares package records while ignoring provenance-only changes, so rerunning the command should not create timestamp churn.

### Generation scopes

- `--used` (default) includes a maximally-inclusive package set:
  - `library()` and `require()` calls
  - `loadNamespace()` and `requireNamespace()` calls
  - the package side of `::` and `:::`
  - packages listed in `renv.lock`
  - the repo `DESCRIPTION` `Imports` and `Depends`
  - transitive `Depends`
- `--installed` and `--all` include every package found across the renv and system library paths.

The freeze path is provider-less: it captures installed Tier 1 metadata only. It must not fall through to an existing `.raven/packages.json` or the bundled `names.db`, because the repo DB is meant to be a frozen local install snapshot, not a copy of fallback guesses.

### renv-first library order

Generation uses the same renv-aware library discovery Raven already uses for package resolution. If the workspace has renv, Raven activates it before reading `.libPaths()`, takes packages from the renv project library first, and uses system libraries only to fill gaps.

`renv.lock` is a set selector, not a version oracle. A package listed in the lockfile is included in the `--used` set, but if that package is not installed locally, Raven cannot freeze its exports and CI will fall through to Tier 3 for that package. Run `renv::restore()` before `raven packages freeze` for best coverage.

### Options and editor entry point

- `--output PATH` writes somewhere other than `.raven/packages.json`.
- `--workspace DIR` sets the workspace root used for scanning scripts, `renv.lock`, and `DESCRIPTION`.
- The planned VS Code command is **Raven: Generate Package Database for CI**.

## Bundled database: `names.db`

The bundled database is a Raven-maintained floor, not a project lockfile. Raven ships it as an executable-relative sidecar file with the binary and VS Code extension. `RAVEN_NAMES_DB` can override the path for testing or custom deployments.

Runtime Raven never queries the network. Network access belongs to the maintainer/CI builder:

```text
raven packages build-shipped-db
```

The shipped DB is built from:

1. a reference-R capture of the build machine's **full installed library**, including base/recommended packages and any hard-to-install, GitHub-only, or internal packages installed there;
2. CRAN r-universe metadata; and
3. Bioconductor r-universe metadata.

The merge is append-only. Each rebuild starts from the prior `names.db`, overlays the reference-R capture, appends CRAN and Bioc r-universe records for packages not already present, and never drops retained packages. Precedence is reference-R over r-universe over retained-from-prior. A richly provisioned bootstrap machine gives the append-only floor its broadest coverage.

The resulting `names.db`, base-exports companion file, and checksums are published on a durable GitHub Release with the moving `names-db` tag. Release and VSIX packaging download that Release asset and place it next to the binary.

The binary format records provenance, snapshot date, package count, Raven version, and a `blake3` checksum. Raven verifies the checksum at open before using the payload. The refresh cadence is weekly plus Raven release builds; because Tier 3 is latest-only by design, projects that require exact package versions should generate and commit Tier 2.

## Base exports and datasets

Base symbols and base datasets need to resolve even when CI has no R installation. The planned bundle therefore includes a separate base-exports file built from the reference R. Raven uses it only when base packages are not present on disk; a real local R install still wins.

Package dataset resolution for non-base packages is provided by [raven#350](https://github.com/jbearak/raven/issues/350). The package database records carry `lazy_data`, so Tier 2 and Tier 3 feed the same dataset-resolution path once providers return package metadata.

## Unreadable or newer databases

Raven distinguishes an absent database from a present but unusable one:

- **Absent** — normal; silently continue to the next tier.
- **Unsupported schema/version** — explain that the DB was written by a newer or incompatible Raven, then continue to the next tier, normally the bundled DB.
- **Corrupt/unreadable** — explain the corruption or read failure, then continue to the next tier.

For `raven check`, these explanations go to stderr. In the language server, they surface as an editor notification. A bad repo DB should not hard-fail analysis; it should degrade predictably to the bundled DB or installed-package-only behavior.

## Fidelity caveats

- **`exportPattern()` is solved for database records.** Tier 2 is generated through Raven's authoritative installed-package path, and Tier 3 uses r-universe `_exports`, which is the post-load namespace export set with `exportPattern()` expanded.
- **Tier 3 is latest-only.** A just-removed export may linger until a project commits Tier 2, and a brand-new export may be missing until the next bundled DB refresh.
- **No `:::` internal-object resolution.** `raven packages freeze --used` records packages referenced on the left side of `:::` so their exports are frozen, but the database does not store internal object names.
- **No function signatures.** Signatures remain tied to local installed packages and R subprocess support; the package database is export-name and package-structure metadata.
- **Bioconductor cadence can differ from CRAN and from your project.** The bundled latest snapshot may not match a project's Bioc release train. Generate Tier 2 when Bioconductor-version exactness matters.
