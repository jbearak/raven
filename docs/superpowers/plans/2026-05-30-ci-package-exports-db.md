# CI Package-Exports Database (three-tier export resolution) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Raven resolve R **package export names** in CI without installing or compiling packages, via an ordered three-tier fallback (installed → committed repo DB → bundled latest-CRAN/Bioc DB).

**Architecture:** A new `package_db` module holds one serializable on-disk record shared by two encodings — a diff-friendly Tier 2 JSON (`.raven/packages.json`) and a memory-mapped Tier 3 binary (`names.db`). Export resolution in `PackageLibrary` gains a small synchronous `PackageMetadataProvider` seam: Tier 1 (existing installed path) stays first and untouched; when a package isn't installed, ordered providers (Tier 2 repo DB → Tier 3 shipped DB) supply its `PackageInfo`. Install-status (the missing-package diagnostic) stays Tier-1-only and is suppressed by default in `raven check`.

**Tech Stack:** Rust (tokio, serde, serde_json, `blake3` and `async-trait` already deps; add `memmap2` + `postcard`), TypeScript (VS Code extension), GitHub Actions (build job).

---

## Prerequisites (build order)

**[raven#350](https://github.com/jbearak/raven/issues/350) — "Resolve package datasets (lazy-data) as symbols" — has LANDED** (merged to `main` via PR [#351](https://github.com/jbearak/raven/pull/351), commit `bda8ff30`; merged into this branch). The dependency is satisfied; this is no longer a blocking prerequisite.

The lazy-data resolution mechanism this plan relies on is now in place:
- `get_package` populates `lazy_data` via `parse_data_symbols` ([`package_library.rs:186`](../../../crates/raven/src/package_library.rs)),
- `collect_exports_recursive` folds `lazy_data` into the resolvable set ([`package_library.rs:1540`](../../../crates/raven/src/package_library.rs)).

So this plan's Tier 2/3 `PackageRecord` (which captures `lazy_data`) is consumed by that same resolution path automatically — once the providers land, package datasets resolve in CI with no extra work here.

> **⚠ Anchor drift (post-#350).** #350 added ~361 lines to `crates/raven/src/package_library.rs`, so every `package_library.rs:NNN` line reference in this plan is now **stale** (shifted ~+30–40 lines) and the `get_package` body changed shape. Re-verify the seams **before** executing M1–M3. Current anchors (post-merge): `PackageInfo` `:110`; `find_package_for_symbol` `:795`; `prefetch_packages` `:630`; `initialize` `:981`; `get_package` `:1183`; `package_exists` `:1431`; `collect_exports_recursive` `:1506`; `build_package_library` `:1652`. Note that `get_package` **no longer** sets `lazy_data = Vec::new()` for regular packages (it now calls `parse_data_symbols`), so the plan's references to the old `:1236` empty-`lazy_data` line and the prereq rationale built on it are obsolete — `PackageRecord::from_info` already carries real `lazy_data`.

---

## Decisions resolved during planning (spec §17)

These were open in the spec; the plan locks them. The "locked" decisions from the handoff are upstream of these and not revisited.

1. **Generation subcommand name → `raven packages freeze`.** The `raven` binary dispatches on a single first token (`main.rs:92`); a `packages` group routes its second token (`freeze`, and the maintainer-only `build-shipped-db`). Group keeps room for future package commands without new top-level verbs.
2. **CI flag name → `raven check --report-uninstalled`.** Descriptive; matches spec §10.2. Plumbed by suppressing missing-package diagnostics by default (set `cross_file_config.packages_missing_package_severity = None` unless the flag is present), reusing the existing severity gate at `handlers.rs:5005`.
3. **Tier 3 encoding → custom container + `postcard` payloads + `memmap2`, integrity via `blake3` (already a dep).** Layout: `MAGIC(8) | version(u32) | header_len(u32) | header(postcard) | payload region`. The header (decoded once at open — the "preload the index" of §12) carries provenance, a `blake3` hex of the payload region, and an index `Vec<{name, offset, len}>`. Per-package `PackageRecord`s live in the mmap'd payload region and are postcard-decoded **lazily** on lookup, off the LSP hot path (the hot path is `try_read`-only against the in-memory cache). No compression in v1 (would fight per-entry lazy mmap; export-name lists postcard-encode compactly; revisit only if size demands).
4. **Resolution seam → a real `PackageMetadataProvider` trait, synchronous, covering the new fallback tiers only.** Tier 1 stays a bespoke first step in `get_package` (its subprocess/INDEX logic is intertwined with `lib_paths`/caches; wrapping it would not be "contained" and risks regressing the authoritative path, which the spec forbids). Tier 2/3 are pure pre-built reads → the trait is sync (no `async_trait` needed). `package_exists()` never consults providers, preserving the install-status invariant (§10).
5. **Build-job hosting → a dedicated GitHub Actions workflow `build-names-db.yml`** (weekly `schedule` + `workflow_dispatch` + on release tag), storing `names.db` on a **GitHub Release** (see decision #14). The shipped binary stays **network-free**: the workflow uses `curl` to fetch r-universe JSON into a directory, then `raven packages build-shipped-db` transforms it. Provenance (source, snapshot date, package count, raven version) + a `blake3` checksum are written into the db header.

---

## Decisions revised in design review (grilling session, 2026-05-30)

The branches below were stress-tested after the first draft and changed the plan. They supersede anything contradictory above.

6. **`freeze` builds a provider-less (Tier-1-only) library.** The capture path must never fall through to Tier 2/3, or it would write latest-CRAN guesses (or a stale prior `.raven/packages.json`) into the "frozen Tier 1" file. Implemented by splitting construction: `build_library_inner` (no providers) feeds both `build_package_library_tier1_only` (capture: freeze + the Tier 3 build's reference-R seed) and `build_package_library` (runtime: inner + provider wiring). Existing 4-arg callers of `build_package_library` are unchanged.
7. **Base/recommended exports ship as a separate bundled file** (built from the reference R), loaded in `initialize()` to populate `base_exports` when the base packages aren't on disk (CI). Base **datasets** (`mtcars`/`iris`) are merged into `base_exports` exactly as the disk path does today — so base datasets resolve in CI in v1 (independent of #350, which covers *non-base* package datasets). A real R install still wins (the file is only consulted when disk base packages are absent).
8. **Tier 3 build = reference-R seed ∪ CRAN+Bioc r-universe append, append-only.** Each rebuild starts from the previous `names.db`, overlays an authoritative reference-R capture of the build machine's **entire installed library** (`enumerate_installed_packages` across all lib paths — base/recommended **and** every CRAN/Bioc/GitHub-only/internal package installed there, with datasets and `exportPattern` expanded), appends r-universe for packages not already present, and **never drops** a package. Precedence: **reference-R > r-universe > retained-from-prior**. r-universe is fetched from **both** `cran.r-universe.dev` and `bioc.r-universe.dev`.

   **Not a curated subset (corrected in review):** the reference-R seed is deliberately the *full* installed library, because packages that were hard to install or are absent from CRAN/Bioc (GitHub-only, internal, fallback-built) only ever enter the floor this way — and append-only guarantees they're never lost on later rebuilds. The build machine's library therefore determines authoritative coverage: the maintainer **bootstraps** the `names-db` Release once from a richly-provisioned machine (e.g. their own), after which automated runs seed from that Release, append CRAN+Bioc, and retain everything. Teams can likewise build a private `names.db`/`base-exports.json` from their own library for richer in-house coverage.
9. **Unreadable databases are explained, not silently dropped.** Readers return typed errors — `Absent` (normal, silent) vs `UnsupportedSchema { found, supported }` vs `Corrupt`. On a present-but-unusable file (e.g. a `.raven/packages.json` written by a newer Raven), the surface **explains and continues** — `raven check` prints a specific stderr note, the language server raises `window/showMessage` — then degrades to the next tier. Never hard-fails the LSP or the build over a committed/seed file. Tier 2 gains a `schema_version`; Tier 3 keeps `FORMAT_VERSION`.
10. **`freeze --used` is maximally inclusive** (over-inclusion is free, since the provider-less library skips anything not installed): `library`/`require`/`loadNamespace`/`requireNamespace` calls ∪ `::`/`:::` LHS (a `namespace_operator` tree walk) ∪ `renv.lock` ∪ the repo's own `DESCRIPTION` `Depends`+`Imports` ∪ transitive `Depends`. (`LinkingTo` excluded — C-level, no R exports.)
11. **`freeze` is a no-op when content is unchanged.** After computing records, if an existing file is present, compare **package content only** (ignoring provenance); if identical, leave the file untouched and print "no changes" — so a no-op regeneration produces zero diff and the provenance timestamp only moves when content changed.
12. **The seam is just one hook.** `prefetch_packages` needs **no** change: its Step 3 already funnels every loaded package (and transitive `Depends` / meta-package `attached_packages`) through `get_all_exports → collect_exports_recursive → get_package`, which carries the provider hook. So meta-packages (`library(tidyverse)`) and `Depends` chains resolve in CI for free. The original Task 2.3 (a separate prefetch fallback) is **removed** as redundant.
13. **Verify the `names.db` checksum at open, in `spawn_blocking`** (Q5) — ~10–20 ms once during library init, off the async runtime; catches truncation/corruption.
14. **`names.db` lives on a GitHub Release** (moving tag, e.g. `names-db`), holding `names.db`, the base-exports file, and their checksums. GH Actions artifacts are per-run and expire, which can't serve the append-only seed or release packaging; a Release gives a durable URL. The weekly job downloads the current asset (seed), rebuilds, re-uploads; `release-build` and `bundle-binary.js` download the same asset to place next to the binary / into the VSIX.
15. **Commit tiny `names.db` + `.raven/packages.json` fixtures** as a back-compat regression guard (a "old fixtures still load" test), alongside the runtime-built tempdir fixtures used for round-trip tests.

---

## Execution order (documentation-first)

**Stage 1 is documentation, shipped as its own PR before any feature code.** Writing the user-facing docs and the `docs/development.md` architecture notes first makes them the agreed contract: reviewers approve the *intended behavior and UX* (command names, flags, file locations, the names-vs-install-status split, the three tiers) before implementation, and the code milestones then build to match.

- **Stage 1 — Documentation PR** = Milestone 6's authoring tasks (6.1–6.4) **plus** the new `docs/development.md` task (6.0). Authored, reviewed, and **merged first**. Because these describe not-yet-shipped behavior, each new/changed user doc carries a **status banner** — `> **Status: planned — tracking [the CI package-exports DB work]. Not yet available in a released build.**` — removed by the final code milestone once the feature ships (Task 6.5 Step 3).
- **Stages 2–6 — Implementation** = Milestones 1→5 in order (each independently testable; never regresses Tier 1). A code milestone touches docs only to *correct drift* from the Stage 1 PR, not to write fresh docs.
- **Closing — Task 6.5** (final whole-build verification + banner removal) runs **last**, after all code.
- **Prerequisite:** [raven#350](https://github.com/jbearak/raven/issues/350) lands before Stage 2 (it may proceed in parallel with the Stage 1 docs PR).

> The "Milestone N" labels below are section labels, not execution order. Execution order is: **Stage 1 docs (M6 §§6.0–6.4) → M1 → M2 → M3 → M4 → M5 → Task 6.5**.

---

## Scope check

This is **one** cohesive feature (a shared spine plus the tiers that consume it), not multiple independent subsystems, so it is a single plan. The milestones are written so each ships independently-testable software and never regresses Tier 1. **Execution order is documentation-first** (see the Execution-order section): **M6's docs §§6.0–6.4 are Stage 1, PR'd before any code**; then M1→M5; then Task 6.5 closes out.

- **M6 §§6.0–6.4 (Stage 1, FIRST)** — Documentation PR: user-facing docs + `docs/development.md`, describing the intended behavior/UX as the agreed contract (with "planned" banners).
- **M1** — `package_db` shared spine: model + both encodings + reader/writer + fixtures.
- **M2** — ordered-resolution seam in `PackageLibrary` (refactor, **no behavior change**).
- **M3** — Tier 3 provider + base-exports loading + exe-relative bundling (from the GitHub Release) + lookup wired through the seam + the `raven check` CI behavior split.
- **M4** — Tier 3 build pipeline: `raven packages build-shipped-db` (reference-R full-library seed ∪ CRAN+Bioc r-universe, append-only) + GH Actions job publishing to a GitHub Release + provenance/integrity.
- **M5** — Tier 2 generation (`raven packages freeze` CLI: provider-less capture, maximally-inclusive `--used` set, no-op-when-unchanged + `renv.lock` reader + repo-DB provider + VS Code command).
- **Task 6.5 (LAST)** — final whole-build verification + removal of the Stage 1 "planned" banners.

---

## File structure

**New files (Rust):**
- `crates/raven/src/package_db/mod.rs` — module root; re-exports; `PackageMetadataProvider` trait; exe-relative `names.db` location.
- `crates/raven/src/package_db/model.rs` — `PackageRecord` (on-disk projection of `PackageInfo`) + conversions.
- `crates/raven/src/package_db/json_db.rs` — Tier 2 encoding (`RepoDb`, provenance, deterministic writer + reader) and `RepoDbProvider`.
- `crates/raven/src/package_db/binary_db.rs` — Tier 3 encoding (container writer + mmap reader) and `ShippedDbProvider`; typed `ShippedDbError`.
- `crates/raven/src/package_db/base_exports.rs` — base-exports file (built from reference R) reader + `initialize()` merge helper.
- `crates/raven/src/package_db/merge.rs` — append-only Tier 3 merge (prior ∪ reference-R ∪ r-universe, with precedence).
- `crates/raven/src/package_db/renv_lock.rs` — minimal `renv.lock` package-name reader.
- `crates/raven/src/package_db/runiverse.rs` — r-universe per-package JSON ingestion (CRAN + Bioc), build-side.
- `crates/raven/src/cli/packages.rs` — `raven packages {freeze,build-shipped-db}` entry points.
- `crates/raven/tests/package_db_consumer.rs` — no-R consumer integration test (§14).

**New files (other):**
- `.github/workflows/build-names-db.yml` — Tier 3 build/refresh job (fetch CRAN+Bioc, build, publish to the `names-db` Release).
- `crates/raven/tests/fixtures/package_db/runiverse/{cran,bioc}/*.json` — sample r-universe JSON (both hosts) for ingester tests.
- `crates/raven/tests/fixtures/package_db/packages.json` — committed Tier 2 back-compat fixture (decision #15).
- `crates/raven/tests/fixtures/package_db/names.db` — committed Tier 3 back-compat fixture (decision #15).
- `docs/package-database.md` — new user doc.
- `tests/bun/packages-freeze-command.test.ts` — VS Code command-contribution drift test.

**Modified files (Rust):**
- `crates/raven/Cargo.toml` — add `memmap2`, `postcard`.
- `crates/raven/src/lib.rs` and `crates/raven/src/main.rs` — declare `package_db`; `main.rs` also gains the `packages` dispatch arm.
- `crates/raven/src/cli/mod.rs` — `pub mod packages;`.
- `crates/raven/src/package_library.rs` — `providers` field + setter; `resolve_from_providers`; **`get_package` provider hook (the only seam change; `prefetch_packages` is untouched — decision #12)**; split `build_library_inner` / `build_package_library_tier1_only` / `build_package_library` (decision #6); base-exports merge in `initialize()` (decision #7); installed-package enumeration helper.
- `crates/raven/src/cli/check.rs` — `--report-uninstalled` flag + default suppression.

**Modified files (TS/docs/config):**
- `editors/vscode/src/extension.ts` — register `raven.packages.freeze`.
- `editors/vscode/package.json` — contribute the command; bundle `names.db`.
- `editors/vscode/scripts/bundle-binary.js`, `editors/vscode/.vscodeignore` — include `names.db`.
- `.github/workflows/release-build.yml` — place `names.db` next to binary + into VSIX.
- `docs/cli.md`, `docs/diagnostics.md`, `docs/cross-file.md`, `docs/r-package-dev.md`, `CLAUDE.md` doc-map.

**Design boundaries:** Tier 1 logic in `package_library.rs` is not moved or rewritten. The `package_db` module owns all encoding/decoding; `package_library.rs` only gains the seam (trait field + two fallback hooks). `package_exists()` is never touched to consult providers.

---

# Milestone 1 — `package_db` shared spine

Goal: one serializable record, two encodings, one reader each, with fixtures — all standalone and unit-tested before any consumer wiring.

### Task 1.1: Add dependencies and declare the module

**Files:**
- Modify: `crates/raven/Cargo.toml`
- Modify: `crates/raven/src/lib.rs`
- Modify: `crates/raven/src/main.rs`
- Create: `crates/raven/src/package_db/mod.rs`

- [ ] **Step 1: Add dependencies**

In `crates/raven/Cargo.toml`, under `[dependencies]` (alongside the existing `blake3 = "1"` at line 17 and `serde`/`serde_json` at lines 22–23), add:

```toml
memmap2 = "0.9"
postcard = { version = "1", features = ["use-std"] }
```

- [ ] **Step 2: Create the module root**

Create `crates/raven/src/package_db/mod.rs`:

```rust
//! Pre-built package-export databases for tiered, R-free export resolution.
//!
//! This module owns everything that lets Raven resolve package **export names**
//! without an installed package or a running R: one serializable record
//! ([`model::PackageRecord`]) and two on-disk encodings that decode back into the
//! existing [`crate::package_library::PackageInfo`]:
//!
//! - **Tier 2** ([`json_db`]): a committed, diff-friendly `.raven/packages.json`
//!   the user generates locally (`raven packages freeze`). "Frozen Tier 1".
//! - **Tier 3** ([`binary_db`]): a Raven-bundled, memory-mapped `names.db` built
//!   from r-universe latest. Export-only; the R-free floor.
//!
//! Consumers query these through the [`PackageMetadataProvider`] seam, which
//! `PackageLibrary` consults in tier order **after** the installed (Tier 1) path
//! misses. Providers feed *export resolution* only; they never affect
//! install-status (the missing-package diagnostic), which stays Tier-1-only.

pub mod binary_db;
pub mod json_db;
pub mod model;
pub mod renv_lock;
pub mod runiverse;

use crate::package_library::PackageInfo;

/// A source of pre-built package metadata, consulted in tier order when the
/// installed (Tier 1) path does not resolve a package.
///
/// Implementations are pure, synchronous reads of pre-built data (an in-memory
/// map for Tier 2, a memory-mapped + lazily-decoded payload for Tier 3). They
/// MUST NOT block or perform I/O beyond a memory-mapped read, because the async
/// resolution path that calls them must stay cheap.
pub trait PackageMetadataProvider: Send + Sync {
    /// Return this source's `PackageInfo` for `name`, or `None` if it does not
    /// know the package.
    fn lookup(&self, name: &str) -> Option<PackageInfo>;
}
```

- [ ] **Step 3: Declare the module in both crate roots**

In `crates/raven/src/lib.rs`, add after the `pub mod package_library;` line (alphabetical neighborhood):

```rust
pub mod package_db;
```

In `crates/raven/src/main.rs`, add after the `mod package_library;` line:

```rust
mod package_db;
```

(Invariant: a new top-level `raven`-crate module must be declared in **both** roots.)

- [ ] **Step 4: Build to verify the module tree compiles**

Run: `cargo build -p raven`
Expected: compiles (empty submodules will exist after Task 1.2+; if building before they exist, temporarily comment the `pub mod` lines — but prefer doing Task 1.2 model first). To avoid an intermediate broken build, create empty stub files now:

```bash
cd crates/raven/src/package_db
: > model.rs ; : > json_db.rs ; : > binary_db.rs ; : > renv_lock.rs ; : > runiverse.rs
```

Run: `cargo build -p raven`
Expected: PASS (empty modules compile).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/Cargo.toml crates/raven/src/lib.rs crates/raven/src/main.rs crates/raven/src/package_db/
git commit -m "feat(package_db): scaffold module + add memmap2/postcard deps"
```

---

### Task 1.2: `PackageRecord` model + conversions

**Files:**
- Modify: `crates/raven/src/package_db/model.rs`
- Test: inline `#[cfg(test)]` in the same file

- [ ] **Step 1: Write the failing test**

Put this in `crates/raven/src/package_db/model.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_library::PackageInfo;
    use std::collections::HashSet;

    #[test]
    fn record_round_trips_through_package_info_and_sorts() {
        let info = PackageInfo::with_details(
            "dplyr".to_string(),
            HashSet::from(["mutate".to_string(), "filter".to_string(), "filter".to_string()]),
            vec!["R".to_string()],
            vec!["starwars".to_string()],
        );

        let rec = PackageRecord::from_info(&info);
        // Exports are sorted and de-duplicated for deterministic encoding.
        assert_eq!(rec.exports, vec!["filter".to_string(), "mutate".to_string()]);
        assert_eq!(rec.name, "dplyr");

        let back = rec.clone().into_info();
        assert_eq!(back.name, "dplyr");
        assert_eq!(back.exports, HashSet::from(["mutate".to_string(), "filter".to_string()]));
        assert_eq!(back.depends, vec!["R".to_string()]);
        assert_eq!(back.lazy_data, vec!["starwars".to_string()]);
    }

    #[test]
    fn meta_package_fields_are_rederived_not_stored() {
        // tidyverse is a known meta-package; attached_packages must come back
        // even though PackageRecord never stores them.
        let info = PackageInfo::new("tidyverse".to_string(), HashSet::new());
        let back = PackageRecord::from_info(&info).into_info();
        assert!(back.is_meta_package);
        assert!(!back.attached_packages.is_empty());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven package_db::model`
Expected: FAIL — `PackageRecord` not defined.

- [ ] **Step 3: Write the implementation**

At the top of `crates/raven/src/package_db/model.rs` (above the test module):

```rust
//! The on-disk projection of [`PackageInfo`] shared by both encodings.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::package_library::PackageInfo;

/// On-disk record for one package, shared by the Tier 2 (JSON) and Tier 3
/// (binary) encodings.
///
/// Vectors are kept **sorted and de-duplicated** so the Tier 2 JSON is
/// deterministic and diff-friendly (a `git diff` then shows "package gained
/// export X"). `is_meta_package` / `attached_packages` are a pure function of
/// the package name (see `meta_package_fields`), so they are re-derived on read
/// via `PackageInfo::with_details` rather than stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageRecord {
    pub name: String,
    /// Sorted, de-duplicated export names.
    pub exports: Vec<String>,
    /// Sorted, de-duplicated `Depends` package names.
    pub depends: Vec<String>,
    /// Sorted, de-duplicated dataset (lazy-data) names.
    pub lazy_data: Vec<String>,
}

fn sorted_unique<I: IntoIterator<Item = String>>(items: I) -> Vec<String> {
    let mut v: Vec<String> = items.into_iter().collect();
    v.sort_unstable();
    v.dedup();
    v
}

impl PackageRecord {
    /// Build a record from a fully-resolved `PackageInfo` (e.g. the Tier 1
    /// authoritative result), normalizing all vectors to sorted/unique.
    pub fn from_info(info: &PackageInfo) -> Self {
        Self {
            name: info.name.clone(),
            exports: sorted_unique(info.exports.iter().cloned()),
            depends: sorted_unique(info.depends.iter().cloned()),
            lazy_data: sorted_unique(info.lazy_data.iter().cloned()),
        }
    }

    /// Decode this record back into a `PackageInfo`. `with_details` re-derives
    /// `is_meta_package` / `attached_packages` from the name.
    pub fn into_info(self) -> PackageInfo {
        PackageInfo::with_details(
            self.name,
            self.exports.into_iter().collect::<HashSet<String>>(),
            self.depends,
            self.lazy_data,
        )
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p raven package_db::model`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_db/model.rs
git commit -m "feat(package_db): PackageRecord model with sorted, name-derived conversions"
```

---

### Task 1.3: Tier 2 JSON encoding (deterministic writer + reader)

**Files:**
- Modify: `crates/raven/src/package_db/json_db.rs`
- Test: inline `#[cfg(test)]`

> **REVISED (decisions #9, #11).** Two changes to the code shown below in this task:
> 1. **`schema_version`.** Add `pub const REPO_DB_SCHEMA_VERSION: u32 = 1;` and a `pub schema_version: u32` field on `RepoDb` (first field; `write_repo_db_string` sets it to the const). The reader checks it.
> 2. **Typed errors, not `anyhow`.** Replace the reader's return type with a typed error so the surface can explain-and-continue:
> ```rust
> #[derive(Debug)]
> pub enum RepoDbError {
>     /// File is not present — normal, callers stay silent.
>     Absent,
>     /// File present but written by an incompatible schema.
>     UnsupportedSchema { found: u32, supported: u32 },
>     /// File present but unparseable / corrupt.
>     Corrupt(String),
> }
> impl std::fmt::Display for RepoDbError {
>     fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
>         match self {
>             RepoDbError::Absent => write!(f, "no .raven/packages.json present"),
>             RepoDbError::UnsupportedSchema { found, supported } => write!(
>                 f,
>                 ".raven/packages.json was generated by a newer Raven (schema v{found}); \
>                  this Raven understands schema v{supported}. Upgrade Raven here, or regenerate \
>                  with `raven packages freeze`. Falling back to the bundled database."
>             ),
>             RepoDbError::Corrupt(d) => write!(f, ".raven/packages.json is unreadable: {d}"),
>         }
>     }
> }
> ```
> `read_repo_db_file` returns `Result<RepoDb, RepoDbError>` (maps a missing file to `Absent`, a serde failure to `Corrupt`, and a `schema_version > REPO_DB_SCHEMA_VERSION` to `UnsupportedSchema`). `RepoDbProvider::from_file` returns `Result<Option<Self>, RepoDbError>` — `Ok(None)` for `Absent`, `Err(e)` for the loud cases — and the caller (Task 3.1) surfaces `Err` via the explain-and-continue path. The round-trip and determinism tests below still apply; add a test asserting a doctored `schema_version: 999` yields `RepoDbError::UnsupportedSchema`.

- [ ] **Step 1: Write the failing test**

In `crates/raven/src/package_db/json_db.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_db::model::PackageRecord;

    fn sample() -> RepoDb {
        RepoDb {
            provenance: RepoDbProvenance {
                raven_version: "9.9.9".into(),
                r_version: "4.4.0".into(),
                generated_unix: 1_700_000_000,
            },
            // intentionally out of order to prove the writer sorts.
            packages: vec![
                PackageRecord { name: "dplyr".into(), exports: vec!["mutate".into()], depends: vec![], lazy_data: vec![] },
                PackageRecord { name: "cli".into(), exports: vec!["cli_alert".into()], depends: vec![], lazy_data: vec![] },
            ],
        }
    }

    #[test]
    fn write_then_read_round_trips() {
        let db = sample();
        let text = write_repo_db_string(&db);
        let parsed = read_repo_db_str(&text).unwrap();
        assert_eq!(parsed.packages.len(), 2);
        // packages are sorted by name on write.
        assert_eq!(parsed.packages[0].name, "cli");
        assert_eq!(parsed.packages[1].name, "dplyr");
        assert_eq!(parsed.provenance.r_version, "4.4.0");
    }

    #[test]
    fn write_is_deterministic_for_same_content() {
        let a = write_repo_db_string(&sample());
        let b = write_repo_db_string(&sample());
        assert_eq!(a, b, "same content must serialize to identical bytes");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven package_db::json_db`
Expected: FAIL — `RepoDb` not defined.

- [ ] **Step 3: Write the implementation**

At the top of `crates/raven/src/package_db/json_db.rs`:

```rust
//! Tier 2 encoding: a committed, deterministic, diff-friendly `.raven/packages.json`.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::package_db::model::PackageRecord;
use crate::package_db::PackageMetadataProvider;
use crate::package_library::PackageInfo;

/// Minimal provenance recorded in the Tier 2 file — for debuggability only.
/// No drift-detection: regeneration is a manual command (spec §7.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoDbProvenance {
    pub raven_version: String,
    pub r_version: String,
    /// Generation time as Unix epoch seconds. (Raven has no date-formatting
    /// dependency; epoch seconds satisfy "record the generation date".)
    pub generated_unix: u64,
}

/// The full Tier 2 document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoDb {
    pub provenance: RepoDbProvenance,
    /// Sorted by package name on write for deterministic, diff-friendly output.
    pub packages: Vec<PackageRecord>,
}

/// Serialize to the canonical pretty JSON string. Packages are sorted by name;
/// each record's vectors are already sorted (`PackageRecord::from_info`).
pub fn write_repo_db_string(db: &RepoDb) -> String {
    let mut sorted = db.clone();
    sorted.packages.sort_by(|a, b| a.name.cmp(&b.name));
    // to_string_pretty is stable for a Vec; struct field order is the declared
    // order. Content equality ⇒ byte equality.
    serde_json::to_string_pretty(&sorted).expect("RepoDb serializes")
}

/// Write the canonical JSON to `path`, creating the parent directory.
pub fn write_repo_db_file(path: &Path, db: &RepoDb) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut text = write_repo_db_string(db);
    text.push('\n'); // trailing newline for clean diffs
    std::fs::write(path, text)
}

/// Parse a Tier 2 document from a string.
pub fn read_repo_db_str(text: &str) -> anyhow::Result<RepoDb> {
    Ok(serde_json::from_str(text)?)
}

/// Parse a Tier 2 document from a file path.
pub fn read_repo_db_file(path: &Path) -> anyhow::Result<RepoDb> {
    let text = std::fs::read_to_string(path)?;
    read_repo_db_str(&text)
}

/// Tier 2 provider: an in-memory map over a loaded `RepoDb`.
pub struct RepoDbProvider {
    by_name: HashMap<String, PackageRecord>,
}

impl RepoDbProvider {
    pub fn from_db(db: RepoDb) -> Self {
        let by_name = db.packages.into_iter().map(|r| (r.name.clone(), r)).collect();
        Self { by_name }
    }

    /// Load from a `.raven/packages.json` file; returns `None` (with a logged
    /// warning) if the file is absent or unparseable.
    pub fn from_file(path: &Path) -> Option<Self> {
        match read_repo_db_file(path) {
            Ok(db) => Some(Self::from_db(db)),
            Err(e) => {
                log::warn!("Failed to read repo package DB at {:?}: {}", path, e);
                None
            }
        }
    }
}

impl PackageMetadataProvider for RepoDbProvider {
    fn lookup(&self, name: &str) -> Option<PackageInfo> {
        self.by_name.get(name).map(|r| r.clone().into_info())
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p raven package_db::json_db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_db/json_db.rs
git commit -m "feat(package_db): Tier 2 JSON encoding + RepoDbProvider"
```

---

### Task 1.4: Tier 3 binary container — writer + mmap reader

**Files:**
- Modify: `crates/raven/src/package_db/binary_db.rs`
- Test: inline `#[cfg(test)]`

> **REVISED (decisions #9, #13).** `ShippedDb::open` returns a **typed** error so a stale `RAVEN_NAMES_DB`/seed file is explained, not silently dropped:
> ```rust
> #[derive(Debug)]
> pub enum ShippedDbError {
>     Absent,                                            // no file → silent
>     UnsupportedFormat { found: u32, supported: u32 },  // FORMAT_VERSION mismatch
>     Corrupt(String),                                   // bad magic, checksum mismatch, decode failure
> }
> ```
> (`bad magic` / `checksum mismatch` / `header decode` all map to `Corrupt`; a version mismatch maps to `UnsupportedFormat`; a missing file maps to `Absent`.) The blake3 verification in `open` stays as written. **Off-thread open (decision #13):** `ShippedDb::open` itself is synchronous; the *caller* in `build_package_library` (Task 3.1) wraps it in `spawn_blocking` so the mmap + ~10–20 ms hash never sits on the async runtime. The round-trip / bad-magic / tamper tests below still apply.

- [ ] **Step 1: Write the failing test**

In `crates/raven/src/package_db/binary_db.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_db::model::PackageRecord;
    use crate::package_db::PackageMetadataProvider;

    fn records() -> Vec<PackageRecord> {
        vec![
            PackageRecord { name: "dplyr".into(), exports: vec!["filter".into(), "mutate".into()], depends: vec!["R".into()], lazy_data: vec!["starwars".into()] },
            PackageRecord { name: "ggplot2".into(), exports: vec!["aes".into(), "ggplot".into()], depends: vec![], lazy_data: vec![] },
        ]
    }

    fn provenance() -> ShippedDbProvenance {
        ShippedDbProvenance { source: "test".into(), snapshot_date: "2026-05-30".into(), package_count: 2, raven_version: "9.9.9".into() }
    }

    #[test]
    fn write_open_lookup_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("names.db");
        write_shipped_db(&path, &records(), provenance()).unwrap();

        let db = ShippedDb::open(&path).unwrap();
        let dplyr = db.lookup("dplyr").expect("dplyr present");
        assert!(dplyr.exports.contains("mutate"));
        assert_eq!(dplyr.depends, vec!["R".to_string()]);
        assert!(db.lookup("nonexistent").is_none());
        assert_eq!(db.provenance().snapshot_date, "2026-05-30");
    }

    #[test]
    fn rejects_bad_magic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.db");
        std::fs::write(&path, b"NOT A RAVEN DB").unwrap();
        assert!(ShippedDb::open(&path).is_err());
    }

    #[test]
    fn detects_payload_tampering() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("names.db");
        write_shipped_db(&path, &records(), provenance()).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        // Flip a byte in the payload region (the last byte is safely in payload).
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        std::fs::write(&path, &bytes).unwrap();
        assert!(ShippedDb::open(&path).is_err(), "checksum mismatch must be rejected");
    }
}
```

(Confirm `tempfile` is a dev-dependency: `grep -n tempfile crates/raven/Cargo.toml`. It is used by existing integration tests; if it is not under `[dev-dependencies]`, add `tempfile = "3"` there in this step.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven package_db::binary_db`
Expected: FAIL — `ShippedDb` / `write_shipped_db` not defined.

- [ ] **Step 3: Write the implementation**

At the top of `crates/raven/src/package_db/binary_db.rs`:

```rust
//! Tier 3 encoding: a compact, memory-mapped, lazily-decoded `names.db`.
//!
//! Layout (all multibyte integers little-endian):
//!
//! ```text
//! MAGIC        8 bytes  = b"RAVNDB\0\0"
//! version      u32      = FORMAT_VERSION
//! header_len   u32      = byte length of the postcard-encoded header
//! header       header_len bytes (postcard ShippedDbHeader: provenance + checksum + index)
//! payload      rest of file (postcard PackageRecord per package, concatenated)
//! ```
//!
//! The header is decoded **once at open** (the "preload the index" of spec §12);
//! per-package payloads stay in the mmap and are postcard-decoded **lazily** on
//! lookup, off the LSP hot path. Integrity: a `blake3` hash of the payload region
//! is stored in the header and verified at open.

use std::collections::HashMap;
use std::path::Path;

use memmap2::Mmap;
use serde::{Deserialize, Serialize};

use crate::package_db::model::PackageRecord;
use crate::package_db::PackageMetadataProvider;
use crate::package_library::PackageInfo;

const MAGIC: &[u8; 8] = b"RAVNDB\0\0";
const FORMAT_VERSION: u32 = 1;

/// Provenance + integrity for the shipped DB (spec §8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShippedDbProvenance {
    pub source: String,
    pub snapshot_date: String,
    pub package_count: u32,
    pub raven_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexEntry {
    name: String,
    /// Offset of this package's payload, relative to the start of the payload region.
    offset: u64,
    len: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ShippedDbHeader {
    provenance: ShippedDbProvenance,
    /// blake3 hex of the payload region.
    payload_checksum: String,
    index: Vec<IndexEntry>,
}

/// Write `records` (need not be pre-sorted) to a Tier 3 container at `path`.
pub fn write_shipped_db(
    path: &Path,
    records: &[PackageRecord],
    provenance: ShippedDbProvenance,
) -> anyhow::Result<()> {
    let mut sorted: Vec<&PackageRecord> = records.iter().collect();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));

    let mut payload: Vec<u8> = Vec::new();
    let mut index: Vec<IndexEntry> = Vec::with_capacity(sorted.len());
    for rec in sorted {
        let bytes = postcard::to_stdvec(rec)?;
        let offset = payload.len() as u64;
        let len = bytes.len() as u32;
        payload.extend_from_slice(&bytes);
        index.push(IndexEntry { name: rec.name.clone(), offset, len });
    }

    let payload_checksum = blake3::hash(&payload).to_hex().to_string();
    let header = ShippedDbHeader { provenance, payload_checksum, index };
    let header_bytes = postcard::to_stdvec(&header)?;

    let mut out: Vec<u8> = Vec::with_capacity(16 + header_bytes.len() + payload.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(&payload);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, &out)?;
    Ok(())
}

/// An opened, memory-mapped Tier 3 database.
pub struct ShippedDb {
    mmap: Mmap,
    /// payload region start, as an absolute file offset.
    payload_start: usize,
    provenance: ShippedDbProvenance,
    /// name -> (payload-relative offset, len)
    index: HashMap<String, (u64, u32)>,
}

impl ShippedDb {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let file = std::fs::File::open(path)?;
        // SAFETY: the file is opened read-only; we treat the mapping as immutable
        // bytes. (A concurrent external truncation could fault — acceptable for a
        // release-bundled, read-only sidecar.)
        let mmap = unsafe { Mmap::map(&file)? };

        if mmap.len() < 16 || &mmap[0..8] != MAGIC {
            anyhow::bail!("not a Raven names.db (bad magic)");
        }
        let version = u32::from_le_bytes(mmap[8..12].try_into().unwrap());
        if version != FORMAT_VERSION {
            anyhow::bail!("unsupported names.db format version {version}");
        }
        let header_len = u32::from_le_bytes(mmap[12..16].try_into().unwrap()) as usize;
        let header_start = 16;
        let payload_start = header_start + header_len;
        if payload_start > mmap.len() {
            anyhow::bail!("names.db header length exceeds file size");
        }
        let header: ShippedDbHeader = postcard::from_bytes(&mmap[header_start..payload_start])?;

        let payload = &mmap[payload_start..];
        let actual = blake3::hash(payload).to_hex().to_string();
        if actual != header.payload_checksum {
            anyhow::bail!("names.db payload checksum mismatch (corrupt or tampered)");
        }

        let index = header
            .index
            .iter()
            .map(|e| (e.name.clone(), (e.offset, e.len)))
            .collect();

        Ok(Self { mmap, payload_start, provenance: header.provenance, index })
    }

    pub fn provenance(&self) -> &ShippedDbProvenance {
        &self.provenance
    }

    /// Decode one package's record, lazily, from the mmap.
    pub fn lookup(&self, name: &str) -> Option<PackageInfo> {
        let (offset, len) = *self.index.get(name)?;
        let start = self.payload_start + offset as usize;
        let end = start + len as usize;
        let slice = self.mmap.get(start..end)?;
        match postcard::from_bytes::<PackageRecord>(slice) {
            Ok(rec) => Some(rec.into_info()),
            Err(e) => {
                log::warn!("names.db: failed to decode '{}': {}", name, e);
                None
            }
        }
    }
}

/// Tier 3 provider over an opened `ShippedDb`.
pub struct ShippedDbProvider {
    db: ShippedDb,
}

impl ShippedDbProvider {
    pub fn new(db: ShippedDb) -> Self {
        Self { db }
    }

    /// Open a `names.db` file as a provider; returns `None` (logged) on failure.
    pub fn from_file(path: &Path) -> Option<Self> {
        match ShippedDb::open(path) {
            Ok(db) => Some(Self::new(db)),
            Err(e) => {
                log::warn!("Failed to open shipped package DB at {:?}: {}", path, e);
                None
            }
        }
    }
}

impl PackageMetadataProvider for ShippedDbProvider {
    fn lookup(&self, name: &str) -> Option<PackageInfo> {
        self.db.lookup(name)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p raven package_db::binary_db`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_db/binary_db.rs crates/raven/Cargo.toml
git commit -m "feat(package_db): Tier 3 mmap container writer/reader + integrity check"
```

---

### Task 1.5: `names.db` location helper (exe-relative + env override)

**Files:**
- Modify: `crates/raven/src/package_db/mod.rs`
- Test: inline `#[cfg(test)]` in `mod.rs`

- [ ] **Step 1: Write the failing test**

Append to `crates/raven/src/package_db/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_wins_over_exe_relative() {
        // RAVEN_NAMES_DB, when set, is returned verbatim.
        std::env::set_var("RAVEN_NAMES_DB", "/tmp/custom-names.db");
        let p = locate_shipped_db().expect("override path");
        assert_eq!(p, std::path::PathBuf::from("/tmp/custom-names.db"));
        std::env::remove_var("RAVEN_NAMES_DB");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven package_db::tests::env_override_wins`
Expected: FAIL — `locate_shipped_db` not defined.

- [ ] **Step 3: Write the implementation**

Add to `crates/raven/src/package_db/mod.rs` (above the test module):

```rust
use std::path::PathBuf;

/// Resolve the bundled `names.db` path.
///
/// Order: the `RAVEN_NAMES_DB` environment variable (used by tests and custom
/// layouts), else a file named `names.db` next to the current executable (where
/// both the standalone CLI and the VS Code extension bundle it). Returns `None`
/// if neither yields a path (existence is checked by the caller via the
/// provider's `from_file`, which logs and returns `None` if the file is absent).
pub fn locate_shipped_db() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("RAVEN_NAMES_DB") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("names.db"))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p raven package_db::tests::env_override_wins`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_db/mod.rs
git commit -m "feat(package_db): exe-relative names.db location with RAVEN_NAMES_DB override"
```

---

# Milestone 2 — Ordered-resolution seam (no behavior change)

Goal: introduce the `PackageMetadataProvider` seam into `PackageLibrary` with an **empty** provider list, refactor `get_package` and `prefetch_packages` to consult it after a Tier-1 miss, and prove Tier 1 behavior is unchanged. This is the "abstraction first" milestone (Codex review).

### Task 2.1: Add the `providers` field + setter to `PackageLibrary`

**Files:**
- Modify: `crates/raven/src/package_library.rs` (struct at `:181`, constructors `new_empty` `:210`, `with_subprocess` `:229`, `new` `:914`)
- Test: inline `#[cfg(test)]` in `package_library.rs` (existing test module at `:1646`)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `crates/raven/src/package_library.rs`:

```rust
    #[tokio::test]
    async fn providers_default_empty_and_settable() {
        use crate::package_db::PackageMetadataProvider;
        use crate::package_library::PackageInfo;
        use std::collections::HashSet;

        struct Fake;
        impl PackageMetadataProvider for Fake {
            fn lookup(&self, name: &str) -> Option<PackageInfo> {
                if name == "fakepkg" {
                    Some(PackageInfo::new("fakepkg".into(), HashSet::from(["zzz".into()])))
                } else {
                    None
                }
            }
        }

        let mut lib = PackageLibrary::new_empty();
        assert!(lib.has_no_providers());
        lib.set_providers(vec![Box::new(Fake)]);
        assert!(!lib.has_no_providers());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven providers_default_empty_and_settable`
Expected: FAIL — `set_providers` / `has_no_providers` not defined.

- [ ] **Step 3: Write the implementation**

In `crates/raven/src/package_library.rs`, add a `use` near the top (with the other `use crate::...` imports):

```rust
use crate::package_db::PackageMetadataProvider;
```

Add the field to the `PackageLibrary` struct (after the `r_subprocess` field at `:200`):

```rust
    /// Ordered fallback metadata providers (Tier 2 repo DB, then Tier 3 shipped
    /// DB), consulted only when the installed (Tier 1) path does not resolve a
    /// package. Empty by default; populated by `build_package_library`. These
    /// feed export resolution only — never `package_exists()` (install status).
    providers: Vec<Box<dyn PackageMetadataProvider>>,
```

Initialize `providers: Vec::new(),` in all three constructors: `new_empty` (`:210`), `with_subprocess` (`:229`), and `new` (`:914`). (Each builds the struct literal; add the field to each.)

Add these methods to `impl PackageLibrary` (near the `r_subprocess` accessor at `:272`):

```rust
    /// Replace the ordered fallback providers (tier order: index 0 first).
    pub fn set_providers(&mut self, providers: Vec<Box<dyn PackageMetadataProvider>>) {
        self.providers = providers;
    }

    /// True when no fallback providers are configured (the common Tier-1-only case).
    pub fn has_no_providers(&self) -> bool {
        self.providers.is_empty()
    }

    /// Consult the fallback providers (Tier 2 → Tier 3) in order; return the
    /// first source that knows `name`. Pure, synchronous reads.
    fn resolve_from_providers(&self, name: &str) -> Option<PackageInfo> {
        for provider in &self.providers {
            if let Some(info) = provider.lookup(name) {
                log::trace!("Package '{}' resolved from a fallback provider", name);
                return Some(info);
            }
        }
        None
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p raven providers_default_empty_and_settable`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_library.rs
git commit -m "feat(package_library): add empty PackageMetadataProvider seam"
```

---

### Task 2.2: Wire the provider fallback into `get_package`

**Files:**
- Modify: `crates/raven/src/package_library.rs` (`get_package` at `:1145`, specifically the "package dir not found" branch `:1155-1167`)
- Test: inline `#[cfg(test)]`

- [ ] **Step 1: Write the failing test**

Add to the test module:

```rust
    #[tokio::test]
    async fn get_package_falls_back_to_provider_when_not_installed() {
        use crate::package_db::PackageMetadataProvider;
        use std::collections::HashSet;

        struct Fake;
        impl PackageMetadataProvider for Fake {
            fn lookup(&self, name: &str) -> Option<PackageInfo> {
                (name == "fakepkg").then(|| PackageInfo::new("fakepkg".into(), HashSet::from(["zzz".into()])))
            }
        }

        // new_empty has no lib paths, so find_package_directory always misses.
        let mut lib = PackageLibrary::new_empty();
        lib.set_providers(vec![Box::new(Fake)]);

        let info = lib.get_package("fakepkg").await.expect("resolved via provider");
        assert!(info.exports.contains("zzz"));
        // Provider hits ARE cached.
        assert!(lib.is_cached("fakepkg").await);

        // A package no provider knows stays unresolved and uncached.
        assert!(lib.get_package("unknownpkg").await.is_none());
        assert!(!lib.is_cached("unknownpkg").await);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven get_package_falls_back_to_provider`
Expected: FAIL — `unknownpkg`/`fakepkg` not resolved (current code returns `None` unconditionally on a directory miss).

- [ ] **Step 3: Write the implementation**

In `get_package` (`:1155`), replace the existing "package dir not found" branch:

```rust
        // Step 2: Find package directory
        let pkg_dir = match self.find_package_directory(name) {
            Some(dir) => dir,
            None => {
                log::trace!(
                    "Package '{}' not found in any library path: {:?}",
                    name,
                    self.lib_paths
                );
                // Don't cache missing packages - return None directly so
                // package_exists() can correctly report the package as missing
                return None;
            }
        };
```

with:

```rust
        // Step 2: Find package directory
        let pkg_dir = match self.find_package_directory(name) {
            Some(dir) => dir,
            None => {
                // Tier 1 (installed) has no directory for this package. Fall
                // back through the ordered metadata providers (Tier 2 repo DB,
                // then Tier 3 shipped DB). The first provider that knows the
                // package wins and its PackageInfo IS cached. A package that no
                // provider knows is left uncached so `package_exists()` still
                // reports it missing (install status stays Tier-1-only).
                if let Some(info) = self.resolve_from_providers(name) {
                    self.insert_package(info).await;
                    return self.get_cached_package(name).await;
                }
                log::trace!(
                    "Package '{}' not found in any tier (libpaths: {:?})",
                    name,
                    self.lib_paths
                );
                return None;
            }
        };
```

- [ ] **Step 4: Run tests to verify they pass (and Tier 1 is unchanged)**

Run: `cargo test -p raven get_package_falls_back_to_provider`
Expected: PASS.

Run: `cargo test -p raven package_library`
Expected: PASS — all existing `package_library` tests still green (empty providers ⇒ no behavior change for the installed path).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_library.rs
git commit -m "feat(package_library): get_package consults providers on Tier-1 miss"
```

---

### Task 2.3: ~~Wire the provider fallback into `prefetch_packages`~~ — REMOVED (decision #12)

**This task is intentionally removed.** It was redundant: `prefetch_packages` Step 3 already calls `get_all_exports(pkg)` for every uncached loaded package, and `get_all_exports → collect_exports_recursive → get_package` ([package_library.rs:1487](crates/raven/src/package_library.rs:1487)) routes through the provider-aware `get_package` (Task 2.2) — recursing into `Depends` and meta-package `attached_packages` (`:1521`). So Tier 2/3 packages, their `Depends` chains, and meta-package attaches (`library(tidyverse)`) all warm into both the per-package cache **and** `combined_exports` with **no change to `prefetch_packages`**.

Add the verification test below to prove this (it would have been Task 2.3's test, but it now passes via the existing Step 3 path with only Task 2.2 in place):

```rust
    #[tokio::test]
    async fn prefetch_warms_provider_packages_via_existing_step3() {
        use crate::package_db::PackageMetadataProvider;
        use std::collections::HashSet;

        struct Fake;
        impl PackageMetadataProvider for Fake {
            fn lookup(&self, name: &str) -> Option<PackageInfo> {
                (name == "dplyr").then(|| PackageInfo::new("dplyr".into(), HashSet::from(["mutate".into()])))
            }
        }

        let mut lib = PackageLibrary::new_empty();
        lib.set_providers(vec![Box::new(Fake)]);

        lib.prefetch_packages(&["dplyr".to_string(), "ggplot2".to_string()]).await;

        // dplyr resolved via the provider (through get_all_exports → get_package) and is cached.
        assert!(lib.is_cached("dplyr").await);
        assert!(lib.is_symbol_from_loaded_packages("mutate", &["dplyr".to_string()]));
        // ggplot2 is unknown to every tier; not cached.
        assert!(!lib.is_cached("ggplot2").await);
    }
```

Run: `cargo test -p raven prefetch_warms_provider_packages_via_existing_step3`
Expected: PASS with **only** Task 2.2's `get_package` hook in place (no `prefetch_packages` edit). Commit the test:

```bash
git add crates/raven/src/package_library.rs
git commit -m "test(package_library): prefetch warms Tier 2/3 via existing get_all_exports path"
```

---

### Task 2.4: Pin the install-status invariant — `package_exists` ignores providers

**Files:**
- Test: inline `#[cfg(test)]` in `crates/raven/src/package_library.rs`

This is a guard test only — no production change. `package_exists` (`:1393`) must remain filesystem/base-package only (spec §10).

- [ ] **Step 1: Write the test**

Add to the test module:

```rust
    #[tokio::test]
    async fn package_exists_never_consults_providers() {
        use crate::package_db::PackageMetadataProvider;
        use std::collections::HashSet;

        struct Fake;
        impl PackageMetadataProvider for Fake {
            fn lookup(&self, name: &str) -> Option<PackageInfo> {
                (name == "dplyr").then(|| PackageInfo::new("dplyr".into(), HashSet::from(["mutate".into()])))
            }
        }

        let mut lib = PackageLibrary::new_empty();
        lib.set_providers(vec![Box::new(Fake)]);

        // The provider KNOWS dplyr's exports, but it is not installed on disk.
        // package_exists answers "is it installed?", which stays Tier-1-only.
        assert!(!lib.package_exists("dplyr"));
    }
```

- [ ] **Step 2: Run the test to verify it passes immediately**

Run: `cargo test -p raven package_exists_never_consults_providers`
Expected: PASS (no production change needed — this pins existing behavior so future edits can't regress it).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/package_library.rs
git commit -m "test(package_library): pin package_exists install-status invariant vs providers"
```

---

# Milestone 3 — Tier 3 shipped DB: bundling, lookup, CI behavior split

Goal: wire the Tier 3 provider into library construction, locate the bundled `names.db`, prove the no-R consumer scenario, and split `raven check`'s missing-package default.

### Task 3.1: Split construction + wire providers (with off-thread open and explain-and-continue)

**Files:**
- Modify: `crates/raven/src/package_library.rs` (`build_package_library` at `:1612`)
- Test: inline `#[cfg(test)]`

**Design (decisions #6, #9, #13).** Refactor construction into three pieces so the *capture* path (freeze, and the Tier 3 build's reference-R seed) is **provider-less** while the *runtime* path wires providers:

- `async fn build_library_inner(r_path, additional_paths, workspace_root) -> (PackageLibrary, PackageLibraryStatus)` — the current `build_package_library` body **minus** the `packages_enabled` guard and minus provider wiring; returns the un-`Arc`'d `lib` so callers can still mutate it.
- `pub async fn build_package_library_tier1_only(r_path, additional_paths, workspace_root) -> PackageLibraryOutcome` — `build_library_inner` + `Arc::new`. No providers. Used by freeze (Task 5.4) and `build-shipped-db` (Task 4.2).
- `pub async fn build_package_library(r_path, additional_paths, workspace_root, packages_enabled) -> PackageLibraryOutcome` — unchanged 4-arg signature (existing callers in `backend.rs`/`cli/check.rs` untouched): keeps the `Disabled` early-return, calls `build_library_inner`, then wires providers and loads base-exports, then `Arc::new`.

Provider construction opens the DBs **in `spawn_blocking`** (decision #13) and surfaces a typed `Err` from an unreadable file so the caller can explain-and-continue (decision #9). It returns the providers **and** any `LoadNote`s (human-facing messages) the caller logs / shows.

- [ ] **Step 1: Write the failing test**

Add to the test module:

```rust
    #[tokio::test]
    async fn build_library_wires_shipped_db_provider_from_env() {
        use crate::package_db::binary_db::{write_shipped_db, ShippedDbProvenance};
        use crate::package_db::model::PackageRecord;

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("names.db");
        write_shipped_db(
            &db_path,
            &[PackageRecord { name: "dplyr".into(), exports: vec!["mutate".into()], depends: vec![], lazy_data: vec![] }],
            ShippedDbProvenance { source: "test".into(), snapshot_date: "2026-05-30".into(), package_count: 1, raven_version: "9.9.9".into() },
        )
        .unwrap();

        std::env::set_var("RAVEN_NAMES_DB", &db_path);
        let outcome = build_package_library(None, &[], None, true).await;   // runtime path → wires providers
        let outcome_t1 = build_package_library_tier1_only(None, &[], None).await; // capture path → no providers
        std::env::remove_var("RAVEN_NAMES_DB");

        assert!(outcome.library.get_package("dplyr").await.expect("Tier 3 resolves dplyr").exports.contains("mutate"));
        // Provider-less capture must NOT resolve dplyr from Tier 3.
        assert!(outcome_t1.library.get_package("dplyr").await.is_none());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven build_library_wires_shipped_db_provider_from_env`
Expected: FAIL — `build_package_library_tier1_only` undefined and `build_package_library` doesn't set providers.

- [ ] **Step 3: Write the implementation**

Refactor per the Design above. The provider-wiring block (in `build_package_library` only), run after `build_library_inner`:

```rust
    // Open the fallback DBs off the async runtime (mmap + ~10–20 ms blake3).
    let repo_db_path = workspace_root.as_ref().map(|r| r.join(".raven").join("packages.json"));
    let shipped_db_path = crate::package_db::locate_shipped_db();
    let (providers, notes) = tokio::task::spawn_blocking(move || {
        let mut providers: Vec<Box<dyn crate::package_db::PackageMetadataProvider>> = Vec::new();
        let mut notes: Vec<String> = Vec::new();

        // Tier 2 first (repo DB), then Tier 3 (shipped DB).
        if let Some(path) = repo_db_path {
            match crate::package_db::json_db::RepoDbProvider::from_file(&path) {
                Ok(Some(p)) => providers.push(Box::new(p)),
                Ok(None) => {}                                   // Absent → silent
                Err(e) => notes.push(e.to_string()),             // explain-and-continue
            }
        }
        if let Some(path) = shipped_db_path {
            match crate::package_db::binary_db::ShippedDbProvider::from_file(&path) {
                Ok(Some(p)) => providers.push(Box::new(p)),
                Ok(None) => {}
                Err(e) => notes.push(e.to_string()),
            }
        }
        (providers, notes)
    })
    .await
    .unwrap_or_else(|_| (Vec::new(), Vec::new()));

    for note in &notes {
        log::warn!("{note}");
    }
    lib.set_providers(providers);
```

`RepoDbProvider::from_file` / `ShippedDbProvider::from_file` now return `Result<Option<Self>, _Error>` (Tasks 1.3/1.4 REVISED). Expose the `notes` on `PackageLibraryOutcome` (add a `pub load_notes: Vec<String>` field) so `cli/check.rs` can print them to stderr and `backend.rs` can `window/showMessage` them (Task 3.5). Base-exports loading is Task 3.2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raven build_library_wires_shipped_db_provider_from_env`
Expected: PASS.

Run: `cargo test -p raven package_library`
Expected: PASS — existing build tests unaffected (no `names.db`/`.raven` present ⇒ empty providers; the 4-arg `build_package_library` signature is unchanged).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_library.rs
git commit -m "feat(package_library): split tier1-only vs runtime construction; wire providers off-thread"
```

---

### Task 3.2: No-R consumer integration test (§14)

**Files:**
- Create: `crates/raven/tests/fixtures/package_db/dplyr_min.json` (helper input is unnecessary — build the db in-test)
- Create: `crates/raven/tests/package_db_consumer.rs`

This validates the end-to-end §14 "no-R consumer fixture": empty libpaths + a Tier 3 db ⇒ `library(dplyr); mutate(df, x = 1)` yields no undefined-variable diagnostic.

- [ ] **Step 1: Write the failing test**

Create `crates/raven/tests/package_db_consumer.rs`:

```rust
//! End-to-end: with no R and empty libpaths, a Tier 3 `names.db` suppresses the
//! undefined-variable storm for package exports (spec §14, §10).

use raven::package_db::binary_db::{write_shipped_db, ShippedDbProvenance};
use raven::package_db::model::PackageRecord;
use raven::package_library::build_package_library;

#[tokio::test]
async fn tier3_resolves_export_with_no_r() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("names.db");
    write_shipped_db(
        &db_path,
        &[PackageRecord {
            name: "dplyr".into(),
            exports: vec!["filter".into(), "mutate".into()],
            depends: vec![],
            lazy_data: vec![],
        }],
        ShippedDbProvenance {
            source: "test".into(),
            snapshot_date: "2026-05-30".into(),
            package_count: 1,
            raven_version: "9.9.9".into(),
        },
    )
    .unwrap();

    std::env::set_var("RAVEN_NAMES_DB", &db_path);
    let outcome = build_package_library(None, &[], None, true).await;
    std::env::remove_var("RAVEN_NAMES_DB");

    let lib = &outcome.library;
    // Simulate the check-path warm: prefetch the loaded package.
    lib.prefetch_packages(&["dplyr".to_string()]).await;

    // The synchronous diagnostic hot path now sees mutate as a dplyr export.
    assert!(lib.is_symbol_from_loaded_packages("mutate", &["dplyr".to_string()]));
    assert_eq!(
        lib.find_package_for_symbol("mutate", &["dplyr".to_string()]),
        Some("dplyr".to_string())
    );
    // And dplyr is NOT considered installed (install status stays Tier-1-only).
    assert!(!lib.package_exists("dplyr"));
}
```

(Confirm the public API is reachable from an integration test: `build_package_library`, `package_db::*`, and `PackageLibrary` methods used here must be `pub`. They are, per the verified signatures. `tempfile` must be a dev-dependency — added in Task 1.4 if absent.)

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cargo test -p raven --test package_db_consumer`
Expected: PASS (all the production wiring landed in M1–M3; this test exists to lock the scenario). If it fails to compile due to a non-`pub` item, make the minimal item `pub` and note it.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/tests/package_db_consumer.rs
git commit -m "test(package_db): no-R consumer resolves exports via Tier 3"
```

---

### Task 3.3: `raven check --report-uninstalled` flag

**Files:**
- Modify: `crates/raven/src/cli/check.rs` (`CheckArgs` `:29`, `parse_args` `:48`, `print_help` `:102`, `run` `:142`)
- Test: inline `#[cfg(test)]` in `check.rs`

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `crates/raven/src/cli/check.rs`:

```rust
    #[test]
    fn parse_report_uninstalled_flag() {
        let args = parse_args(["--report-uninstalled".to_string()].into_iter()).unwrap();
        assert!(args.report_uninstalled);

        let default = parse_args(std::iter::empty()).unwrap();
        assert!(!default.report_uninstalled);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven parse_report_uninstalled_flag`
Expected: FAIL — `report_uninstalled` field/flag absent (and `--report-uninstalled` currently errors as an unknown flag).

- [ ] **Step 3: Write the implementation**

Add the field to `CheckArgs` (`:45`, after `color`):

```rust
    /// Re-enable the missing-package ("not installed") diagnostic in CI. By
    /// default `raven check` suppresses it because CI deliberately omits package
    /// installation. Reports `library()` calls absent from the local library
    /// paths — NOT relative to Tier 2/Tier 3 metadata (see docs/diagnostics.md).
    pub report_uninstalled: bool,
```

In `parse_args` (`:48`), add the local `let mut report_uninstalled = false;` with the other defaults, a match arm before the `s if s.starts_with("--")` catch-all:

```rust
            "--report-uninstalled" => report_uninstalled = true,
```

and include `report_uninstalled,` in the returned `Ok(CheckArgs { ... })`.

In `print_help` (`:128`, the "R / packages:" section), document it:

```
  --report-uninstalled        Report packages from library() calls that are not
                              present in the local library paths. Off by default
                              in CI; useful when the pipeline DID install packages
                              (e.g. renv::restore()) and you want to catch failures.
```

In `run` (`:175`, immediately after `build_indexed_state` returns `state`), suppress by default:

```rust
    // CI default: suppress the missing-package ("not installed") diagnostic,
    // because CI deliberately omits installation (spec §10.1). `recompute_parsed_configs`
    // already ran inside build_indexed_state; the CLI owns `state` exclusively, so a
    // direct field set here is safe. `--report-uninstalled` opts back in.
    if !args.report_uninstalled {
        state.cross_file_config.packages_missing_package_severity = None;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raven parse_report_uninstalled_flag`
Expected: PASS.

Run: `cargo test -p raven --lib cli::check`
Expected: PASS — existing check tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/cli/check.rs
git commit -m "feat(check): --report-uninstalled flag; suppress missing-package by default in CI"
```

---

### Task 3.4: Bundle `names.db` with the binary and VSIX

**Files:**
- Modify: `editors/vscode/scripts/bundle-binary.js`
- Modify: `editors/vscode/.vscodeignore`
- Modify: `.github/workflows/release-build.yml`

This is packaging config (no Rust unit test). Verification is by inspection + the bun manifest test in Task 5.5 era is unrelated; here we add a focused check that the bundle script references `names.db`.

- [ ] **Step 1: Make the bundle script copy `names.db` next to the binary**

In `editors/vscode/scripts/bundle-binary.js`, after the existing binary copy into `editors/vscode/bin/`, add a best-effort copy of `names.db` (built by the names-db workflow into the repo `dist`/`bin` staging area; absent in dev builds, which is fine — the extension degrades to Tier 1/2):

```js
// Bundle the Tier 3 package-export database next to the binary, if present.
// In dev builds it is usually absent (Tier 3 unavailable, which is fine).
const namesDbSrc = process.env.RAVEN_NAMES_DB_SRC
  || path.join(__dirname, '..', '..', '..', 'dist', 'names.db');
const namesDbDest = path.join(binDir, 'names.db');
if (fs.existsSync(namesDbSrc)) {
  fs.copyFileSync(namesDbSrc, namesDbDest);
  console.log(`Bundled names.db from ${namesDbSrc}`);
} else {
  console.log('names.db not found; Tier 3 will be unavailable in this build');
}
```

- [ ] **Step 2: Ensure `.vscodeignore` does not exclude it**

In `editors/vscode/.vscodeignore`, confirm `bin/` is not excluded (it is not, per the verified file) and add an explicit keep comment if helpful. `bin/names.db` ships in the VSIX alongside `bin/raven`.

> **REVISED (decisions #7, #14).** Bundle **both** `names.db` and the base-exports file (`base-exports.json`), and fetch them from the **GitHub Release** (tag `names-db`), not from a per-run artifact. The bundle script copies both into `editors/vscode/bin/`; the consumer resolves both exe-relative (Tasks 1.5 / 3.5).

- [ ] **Step 3: Download `names.db` + base-exports from the GitHub Release in the release workflow**

In `.github/workflows/release-build.yml`, before archiving the Rust binary and before `vsce package`, download the current Release assets and stage them in `dist/`, then point `RAVEN_NAMES_DB_SRC` (and a sibling for base-exports) at them:

```yaml
      - name: Download package DB from the names-db Release
        run: |
          mkdir -p dist
          gh release download names-db --repo "$GITHUB_REPOSITORY" \
            --pattern 'names.db' --pattern 'base-exports.json' --dir dist || \
            echo "no names-db release yet; Tier 3 unavailable in this build"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`bundle-binary.js` copies `dist/names.db` and `dist/base-exports.json` into `editors/vscode/bin/` (extend Step 1 to copy `base-exports.json` the same best-effort way). For the standalone CLI archive, copy both into `dist/` next to the binary so exe-relative resolution finds them.

- [ ] **Step 4: Verify the bundle script parses**

Run: `node --check editors/vscode/scripts/bundle-binary.js`
Expected: no syntax error.

- [ ] **Step 5: Commit**

```bash
git add editors/vscode/scripts/bundle-binary.js editors/vscode/.vscodeignore .github/workflows/release-build.yml
git commit -m "build: bundle names.db + base-exports from the names-db Release into binary and VSIX"
```

---

### Task 3.5: Load the base-exports file in `initialize()` (decision #7)

**Files:**
- Modify: `crates/raven/src/package_db/base_exports.rs`
- Modify: `crates/raven/src/package_db/mod.rs` (a `locate_base_exports()` helper mirroring `locate_shipped_db`, env override `RAVEN_BASE_EXPORTS`)
- Modify: `crates/raven/src/package_library.rs` (`initialize` at `:946`)
- Test: inline `#[cfg(test)]`

**Why:** base/recommended exports (and base **datasets** like `mtcars`/`iris`) are loaded from disk in `initialize()` (`:982-1041`). In CI with no R/library tree that set is empty, so base datasets — and any base export not in the hardcoded `builtins` list — go unresolved. The base-exports file (built from the reference R, Task 4.2) supplies them. A real install still wins (loaded only when the base packages aren't on disk).

- [ ] **Step 1: Write the failing test**

```rust
    #[tokio::test]
    async fn initialize_loads_base_exports_file_when_disk_absent() {
        use crate::package_db::json_db::{write_repo_db_file, RepoDb, RepoDbProvenance};
        use crate::package_db::model::PackageRecord;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("base-exports.json");
        // 'datasets' base package contributing the mtcars dataset name.
        write_repo_db_file(&path, &RepoDb {
            schema_version: crate::package_db::json_db::REPO_DB_SCHEMA_VERSION,
            provenance: RepoDbProvenance { raven_version: "t".into(), r_version: "4.4.0".into(), generated_unix: 0 },
            packages: vec![PackageRecord { name: "datasets".into(), exports: vec![], depends: vec![], lazy_data: vec!["mtcars".into()] }],
        }).unwrap();

        std::env::set_var("RAVEN_BASE_EXPORTS", &path);
        // new_empty + initialize with no lib paths simulates CI (no disk base packages).
        let mut lib = PackageLibrary::new_empty();
        lib.initialize().await.unwrap();
        std::env::remove_var("RAVEN_BASE_EXPORTS");

        assert!(lib.is_base_export("mtcars"), "base dataset resolves from the base-exports file");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven initialize_loads_base_exports_file_when_disk_absent`
Expected: FAIL — no base-exports loading exists.

- [ ] **Step 3: Write the implementation**

In `base_exports.rs`, the file reuses the Tier 2 `RepoDb` encoding (a list of base `PackageRecord`s; datasets in `lazy_data`):

```rust
//! The bundled base-exports file: base/recommended package exports (incl. base
//! datasets), built from the reference R, loaded when disk base packages are
//! absent (CI). Reuses the Tier 2 `RepoDb` encoding.

use std::collections::HashSet;
use std::path::Path;

use crate::package_db::json_db::read_repo_db_file;

/// Merge base-package exports + dataset names from the file at `path` into a
/// flat set, plus the set of base package names. Returns None if absent/unreadable.
pub fn load_base_exports(path: &Path) -> Option<(HashSet<String>, HashSet<String>)> {
    let db = read_repo_db_file(path).ok()?;
    let mut exports = HashSet::new();
    let mut packages = HashSet::new();
    for rec in db.packages {
        packages.insert(rec.name.clone());
        // Base treats datasets as base exports (mirrors initialize()'s disk merge).
        exports.extend(rec.exports);
        exports.extend(rec.lazy_data);
    }
    Some((exports, packages))
}
```

In `initialize()`, after Step 3's disk loop (`:1041`), when the disk merge produced an empty base-export set (or unconditionally as a union — but gating on "disk produced nothing" keeps a real install authoritative), load and merge the file:

```rust
        // CI fallback: if no base exports were found on disk, load the bundled
        // base-exports file (built from a reference R) so base symbols and base
        // datasets (mtcars/iris) still resolve without R.
        if all_base_exports.is_empty() {
            if let Some(path) = crate::package_db::locate_base_exports() {
                if let Some((file_exports, file_packages)) =
                    crate::package_db::base_exports::load_base_exports(&path)
                {
                    log::info!("Loaded base exports from {:?}", path);
                    all_base_exports.extend(file_exports);
                    self.base_packages.extend(file_packages);
                }
            }
        }
```

(Then the existing `set_base_exports(all_base_exports)` at the end of `initialize` publishes it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p raven initialize_loads_base_exports_file_when_disk_absent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_db/base_exports.rs crates/raven/src/package_db/mod.rs crates/raven/src/package_library.rs
git commit -m "feat(package_db): load bundled base-exports file when base packages absent from disk"
```

---

### Task 3.6: Surface unreadable-DB notes in `raven check` and the language server (decision #9)

**Files:**
- Modify: `crates/raven/src/cli/check.rs` (`run`)
- Modify: `crates/raven/src/backend.rs` (post-`build_package_library` init path)

`PackageLibraryOutcome.load_notes` (Task 3.1) carries human-facing messages for present-but-unusable DBs.

- [ ] **Step 1: `raven check` prints notes to stderr**

In `cli/check.rs::run`, after `maybe_init_r` populates the library, print each note (same style as the existing "R not found" note):

```rust
    for note in state.package_library.load_notes() {
        eprintln!("raven check: {note}");
    }
```

(Add a `load_notes()` accessor on `PackageLibrary`, or thread the `Vec<String>` from the outcome through `maybe_init_r`.)

- [ ] **Step 2: Language server raises `window/showMessage`**

In `backend.rs`, where `build_package_library`'s outcome is applied to state (`:1190-1208`), for each note send a warning:

```rust
    for note in &outcome.load_notes {
        self.client.show_message(tower_lsp::lsp_types::MessageType::WARNING, note).await;
    }
```

- [ ] **Step 3: Test**

Add a unit/integration test: point `RAVEN_NAMES_DB` at a file with bad magic, build the library, assert `load_notes` contains a non-empty message and the library still constructs (degrades, doesn't panic).

Run: `cargo test -p raven load_notes`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/cli/check.rs crates/raven/src/backend.rs crates/raven/src/package_library.rs
git commit -m "feat: explain unreadable package DBs in check (stderr) and editor (showMessage)"
```

---

# Milestone 4 — Tier 3 build pipeline (reference-R seed ∪ CRAN+Bioc, append-only)

Goal: `raven packages build-shipped-db` merges a reference-R authoritative capture, CRAN+Bioc r-universe JSON, and the prior `names.db` (append-only) into a new `names.db` + base-exports file; the GH Actions job fetches both r-universe hosts and publishes to the `names-db` GitHub Release. The shipped binary stays network-free (the workflow's `curl` does the fetching).

> **REVISED (decisions #8, #11, #14).** This milestone changed substantially from "ingest r-universe JSON only." The merge is now **prior ∪ reference-R ∪ r-universe** with precedence **reference-R > r-universe > prior** and **append-only** (never drop a package). r-universe is fetched from **both** `cran.r-universe.dev` and `bioc.r-universe.dev`. Output is published to a **GitHub Release**, not an artifact. Task 4.1 (ingestion) is unchanged except for accepting both hosts' directories; Task 4.2 becomes the merge + `build-shipped-db` command; Task 4.3 becomes the Release-publishing workflow.

### Task 4.1: r-universe JSON ingestion → `PackageRecord`

**Files:**
- Modify: `crates/raven/src/package_db/runiverse.rs`
- Create: `crates/raven/tests/fixtures/package_db/runiverse/dplyr.json`
- Create: `crates/raven/tests/fixtures/package_db/runiverse/ggplot2.json`
- Test: inline `#[cfg(test)]`

- [ ] **Step 1: Create fixture JSON**

Create `crates/raven/tests/fixtures/package_db/runiverse/dplyr.json` (the r-universe per-package shape; `_dependencies` includes role, only `Depends` is kept):

```json
{
  "Package": "dplyr",
  "Version": "1.1.4",
  "_exports": ["filter", "mutate", "select"],
  "_dependencies": [
    { "package": "R", "version": ">= 3.5.0", "role": "Depends" },
    { "package": "cli", "version": "*", "role": "Imports" }
  ],
  "_datasets": [
    { "name": "starwars", "title": "Starwars characters" },
    { "name": "storms" }
  ]
}
```

Create `crates/raven/tests/fixtures/package_db/runiverse/ggplot2.json`:

```json
{
  "Package": "ggplot2",
  "Version": "3.5.0",
  "_exports": ["aes", "ggplot"],
  "_dependencies": [],
  "_datasets": []
}
```

- [ ] **Step 2: Write the failing test**

In `crates/raven/src/package_db/runiverse.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/package_db/runiverse")
    }

    #[test]
    fn ingests_directory_of_runiverse_json() {
        let records = ingest_runiverse_dir(&fixture_dir()).unwrap();
        let dplyr = records.iter().find(|r| r.name == "dplyr").unwrap();
        assert_eq!(dplyr.exports, vec!["filter".to_string(), "mutate".to_string(), "select".to_string()]);
        // Only Depends-role dependencies are kept (cli is Imports).
        assert_eq!(dplyr.depends, vec!["R".to_string()]);
        // Datasets come from _datasets[].name.
        assert_eq!(dplyr.lazy_data, vec!["starwars".to_string(), "storms".to_string()]);
        assert!(records.iter().any(|r| r.name == "ggplot2"));
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p raven package_db::runiverse`
Expected: FAIL — `ingest_runiverse_dir` not defined.

- [ ] **Step 4: Write the implementation**

At the top of `crates/raven/src/package_db/runiverse.rs`:

```rust
//! Build-side ingestion of r-universe per-package JSON into `PackageRecord`s.
//!
//! The shipped binary never fetches from the network. A build job (`curl`)
//! writes one `<pkg>.json` file per package into a directory; this module reads
//! that directory. The JSON shape is pinned by the fixtures under
//! `tests/fixtures/package_db/runiverse/`; if r-universe changes its schema, the
//! ingester test (and the §14 differential test) catch the drift.

use std::path::Path;

use serde::Deserialize;

use crate::package_db::model::PackageRecord;

#[derive(Debug, Deserialize)]
struct RUniversePackage {
    #[serde(rename = "Package")]
    package: String,
    #[serde(rename = "_exports", default)]
    exports: Vec<String>,
    #[serde(rename = "_dependencies", default)]
    dependencies: Vec<RUniverseDep>,
    #[serde(rename = "_datasets", default)]
    datasets: Vec<RUniverseDataset>,
}

#[derive(Debug, Deserialize)]
struct RUniverseDep {
    package: String,
    #[serde(default)]
    role: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RUniverseDataset {
    #[serde(default)]
    name: Option<String>,
}

/// Parse a single r-universe package JSON string into a `PackageRecord`.
pub fn parse_runiverse_json(text: &str) -> anyhow::Result<PackageRecord> {
    let pkg: RUniversePackage = serde_json::from_str(text)?;
    let depends: Vec<String> = pkg
        .dependencies
        .into_iter()
        .filter(|d| d.role.as_deref() == Some("Depends"))
        .map(|d| d.package)
        .collect();
    let lazy_data: Vec<String> = pkg.datasets.into_iter().filter_map(|d| d.name).collect();
    // PackageRecord-style normalization (sort/unique) via from_info would require
    // a PackageInfo; build the record directly and normalize here.
    let mut exports = pkg.exports;
    exports.sort_unstable();
    exports.dedup();
    let mut depends = depends;
    depends.sort_unstable();
    depends.dedup();
    let mut lazy_data = lazy_data;
    lazy_data.sort_unstable();
    lazy_data.dedup();
    Ok(PackageRecord { name: pkg.package, exports, depends, lazy_data })
}

/// Read every `*.json` in `dir` and parse it into a `PackageRecord`. Files that
/// fail to parse are logged and skipped (a single bad package must not fail the
/// whole build).
pub fn ingest_runiverse_dir(dir: &Path) -> anyhow::Result<Vec<PackageRecord>> {
    let mut records = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = std::fs::read_to_string(&path)?;
        match parse_runiverse_json(&text) {
            Ok(rec) => records.push(rec),
            Err(e) => log::warn!("skipping {:?}: {}", path, e),
        }
    }
    records.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(records)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p raven package_db::runiverse`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/package_db/runiverse.rs crates/raven/tests/fixtures/package_db/runiverse/
git commit -m "feat(package_db): ingest r-universe per-package JSON into PackageRecord"
```

---

### Task 4.2: `raven packages build-shipped-db` subcommand (merge: prior ∪ reference-R ∪ r-universe)

**Files:**
- Modify: `crates/raven/src/cli/mod.rs` (add `pub mod packages;`)
- Create: `crates/raven/src/cli/packages.rs`
- Create: `crates/raven/src/package_db/merge.rs`
- Modify: `crates/raven/src/main.rs` (dispatch arm)
- Test: inline `#[cfg(test)]` in `packages.rs` and `merge.rs`

> **REVISED (decisions #6, #7, #8).** `build-shipped-db` is no longer a thin r-universe ingester. It now:
> 1. **Captures the reference R** authoritatively via `build_package_library_tier1_only` (Task 3.1) + `enumerate_installed_packages` (Task 5.2) — the build machine's **entire installed library** (every package across all lib paths, not just base/recommended; datasets + `exportPattern` expanded; decision #8) — into `PackageRecord`s, and also writes the **base-exports file** (the base packages' records, a subset of the capture).
> 2. **Ingests r-universe** from CRAN **and** Bioc directories (Task 4.1).
> 3. **Seeds from the prior `names.db`** (if `--seed` given), read via `ShippedDb`.
> 4. **Merges append-only** with precedence **reference-R > r-universe > prior** (a new `package_db::merge::merge_append_only(prior, runiverse, reference_r) -> Vec<PackageRecord>` that unions by name, taking the highest-precedence source per name, and never drops a name present in any source).
>
> **Revised args:** `--reference-lib` (capture installed R; optional — omit in pure-ingest tests), `--runiverse-cran <dir>`, `--runiverse-bioc <dir>`, `--seed <prior names.db>` (optional), `--output <names.db>`, `--base-exports-output <base-exports.json>`, `--snapshot-date`, `--source`. The `parse_build_shipped_db_args` test below extends to cover the new flags; the merge precedence + append-only properties get dedicated `merge.rs` unit tests (e.g. a name only in `prior` is retained; a name in both `reference_r` and `runiverse` takes the reference-R record).
>
> The Step-3 code below is the **v1 skeleton** (single `--input` ingest); extend it to the merge flow above. The `parse_build_shipped_db_args`/dispatch/`print_help` wiring is otherwise reused as-is.

**Files:**
- Modify: `crates/raven/src/cli/mod.rs` (add `pub mod packages;`)
- Create: `crates/raven/src/cli/packages.rs`
- Modify: `crates/raven/src/main.rs` (dispatch arm)
- Test: inline `#[cfg(test)]` in `packages.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/raven/src/cli/packages.rs` with just the test first (implementation follows in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_build_shipped_db_args() {
        let args = parse_build_shipped_db_args(
            ["--input".to_string(), "in".to_string(), "--output".to_string(), "out.db".to_string(),
             "--snapshot-date".to_string(), "2026-05-30".to_string()]
                .into_iter(),
        )
        .unwrap();
        assert_eq!(args.input, std::path::PathBuf::from("in"));
        assert_eq!(args.output, std::path::PathBuf::from("out.db"));
        assert_eq!(args.snapshot_date, "2026-05-30");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven cli::packages`
Expected: FAIL — module/functions not defined.

- [ ] **Step 3: Write the implementation**

Replace the contents of `crates/raven/src/cli/packages.rs` with (test module kept at the bottom):

```rust
//! `raven packages {freeze,build-shipped-db}` — package-database commands.
//!
//! `freeze` (Task 5.3) generates a repo's Tier 2 `.raven/packages.json`.
//! `build-shipped-db` is the maintainer-only ingester that turns a directory of
//! r-universe JSON into the Tier 3 `names.db`. The shipped binary never fetches
//! from the network; a build job supplies the JSON directory.

use std::path::PathBuf;

use crate::package_db::binary_db::{write_shipped_db, ShippedDbProvenance};
use crate::package_db::runiverse::ingest_runiverse_dir;

pub struct BuildShippedDbArgs {
    pub input: PathBuf,
    pub output: PathBuf,
    pub snapshot_date: String,
    pub source: String,
}

pub fn parse_build_shipped_db_args(
    mut argv: impl Iterator<Item = String>,
) -> Result<BuildShippedDbArgs, String> {
    let mut input = None;
    let mut output = None;
    let mut snapshot_date = String::new();
    let mut source = "r-universe".to_string();
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--input" => input = Some(PathBuf::from(argv.next().ok_or("--input needs a path")?)),
            "--output" => output = Some(PathBuf::from(argv.next().ok_or("--output needs a path")?)),
            "--snapshot-date" => snapshot_date = argv.next().ok_or("--snapshot-date needs a value")?,
            "--source" => source = argv.next().ok_or("--source needs a value")?,
            "--help" => return Err("HELP".into()),
            s => return Err(format!("unknown flag: {s}")),
        }
    }
    Ok(BuildShippedDbArgs {
        input: input.ok_or("--input is required")?,
        output: output.ok_or("--output is required")?,
        snapshot_date,
        source,
    })
}

pub fn run_build_shipped_db(args: BuildShippedDbArgs) -> Result<(), String> {
    let records = ingest_runiverse_dir(&args.input).map_err(|e| e.to_string())?;
    let provenance = ShippedDbProvenance {
        source: args.source,
        snapshot_date: args.snapshot_date,
        package_count: records.len() as u32,
        raven_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    write_shipped_db(&args.output, &records, provenance).map_err(|e| e.to_string())?;
    eprintln!("Wrote {} packages to {}", records.len(), args.output.display());
    Ok(())
}

/// Dispatch the `packages` subcommand group on its second token.
pub async fn run(mut argv: impl Iterator<Item = String>) -> Result<(), String> {
    match argv.next().as_deref() {
        Some("build-shipped-db") => {
            let args = parse_build_shipped_db_args(argv)?;
            run_build_shipped_db(args)
        }
        // "freeze" arm is added in Task 5.3.
        Some(other) => Err(format!("unknown packages subcommand: {other}")),
        None => Err("usage: raven packages <freeze|build-shipped-db> [OPTIONS]".into()),
    }
}
```

In `crates/raven/src/cli/mod.rs`, add:

```rust
pub mod packages;
```

In `crates/raven/src/main.rs`, add a dispatch arm in the `match args.first().map(String::as_str)` block (after the `Some("check")` arm, before `_ => {}`):

```rust
        Some("packages") => {
            env_logger::init();
            let rest = args.into_iter().skip(1);
            match cli::packages::run(rest).await {
                Ok(()) => return Ok(()),
                Err(msg) if msg == "HELP" => {
                    cli::packages::print_help();
                    return Ok(());
                }
                Err(msg) => return Err(anyhow::anyhow!("raven packages: {}", msg)),
            }
        }
```

Add a minimal `print_help` to `packages.rs`:

```rust
pub fn print_help() {
    println!(
        "raven packages — package-database commands\n\n\
         Usage:\n  \
         raven packages freeze [--used|--installed|--all] [--output PATH] [--workspace DIR]\n  \
         raven packages build-shipped-db --input DIR --output names.db [--snapshot-date S] [--source S]\n"
    );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p raven cli::packages`
Expected: PASS.

- [ ] **Step 5: End-to-end check via the binary**

Run:
```bash
cargo run -p raven -- packages build-shipped-db \
  --input crates/raven/tests/fixtures/package_db/runiverse \
  --output /tmp/test-names.db --snapshot-date 2026-05-30
```
Expected: prints "Wrote 2 packages to /tmp/test-names.db".

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/cli/mod.rs crates/raven/src/cli/packages.rs crates/raven/src/main.rs
git commit -m "feat(cli): raven packages build-shipped-db ingester subcommand"
```

---

### Task 4.3: GitHub Actions build/refresh workflow

**Files:**
- Create: `.github/workflows/build-names-db.yml`

Config only — verification is YAML validity + manual `workflow_dispatch`.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/build-names-db.yml`. It (1) seeds from the prior Release asset, (2) sets up R + installs base/recommended (the GH `r-lib/actions/setup-r` action) for the reference-R capture, (3) fetches **both** CRAN and Bioc r-universe, (4) runs the append-only `build-shipped-db`, (5) publishes to the `names-db` Release:

```yaml
name: Build names.db (Tier 3 package-export DB)

on:
  workflow_dispatch:
  schedule:
    - cron: "0 6 * * 1"   # weekly, Monday 06:00 UTC (latest-only; export names are stable)

permissions:
  contents: write   # to update the names-db Release

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: r-lib/actions/setup-r@v2      # reference R; --reference-lib captures whatever is installed here

      - name: Build raven (release)
        run: cargo build --release -p raven

      - name: Seed from the prior names.db (append-only)
        run: |
          mkdir -p dist
          gh release download names-db --repo "$GITHUB_REPOSITORY" \
            --pattern 'names.db' --dir seed || echo "no prior release; building fresh"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Fetch CRAN + Bioc r-universe JSON
        run: |
          set -euo pipefail
          for host in cran.r-universe.dev bioc.r-universe.dev; do
            dest="runiverse/${host%%.*}"; mkdir -p "$dest"
            curl -sf "https://${host}/api/ls" -o "pkglist-${host}.json"
            # Prefer a bulk endpoint if available; else per-package with skip-on-failure
            # (append-only means a transient miss is non-destructive).
            jq -r '.[]' "pkglist-${host}.json" | while read -r pkg; do
              curl -sf "https://${host}/api/packages/${pkg}" -o "${dest}/${pkg}.json" || echo "skip ${host}/${pkg}"
            done
          done

      - name: Build names.db (reference-R seed ∪ CRAN+Bioc, append-only)
        run: |
          SNAPSHOT_DATE="$(date -u +%Y-%m-%d)"
          ./target/release/raven packages build-shipped-db \
            --reference-lib \
            --runiverse-cran runiverse/cran \
            --runiverse-bioc runiverse/bioc \
            ${{ hashFiles('seed/names.db') != '' && '--seed seed/names.db' || '' }} \
            --output dist/names.db \
            --base-exports-output dist/base-exports.json \
            --snapshot-date "${SNAPSHOT_DATE}" \
            --source r-universe+reference

      - name: Record checksums
        run: ( cd dist && b3sum names.db base-exports.json > checksums.b3 )

      - name: Publish to the names-db Release
        run: |
          gh release upload names-db dist/names.db dist/base-exports.json dist/checksums.b3 \
            --repo "$GITHUB_REPOSITORY" --clobber
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Bootstrap (decision #8):** create the `names-db` Release once and seed it from a **richly-provisioned machine** — run `raven packages build-shipped-db --reference-lib --runiverse-cran … --runiverse-bioc … --output names.db --base-exports-output base-exports.json` where your full working library is installed (so the hard-to-install / non-CRAN packages enter the floor), then `gh release upload names-db …`. Thereafter this automated runner job — which only has base+recommended via `setup-r` — seeds from that Release, appends CRAN+Bioc, and **retains** the bootstrapped packages (append-only), so the rich coverage persists without re-provisioning the runner.

- [ ] **Step 2: Validate YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build-names-db.yml'))"`
Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-names-db.yml
git commit -m "ci: weekly build-names-db (reference-R + CRAN+Bioc, append-only, publish to Release)"
```

---

# Milestone 5 — Tier 2 generation (`freeze` + renv.lock + repo provider + VS Code)

Goal: the user-facing generation command and its supporting reader/provider, plus the VS Code entry point.

### Task 5.1: `renv.lock` package-name reader

**Files:**
- Modify: `crates/raven/src/package_db/renv_lock.rs`
- Create: `crates/raven/tests/fixtures/package_db/renv.lock`
- Test: inline `#[cfg(test)]`

- [ ] **Step 1: Create the fixture**

Create `crates/raven/tests/fixtures/package_db/renv.lock`:

```json
{
  "R": { "Version": "4.4.0" },
  "Packages": {
    "dplyr": { "Package": "dplyr", "Version": "1.1.4" },
    "ggplot2": { "Package": "ggplot2", "Version": "3.5.0" }
  }
}
```

- [ ] **Step 2: Write the failing test**

In `crates/raven/src/package_db/renv_lock.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn reads_locked_package_names() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/package_db/renv.lock");
        let names = read_renv_lock_package_names(&path).unwrap();
        assert_eq!(names, vec!["dplyr".to_string(), "ggplot2".to_string()]);
    }

    #[test]
    fn missing_file_is_empty_not_error() {
        let names = read_renv_lock_package_names(std::path::Path::new("/nonexistent/renv.lock"))
            .unwrap();
        assert!(names.is_empty());
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p raven package_db::renv_lock`
Expected: FAIL — `read_renv_lock_package_names` not defined.

- [ ] **Step 4: Write the implementation**

At the top of `crates/raven/src/package_db/renv_lock.rs`:

```rust
//! Minimal `renv.lock` reader. `renv.lock` is JSON; its `Packages` object's keys
//! are the locked package names. Per spec §7.2, the lockfile is a **set
//! selector** (which packages to include), not a version oracle — so only names
//! are read.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct RenvLock {
    #[serde(rename = "Packages", default)]
    packages: HashMap<String, serde_json::Value>,
}

/// Return the sorted, de-duplicated set of package names listed in `renv.lock`.
/// A missing file yields an empty list (not an error): a repo may have no lock.
pub fn read_renv_lock_package_names(path: &Path) -> anyhow::Result<Vec<String>> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path)?;
    let lock: RenvLock = serde_json::from_str(&text)?;
    let mut names: Vec<String> = lock.packages.into_keys().collect();
    names.sort_unstable();
    names.dedup();
    Ok(names)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p raven package_db::renv_lock`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/package_db/renv_lock.rs crates/raven/tests/fixtures/package_db/renv.lock
git commit -m "feat(package_db): minimal renv.lock package-name reader"
```

---

### Task 5.2: Installed-package enumeration helper

**Files:**
- Modify: `crates/raven/src/package_library.rs`
- Test: inline `#[cfg(test)]`

`freeze --installed/--all` needs "every package across the lib paths." Add an enumeration helper next to `find_package_directory` (`:1343`).

- [ ] **Step 1: Write the failing test**

Add to the `package_library.rs` test module:

```rust
    #[test]
    fn enumerate_installed_lists_package_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let lib = dir.path().join("lib");
        std::fs::create_dir_all(lib.join("dplyr")).unwrap();
        std::fs::create_dir_all(lib.join("ggplot2")).unwrap();
        // a non-package file should be ignored
        std::fs::write(lib.join("README"), "x").unwrap();

        let mut pl = PackageLibrary::new_empty();
        pl.set_lib_paths(vec![lib]);
        let mut found = pl.enumerate_installed_packages();
        found.sort();
        assert_eq!(found, vec!["dplyr".to_string(), "ggplot2".to_string()]);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven enumerate_installed_lists_package_dirs`
Expected: FAIL — `enumerate_installed_packages` not defined.

- [ ] **Step 3: Write the implementation**

Add to `impl PackageLibrary` (near `find_package_directory` at `:1343`):

```rust
    /// Enumerate the names of all packages present across the library paths.
    /// A "package" is a subdirectory containing a `DESCRIPTION` file. Used by
    /// `raven packages freeze --installed/--all`.
    pub fn enumerate_installed_packages(&self) -> Vec<String> {
        let mut names = std::collections::HashSet::new();
        for lib in &self.lib_paths {
            let Ok(entries) = std::fs::read_dir(lib) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && path.join("DESCRIPTION").is_file() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        names.insert(name.to_string());
                    }
                }
            }
        }
        names.into_iter().collect()
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p raven enumerate_installed_lists_package_dirs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_library.rs
git commit -m "feat(package_library): enumerate_installed_packages helper for freeze"
```

---

### Task 5.3: `raven packages freeze` command

**Files:**
- Modify: `crates/raven/src/cli/packages.rs` (add freeze args/run + dispatch arm)
- Test: inline `#[cfg(test)]` in `packages.rs`

This reuses the authoritative path: build a library with R, resolve the `--used`/`--installed` set, capture each package's full `PackageInfo` via `get_package`, and write the Tier 2 file.

> **REVISED (decisions #6, #10, #11).** Four changes to `run_freeze` below:
>
> 1. **Provider-less capture (#6).** Build with `build_package_library_tier1_only(None, &[], Some(root.clone()))`, **not** `build_package_library` — so a not-installed package can never resolve from Tier 2/3 and leak into the frozen file. Additionally gate each record on `lib.package_exists(&name)` (Tier-1-only) before `from_info`, and skip base packages (always builtins/Tier-1). Belt-and-suspenders: provider-less means `get_package` returns `None` for non-installed anyway, but the `package_exists` gate makes intent explicit and excludes the degraded parse-empty case.
>
> 2. **Maximally-inclusive `--used` set (#10).** Replace `scan_workspace_loaded_packages` with `scan_workspace_referenced_packages`, which collects, per `Document`'s tree:
>    - `library`/`require`/`loadNamespace`/**`requireNamespace`** call args (extend the existing detection), and
>    - the `namespace_identifier` (LHS) of every **`namespace_operator`** node (`::` and `:::`),
>
>    unioned with `renv.lock` names, the repo's own **`DESCRIPTION` `Depends`+`Imports`** (parse via `parse_description_depends` for Depends; add an `Imports` parse — exclude `LinkingTo`), and transitive `Depends`. A small tree-walk helper:
>    ```rust
>    fn collect_referenced_packages(doc_tree: &tree_sitter::Tree, text: &str, out: &mut BTreeSet<String>) {
>        let mut stack = vec![doc_tree.root_node()];
>        while let Some(node) = stack.pop() {
>            match node.kind() {
>                // pkg::name / pkg:::name — take the namespace_identifier child.
>                "namespace_operator" => {
>                    if let Some(id) = node.child(0) {           // [namespace_identifier, "::"/":::" , id]
>                        let name = text[id.byte_range()].trim_matches(|c| c == '"' || c == '\'');
>                        if crate::r_subprocess::is_valid_package_name(name) { out.insert(name.to_string()); }
>                    }
>                }
>                "call" => { /* library/require/loadNamespace/requireNamespace: first arg, as in extract_loaded_packages */ }
>                _ => {}
>            }
>            for i in (0..node.child_count()).rev() { if let Some(c) = node.child(i) { stack.push(c); } }
>        }
>    }
>    ```
>    Over-inclusion is harmless — the `package_exists` gate (change #1) drops anything not installed.
>
> 3. **No-op when unchanged (#11).** Before writing, if `out` exists, read it (`read_repo_db_file`) and compare **`.packages` only** (ignoring provenance) to the freshly-computed `records`. If equal, print `"no changes; left {out} untouched"` and return `Ok(())` **without writing** — so a no-op regeneration produces zero diff.
>
> 4. **`RepoDb` literal** gains `schema_version: crate::package_db::json_db::REPO_DB_SCHEMA_VERSION` (Task 1.3 REVISED).
>
> Add tests: a `--used` fixture workspace with a `pkg::fn` reference (no `library()`) includes `pkg`; running freeze twice on unchanged content leaves the file byte-identical (and the second run prints "no changes"). The `parse_freeze_args` test below is unchanged.

- [ ] **Step 1: Write the failing test (arg parsing)**

Add to the `packages.rs` test module:

```rust
    #[test]
    fn parse_freeze_args_defaults_to_used() {
        let a = parse_freeze_args(std::iter::empty()).unwrap();
        assert_eq!(a.scope, FreezeScope::Used);
        assert_eq!(a.output, std::path::PathBuf::from(".raven/packages.json"));

        let b = parse_freeze_args(["--all".to_string()].into_iter()).unwrap();
        assert_eq!(b.scope, FreezeScope::All);

        let c = parse_freeze_args(["--installed".to_string(), "--output".to_string(), "x.json".to_string()].into_iter()).unwrap();
        assert_eq!(c.scope, FreezeScope::All);
        assert_eq!(c.output, std::path::PathBuf::from("x.json"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven cli::packages::tests::parse_freeze_args`
Expected: FAIL — `parse_freeze_args` / `FreezeScope` not defined.

- [ ] **Step 3: Write the implementation**

Add to `crates/raven/src/cli/packages.rs` (above the test module):

```rust
use crate::package_db::json_db::{write_repo_db_file, RepoDb, RepoDbProvenance};
use crate::package_db::model::PackageRecord;
use crate::package_db::renv_lock::read_renv_lock_package_names;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum FreezeScope {
    /// scripts-referenced ∪ renv.lock ∪ transitive Depends (spec §7.2 default)
    Used,
    /// every package across the renv + system libraries (`--installed`/`--all`)
    All,
}

pub struct FreezeArgs {
    pub scope: FreezeScope,
    pub output: PathBuf,
    pub workspace: Option<PathBuf>,
}

pub fn parse_freeze_args(mut argv: impl Iterator<Item = String>) -> Result<FreezeArgs, String> {
    let mut scope = FreezeScope::Used;
    let mut output = PathBuf::from(".raven/packages.json");
    let mut workspace = None;
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--used" => scope = FreezeScope::Used,
            "--installed" | "--all" => scope = FreezeScope::All,
            "--output" => output = PathBuf::from(argv.next().ok_or("--output needs a path")?),
            "--workspace" => workspace = Some(PathBuf::from(argv.next().ok_or("--workspace needs a path")?)),
            "--help" => return Err("HELP".into()),
            s => return Err(format!("unknown flag: {s}")),
        }
    }
    Ok(FreezeArgs { scope, output, workspace })
}
```

Add the `freeze` arm to the group dispatcher `run`:

```rust
        Some("freeze") => {
            let args = parse_freeze_args(argv)?;
            run_freeze(args).await
        }
```

Add `run_freeze`. It builds a library (Tier 1, with R), computes the package set, resolves each via the authoritative `get_package`, and writes the Tier 2 file:

```rust
pub async fn run_freeze(args: FreezeArgs) -> Result<(), String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let root = match &args.workspace {
        Some(p) if p.is_absolute() => p.clone(),
        Some(p) => cwd.join(p),
        None => cwd.clone(),
    };

    // Authoritative path: real R + renv-aware lib order (get_lib_paths sources
    // renv/activate.R, so .libPaths() is [renv_lib, system_libs…]).
    let outcome = crate::package_library::build_package_library(
        None,                 // auto-detect R on PATH
        &[],                  // no extra lib paths
        Some(root.clone()),   // working dir → renv-aware
        true,                 // packages enabled
    )
    .await;
    let lib = &outcome.library;

    // 1) Determine the package set.
    let mut wanted: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    match args.scope {
        FreezeScope::All => {
            wanted.extend(lib.enumerate_installed_packages());
        }
        FreezeScope::Used => {
            // scripts-referenced: scan the workspace for library/require/:: .
            for pkg in scan_workspace_loaded_packages(&root) {
                wanted.insert(pkg);
            }
            // renv.lock-listed.
            for pkg in read_renv_lock_package_names(&root.join("renv.lock")).map_err(|e| e.to_string())? {
                wanted.insert(pkg);
            }
        }
    }

    // 2) Resolve each (authoritative), then add transitive Depends for --used.
    let mut records: Vec<PackageRecord> = Vec::new();
    let mut queue: Vec<String> = wanted.iter().cloned().collect();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    while let Some(name) = queue.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        if let Some(info) = lib.get_package(&name).await {
            // transitive Depends: a locked/used package pulls in its Depends
            // (spec §7.2). --all already has everything, so only extend for Used.
            if matches!(args.scope, FreezeScope::Used) {
                for dep in &info.depends {
                    if dep != "R" && !seen.contains(dep) {
                        queue.push(dep.clone());
                    }
                }
            }
            records.push(PackageRecord::from_info(&info));
        }
    }
    records.sort_by(|a, b| a.name.cmp(&b.name));

    // 3) Provenance + write.
    let r_version = lib
        .r_subprocess()
        .map(|_| "present".to_string())   // exact version is best-effort; see note
        .unwrap_or_else(|| "unknown".to_string());
    let generated_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let db = RepoDb {
        provenance: RepoDbProvenance {
            raven_version: env!("CARGO_PKG_VERSION").to_string(),
            r_version,
            generated_unix,
        },
        packages: records,
    };
    let out = if args.output.is_absolute() { args.output.clone() } else { root.join(&args.output) };
    write_repo_db_file(&out, &db).map_err(|e| e.to_string())?;
    eprintln!("Wrote {} packages to {}", db.packages.len(), out.display());
    Ok(())
}

/// Scan the workspace's R/Rmd scripts for `library()` / `require()` / `pkg::`
/// references. Reuses the workspace indexer (the same scan `raven check` uses).
/// `scan_workspace` returns `WorkspaceScanResult` — a tuple type alias whose
/// first element is `HashMap<Url, Document>` (verified at `state.rs:1140`); each
/// `Document.loaded_packages` (`state.rs:153`) is populated during the scan, so
/// no `apply_workspace_index` is needed just to read it. The `is_valid_package_name`
/// filter mirrors `prefetch_reported_packages` (`cli/check.rs:476-483`).
fn scan_workspace_loaded_packages(root: &std::path::Path) -> Vec<String> {
    use tower_lsp::lsp_types::Url;
    let Ok(workspace_url) = Url::from_file_path(root) else { return Vec::new() };
    // max_chain_depth is irrelevant to per-file loaded_packages extraction; 0 is fine.
    let (index, _cross_file_entries, _new_index_entries) =
        crate::state::scan_workspace(std::slice::from_ref(&workspace_url), 0);
    let mut names = std::collections::BTreeSet::new();
    for doc in index.values() {
        for pkg in &doc.loaded_packages {
            if crate::r_subprocess::is_valid_package_name(pkg) {
                names.insert(pkg.clone());
            }
        }
    }
    names.into_iter().collect()
}
```

> **Note (R version):** capturing the exact R version requires a subprocess query. To avoid scope creep, v1 records `"present"`/`"unknown"`; a follow-up can add an `RSubprocess::r_version()` one-liner (`cat(as.character(getRversion()))`) and store it. This is provenance-for-debuggability only (spec §7.3) and does not affect resolution. The `scan_workspace` API was verified during planning (3-tuple alias at `state.rs:1140`, first element `HashMap<Url, Document>`, `Document.loaded_packages` at `state.rs:153`), so the helper above compiles as written.

Update `print_help` (already lists `freeze`) — no change needed.

- [ ] **Step 4: Run the arg test**

Run: `cargo test -p raven cli::packages::tests::parse_freeze_args`
Expected: PASS.

- [ ] **Step 5: Build to verify `run_freeze` compiles against the real APIs**

Run: `cargo build -p raven`
Expected: PASS. (If `scan_workspace`'s signature or `loaded_packages` field differs, fix `scan_workspace_loaded_packages` to match — see the note.)

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/cli/packages.rs
git commit -m "feat(cli): raven packages freeze generates Tier 2 .raven/packages.json"
```

---

### Task 5.4: Tier precedence test — repo DB outranks shipped DB

**Files:**
- Test: inline `#[cfg(test)]` in `crates/raven/src/package_library.rs`

Spec §14: a package in both Tier 2 and Tier 3 resolves from Tier 2; a Tier-3-only package still resolves. Tier 2 is index 0 in the providers vec (per Task 3.1 ordering).

- [ ] **Step 1: Write the test**

Add to the `package_library.rs` test module:

```rust
    #[tokio::test]
    async fn tier2_outranks_tier3() {
        use crate::package_db::PackageMetadataProvider;
        use std::collections::HashSet;

        struct Tier2;
        impl PackageMetadataProvider for Tier2 {
            fn lookup(&self, name: &str) -> Option<PackageInfo> {
                (name == "dplyr").then(|| PackageInfo::new("dplyr".into(), HashSet::from(["from_tier2".into()])))
            }
        }
        struct Tier3;
        impl PackageMetadataProvider for Tier3 {
            fn lookup(&self, name: &str) -> Option<PackageInfo> {
                match name {
                    "dplyr" => Some(PackageInfo::new("dplyr".into(), HashSet::from(["from_tier3".into()]))),
                    "tidyr" => Some(PackageInfo::new("tidyr".into(), HashSet::from(["pivot_longer".into()]))),
                    _ => None,
                }
            }
        }

        let mut lib = PackageLibrary::new_empty();
        lib.set_providers(vec![Box::new(Tier2), Box::new(Tier3)]); // Tier 2 first

        let dplyr = lib.get_package("dplyr").await.unwrap();
        assert!(dplyr.exports.contains("from_tier2"), "Tier 2 wins when both know dplyr");
        assert!(!dplyr.exports.contains("from_tier3"));

        let tidyr = lib.get_package("tidyr").await.unwrap();
        assert!(tidyr.exports.contains("pivot_longer"), "Tier-3-only package still resolves");
    }
```

- [ ] **Step 2: Run the test**

Run: `cargo test -p raven tier2_outranks_tier3`
Expected: PASS (the ordered `resolve_from_providers` already returns the first hit).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/package_library.rs
git commit -m "test(package_library): pin Tier 2 > Tier 3 resolution precedence"
```

---

### Task 5.5: VS Code command — *"Raven: Generate Package Database for CI"*

**Files:**
- Modify: `editors/vscode/package.json` (contribute the command)
- Modify: `editors/vscode/src/extension.ts` (register it)
- Create: `tests/bun/packages-freeze-command.test.ts`

The command runs the bundled `raven packages freeze` against the workspace folder. Registered manually via `vscode.commands.registerCommand`, so `executeCommandProvider.commands` stays `vec![]` (invariant).

- [ ] **Step 1: Write the failing bun test**

Create `tests/bun/packages-freeze-command.test.ts`:

```ts
import { test, expect } from "bun:test";
import pkg from "../../editors/vscode/package.json";

test("freeze command is contributed in package.json", () => {
  const commands = (pkg.contributes?.commands ?? []) as Array<{ command: string; title: string }>;
  const freeze = commands.find((c) => c.command === "raven.packages.freeze");
  expect(freeze).toBeDefined();
  expect(freeze!.title).toContain("Generate Package Database");
});
```

(Before adding this file to a tsconfig, ensure `./editors/vscode/node_modules/.bin/tsc --project tests/bun/tsconfig.json --noEmit` stays clean — per CLAUDE.md. This test imports JSON only, so it should not need a tsconfig include change, but verify.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bun/packages-freeze-command.test.ts`
Expected: FAIL — command not contributed.

- [ ] **Step 3: Contribute the command in `package.json`**

In `editors/vscode/package.json`, under `contributes.commands`, add:

```json
{
  "command": "raven.packages.freeze",
  "title": "Raven: Generate Package Database for CI",
  "category": "Raven"
}
```

- [ ] **Step 4: Register the command in `extension.ts`**

In `editors/vscode/src/extension.ts`, alongside the other `vscode.commands.registerCommand(...)` calls (e.g. near `:401`), add a registration that runs the bundled binary's `packages freeze` in the active workspace folder, streaming output to a Raven output channel:

```ts
vscode.commands.registerCommand("raven.packages.freeze", async () => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("Raven: open a workspace folder to generate its package database.");
    return;
  }
  const serverPath = getServerPath(context); // same resolver used to launch the LSP
  const cp = await import("node:child_process");
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Raven: generating package database…" },
    () =>
      new Promise<void>((resolve) => {
        const proc = cp.spawn(serverPath, ["packages", "freeze", "--workspace", folder.uri.fsPath], {
          cwd: folder.uri.fsPath,
        });
        let stderr = "";
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("close", (code) => {
          if (code === 0) {
            vscode.window.showInformationMessage("Raven: wrote .raven/packages.json");
          } else {
            vscode.window.showErrorMessage(`Raven: package database generation failed: ${stderr.trim()}`);
          }
          resolve();
        });
      }),
  );
}),
```

(Confirm `getServerPath` is in scope where commands are registered; per the verified code it lives in `extension.ts:100`. If commands are registered before `getServerPath`/`context` is available, hoist the registration to after the client is created.)

Leave the Rust `execute_command_provider.commands` as `vec![]` (`backend.rs:2056`) — do not add this command there (double-registration crash invariant).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/bun/packages-freeze-command.test.ts`
Expected: PASS.

Run: `cd editors/vscode && bun run compile` (or the repo's TS build) to confirm `extension.ts` compiles.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/package.json editors/vscode/src/extension.ts tests/bun/packages-freeze-command.test.ts
git commit -m "feat(vscode): Raven: Generate Package Database for CI command"
```

---

### Task 5.6: Generation round-trip test (§14, R-gated)

**Files:**
- Modify: `crates/raven/tests/package_db_consumer.rs` (add a gated test)

Spec §14 "Generation round-trip": on a machine with R, generate, read back, assert parity with the live Tier 1 result. Gate on R presence so CI without R skips it.

- [ ] **Step 1: Write the test**

Add to `crates/raven/tests/package_db_consumer.rs`:

```rust
/// R-gated: generate a Tier 2 record for an installed package and assert the
/// round-tripped record matches the live Tier 1 result. Skips when R is absent.
#[tokio::test]
async fn freeze_round_trip_matches_tier1_when_r_present() {
    use raven::package_db::json_db::{read_repo_db_str, write_repo_db_string, RepoDb, RepoDbProvenance};
    use raven::package_db::model::PackageRecord;
    use raven::package_library::build_package_library;

    let outcome = build_package_library(None, &[], None, true).await;
    let lib = &outcome.library;
    if lib.r_subprocess().is_none() {
        eprintln!("skipping: R not available");
        return;
    }
    // 'stats' is a base/recommended package present wherever R is.
    let Some(live) = lib.get_package("stats").await else {
        eprintln!("skipping: stats not resolvable");
        return;
    };
    let rec = PackageRecord::from_info(&live);
    let db = RepoDb {
        provenance: RepoDbProvenance { raven_version: "test".into(), r_version: "present".into(), generated_unix: 0 },
        packages: vec![rec.clone()],
    };
    let text = write_repo_db_string(&db);
    let parsed = read_repo_db_str(&text).unwrap();
    let back = parsed.packages.into_iter().next().unwrap().into_info();

    // Parity: same export set after the round-trip.
    assert_eq!(back.exports, live.exports);
    assert_eq!(back.name, live.name);
}
```

- [ ] **Step 2: Run the test**

Run: `cargo test -p raven --test package_db_consumer freeze_round_trip`
Expected: PASS (or a printed "skipping" if R is absent — both are green).

- [ ] **Step 3: Commit**

```bash
git add crates/raven/tests/package_db_consumer.rs
git commit -m "test(package_db): R-gated generation round-trip parity with Tier 1"
```

---

# Milestone 6 — Documentation (spec §15) — **Stage 1: authored & PR'd FIRST, before any code**

Goal: write all user-facing docs **and** the `docs/development.md` architecture notes that describe the feature's intended behavior, and ship them as the **first PR** (Execution-order section). Reviewers approve the UX/contract here; the code milestones build to match. Tasks 6.0–6.4 are Stage 1; **Task 6.5 (final verification + banner removal) runs last, after all code.**

**Status banner (Stage 1 only).** Because these docs describe not-yet-released behavior, prepend each *new or materially-changed* user-facing doc/section with:

```markdown
> **Status: planned.** Describes the CI package-exports database, in active development; not yet in a released build. Tracking: the package-database work (and prerequisite [raven#350](https://github.com/jbearak/raven/issues/350)).
```

Task 6.5 removes these banners once the feature ships.

### Task 6.0: `docs/development.md` — architecture & internals (Stage 1)

**Files:**
- Modify: `docs/development.md`

Per CLAUDE.md, internal architecture/caching/performance/debugging guidance goes in `docs/development.md`.

- [ ] **Step 1: Document the internals**

Add a "Package-export databases (CI / R-free resolution)" section covering:
- The `package_db` module: one `PackageRecord`, two encodings (Tier 2 deterministic JSON `.raven/packages.json`; Tier 3 mmap binary `names.db`), one reader each; `schema_version`/`FORMAT_VERSION` + typed reader errors (`Absent`/`UnsupportedSchema`/`Corrupt`) and the explain-and-continue surfacing.
- The `PackageMetadataProvider` seam: Tier 1 bespoke + first; Tier 2/3 providers consulted only on a `get_package` not-found miss; `package_exists()` stays Tier-1-only (install status). Why `prefetch_packages` needs no change (the `get_all_exports → get_package` recursion).
- Performance discipline (§12): index preloaded at open, payloads decoded lazily from the mmap, `blake3` verified at open **in `spawn_blocking`**, hot path stays `try_read`-only.
- The Tier 3 build pipeline: reference-R full-library capture ∪ CRAN+Bioc r-universe, **append-only**, published to the `names-db` GitHub Release; the base-exports companion file; bootstrap-from-a-rich-machine.
- The `#350` dependency (package-dataset resolution) and how `lazy_data` capture plugs into it.
- Testing approach: runtime tempdir fixtures + committed back-compat fixtures; the build-side differential and generation round-trip tests.

- [ ] **Step 2: Commit**

```bash
git add docs/development.md
git commit -m "docs(development): package-export databases — architecture, seam, build pipeline"
```

### Task 6.1: `docs/cli.md`

**Files:**
- Modify: `docs/cli.md`

- [ ] **Step 1: Document the new surfaces**

Add sections to `docs/cli.md`:
- `raven packages freeze` — purpose (generate `.raven/packages.json`), `--used` (default) / `--installed` / `--all`, `--output`, `--workspace`; the renv-first library order and the "renv.lock is a set selector" rule (§7.2); generate after `renv::restore()` for best coverage.
- `raven packages build-shipped-db` — note it as maintainer/CI-only (the binary never fetches the network).
- `raven check --report-uninstalled` — what it does and the precise wording from §10.2: it reports `library()` calls **not present in the local library paths**, *not* relative to Tier 2/Tier 3 metadata. State that missing-package is **off by default** in `raven check`.

- [ ] **Step 2: Verify and commit**

Run: `grep -n "report-uninstalled\|packages freeze" docs/cli.md`
Expected: matches present.

```bash
git add docs/cli.md
git commit -m "docs(cli): document packages freeze, build-shipped-db, --report-uninstalled"
```

---

### Task 6.2: `docs/diagnostics.md`

**Files:**
- Modify: `docs/diagnostics.md`

- [ ] **Step 1: Document the CI default + names-vs-install-status distinction**

Add to `docs/diagnostics.md`:
- The missing-package diagnostic is **install-status only** (Tier 1), independent of the export database. Knowing a package's exports does **not** make it count as installed (§10).
- Per-mode behavior table (§10.1): language server fires missing-package when install-state is known; `raven check` suppresses it by default, re-enabled with `--report-uninstalled`.
- The accepted gap (§10.3): a typo like `library(dpylr)` is silent in `raven check` by default.

- [ ] **Step 2: Commit**

```bash
git add docs/diagnostics.md
git commit -m "docs(diagnostics): CI missing-package default + names-vs-install-status"
```

---

### Task 6.3: `docs/cross-file.md` and `docs/r-package-dev.md`

**Files:**
- Modify: `docs/cross-file.md`
- Modify: `docs/r-package-dev.md`

- [ ] **Step 1: Document three-tier resolution + renv-aware generation**

- `docs/cross-file.md`: in/near the "When Raven calls R" section, describe the three-tier export resolution (Tier 1 installed → Tier 2 repo DB → Tier 3 shipped DB) and that Tiers 2/3 are export-names-only (no `:::`, no signatures).
- `docs/r-package-dev.md`: describe generating `.raven/packages.json` for CI and the renv-first library order.

- [ ] **Step 2: Commit**

```bash
git add docs/cross-file.md docs/r-package-dev.md
git commit -m "docs: three-tier export resolution + renv-aware generation"
```

---

### Task 6.4: New `docs/package-database.md` + CLAUDE.md doc-map

**Files:**
- Create: `docs/package-database.md`
- Modify: `CLAUDE.md` (the user-facing docs list)

- [ ] **Step 1: Write the page**

Create `docs/package-database.md` covering: the three tiers and their fidelity (table from §4); the committed `.raven/packages.json` (generated not hand-edited, reviewable in PRs, **regeneration is a no-op when unchanged**, **version-skew is explained and the bundled DB is used** — decisions #9/#11); the generation command and its maximally-inclusive `--used` set (decision #10); the bundled `names.db` (latest-only, export-only; built from a **reference R seed ∪ CRAN+Bioc r-universe, append-only**; shipped via a **GitHub Release**; provenance/integrity via `blake3`; refresh = weekly + release cadence — decisions #8/#14); the separate **base-exports file** that makes base symbols + base datasets resolve in CI (decision #7); package-dataset resolution arrives via [raven#350](https://github.com/jbearak/raven/issues/350); and the fidelity caveats (§13: `exportPattern` solved by r-universe; Tier 3 latest-only drift; no `:::`/signatures; Bioconductor cadence).

- [ ] **Step 2: Link it from CLAUDE.md**

In `CLAUDE.md`, add `- \`docs/package-database.md\`` to the user-facing docs list.

- [ ] **Step 3: Commit**

```bash
git add docs/package-database.md CLAUDE.md
git commit -m "docs: add package-database page and link from CLAUDE.md"
```

---

### Task 6.4b: Open and merge the Stage 1 documentation PR (before any code)

**This is the gate between Stage 1 and Stage 2.** Tasks 6.0–6.4 must be committed (each carrying the status banner) before opening this PR; no feature code is written until it merges.

- [ ] **Step 1: Push the docs branch and open the PR**

```bash
git push -u origin HEAD
gh pr create \
  --title "docs: CI package-exports database (planned) — user + architecture docs" \
  --body "Stage 1 of the CI package-exports DB work (plan: docs/superpowers/plans/2026-05-30-ci-package-exports-db.md; design: docs/superpowers/specs/2026-05-30-ci-package-exports-db-design.md). Docs-first: this PR is the agreed UX/behavior contract; implementation (Stages 2+) builds to match. Each new doc carries a 'Status: planned' banner removed when the feature ships. Prerequisite: #350."
```

- [ ] **Step 2: Review & merge**

Land the PR after review. Implementation (Milestone 1) begins only after this merges. The `#350` prerequisite may proceed in parallel but must also land before Stage 2.

---

### Task 6.5: Final whole-build verification — **runs LAST, after all code**

**Files:** none (verification only)

- [ ] **Step 1: Full test + build sweep**

Run:
```bash
cargo build -p raven
cargo test -p raven
bun test
```
Expected: all PASS. If any pre-existing Tier 1 (R-present) test regressed, treat it as a bug in the seam wiring and fix before proceeding (the seam must regress nothing — spec §2).

- [ ] **Step 2: Settings-reference drift check (only if a setting was added)**

This plan adds **no** LSP-exposed setting (`--report-uninstalled` is a CLI flag; the `.raven/packages.json` path override is **deferred** — see below). So the three-place VS Code settings-sync and `bun editors/vscode/scripts/generate-settings-reference.mjs` regeneration are **not** required. Confirm no `package.json` `configuration` entry was added:

Run: `git diff --stat -- editors/vscode/package.json`
Expected: only the `contributes.commands` addition, no `configuration` change.

- [ ] **Step 3: Remove the Stage 1 "Status: planned" banners**

The feature now ships, so the planned-status banners added in Stage 1 must go.

Run: `grep -rn "Status: planned" docs/ README.md`
Then delete each banner block from the docs it flagged (`docs/cli.md`, `docs/diagnostics.md`, `docs/cross-file.md`, `docs/r-package-dev.md`, `docs/package-database.md`, `docs/development.md`, and README if touched).
Expected after: `grep -rn "Status: planned" docs/ README.md` returns nothing for this feature.

- [ ] **Step 4: Commit any final touch-ups**

```bash
git add -A
git commit -m "chore: final verification sweep + drop planned-status banners for CI package-exports DB" || echo "nothing to commit"
```

---

## Prerequisite & explicit deferrals

**Prerequisite (must land first):** [raven#350](https://github.com/jbearak/raven/issues/350) — package-dataset (lazy-data) resolution. See the Prerequisites section at the top.

**Deferred (carried from spec, not built in v1):**

- **`.raven/packages.json` path-override setting.** The spec allows "a config key may override the path" (§7.3). v1 uses auto-discovery at the repo root only. Adding the override later requires the three-place VS Code settings-sync discipline + settings-reference regeneration (CLAUDE.md) — out of scope here.
- **Function signatures (`formals`)** — R-subprocess-only, deferred fast-follow (§11).
- **`:::` internal-object resolution** — `PackageInfo` has no internal-objects field; orthogonal (§11). (Note: `freeze`/Tier 3 *do* record the `:::`-referenced package in the `--used` set so its **exports** are frozen; only the internal-object *names* are out of scope.)
- **Exact R version in provenance** — v1 records `"present"`/`"unknown"`; a follow-up adds an `RSubprocess` version query (Task 5.3 note). Debuggability-only; does not affect resolution.
- **Tier 3 build-side differential test against `getNamespaceExports()`** (§14 first bullet) — requires a build environment with R + a sample corpus; belongs in the `build-names-db` job (Task 4.3) as a post-build check, deferred to when the job runs against live data. The ingester unit test (Task 4.1), the merge unit tests (Task 4.2), and the generation round-trip (Task 5.6) cover format/merge/parity in the meantime.

**No longer deferred (resolved in grilling):** base/recommended exports + base datasets in CI (now shipped via the base-exports file, Tasks 3.5/4.2); Bioconductor coverage (Task 4.1/4.3).

---

## Self-review

**1. Spec coverage**

| Spec section | Task(s) |
|---|---|
| §4 ordered fallback over three tiers | M2 (seam), M3/M5 (wiring) |
| §5.1 `package_db` module, shared model, two encodings, one reader each | Tasks 1.1–1.4 |
| §5.1 module declared in both crate roots | Task 1.1 Step 3 |
| §5.2 ordered-resolution seam; Tier 1 untouched; abstraction first | M2 (Tasks 2.1, 2.2, 2.4; 2.3 removed as redundant — decision #12) |
| §6 Tier 1 unchanged | Task 2.2 Step 4 + Task 3.1 (no-regression runs), Task 6.5 |
| §7 Tier 2 repo DB (renv-first, set rule, location/format/provenance, reuse) | Tasks 5.1–5.3 (provider-less capture, generous `--used` set, no-op-when-unchanged) |
| §8 Tier 3 shipped DB (source, contents, delivery, integrity, freshness) | Tasks 1.4, 1.5, 3.1, 3.4 (Release bundling), 4.1–4.3 (reference-R seed ∪ CRAN+Bioc, append-only, GitHub Release) |
| §9 generation command, two entry points, VS Code invariant | Tasks 5.3, 5.5 |
| §10 names ≠ install status; per-mode behavior; `--report-uninstalled`; accepted gap | Tasks 2.4, 3.3, 6.1, 6.2 |
| §11 scope/deferrals | Deferrals section (+ #350 prerequisite) |
| §12 performance discipline (mmap off hot path, preload index, off-thread open, lock-free reads) | Task 1.4 (lazy payload decode; index preloaded at open); Task 3.1 (open+verify in `spawn_blocking`, decision #13); seam feeds the existing `try_read` cache (Task 2.2) |
| §13 fidelity caveats documented | Task 6.4 |
| §14 testing strategy (5 bullets) | build-differential → Deferrals/Task 4.3; round-trip → Task 5.6; no-R consumer → Tasks 3.2/3.3; tier precedence → Task 5.4; no-regression → Task 6.5; **+ format back-compat fixtures (decision #15), base-exports (Task 3.5), merge precedence/append-only (Task 4.2)** |
| §15 docs | Tasks 6.0 (`development.md`) + 6.1–6.4, authored **first** as the Stage 1 PR (Execution-order section); banners removed in Task 6.5 |
| §16 touchpoints | exercised across M2–M5 at the verified line numbers |
| §17 open items + grilling | Resolved in "Decisions resolved during planning" + "Decisions revised in design review" (#6–#15) |
| Datasets (§3 scope) | Resolution = prerequisite [raven#350](https://github.com/jbearak/raven/issues/350); this plan captures `lazy_data` (Task 1.2) + base datasets via base-exports file (Tasks 3.5/4.2) |

**2. Placeholder scan** — No "TBD"/"add error handling"/"similar to Task N". Code steps show complete code; the grilling REVISED callouts (Tasks 1.3, 1.4, 3.1, 4.2, 5.3) specify their deltas as concrete code, superseding the v1 skeleton beneath them. Verify-at-implementation notes: Task 5.5 (`getServerPath` scope, `extension.ts:100`); Task 4.x r-universe JSON shape & a possible bulk endpoint (pinned by fixtures, validated by the build-differential test). `scan_workspace` shape verified during planning (`state.rs:1140`).

**3. Type consistency** — `PackageRecord` (`name/exports/depends/lazy_data`) consistent across Tasks 1.2–1.4, 3.5, 4.1–4.2, 5.3. `PackageMetadataProvider::lookup(&self,&str)->Option<PackageInfo>` consistent across 1.1/1.3/1.4 + test fakes. Construction split — `build_library_inner` / `build_package_library_tier1_only` / `build_package_library` (4-arg) — consistent across Tasks 3.1 (def), 5.3 (freeze uses tier1_only), 4.2 (build uses tier1_only); existing 4-arg callers untouched. Typed errors `RepoDbError`/`ShippedDbError` (Tasks 1.3/1.4) surfaced via `PackageLibraryOutcome.load_notes` (Tasks 3.1/3.6). `RepoDb` carries `schema_version` (Tasks 1.3, 3.5, 5.3). `FreezeScope::{Used,All}`, `ShippedDbProvenance`, `RepoDbProvenance` fields consistent across their tasks.

**4. Internal consistency after grilling revisions** — Task 2.3 removed (decision #12); the prefetch warm test relocated into the Task 2.3 stub and passes via Task 2.2 alone. `prefetch_packages` is explicitly *unchanged*. All `build_package_library(…, true)` call sites in tests (Tasks 3.1, 3.2, 5.4, 5.6) intentionally use the runtime (provider-wiring) path; only freeze and `build-shipped-db` use `build_package_library_tier1_only`.

All spec requirements map to a task; the one scope item that became a dependency (datasets) is tracked as [raven#350](https://github.com/jbearak/raven/issues/350).
