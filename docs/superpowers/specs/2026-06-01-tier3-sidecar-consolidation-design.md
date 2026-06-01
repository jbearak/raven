# Tier 3 sidecar consolidation: embed base in the binary, keep one `names.db`

## Problem

Raven's R-free package-export floor ships as **two** Tier 3 sidecars next to the
executable: `names.db` (the broad CRAN/Bioconductor ecosystem) and
`base-exports.json` (base/recommended exports + base datasets). Having two files
adds complexity to every layer — the build, the `update` download, the bundling,
the packaging, and the docs — and the data is **already redundant**:
`build-shipped-db`'s reference-R capture enumerates the whole installed library
(base packages included), and `base-exports.json` is literally a filtered subset
of those same merged records (`write_base_exports_file` keeps only
`get_fallback_base_packages()`).

The two files differ only in **how they are consumed**, not in what they hold:

- `names.db` is consulted **lazily, per package**, through the
  `PackageMetadataProvider` seam — only when something references `library(pkg)`
  / `pkg::name`. It is opened in `build_package_library()` **after**
  `lib.initialize()` and wired via `set_providers()`.
- `base-exports.json` is loaded **eagerly** inside `initialize()` into a flat
  always-in-scope set (base R symbols such as `c`, `print`, plus base datasets
  such as `mtcars`), because base symbols are in scope with no `library()` call.

This consumption split is also why base could not simply move "into `names.db`":
base loads inside `initialize()`, but `names.db` opens after it, so reading base
from `names.db` would force either a startup reorder or a second mmap+blake3 open
on the hot path. Embedding base in the binary sidesteps the ordering problem
entirely.

The vocabulary in this document (Base-7, Recommended packages, Dataset export,
Export kind) is defined in the repo-root `CONTEXT.md`.

## Decision summary

1. **Eliminate `base-exports.json` entirely.** Clean break — nothing has shipped,
   so there is no deprecation window and no transition period emitting both files.
2. **Base exports move into the binary** as **generated Rust source**, replacing
   both `base-exports.json` and the hand-maintained const floor in
   `embedded_base.rs`. Compile-time-known data, embedded as `&'static` data with
   zero runtime parse and compile-time validation. (See **ADR 1**.)
3. **The embedded base file is a committed, generated artifact** refreshed by a
   maintainer command (`build-embedded-base`) that uses R. It is **not** built
   from R at compile time. (See **ADR 1**.)
4. **The embedded base preserves the dataset-vs-non-dataset distinction** (which
   is knowable ecosystem-wide and already modeled as `lazy_data`), but does
   **not** track function-vs-variable `SymbolKind`. r-universe's `_exports` is a
   names-only list, so export kind cannot be known for the ecosystem floor; that
   is a separate future feature (see Non-goals).
5. **`names.db` excludes the base-7** — a post-merge filter; **no
   `FORMAT_VERSION` bump** (same format, fewer records). It becomes strictly
   non-base (CRAN/Bioc + recommended + reference capture minus
   `get_fallback_base_packages()`). Recommended packages (MASS, Matrix, …) stay,
   because they attach via `library()` and resolve lazily like any package.
6. **A comprehensive `names.db` seed is committed via Git LFS** as the bootstrap
   starting point and disaster-recovery backstop for the append-only release
   lineage. (See **ADR 2**.)
7. **The weekly `names.db` refresh schedule is turned on** — `0 6 * * 1`
   (Mondays 06:00 UTC).
8. **The r-universe fetch + build is extracted into a shared script**
   (`scripts/build-names-db.sh`) used by both the weekly workflow and local seed
   generation, keeping the binary network-free.

The base-7 are the seven always-attached packages from
`get_fallback_base_packages()`: `base`, `methods`, `utils`, `grDevices`,
`graphics`, `stats`, `datasets`. They are 7 of R's 14 base-priority packages
(`installed.packages(priority="base")`); the other 7 — compiler, grid, parallel,
splines, stats4, tcltk, tools — ship with R but require `library()`. Raven
embeds all 14 (`get_base_priority_packages()`) so they resolve offline, but only
the base-7 are always in scope.

## Non-goals

- No `build.rs` network or R invocation; no requirement that R be present to
  build Raven.
- No change to Tier 1 (installed) or Tier 2 (`.raven/packages.json`) resolution.
- **Function-vs-variable `SymbolKind` tracking and a `not_a_function()`
  diagnostic are a separate future feature.** Today all package/base exports are
  seeded into scope as `SymbolKind::Variable` and no non-function-call diagnostic
  exists. The embedded data is shaped not to preclude it (dataset vs non-dataset
  is retained), but tracking export *kind* across the ecosystem would need an
  `Unknown` kind for the r-universe-sourced floor plus format/schema bumps, and
  is out of scope here.
- **No refactor of the disk base path.** `initialize()` Step 3b keeps lumping
  base datasets into the flat always-in-scope set (cache `lazy_data` empty);
  only the new embedded path separates datasets into `lazy_data`. Both resolve
  identically (flat set + issue #350 folding); the per-package cache shape just
  differs by load path. Out of scope.
- **No automated regeneration of the embedded base.** It is a manual maintainer
  command now. Automating it via a workflow triggered on new R releases is a
  noted future enhancement, not built here.
- No change to how `names.db` is shipped/bundled (still pulled from the GitHub
  Release, not the committed LFS seed).
- Recommended packages are not embedded in the binary; they remain in `names.db`.

## End state by source of truth

| Data | Source of truth | Consumption |
|---|---|---|
| Base-priority (14) exports + base datasets | **Embedded in the binary** (generated Rust) | Eager, in `initialize()`; base-7 seed the flat always-in-scope set, all 14 the per-package cache |
| CRAN/Bioc + recommended + off-ecosystem capture (minus base-7) | **`names.db`** (one sidecar) | Lazy, per package, via `PackageMetadataProvider` |
| A real on-disk install | The install (Tier 1) | Unchanged; still wins, version-exact |

A real on-disk base install still wins: the embedded base is consulted only when
the base packages are absent from disk (CI without R).

## Embedded base: format, regen, loading

### Generated file

`crates/raven/src/package_db/embedded_base.rs` is rewritten from a hand-maintained
floor into a `// @generated` per-package table:

```rust
pub struct EmbeddedBasePackage {
    pub name: &'static str,
    pub exports: &'static [&'static str],   // non-dataset exports (functions + constants)
    pub datasets: &'static [&'static str],  // -> PackageInfo.lazy_data
    pub depends: &'static [&'static str],
}

pub static EMBEDDED_BASE_PACKAGES: &[EmbeddedBasePackage] = &[ /* the base-7 */ ];
```

`version` is dropped — `PackageInfo` has no version field and base resolution
never uses one. Datasets are kept distinct from `exports` (mapping to
`PackageInfo.lazy_data`), which both retains the only ecosystem-knowable
distinction and brings base into line with how every non-base package is already
modeled. Per-package structure lets `initialize()` populate both the flat set and
the cache.

`load()` keeps its current return shape (flat exports set + base package-name
set) but folds over `EMBEDDED_BASE_PACKAGES`, unioning each package's `exports`
+ `datasets` into the flat always-in-scope set (so `mtcars` stays in scope with
no `library(datasets)`). A small accessor exposes the per-package records so
`initialize()` can insert each into the cache with `exports`, `lazy_data`
(= `datasets`), and `depends`. `collect_exports_recursive` already folds
`lazy_data` into the resolvable set (issue #350), so resolution is unchanged. The
package set derived from the table must match `get_fallback_base_packages()`.

### Regen command

```sh
raven packages build-embedded-base --reference-lib <DIR> [--output <path>]
```

It captures the base-7 from a reference R and writes the generated `.rs`,
defaulting `--output` to the committed `embedded_base.rs` path. Per base package
it collects, in **separate buckets**, the namespace exports (functions +
constants, via `getNamespaceExports`/`exportPattern` expansion) and the datasets
(via the data-dir/`data()` path) — the existing export helpers return names only
and omit datasets, so datasets need their own capture. No `is.function`
classification is performed (export kind is deferred). Each string literal is
emitted via Rust's `{:?}` (Debug) formatting, which yields a correctly-escaped
string literal for operator and exotic export names (`%in%`, `[.data.frame`,
`if`, backtick-quoted identifiers). A header comment records the reference R
version. Run manually on R-version bumps or at release — never in the weekly job.

### `initialize()` change

The base-loading tail collapses to: if the on-disk base merge is non-empty (a
real install), use it; otherwise load from `EMBEDDED_BASE_PACKAGES` into both the
flat `base_exports` set and the per-package cache. The
`locate_base_exports_candidates` / `load_base_exports` sidecar branch and the
separate embedded-floor fallback are both removed. Nothing in `initialize()` now
depends on `names.db`, so the startup ordering problem disappears.

## `names.db` build changes (`build-shipped-db`)

- **Exclude the base-7:** after the append-only merge, filter out
  `get_fallback_base_packages()` before `write_shipped_db`. Filtering post-merge
  cleans base out of every source (prior seed/Release, reference capture,
  r-universe) uniformly. No `FORMAT_VERSION` bump.
- **Drop base-exports emission:** remove `--base-exports-output`,
  `write_base_exports_file` (and its test), and the `package_db/base_exports.rs`
  module.
- **Seed fallback chain:** seed from the prior Release `names.db` if present,
  **else** from the committed LFS seed (replacing today's "build fresh/empty").
  Same `--seed` input, new fallback source. The existing "corrupt/incompatible
  seed aborts unless `--fresh`" safety net is retained.
- **Add** the `build-embedded-base` subcommand (above), dispatched in
  `packages::run()` and documented in `print_help`.
- The fetch + build invocation moves into the shared script (below).

## Shared build script

`scripts/build-names-db.sh` encapsulates the two steps the shipped binary
deliberately does not do itself: `curl`-fetch the CRAN + Bioc r-universe JSON into
directories, then invoke `raven packages build-shipped-db` against those
pre-fetched directories. Both the weekly workflow and the maintainer's local seed
build call this one script, so CI and local stay in lockstep and the binary
remains network-free (it only ever consumes pre-fetched directories).

## Seed bootstrap (committed `names.db` via Git LFS)

- **Content (M1, comprehensive):** all installed packages (minus base-7,
  auto-discovered via `.libPaths()` when R is present) **∪** CRAN/Bioc, built
  locally on the maintainer's machine via the shared script. A standalone,
  complete `names.db`.
- **Location:** committed at `crates/raven/data/names-db-seed.db`, tracked by Git
  LFS. `.gitattributes` is scoped to **that exact path**
  (`crates/raven/data/names-db-seed.db filter=lfs diff=lfs merge=lfs -text`),
  deliberately **not** `*.db`, so it never catches test fixtures or temp DBs.
- **Not a build input** — nothing in `cargo build` / `cargo test` reads it.
  Ordinary contributors get a pointer file with zero friction and need no
  `git lfs`. Only a maintainer **refreshing the seed** needs `git lfs` locally.
- **Usage — bootstrap/disaster-only.** Release-first: after the first release the
  Release `names.db` already contains the seed's packages (append-only never
  drops them), so the committed seed is consulted only when no Release exists
  (bootstrap, or a lost Release). The full M1 content makes it a true
  disaster-recovery artifact (works even if r-universe is gone).
- **Off-CRAN enrichment — additive Release push.** New off-CRAN packages enter
  the floor by the maintainer running a comprehensive local build and pushing it
  into the Release through the append-only seed-merge (download the current
  Release as `--seed`, merge, re-upload) — additive, never dropping existing
  Release packages. The weekly job therefore does not union the seed.
- `bundle-binary.js` and `release-build.yml` still pull `names.db` from the
  GitHub Release, so shipping/bundling is unaffected by LFS.

## Producing the committed artifacts (in scope, maintainer-run)

This spec includes generating and committing the two artifacts, not just the
commands. Both runs need R + the maintainer's rich library (and `curl` for the
seed), so the maintainer runs them and commits the outputs; the implementation
otherwise builds the commands, the script, and all wiring. The partition is
exact: **base-7 → embedded `.rs`; all other installed packages → `names.db`
seed**, split at `get_fallback_base_packages()`.

1. `raven packages build-embedded-base --reference-lib <libs>` → commit
   `embedded_base.rs`.
2. `scripts/build-names-db.sh` (M1) → commit `names-db-seed.db` via LFS.

## Delivery & packaging (one sidecar everywhere)

- `run_update`: download only `names.db`; remove the `base-exports.json`
  download, `locate_base_exports_candidates`, and the `RAVEN_BASE_EXPORTS`
  override. (`RAVEN_NAMES_DB` stays.)
- `install_downloaded_sidecars`: collapse the two-file atomic install to a
  single-file install; drop `InstalledSidecars.base_exports_path` and the
  base-exports validation/rollback paths (and their tests).
- `bundle-binary.js`: bundle only `names.db`.
- `release-build.yml`: download only `names.db`.
- `editors/vscode/.vscodeignore`: drop the `base-exports.json` entry.
- `main.rs`: update the `update` help text that names `base-exports.json`.

## Weekly schedule (`build-names-db.yml`)

- Enable the weekly `schedule:` — `0 6 * * 1` (Mondays 06:00 UTC); keep
  `workflow_dispatch` for manual runs.
- The job calls `scripts/build-names-db.sh` instead of inlining the fetch+build.
- `actions/checkout` stays **default (`lfs: false`)** so it pulls only the
  pointer, wasting no LFS bandwidth.
- The seed step prefers the Release and fetches the LFS blob only as fallback:
  `gh release download names-db --pattern names.db` on success seeds from the
  Release and never touches the committed copy; only if no Release exists,
  `git lfs pull --include=crates/raven/data/names-db-seed.db` materializes the
  seed. `git-lfs` is preinstalled on `ubuntu-latest`, and "pull before use" rules
  out opening a pointer file as `names.db`.
- Remove `base-exports.json` from the build invocation, the upload, and
  `checksums.sha256` (which then covers only `names.db`).

## Documentation

- `docs/package-database.md` — Tier 3 section, "Base packages and datasets",
  "See also": base coverage is embedded in the binary; the floor is one sidecar,
  `names.db`. Do not claim recommended packages are embedded — only the base-7
  are.
- `README.md` — the two Installation passages naming "`names.db` and
  `base-exports.json`" drop the second file.
- `docs/development.md` — internal architecture; add the `git lfs` / seed-refresh
  note, the shared script, and the `build-embedded-base` regen step.
- `docs/cli.md` and `main.rs` help — `build-shipped-db` / `update` text and the
  new `build-embedded-base`.

## Decision records (ADRs)

### ADR 1 — Base package exports embedded in the binary as a committed generated file

Raven embeds the base-7 packages' exports as a generated Rust source
(`embedded_base.rs`), regenerated by a maintainer command
(`raven packages build-embedded-base`, which uses R) and committed to the repo.
Chosen over (a) carrying base in `names.db` — rejected because base loads eagerly
in `initialize()` before the lazy `names.db` provider opens, and a no-sidecar
source install still needs a base floor; and (b) generating from R at compile
time — rejected because it would require R for `cargo install`, make builds
non-reproducible and platform-divergent, break cross-compilation, and let an
older local R silently downgrade coverage. Consequently `names.db` excludes the
base-7 and carries only the broader ecosystem. Reversible but with real cost (it
shapes the binary, the regen tooling, and `initialize()`), and a future reader
would otherwise wonder why base isn't simply in `names.db`.

### ADR 2 — Comprehensive `names.db` seed committed via Git LFS

The append-only release lineage is bootstrapped from a comprehensive `names.db`
(the maintainer's full installed library minus base-7, ∪ CRAN/Bioc) committed to
the repo via Git LFS, serving as bootstrap input and disaster-recovery backstop.
Chosen over committing a plain blob (history bloat) and over a lean
reference-only seed (the maintainer wanted a standalone, comprehensive
artifact that can additively replace the Release). The trade-offs: Git LFS
carries real tooling/history lock-in, and the seed is vestigial after the first
Release (Release-first usage) — both surprising without this rationale.

## Testing

- Embedded base `load()`: flat set + per-package records, datasets kept distinct
  (`mtcars` in `datasets`/`lazy_data`), and the derived package set equals
  `get_fallback_base_packages()`.
- `initialize()`: falls back to embedded base when disk base is absent; a real
  on-disk base install still wins when present.
- `build-shipped-db`: the base-7 are excluded from the written `names.db`; no
  base-exports file is produced.
- `update` / `install_downloaded_sidecars`: single-file install round-trips and
  rolls back on a bad `names.db`.
- Seed fallback chain: Release present → seed from Release; Release absent → seed
  from committed seed.
- Remove the obsolete two-file install and `write_base_exports_file` tests.

## Risks

- **Embedded base staleness between regens** — low: base R changes ~yearly, and
  the weekly `names.db` build surfaces fresh base data as a reference; manual
  regen now, with automated-on-R-release a future enhancement.
- **Contributor without `git lfs`** sees a pointer file — harmless, since the seed
  is not a build input; CI's "pull before use" handles the bootstrap case.
- **M1 local seed build requires a full local r-universe fetch** — heavy, but
  maintainer-only and run through the shared script.
