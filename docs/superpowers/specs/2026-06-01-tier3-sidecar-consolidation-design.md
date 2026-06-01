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
on the hot path.

## Decision summary

1. **Eliminate `base-exports.json` entirely.** Clean break — nothing has shipped,
   so there is no deprecation window and no transition period emitting both files.
2. **Base exports move into the binary** as **generated Rust source**, replacing
   both `base-exports.json` and the hand-maintained const floor in
   `embedded_base.rs`. Compile-time-known data is embedded as `&'static` data
   with zero runtime parse and compile-time validation.
3. **The embedded base file is a committed, generated artifact** refreshed by a
   maintainer command that uses R. It is **not** built from R at compile time
   (that would break `cargo install` on machines without R, make builds
   non-reproducible and platform-divergent, break cross-compilation, and let an
   older local R silently downgrade coverage).
4. **`names.db` excludes the base-7.** It becomes strictly non-base
   (CRAN/Bioconductor + recommended + reference capture minus
   `get_fallback_base_packages()`). Recommended packages (MASS, Matrix, …) stay,
   because they are attached via `library()` and resolve lazily like any package.
5. **A comprehensive `names.db` seed is committed to the repo via Git LFS** as the
   durable starting point and disaster-recovery backstop for the append-only
   release lineage.
6. **The weekly `names.db` refresh schedule is turned on.**

The base-7 are the seven always-attached packages from
`get_fallback_base_packages()`: `base`, `methods`, `utils`, `grDevices`,
`graphics`, `stats`, `datasets`.

## Non-goals

- No `build.rs` network or R invocation; no requirement that R be present to
  build Raven.
- No change to Tier 1 (installed) or Tier 2 (`.raven/packages.json`) resolution.
- No automatic regeneration of the embedded base in the weekly job — it is a
  manual maintainer step on R bumps / at release.
- No change to how `names.db` is shipped/bundled (still pulled from the GitHub
  Release, not the committed LFS seed).
- Recommended packages are not embedded in the binary; they remain in `names.db`.

## End state by source of truth

| Data | Source of truth | Consumption |
|---|---|---|
| Base-7 exports + base datasets | **Embedded in the binary** (generated Rust) | Eager, in `initialize()`; the flat always-in-scope set + per-package cache |
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
    pub version: &'static str,
    pub exports: &'static [&'static str],
    pub datasets: &'static [&'static str],
    pub depends: &'static [&'static str],
}

pub static EMBEDDED_BASE_PACKAGES: &[EmbeddedBasePackage] = &[ /* the base-7 */ ];
```

Per-package structure is required so `initialize()` can populate **both** the
flat `base_exports` set (union of every package's `exports` + `datasets`) **and**
the per-package cache records (preserving `stats::lm`-style attribution).

`load()` keeps its current return shape (flat exports set + base package-name
set) but folds over `EMBEDDED_BASE_PACKAGES` instead of the old consts. A small
accessor additionally exposes the per-package records for the cache. The package
set derived from the table must match `get_fallback_base_packages()`.

### Regen command

```sh
raven packages build-embedded-base --reference-lib <DIR> [--output <path>]
```

It runs the existing Tier-1 capture (`build_package_library_tier1_only`) against
the reference R, keeps only `get_fallback_base_packages()`, and writes the
generated `.rs`. Each string literal is emitted via Rust's `{:?}` (Debug)
formatting, which produces a correctly-escaped string literal for operator and
exotic export names (`%in%`, `[.data.frame`, `if`, backtick-quoted identifiers).
It is dispatched in `packages::run()` and documented in `print_help`. A header
comment records the reference R version used. Run manually on R-version bumps or
at release — never in the weekly job.

### `initialize()` change

The base-loading tail collapses to: if the on-disk base merge is non-empty (a
real install), use it; otherwise load from `EMBEDDED_BASE_PACKAGES` into both the
flat `base_exports` set and the per-package cache. The
`locate_base_exports_candidates` / `load_base_exports` sidecar branch and the
separate embedded-floor fallback are both removed. Because nothing in
`initialize()` now depends on `names.db`, the startup ordering problem disappears.

## `names.db` build changes (`build-shipped-db`)

- **Exclude the base-7:** after the append-only merge, filter out
  `get_fallback_base_packages()` before `write_shipped_db`.
- **Drop base-exports emission:** remove `--base-exports-output`,
  `write_base_exports_file` (and its test), and the `package_db/base_exports.rs`
  module.
- **Seed fallback chain:** seed from the prior Release `names.db` if present,
  **else** from the committed LFS seed (replacing today's "build fresh/empty").
  Same `--seed` input, new fallback source. The existing "corrupt/incompatible
  seed aborts unless `--fresh`" safety net is retained.
- **Add** the `build-embedded-base` subcommand (above).

## Seed bootstrap (committed `names.db` via Git LFS)

- The comprehensive `names.db` built on the maintainer's richly-provisioned
  machine is committed at `crates/raven/data/names-db-seed.db`, tracked by Git
  LFS. It excludes the base-7 like every `names.db`.
- `.gitattributes` is scoped to **that exact path**
  (`crates/raven/data/names-db-seed.db filter=lfs diff=lfs merge=lfs -text`),
  deliberately **not** `*.db`, so it never catches test fixtures or temp DBs.
- The seed is **not a build input** — nothing in `cargo build` / `cargo test`
  reads it. Ordinary contributors get a pointer file with zero friction and need
  no `git lfs`. Only a maintainer **refreshing the seed** needs `git lfs` locally.
- It is purely a **CI build input + disaster-recovery backstop**. After the first
  release the Release `names.db` already contains the seed's packages
  (append-only never drops them), so the committed seed is only consulted again if
  the Release is ever lost.
- `bundle-binary.js` and `release-build.yml` still pull `names.db` from the
  GitHub Release, so shipping/bundling is unaffected by LFS.

## Delivery & packaging (one sidecar everywhere)

- `run_update`: download only `names.db`; remove the `base-exports.json`
  download, `locate_base_exports_candidates`, and the `RAVEN_BASE_EXPORTS`
  override.
- `install_downloaded_sidecars`: collapse the two-file atomic install to a
  single-file install; drop `InstalledSidecars.base_exports_path` and the
  base-exports validation/rollback paths (and their tests).
- `bundle-binary.js`: bundle only `names.db`.
- `release-build.yml`: download only `names.db`.
- `editors/vscode/.vscodeignore`: drop the `base-exports.json` entry.

## Weekly schedule (`build-names-db.yml`)

- Enable the weekly `schedule:` — `0 6 * * 1` (Mondays 06:00 UTC); keep
  `workflow_dispatch` for manual runs.
- `actions/checkout` stays **default (`lfs: false`)** so it pulls only the
  pointer, wasting no LFS bandwidth.
- The seed step prefers the Release and fetches the LFS blob only as fallback:
  - `gh release download names-db --pattern names.db` — on success, seed from the
    Release and never touch the committed copy.
  - Only if no Release exists, `git lfs pull
    --include=crates/raven/data/names-db-seed.db` to materialize the seed, then
    build from it.
- So the LFS blob is fetched in CI only during bootstrap (or if the Release is
  lost). `git-lfs` is preinstalled on `ubuntu-latest`. The "pull before use"
  ordering also rules out opening a pointer file as `names.db` by construction.
- Remove `base-exports.json` from the `build-shipped-db` invocation, the upload,
  and `checksums.sha256` (which then covers only `names.db`).

## Documentation

- `docs/package-database.md` — Tier 3 section, "Base packages and datasets",
  "See also": reframe base coverage as embedded in the binary; the floor is one
  sidecar, `names.db`.
- `README.md` — the two Installation passages naming "`names.db` and
  `base-exports.json`" drop the second file.
- `docs/development.md` — internal architecture notes; add the `git lfs` /
  seed-refresh note and the `build-embedded-base` regen step.
- `docs/cli.md` — `build-shipped-db` / `update` help and the new
  `build-embedded-base`.

## Testing

- Embedded base `load()`: flat set + per-package records, including base datasets
  (`mtcars`), and the derived package set equals `get_fallback_base_packages()`.
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
  the weekly `names.db` build surfaces fresh base data as a reference for when the
  maintainer does regenerate.
- **Contributor without `git lfs`** sees a pointer file — harmless, since the seed
  is not a build input; CI's "pull before use" handles the bootstrap case.
