# Lazy-Loaded Package Data Enumeration — Design

**Issue:** [#429](https://github.com/jbearak/raven/issues/429)
**Date:** 2026-06-11
**Branch:** `issue429`

## Problem

Raven cannot enumerate objects stored in R's serialized lazy-data databases, even for installed packages. Corpus triage left ~73 ledger entries in three buckets:

1. **44 entries** — lazy-loaded datasets of `library()`-attached packages bundled in `Rdata.rdb` with no `datalist` (e.g. `library(survival); lung`). Static file-stem discovery cannot see the names.
2. **26 entries** — package-internal `R/sysdata.rda` objects (cli's `emojis`, readr's `date_symbols`). These are *not* attached by `library()` in real R; in scope only for package-development mode.
3. **3 entries** — multi-object data files where `data(name, package=)` binds differently-named objects (survey's `data/api.rda` defines `apiclus1`/`apistrat`).

## Approach

**Use R as the oracle** (option 2 of the issue's three). Enumerate via the existing R subprocess, cache the result, degrade gracefully without R — the same hybrid shape as `exportPattern` expansion (`get_multiple_package_exports`). Since the goal is matching R's `data(package=)` semantics, asking R is cleaner than reimplementing lazyload internals.

Rejected alternatives (per issue): parsing `Rdata.rdx`/RDS in Rust (couples Raven to R serialization internals with a history of sharp edges — CVE-2024-27322 class); relying on names.db `lazy_data` (Tier 2/3 is consulted only on Tier-1 miss, so it never helps the installed-package case — a separate offline follow-up).

## Design decisions (resolved during brainstorming)

- **Non-LazyData tightening: deferred.** Real R does not attach datasets on `library(pkg)` for non-LazyData packages (raw `.rda`, no `Rdata.rdb`), but Raven's current file-stem injection stays as-is. This issue is strictly additive (more names, never fewer). Tightening is a separate follow-up issue whose first step is a corpus re-probe.
- **Bare `data(api)` expansion: search attached packages.** When `package =` is absent, expand against every package attached so far in scope plus default-attached base packages, matching R's search. Always also bind the literal name as fallback.

## Components

### 1. Enumeration — `crates/raven/src/r_subprocess.rs`

New batched query `get_multiple_package_datasets(packages) -> HashMap<String, Vec<DataObject>>`, modeled on `get_multiple_package_exports` (structured markers: one header marker, `__PKG:name__` per package). R side per package:

```r
data(package = "pkg")$results[, "Item"]
```

Each `Item` line is `name` or `name (stem)`; parse into `DataObject { name: String, file_stem: String }` (stem = name when unaliased). Prior art for the query exists in the CLI's `capture_base_datasets`.

Safety (module-doc invariants): validate package names before R codegen; wrap in the standard timeout; never interpolate unvalidated strings into R code.

### 2. Population — `crates/raven/src/package_library.rs`

For any installed package whose `data/` directory exists, run the enumeration in the `get_package` flow (batched with existing Tier-2 subprocess work where possible). Cache results in the existing `ArcSwap<PackageCache>`:

- **`PackageInfo.lazy_data`** ← enumerated object names, **only for LazyData packages**. `Rdata.rdb` presence in `data/` is itself the LazyData marker: R builds that DB only when `DESCRIPTION` sets `LazyData`, and only then does `library(pkg)` attach the datasets. `collect_exports_recursive` already folds `lazy_data` into scope/completion, so bucket 1 needs no consumption changes.
- **`PackageInfo.data_aliases: HashMap<String, Vec<String>>`** (new; file stem → object names) ← enumerated for **all** packages with `data/`. Feeds only `data()` call expansion, so non-LazyData packages gain no extra post-`library()` names.
- **Without R** (absent, timeout, parse failure): fall back to today's behavior — `parse_data_symbols` file stems, INDEX fallback, the #427 embedded base floor. No regression, reduced fidelity. Enumeration failure is never fatal to `get_package`; follow the existing Tier-2 negative-result handling to avoid hammering a broken R.

Side effect: `build-shipped-db --capture-reference` routes through `get_package`, so reference DB capture gets authoritative dataset lists for free, removing the merge wrinkle where incomplete Tier-1 records shadow r-universe `_datasets` lists on version ties.

### 3. `data()` alias expansion — `crates/raven/src/cross_file/scope.rs`

Extend `try_extract_data_call_definitions` (today: binds literal positional names only, skips named args):

- Read the `package =` named argument when it is a string literal; expand each positional dataset name via that package's `data_aliases`.
- When `package =` is absent, search packages attached so far in scope (detected `library()`/`require()`) plus default-attached base packages; bind all objects whose file stem matches.
- Always also bind the literal name — fallback when enumeration is unavailable or the stem is unknown. Behavior is strictly additive.

Bucket 3 lands entirely here.

### 4. sysdata bucket — triage, not code

Re-probe the 26 `sysdata.rda` ledger entries against the existing package-mode machinery (`crates/raven/src/package_state/sysdata.rs`):

- Entries the machinery now covers (the package's own code referencing its sysdata) → cleared.
- Entries where a *user script* references sysdata objects after `library()` → **reclassified as true positives** (`library(cli); emojis` is a genuine error in real R; even `cli::emojis` fails).

sysdata names must never enter user-script scope.

## Out of scope

- names.db `lazy_data` as a no-R floor for installed packages (offline follow-up).
- Rust-side `Rdata.rdx` parsing (last resort; revisit only if the no-R gap matters in practice).
- Tightening non-LazyData `library()` injection (separate follow-up issue; needs corpus re-probe first).

## Testing

- Unit: `name (stem)` item parsing; multi-package marker output parsing (empty packages, missing `data/`, alias and non-alias forms).
- R-gated integration: subprocess enumeration against installed packages, matching existing R-availability gating.
- Scope: `data()` expansion with explicit `package=`, bare form across attached packages, and literal-name fallback.
- Acceptance (from the issue):
  - `library(survival); lung` — no undefined-variable diagnostic (editor + `raven check`).
  - `data(api, package = "survey")` then `apiclus1` — no diagnostic.
  - Negative: `library(cli); emojis` in a plain user script **still flags**.
- Corpus: full 4-group strict run green; cleared ledger entries pruned via the stale-FP report; sysdata entries re-probed and re-classified.

## Documentation

- `docs/cross-file.md` / `docs/package-database.md`: subprocess dataset enumeration, alias expansion, no-R fallback behavior.
- Doc comments: the new subprocess query, `data_aliases` field semantics, and the `Rdata.rdb`-as-LazyData-marker invariant on the population code.

## Review gate (from the issue, required)

No PR until the branch survives **two consecutive clean review passes**: parallel dimension reviewers (correctness, invariants, tests, docs, simplification/reuse) over the full branch diff, each finding adversarially verified by an independent subagent; any fix resets the counter. Prerequisites per pass: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --features test-support -- -D warnings`, `cargo test -p raven` green, and the relevant strict corpus run reporting 0 unclassified / 0 stale acceptances / 0 stale FPs.
