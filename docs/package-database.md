# Package database

[Docs](README.md) › Understanding Raven

The package database lets Raven recognize functions from CRAN and Bioconductor packages when neither R nor the packages are installed, so `raven check` in CI doesn't report every package function as an undefined variable.

On your own machine, Raven reads package exports from the packages you have installed, and you don't need any of this. In CI there is often no R and no installed packages, so run one command before `raven check`:

```bash
raven packages update
```

| Your situation | Run | What Raven uses |
|---|---|---|
| R and the project's packages are installed | nothing | The installed packages |
| CI without R, and you want broad coverage | `raven packages update` | Downloaded export names for all of CRAN and Bioconductor |
| You want package names pinned to the versions you use | `raven packages freeze`, then commit `.raven/packages.json` | Your committed snapshot |
| CI without R, and you want only your project's packages | `raven packages fetch` | A snapshot built from r-universe for this run |

The database holds export **names** only. It suppresses false undefined-variable findings; it never makes a package count as *installed*. See [Names vs. install status](#names-vs-install-status).

<a id="the-three-tiers"></a>

## How Raven finds a package's exports

For each package, Raven tries three sources in order and stops at the first that has it:

1. **Installed.** The package's directory in a local library path. This is exact for the version you installed.
2. **Project snapshot.** A committed `.raven/packages.json` in your repository, made by `raven packages freeze` or `raven packages fetch`.
3. **Downloaded database.** `names.db`, which `raven packages update` downloads. It covers all of CRAN and Bioconductor.

Raven's other pages call these tier 1, tier 2, and tier 3. Base R packages are built into the binary and need none of these. The fallback starts only when a package's directory is missing, never merely because R is missing: an installed package still resolves from its directory even without R. Whenever a package resolves from a real local install, that install is used, so nothing changes when packages *are* installed.

A repository that never commits a snapshot still works in CI once `raven packages update` has run. Without it, Raven still knows base R, but not CRAN or Bioconductor packages.

<a id="tier-2--the-committed-ravenpackagesjson"></a>

## Commit a project snapshot

A snapshot is generated on a machine that has R and the project's packages installed, and committed to the repository. It captures exports (with `exportPattern()` correctly expanded), `Depends`, datasets, and meta-package attaches, read the same way Raven reads an installed package.

Commit one when CI should use package names from the versions your project actually installed. A snapshot makes diagnostics *more accurate* in two cases:

- Your repository uses packages that **aren't** in Raven's downloaded database: GitHub-only, internal, or not-yet-indexed packages.
- You pin package versions whose exports **differ** from the versions the downloaded database captured, in ways that change diagnostics (see [Limitations](#limitations)).

If neither applies, the downloaded database is present, and you don't need project-pinned reproducibility, `raven packages update` alone is enough.

### Generating it

```bash
raven packages freeze
```

In VS Code, **Raven: Generate Package Database for CI** in the Command Palette runs the same generation. See [`raven packages freeze`](cli.md#raven-packages-freeze) for every option.

- **Opt-in.** The file exists only if you run the command; Raven never creates it on its own.
- **Location.** `.raven/packages.json` at the repository root, found automatically like `raven.toml` and `.lintr`.
- **Format.** Sorted, deterministic JSON, generated and **not hand-edited**, meant to be reviewed in pull requests. A `git diff` reads as "package Y gained export X", and because each record stores the package **version**, a dependency bump reads as "dplyr 1.1.0 → 1.1.4."
- **Provenance.** The file records the Raven version, R version, and generation date, for debugging only. There is **no staleness check**: no lockfile-hash comparison and no "snapshot is stale" diagnostic. Export names are stable, and you regenerate when you choose.

<a id="regeneration-is-a-no-op-when-unchanged"></a>

If `.raven/packages.json` already exists, `freeze` compares **package content only**, ignoring provenance such as the timestamp. When the content is identical it leaves the file untouched and prints "no changes", so a regeneration that found nothing new produces a **zero-line diff**.

<a id="two-producers-one-artifact"></a>

### `freeze` or `fetch`

Two commands write `.raven/packages.json`, in the same format, and Raven reads both the same way:

- **`raven packages freeze`** reads exports from a local R install. It is version-exact and deterministic, meant to be committed and reviewed.
- **`raven packages fetch`** reads exports from CRAN/Bioconductor r-universe (`cran.r-universe.dev`, `bioc.r-universe.dev`). It needs no R, no installed packages, and no access to Raven's `names-db` Release. r-universe keeps only the latest version of each package, so the result isn't version-pinned. The file is meant to be regenerated each CI run and gitignored, not committed.

`fetch` only adds: it keeps every record in an existing file and adds records only for used packages not yet present. Run after `freeze`, it fills in whatever `freeze` missed (for example uninstalled packages) without changing any `freeze` record.

Because r-universe has only the latest version, `fetch` can't get the exact version `renv.lock` pins. When the fetched version differs from the locked one, `fetch` prints a warning naming both. Export names are usually stable across versions, so this is informational, never an error.

`fetch` covers only the project's used packages; it doesn't replace the downloaded database's coverage of the whole ecosystem. Base and recommended packages are not on r-universe, so at analysis time they still come from local R or from the built-in base data.

See [`raven packages fetch`](cli.md#raven-packages-fetch) for flags and [Choose where package names come from](ci.md#choose-where-package-names-come-from) for a comparison of the CI options.

<a id="version-skew-is-explained-not-silently-dropped"></a>

### When the snapshot can't be read

If a committed `.raven/packages.json` was written by a **newer** Raven than the one reading it, Raven explains the problem and continues. `raven check` prints a note (with the diagnostics on stdout for `text` output, or on stderr for `json`/`sarif`; see [Output streams](cli.md#output-streams)), the language server shows a notification, and Raven falls back to the downloaded database when one is available. The message tells you to upgrade Raven or regenerate the file with `raven packages freeze`. An unreadable or corrupt file is reported the same way. A missing file is normal and silent.

## Names vs. install status

Knowing a package's exports is deliberately **separate** from knowing whether it is installed:

- **Export names**, which prevent false undefined-variable findings, come from all three sources.
- **Install status**, which drives the *missing-package* diagnostic, comes only from installed packages in the local library paths, never from a database.

In CI, `raven check` **suppresses missing-package warnings by default**, because CI usually skips installation. Turn them back on with [`--report-uninstalled`](cli.md#missing-package-reporting-in-ci), which reports `library()` calls for packages missing from the local library paths, regardless of the databases. One consequence is a known gap: a genuine typo such as `library(dpylr)` is silent by default, because no source knows it and `raven check` isn't checking install status. It shows up only with `--report-uninstalled`. The full behavior is in [Diagnostics](diagnostics.md#package-names-vs-install-status).

## Limitations

<a id="fidelity-caveats"></a>

- **The downloaded database tracks the latest CRAN and Bioconductor versions as of its last refresh.** It is present only after `raven packages update` or a manually installed database file. Two small drifts follow. A just-removed export may linger until the next rebuild. And if your project uses a **newer** version of a package than the database captured, a symbol added in that version is unknown and can produce a **false undefined-variable** finding. Both are rare; a project that needs exactness commits a snapshot with `raven packages freeze`, which reads exports from the installed version.
- **Bioconductor** releases on a different schedule from CRAN, so the downloaded database may not match a project's Bioconductor release. A snapshot covers projects that need exactness.
- **Exports, `Depends`, and datasets only.** Snapshots and the downloaded database carry no internal (`:::`) objects and no function signatures. Those come only from an installed package.
- **`exportPattern()`** exports are correct in both the downloaded database (r-universe reports the namespace's real exports after loading) and snapshots (generated by loading the namespace). For an installed package without R, `exportPattern()` exports fall back to an approximation from the package's `INDEX` file.
- **S4 export directives.** Raven reads `exportMethods` and `exportClasses` from an installed package's `NAMESPACE` as plain exports, matching `getNamespaceExports()`. This matters for S4-heavy packages (for example the retiring spatial stack `sp`, `maptools`, `rgeos`) that export symbols *only* this way; without it, symbols like `spTransform` and `spRbind` would be reported as undefined. `exportClassPattern` is treated like `exportPattern`, with the same best-effort `INDEX` fallback when R is absent.

## Details

<a id="tier-3--namesdb-database"></a>

### The downloaded database (`names.db`)

`names.db` covers CRAN, Bioconductor, and recommended packages. It is **not** bundled with the binary: install it with [`raven packages update`](cli.md#raven-packages-update), or point the `RAVEN_NAMES_DB` environment variable at your own copy.

<details markdown="1">
<summary>How <code>names.db</code> is built, delivered, and checked</summary>

- **Source.** A capture of the build machine's entire installed library, read the same way Raven reads installed packages, combined with CRAN and Bioconductor from [r-universe](https://r-universe.dev) (`cran.r-universe.dev` and `bioc.r-universe.dev`). r-universe's export lists are the real namespace exports after loading, with `exportPattern()` already expanded, for the whole ecosystem.
- **Append-only merge.** Each rebuild starts from the previous database, merges in the library capture and r-universe, and **never drops** a package. When more than one source has a package, the merge keeps the record with the **highest version** among the previous database, the build machine's install, and the latest CRAN/Bioconductor release. A newer CRAN release overrides an older installed copy, a newer local build overrides an older CRAN release, and a still-newer version already in the database is kept.
- **Why the full installed library.** Hard-to-install, GitHub-only, internal, or fallback-built packages are absent from CRAN and Bioconductor and enter the database only through the library capture; append-only merging keeps them on later rebuilds. The maintainer seeded the database once from a well-provisioned machine, and automated runs add to it. Teams can build a private `names.db` from their own library for richer in-house coverage and point Raven at it with `RAVEN_NAMES_DB`.
- **Contents.** Export names, `Depends`, and dataset names. No internal (`:::`) objects and no signatures. The 14 base-priority packages are left out, because they are built into the binary.
- **Delivery.** A file downloaded by `raven packages update` into Raven's user data directory (override the location with `RAVEN_NAMES_DB`). It is not bundled with the binary, not compiled into it, and not committed to git. It lives on a GitHub Release (the moving `names-db` tag), alongside its checksums.
- **Integrity and provenance.** The build records its source, snapshot date, package count, and Raven version in the database header, plus a [`blake3`](https://github.com/BLAKE3-team/BLAKE3) checksum of the contents that is verified when the file is opened.
- **Freshness.** The database is rebuilt on each Raven release and on demand; the exact refresh interval is not fixed. Export names are stable, and append-only merging means coverage only grows.
- **Size.** Because nothing is removed, `names.db` grows, but slowly: at CRAN's rate of about 2,000 new packages a year it gains about 1.7 MB a year, so a 20 to 25 MB database stays well under 40 MB a decade out.

A stale or corrupt `names.db`, for example a custom `RAVEN_NAMES_DB` from an incompatible Raven, is explained and skipped, like an unreadable snapshot. Raven never stops over it.

</details>

### Data source and acknowledgement

The CRAN/Bioconductor portion of `names.db` is built from [r-universe](https://r-universe.dev), the package-build and metadata service maintained by [rOpenSci](https://ropensci.org/r-universe/) (with support from the R Consortium, the Moore Foundation, and Google Season of Docs). Raven gratefully acknowledges that work. To minimize load on their infrastructure, the build fetches **one bulk `/api/dbdump` per universe**, the metadata-dump endpoint r-universe documents for this purpose, rather than crawling packages one by one. It identifies itself with a descriptive `User-Agent` and runs no more than weekly. See [`scripts/build-names-db.sh`](https://github.com/jbearak/raven/blob/main/scripts/build-names-db.sh) and the [build pipeline notes](https://github.com/jbearak/raven/blob/main/docs/development.md#tier-3-build-pipeline).

<a id="base-packages-and-datasets"></a>

### Base packages and datasets

Base and recommended packages (`base`, `methods`, `utils`, `stats`, `datasets`, and so on) are normally read from your R installation. In CI without R they aren't on disk, so Raven uses base-package data built into the binary for all 14 of R's base-priority packages. Only the seven attached by default (`base`, `methods`, `utils`, `grDevices`, `graphics`, `stats`, `datasets`) are always in scope; the other seven (`compiler`, `grid`, `parallel`, `splines`, `stats4`, `tcltk`, `tools`) resolve offline after an explicit `library()` call.

Recommended packages such as `MASS`, `Matrix`, and `survival` are not built in; they come from `names.db` when it is present. Base **datasets** such as `mtcars` and `iris` come from the built-in `datasets` data, so they resolve in CI too. A real R install still wins: the built-in data is used only when the base packages aren't found locally.

<details markdown="1">
<summary>How package datasets are collected</summary>

**Non-base package datasets** (for example `flights` from `nycflights13` or `diamonds` from `ggplot2`) are recorded with each package's exports in every source, so they resolve in CI with no extra work.

When Raven reads an installed package, or generates a snapshot, the dataset list depends on the package:

- **LazyData packages** (`LazyData: true` in `DESCRIPTION`, identifiable by `data/Rdata.rdb`) store all data objects in a binary database, so their `data/` file names don't give a complete list. Raven asks R (`data(package = "pkg")$results`) for the dataset names. Without R, it falls back to the file names, with reduced accuracy: a package like `survival` may be missing unlisted datasets such as `lung`.
- **Non-LazyData packages** store individual `.rda` or `.RData` files in `data/`. Raven collects dataset names from those files and the `INDEX` file, with no R needed.

The library capture for `names.db` uses the same path, so it records complete dataset lists for LazyData packages when R is available at build time.

</details>

<a id="exports-completeness"></a>

### When Raven reports a missing `pkg::member`

The [`namespace-member-not-found`](diagnostics.md#namespace-member-references-pkgmember) diagnostic reports `pkg::member` only when Raven is sure it knows the package's complete export list.

<details markdown="1">
<summary>When an export list counts as complete</summary>

| Export list | Comes from | Missing member reported? |
|---|---|---|
| **Complete** | An installed `NAMESPACE` without `exportPattern()`/`exportClassPattern()`; R's `getNamespaceExports()`; a snapshot or `names.db` record; built-in base data. A package with a `data/` directory counts only when R listed its datasets. | Yes |
| **Partial** | The `INDEX` approximation (R absent for an `exportPattern()` package), or a package with `data/` whose datasets couldn't be listed without R. A binary `data/Rdata.rdb` exposes no object names, so a missing dataset can't be ruled out. | No |
| **Unknown** | Not yet loaded, or can't be resolved without R | No |

The check never starts R and never reads files while you type. A package referenced with `pkg::` or a static `box::use(package)` import is loaded in the background, and until that finishes the check stays silent rather than block typing. Static `box` imports use the same installed, snapshot, `names.db`, and built-in records for completion and selective attachment. Dataset names can confirm a member exists but never prove one absent.

Once a package's export list is complete, a later, less complete load (for example a reload without R) can only add data; it never makes a known-complete list partial again.

</details>

## See also

- [`raven packages`](cli.md#raven-packages): the `freeze`, `fetch`, and `update` commands.
- [Automated checks in CI](ci.md): CI templates and the strategy comparison.
- [Diagnostics](diagnostics.md#package-names-vs-install-status): names vs. install status, and the `raven check` default.
- [Cross-file analysis](cross-file.md#resolving-exports-without-r): where these sources fit in package resolution.
- [Package development](r-package-dev.md#generating-a-package-database-for-ci): generating a snapshot for a package project.
