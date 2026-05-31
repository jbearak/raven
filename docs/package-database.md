# Package database

> **Status: planned.** Describes the CI package-exports database, in active development; not yet in a released build. Tracking: the package-database work (and prerequisite [raven#350](https://github.com/jbearak/raven/issues/350)).

Raven resolves the symbols a package exports so it can offer completions, hover, and — most importantly — avoid flagging every package function as an undefined variable. Normally it reads that information from the package as installed on your machine. But in CI there is often **no R and no installed packages**: `.libPaths()` is empty, so every `library(pkg)` would fire a missing-package warning and every symbol from a package would show as undefined. That makes Raven effectively unusable in CI.

The package database fixes this by giving Raven a pre-built source of export **names** that needs neither R nor installed packages at analysis time. Resolution becomes an **ordered fallback over three tiers**, consulted per package only when the package isn't already resolved.

## The three tiers

| Tier | When it applies | Source | Fidelity |
|---|---|---|---|
| **1 — Installed** | Package found in a local library path (R only affects `exportPattern` fidelity, not whether Tier 1 applies) | The existing on-disk path: static `NAMESPACE` parse + an R subprocess to expand `exportPattern` (or the `INDEX` approximation when R is absent) | Authoritative, version-exact to the install |
| **2 — Repo DB** | No package directory found on disk (e.g. CI with an empty `.libPaths()`) | A repo-specific, committed `.raven/packages.json` you generate locally | "Frozen Tier 1": full structure, version-exact to when it was generated |
| **3 — Shipped DB** | Otherwise (no Tier 1 directory and no Tier 2 record) | A Raven-bundled `names.db`: a reference-R capture ∪ CRAN + Bioconductor (via r-universe), merged **append-only** into a version-monotonic union | Highest version per package; exports + `Depends` + datasets (no `:::`/signatures) |

The fallback trigger is a **missing package directory**, never a missing R: the tiers below Tier 1 are consulted only when the package isn't found on disk at all. A package that *is* installed still resolves from Tier 1 even with no R — its `exportPattern` exports just degrade to the `INDEX` approximation. **Tier 2 outranks Tier 3** because it is project-specific and built through the authoritative path. A repo that never generates a Tier 2 file still works in CI via Tier 3 alone — the bundled floor (subject to the [drift caveat](#fidelity-caveats) below). The two databases share one in-memory model, one reader, and one writer.

The tiers are a **floor, never a replacement**: whenever a package resolves from a real local install (Tier 1), that path stays in charge and is version-exact. Nothing here regresses behavior when packages *are* installed.

> **Export names, not install status.** The database suppresses undefined-variable noise; it never makes a package count as *installed*. The missing-package diagnostic stays Tier-1-only and is **off by default in `raven check`**. See [Names vs. install status](#names-vs-install-status) below.

## Tier 2 — the committed `.raven/packages.json`

A repo-specific snapshot, generated on a machine that has R and the project's packages installed, and **committed to the repo**. Because it is produced through Raven's authoritative path, it is effectively *frozen Tier 1*: it captures the full structure — exports (with `exportPattern` correctly expanded), `Depends`, datasets, and meta-package attaches.

**Why generate one at all?** You get package-aware diagnostics in CI **regardless** — the bundled Tier 3 database is always there. A Tier 2 file isn't how you turn diagnostics on; it makes them *more accurate* in two cases: (1) your repo uses packages whose exports **aren't shipped** in Raven's bundled database (GitHub-only, internal, or not-yet-indexed packages), and (2) you pin package versions whose exports **differ** from the versions Tier 3 captured, in ways that could change diagnostics (the [drift caveat](#fidelity-caveats) below). If neither applies, Tier 3 alone is enough and you don't need to run `freeze`.

- **Opt-in.** It exists only if you run the generation command; Raven never auto-creates it.
- **Location.** `.raven/packages.json` at the repo root, auto-discovered like `raven.toml` / `.lintr`.
- **Format.** Sorted, deterministic, diff-friendly JSON — generated, **not hand-edited**, and meant to be reviewed in PRs, so a `git diff` reads as "package Y gained export X." Each record also stores the package **version**, so a dependency bump reads as "dplyr 1.1.0 → 1.1.4."
- **Provenance.** Records the generator Raven version, the R version, and the generation date — for debuggability only. There is **no drift-detection machinery**: no lockfile-hash comparison and no "snapshot is stale" diagnostic. Export names are stable; regeneration is a manual command you run when you choose.

### Generating it

```bash
raven packages freeze
```

In VS Code, the same generation runs from the command palette as **Raven: Generate Package Database for CI** — one implementation, two entry points. See [`raven packages freeze`](cli.md#raven-packages-freeze) for all options. Generation resolves each package from a **renv-first** library order (the renv project library first, system libraries only for what renv doesn't cover), so "renv wins, system fills the gaps" happens automatically.

The default `--used` scope is **maximally inclusive** — over-inclusion is free, because the capture simply skips anything not actually installed. The "used" set is:

- packages referenced via `library`/`require`/`loadNamespace`/`requireNamespace`, **∪**
- the left-hand side of `::` / `:::` references, **∪**
- everything listed in `renv.lock`, **∪**
- the repo's own `DESCRIPTION` `Depends` / `Imports`, **∪**
- their transitive `Depends`.

(`LinkingTo` is excluded — it is C-level and has no R exports. For a `:::` reference, the *package's exports* are still frozen; only the internal-object names are out of scope.) Use `--installed` / `--all` to capture every package across the renv + system libraries instead.

`renv.lock` is a **set selector** — it decides *which* packages to include (a locked package is included even if no script calls it), **not** which version to read; exports always come from whatever is installed locally. A locked package that isn't installed can't be captured and falls through to Tier 3 in CI. Best coverage therefore comes from generating after `renv::restore()`, but nothing breaks otherwise.

### Regeneration is a no-op when unchanged

If a `.raven/packages.json` already exists, `freeze` compares **package content only** (ignoring provenance such as the timestamp). When the content is identical it leaves the file untouched and prints "no changes" — so a regeneration that found nothing new produces a **zero-line diff**, and the provenance timestamp moves only when the captured exports actually changed.

### Version skew is explained, not silently dropped

If a committed `.raven/packages.json` was written by a **newer** Raven than the one reading it (an incompatible schema), Raven does not silently ignore it. It **explains and continues**: `raven check` prints a specific note to stderr, the language server raises a notification, and resolution degrades to the bundled database (Tier 3). The message tells you to upgrade Raven here or regenerate the file with `raven packages freeze`. An unreadable or corrupt file is reported the same way. A missing file is normal and silent.

## Tier 3 — bundled `names.db`

A Raven-bundled, latest-CRAN/Bioc export database — the R-free floor that works with no setup at all.

- **Source.** An authoritative **reference-R capture of the build machine's entire installed library** (via Raven's Tier-1 path) **∪** **CRAN + Bioconductor** from [r-universe](https://r-universe.dev) (`cran.r-universe.dev` and `bioc.r-universe.dev`). r-universe's `_exports` is the *true post-load namespace export set* — `exportPattern()` already expanded — for the whole ecosystem. The sources are merged **append-only and monotonically**: each rebuild **seeds from the previous database by default**, merges in the reference-R capture and r-universe, and **never drops** a package. When more than one source carries a package, the merge keeps the record with the **highest version** — comparing all three (the prior database, the build machine's install, and the latest CRAN/Bioc) — so a package is never moved to an older export set: a newer CRAN/Bioc release overrides an older installed copy, a newer local build overrides an older CRAN release, and a still-newer version already in the database is kept. (Each record stores its package version for this comparison.)
- **Why the full installed library.** Hard-to-install, GitHub-only, internal, or fallback-built packages are absent from CRAN/Bioc and only ever enter the floor through the reference-R capture; append-only guarantees they're never lost on later rebuilds. The maintainer **bootstraps** the floor once from a richly-provisioned machine, after which automated runs seed from it and append. Teams can likewise build a private `names.db` from their own library for richer in-house coverage (point Raven at it with `RAVEN_NAMES_DB`).
- **Contents.** Export names + `Depends` + dataset names. **Export-only** — no internal (`:::`) objects, no signatures.
- **Delivery.** A sidecar file shipped with both the standalone binary and the VS Code extension, located next to the executable (override with the `RAVEN_NAMES_DB` environment variable). It is **not** compiled into the binary (which would bloat it) and **not** committed to git. It lives on a **GitHub Release** (a moving `names-db` tag) — a durable URL, unlike a per-run CI artifact — alongside the base-exports file and their checksums.
- **Integrity & provenance.** The build records its source, snapshot date, package count, and Raven version in the database header, plus a [`blake3`](https://github.com/BLAKE3-team/BLAKE3) checksum of the payload that is verified when the file is opened. Bundling third-party data carries supply-chain responsibility, so provenance and a tamper check are part of the pipeline.
- **Freshness.** Equals Raven's release/refresh cadence — a rebuild on each release plus on-demand rebuilds; the **exact refresh interval is not yet committed**. Acceptable because the database tracks the latest CRAN/Bioc and export names are stable; append-only means coverage only ever grows.
- **Growth bound.** Because the merge is append-only, `names.db` grows monotonically — but slowly: at CRAN's ~2k-packages-per-year rate the file gains only ~1.7 MB/year, so a ~20–25 MB database is still well under ~40 MB a decade out. Names-only storage keeps the bound comfortable; no pruning is planned.

A stale or corrupt `names.db` (for example a custom `RAVEN_NAMES_DB` from an incompatible Raven) is **explained and skipped**, exactly like a version-skewed Tier 2 file — Raven never hard-fails over it.

## Base packages and datasets

Base and recommended packages (**base**, **methods**, **utils**, **stats**, **datasets**, …) are normally read from your R installation. In CI without R they aren't on disk, so Raven ships a separate **base-exports file** (built from the same reference R) that populates base symbols when the base packages are absent. Base **datasets** — `mtcars`, `iris`, and the like — are merged in exactly as the on-disk path does, so they resolve in CI too. A real R install still wins: the file is only consulted when the base packages aren't found locally.

**Non-base package datasets** (e.g. `flights` from **nycflights13**, `diamonds` from **ggplot2**) are captured as `lazy_data` in every tier's records. Resolving them as symbols is handled by [raven#350](https://github.com/jbearak/raven/issues/350) (the package-dataset / lazy-data resolution mechanism, already landed): once a record carries its datasets, that path folds them into the resolvable set automatically — so package datasets resolve in CI with no extra work here.

## Names vs. install status

Knowing a package's exports is deliberately **separate** from knowing whether it is installed:

- **Export resolution** (suppresses undefined-variable noise) uses all three tiers, in every mode.
- **Install status** (drives the *missing-package* diagnostic) is **Tier 1 only** — it reflects what is present in the local library paths, never the database.

In CI, `raven check` **suppresses missing-package warnings by default** (CI deliberately omits installation); re-enable them with [`--report-uninstalled`](cli.md#missing-package-reporting-in-ci), which reports `library()` calls not present in the local library paths — *not* relative to the database. One consequence is an **accepted gap**: a genuine typo such as `library(dpylr)` is silent by default — no tier knows it, but `raven check` isn't checking install status — and surfaces only under `--report-uninstalled`. The full per-mode behavior and this gap are documented in [Diagnostics](diagnostics.md#package-names-vs-install-status).

## Fidelity caveats

- **`exportPattern` → solved.** r-universe `_exports` is the post-load truth, so the minority of packages whose exports require a built-and-loaded namespace are correct, including the `.onLoad` ∩ pattern corner. Tier 2, generated via `asNamespace()`, is equally correct.
- **Tier 3 tracks the latest CRAN/Bioc as of Raven's last database refresh.** Two soft drifts follow: (a) a just-removed export may linger until the next rebuild; (b) if your project uses a **newer** version of a package than Tier 3 captured, a symbol added in that newer version is unknown to Tier 3 and can surface as a **false-positive undefined-variable** diagnostic. Both are rare and soft — a project that needs exactness pins it via Tier 2 (`raven packages freeze`), which reads exports from the version actually installed.
- **Exports + `Depends` + datasets only.** Tiers 2 and 3 carry no `:::` internal objects and no function signatures (`formals`); those still come only from a local install (Tier 1/2 from a machine with the package). Signatures stay R-subprocess-only.
- **Bioconductor cadence** differs from CRAN, so the shipped latest snapshot may not match a project's Bioc release train. Tier 2 covers projects that need exactness.

## See also

- [`raven packages`](cli.md#raven-packages) — the `freeze` and `build-shipped-db` commands.
- [Diagnostics](diagnostics.md#package-names-vs-install-status) — names vs. install status, and the `raven check` default.
- [Cross-File & Package Awareness](cross-file.md#resolving-exports-without-r) — where the three-tier fallback sits in package resolution.
- [R Package Development](r-package-dev.md#generating-a-package-database-for-ci) — generating the repo database for a package project.
- [Development notes](development.md#package-export-databases-ci--r-free-resolution) — the internal architecture.
