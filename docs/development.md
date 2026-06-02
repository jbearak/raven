# Development Notes

This document is for contributors/maintainers (and LLMs) working on Raven’s Rust codebase. User-facing behavior is documented in `README.md` and `docs/`.

## Where to look first

User-facing docs:
- `README.md`
- `docs/cross-file.md`
- `docs/r-package-dev.md`
- `docs/directives.md`
- `docs/diagnostics.md`
- `docs/indentation.md`
- `docs/r-console.md`
- `docs/plot-viewer.md`
- `docs/data-viewer.md`
- `docs/help-viewer.md`
- `docs/document-outline.md`
- `docs/coexistence.md`
- `docs/configuration.md`

Key code entry points:
- Cross-file metadata extraction: `crates/raven/src/cross_file/mod.rs` (`extract_metadata()`)
- Dependency graph: `crates/raven/src/cross_file/dependency.rs`
- Scope artifacts + interface hash: `crates/raven/src/cross_file/scope.rs`
- Path resolution: `crates/raven/src/cross_file/path_resolve.rs`
- Real-time updates / diagnostics gating: `crates/raven/src/cross_file/revalidation.rs`
- On-demand background indexing: `crates/raven/src/cross_file/background_indexer.rs`
- Package loading: `crates/raven/src/package_library.rs`
- Package state: `crates/raven/src/package_state/` (`PackageState`, `derive_package_state()`)
- Package namespace: `crates/raven/src/package_namespace.rs` (workspace detection, namespace model)
- Help rendering: `crates/raven/src/help/` (Rd2txt, Rd2HTML)
- Libpath watching: `crates/raven/src/libpath_watcher.rs`
- Qualified member resolution: `crates/raven/src/qualified_resolve.rs`
- Parameter resolution: `crates/raven/src/parameter_resolver.rs`
- Roxygen parsing: `crates/raven/src/roxygen.rs`
- Content provider: `crates/raven/src/content_provider.rs`

## Build from source

Prerequisites:
- Rust toolchain (MSRV: 1.75)

Clone and build:
```bash
git clone https://github.com/jbearak/Raven.git
cd Raven
cargo build --release -p raven
# Binary will be at target/release/raven
```

## Build, test, run

- Debug build: `cargo build -p raven`
- Release build: `cargo build --release -p raven`
- Run (stdio): `RAVEN_PERF=1 cargo run -p raven -- --stdio`
- Unit tests: `cargo test -p raven`
- Integration tests: `cargo test -p raven --features test-support -- --test`
- Bun tests (TypeScript): `bun test` (from repo root; `bunfig.toml` sets root to `./tests/bun`)
- VS Code extension tests: `cd editors/vscode && bun run test`
- Setup (build + install + package): `./scripts/setup.sh`

The VS Code extension tests include a real-layout webview harness for the
data-viewer toolbar's responsive chip-wrap behavior
(`editors/vscode/src/test/toolbar-wrap-layout.test.ts` +
`toolbar-wrap-harness-panel.ts`). The harness mounts the production
toolbar JSX in a webview, pins its width via `postMessage`, and posts the
measured geometry back to the host for assertions. The harness bundle
lives at `editors/vscode/dist-test/toolbar-wrap-harness/` — separate from
the shipped `dist/`, built by `bun run bundle:webview-test` (already
wired into `pretest`), excluded from the VSIX. Set
`RAVEN_SKIP_LAYOUT_TESTS=1` to skip the suite in sandboxes that can't
render a webview.

### Benchmarks

All benchmarks except `startup` require `--features test-support`. Set `RAVEN_BENCH_ALLOC=1` for allocation tracking.

- `cargo bench --bench startup`
- `cargo bench --bench lsp_operations --features test-support`
- `cargo bench --bench cross_file --features test-support`
- `cargo bench --bench libpath_capture --features test-support`
- `cargo bench --bench edit_to_publish --features test-support`

## Profiling startup

Python scripts under `scripts/` measure LSP startup latency:
- `scripts/profile_startup.py`: spawns the LSP, opens files, measures time to first diagnostic
- `scripts/profile_simple.py`: simpler initialization timing

Typical flow:
- `cargo build --release -p raven`
- `python3 scripts/profile_startup.py`

## Heap profiling

For investigating memory usage, allocation patterns, and leaks, Raven supports two heap profiling approaches.

### Quick RSS profiling with `analysis-stats`

The built-in `analysis-stats` command reports peak RSS after each analysis phase — useful for a quick check without any extra tooling:

```bash
cargo build --release -p raven
./target/release/raven analysis-stats /path/to/workspace
```

This reports timing and peak RSS per phase (parse, metadata, scope, packages). Use `--csv` for machine-readable output or `--only <phase>` to isolate a single phase.


## Releasing

### Version bump and tag

Use the bump script to update versions, commit, tag, and push:

```bash
./scripts/bump-version.sh           # patch bump (default): 0.1.0 -> 0.1.1
./scripts/bump-version.sh patch     # same as above
./scripts/bump-version.sh minor     # 0.1.1 -> 0.2.0
./scripts/bump-version.sh major     # 0.2.0 -> 1.0.0
./scripts/bump-version.sh 2.0.0     # explicit version
```

This updates `Cargo.toml` (workspace version) and `editors/vscode/package.json`, commits the change, creates a git tag, and pushes both.

### CI build

Pushing the tag triggers `release-build.yml`, which:
1. Cross-compiles the `raven` binary for 6 platforms (linux-x64, linux-arm64, macos-arm64, macos-x64, windows-x64, windows-arm64)
2. Packages a platform-specific `.vsix` for each target (the binary is embedded in `bin/`)
3. Generates a Sigstore-backed build-provenance attestation (`actions/attest-build-provenance`) for each `raven-<platform>.zip` and `.vsix`, so a published artifact can be verified with `gh attestation verify <file> --repo jbearak/raven`

### Publishing

After the build succeeds, manually run `release-publish.yml` from GitHub Actions:
1. Enter the tag (e.g., `v0.2.0`)
2. Optionally check "Publish to VS Code Marketplace and Open VSX"

This creates a GitHub Release with all binaries and `.vsix` files. If marketplace publishing is enabled, it uploads each platform `.vsix` to both VS Code Marketplace and Open VSX.

**Required secrets** (for marketplace publishing): `VSCE_PAT`, `OVSX_PAT`.

## Cross-file internals (high-level)

Cross-file awareness is implemented under `crates/raven/src/cross_file/`.

Rough pipeline:
1. Extract per-file metadata (directives + AST-detected `source()` + library calls)
2. Update dependency graph edges (forward + backward)
3. Compute per-file artifacts (exported interface, timeline, interface hash)
4. Resolve scope at a position by traversing edges and applying call-site filtering
5. Revalidate dependents on relevant changes (interface hash / edges / working directory changes)

### Module map

Key files under `crates/raven/src/cross_file/`:

- `mod.rs` — Public API (`extract_metadata()`)
- `dependency.rs` — Dependency graph (forward + backward edges)
- `scope.rs` — Scope artifacts, interface hash, scope-at-position resolution
- `path_resolve.rs` — Path resolution (forward vs backward invariant)
- `revalidation.rs` — Real-time updates, diagnostics gating, debounce
- `background_indexer.rs` — On-demand background indexing
- `source_detect.rs` — AST-based detection of `source()`, `sys.source()`, and related calls
- `directive.rs` — Parsing of `@lsp-*` directive comments
- `types.rs` — Shared types (`CrossFileMetadata`, `SymbolKind`, etc.)
- `config.rs` — Cross-file configuration (cache sizes, debounce intervals, feature flags)
- `parent_resolve.rs` — Parent-prefix scope resolution (backward-edge traversal)
- `content_provider.rs` — Cross-file content provider (open-doc-authoritative reads)
- `cache.rs` — `MetadataCache`
- `file_cache.rs` — `CrossFileFileCache` (content + existence)
- `workspace_index.rs` — `CrossFileWorkspaceIndex`
- `property_tests.rs` / `integration_tests.rs` — Property-based and integration test suites

### Path resolution invariant (forward vs backward)

There is a deliberate distinction in how relative paths are resolved:
- **Backward directives** (`@lsp-sourced-by`, `@lsp-run-by`, `@lsp-included-by`) are resolved **relative to the child file’s directory**, ignoring `@lsp-cd`.
- **Forward directives** (`@lsp-source`, `@lsp-run`, `@lsp-include`) and AST-detected **`source()` calls** resolve using `@lsp-cd` when present (otherwise file-relative).

Implementation:
- Backward directives must use `PathContext::new()`.
- Forward directives and `source()` calls must use `PathContext::from_metadata()`.

User-facing explanation/examples live in `docs/cross-file.md`.

### Workspace-root fallback for unannotated codebases

For codebases without `@lsp-cd`, `source()` paths are often written relative to the workspace root.

For **AST-detected `source()` calls and forward directives** (`@lsp-source`, `@lsp-run`, `@lsp-include`), Raven attempts:
1. File-relative resolution
2. If the file does not exist *and* there is no explicit/inherited working directory: try workspace-root-relative resolution

Forward directives are semantically equivalent to `source()` calls (see `.kiro/specs/lsp-source-directive/`) and must resolve identically across dependency edges, scope, diagnostics, cmd-click, and path completion. This fallback must **not** apply to backward directives.

### Parent-prefix scope and forward-source traversal

Scope resolution has two distinct graph traversals:
- **Parent prefix**: when resolving a file, Raven first walks backward edges to model symbols available at the start of that file. Symbols introduced only by this prefix are tracked separately so they can be filtered when a child is re-exported through a forward `source()` edge.
- **Forward sources**: Raven then applies the file's local timeline. When following `source()` calls, real forward-source execution uses a path-local copy of the visited map so one sourced sibling's recursive walk cannot make a later sibling source look already visited. Parent-prefix discovery keeps shared visited pruning to avoid expanding every possible parent/forward path while collecting inherited context.

### Interface hash + selective invalidation

`ScopeArtifacts` includes an `interface_hash` used to avoid cascading revalidation when edits don’t change a file’s “exported interface”.

The hash is deterministic and includes:
- Exported symbols
- Loaded packages (from `library()` / `require()` / `loadNamespace()`)
- Declared symbols (from `@lsp-var` / `@lsp-func` directives)

The backend uses `old_interface_hash` vs `new_interface_hash` to decide whether to revalidate dependents.

### Caching model

Cross-file caches use the `lru` crate and are wrapped with locks for interior mutability.

Concurrency choice:
- Reads use `peek()` (no LRU promotion) under read locks.
- Writes use `push()` under write locks.

Implication: eviction is effectively “LRU by insertion/update time”, not “LRU by access time”, which keeps the read path maximally concurrent.

Default capacities are defined close to each cache:
- `MetadataCache`: `crates/raven/src/cross_file/cache.rs`
- `CrossFileFileCache` (content + existence): `crates/raven/src/cross_file/file_cache.rs`
- `CrossFileWorkspaceIndex`: `crates/raven/src/cross_file/workspace_index.rs`
- `WorkspaceIndex`: `crates/raven/src/workspace_index.rs`

Cache sizes are configurable via VS Code settings and applied during initialization/config change.

### Real-time diagnostics & monotonic publishing

Cross-file revalidation is debounced and cancelable.

A diagnostics gate enforces monotonic publishing:
- never publish diagnostics for an older document version
- allow “force republish” at the same version for dependency-triggered revalidation

See `crates/raven/src/cross_file/revalidation.rs`.

### Interactive request cancellation

Raven keeps `tower-lsp` at `.concurrency_level(1)` to preserve ordered text sync, which means tower-lsp's built-in `$/cancelRequest` notification can be delayed behind the in-flight request it is supposed to cancel. `start_lsp()` wraps the `LspService` in `RequestCancellationService`, which intercepts `$/cancelRequest` synchronously in `Service::call` and records cancellations in a request-id keyed registry before tower-lsp queues the notification.

Interactive handlers that can spend noticeable time in cross-file scope resolution should use a request-scoped `DiagCancelToken` from the registry and poll it through long loops and scope helpers. Qualified-member go-to-definition threads this token through `goto_definition_with_cancel` → `resolve_qualified_member_with_cancel` → `get_cross_file_scope_with_cache`, including per-candidate validation. New interactive multi-position resolvers should follow the same pattern: keep a request-local `ParentPrefixCache`, pass the token into every scope lookup, and check the token between candidate batches while still preserving a single `WorldState` snapshot.

### Semantic tokens

Raven advertises full-document semantic tokens for R documents and currently emits the standard LSP `function` token type for function-definition names and call heads. The token legend order is part of the LSP contract: keep `SemanticTokenType::FUNCTION` at index 0 unless all encoded token-type indexes are updated together.

### On-demand background indexing

On-demand indexing is used to index files that are not currently open in the editor, prioritizing:
- direct sourced files
- backward-directive targets
- then transitive dependencies (bounded depth + bounded queue)

See `crates/raven/src/cross_file/background_indexer.rs`.

## Package library internals

Raven prefers static parsing for package exports and uses R subprocesses selectively.

Key ideas:
- Parse `NAMESPACE` exports when available (fast)
- Detect `exportPattern()` and only then fall back to an R subprocess for accurate expansion
- If R is unavailable, fall back to `INDEX` parsing (best-effort)
- When merging `Depends` with meta-package `attached_packages`, keep a companion `HashSet` for dedupe; repeated `Vec::contains()` checks make recursive export expansion quadratic.

All R subprocess calls must:
- validate user-controlled inputs (package names, paths)
- use timeouts to avoid hangs

See `crates/raven/src/package_library.rs` and `crates/raven/src/r_subprocess.rs`.

## Package-export databases (CI / R-free resolution)

This subsystem lets Raven resolve package **export names** without an installed
package or a running R — the case that makes `raven check` usable in CI. It is an
**ordered fallback over three tiers**: Tier 1 (installed, authoritative — the
existing path above) → Tier 2 (a committed, repo-specific `.raven/packages.json`)
→ Tier 3 (a `names.db` sidecar). Release archives and package-manager builds ship `names.db` next to the executable; raw Cargo/source installs ship only the executable and need `raven packages update` for broad CRAN/Bioconductor coverage. R's base-priority packages are embedded in the binary (all 14; only the default-attached base-7 are always in scope). The user-facing contract lives in
[`docs/package-database.md`](package-database.md); this section is the internals.

**Critical invariant — names ≠ install status.** The databases feed *export
resolution* only (they suppress the undefined-variable storm when R is absent).
They **never** make a package count as installed. The missing-package diagnostic
is Tier-1-only and is suppressed by default in `raven check` (re-enabled with
`--report-uninstalled`). `package_exists()` is never wired to consult providers.
See `docs/diagnostics.md` and `crates/raven/src/handlers.rs`.

### The `package_db` module

A new top-level module (`crates/raven/src/package_db/`) — declared in
`crates/raven/src/lib.rs` only, while `main.rs` remains a thin shim — owns all
encoding/decoding. `package_library.rs` is not moved or rewritten; it only gains
the seam.

- **One serializable record:** `model::PackageRecord` is the on-disk projection
  of `PackageInfo` — `{ name, version, exports, depends, lazy_data }`, with all
  vectors kept **sorted and de-duplicated** so the Tier 2 JSON is deterministic
  and diff-friendly. `version` (the `DESCRIPTION` `Version`, `""` when unknown)
  rides in both encodings and drives the Tier 3 monotonic merge (see below);
  `PackageInfo` itself carries no version, so `from_info` defaults it to `""` and
  `into_info` drops it — the field is populated only by the capture paths
  (reference-R seed, `freeze`, r-universe ingest). `is_meta_package` /
  `attached_packages` are a pure function of the package name, so they are
  **re-derived on read** (via `PackageInfo::with_details`), never stored.
- **Two encodings, one reader each:**
  - **Tier 2 — `json_db.rs`** (`RepoDb`): deterministic, sorted, pretty JSON,
    committed as `.raven/packages.json`. Carries minimal provenance (Raven
    version, R version, generation epoch) and a `schema_version`
    (`REPO_DB_SCHEMA_VERSION`).
  - **Tier 3 — `binary_db.rs`** (`ShippedDb`): a compact, memory-mapped,
    lazily-decoded container. Layout: `MAGIC(8) | version(u32) | header_len(u32)
    | header(postcard) | payload`. The header (provenance + a `blake3` hex of the
    payload region + an index of `{name, offset, len}`) is decoded **once at
    open**; per-package `PackageRecord`s in the mmap'd payload are postcard-decoded
    **lazily** on lookup. Versioned by `FORMAT_VERSION`. Dependencies: `memmap2`,
    `postcard` (added in Milestone 1); `blake3` was already a dep.
- **Typed reader errors, explained not dropped (decision #9):** each reader
  returns `Absent` (normal, silent) vs `UnsupportedSchema { found, supported }` /
  `UnsupportedFormat` vs `Corrupt`. A present-but-unusable file (e.g. a
  `.raven/packages.json` written by a newer Raven) is **explained and the surface
  continues**: `raven check` prints a specific stderr note, the language server
  raises `window/showMessage`, then resolution degrades to the next tier. A
  missing or unreadable database never hard-fails the LSP or the build.
- **Tier 3 locator order:** environment overrides still win, then the user-data
  sidecars installed by `raven packages update`, then exe-relative sidecars shipped
  by release archives and package-manager builds. Source/Cargo
  installs normally have only the user-data candidate unless the sidecars were
  placed manually next to the executable.

### The `PackageMetadataProvider` seam

Tier 1 stays a bespoke first step inside `get_package` — its subprocess/INDEX
logic is intertwined with `lib_paths` and the caches, and wrapping it would risk
regressing the authoritative path. The new tiers are pure pre-built reads, so the
seam is a small **synchronous** trait:

```rust
pub trait PackageMetadataProvider: Send + Sync {
    fn lookup(&self, name: &str) -> Option<PackageInfo>;
}
```

`PackageLibrary` gains an ordered `providers: Vec<Box<dyn PackageMetadataProvider>>`
(Tier 2 repo DB at index 0, Tier 3 shipped DB next), empty by default. The **one**
hook is in `get_package`: when `find_package_directory` misses (Tier 1 has no
directory), it consults the providers in order; the first hit is cached like any
other `PackageInfo`. A package no provider knows is left **uncached**, so
`package_exists()` still reports it missing.

`prefetch_packages` is **unchanged** (decision #12): its Step 3 already funnels
every loaded package — and transitive `Depends` and meta-package
`attached_packages` — through `get_all_exports → collect_exports_recursive →
get_package`, which carries the hook. So `library(tidyverse)` and `Depends`
chains resolve in CI for free.

**Construction split (decision #6):** `freeze` (and the Tier 3 reference-R seed)
must capture a *provider-less* library so a "frozen Tier 1" file can't be
contaminated by Tier 2/3 guesses. Construction is split into
`build_library_inner` (no providers) feeding both
`build_package_library_tier1_only` (capture) and `build_package_library`
(runtime: inner + provider wiring). Existing 4-arg callers of
`build_package_library` are unchanged.

### Performance discipline (§12)

The LSP hot path (diagnostic collection) reads the in-memory cache `try_read`-only
and must not take a disk/page-fault stall. So:

- the Tier 3 index is **preloaded at open**; per-package payloads decode lazily
  from the mmap on first lookup;
- optionally, a one-shot `madvise(MADV_WILLNEED)` over the header/index region
  (~500 KB) right after `mmap` faults the offset table in before the first
  lookup — one syscall, eliminating even the first index page fault. A cheap
  nicety, not required for correctness, and a no-op on platforms without
  `madvise`;
- the `blake3` payload checksum is verified **at open, in `spawn_blocking`**
  (decision #13) — ~10–20 ms once during library init, off the async runtime —
  catching truncation/corruption/tampering;
- provider results feed the existing per-package cache, so steady-state lookups
  are lock-free reads with no provider call.

### Tier 3 build pipeline

The shipped `names.db` is built **append-only** from an authoritative reference-R
capture of the build machine's **entire installed library**
(`enumerate_installed_packages` across all lib paths, via the Tier 1 path:
`NAMESPACE` + subprocess `exportPattern` expansion + `data/` datasets) **∪** CRAN
+ Bioc r-universe (`cran.r-universe.dev` and `bioc.r-universe.dev` per-package
`_exports`/`_dependencies`/`_datasets`). Each rebuild **seeds from the previous
database by default** (append-only; `--fresh` rebuilds from scratch) and **never
drops** a package. **The merge is version-driven and monotonic (decision #16):**
for each package it keeps the record with the **highest version across all three
sources** (prior DB, reference-R, r-universe), so a package is never moved to an
older export set — a newer CRAN/Bioc release beats an older reference-R install, a
newer local/dev build beats an older CRAN release, and a still-newer prior capture
is retained. Equal versions tiebreak reference-R → r-universe → prior. The
comparison reads a `version` field on `PackageRecord` (captured from `DESCRIPTION`
`Version` by the reference-R seed and `freeze`, or the r-universe JSON `Version`);
the field rides in both encodings, so Tier 2 `.raven/packages.json` shows version
changes in `git diff` too. The full
installed library is the point — hard-to-install / GitHub-only / internal
packages enter the floor only this way, and append-only keeps them. The
maintainer **bootstraps** the floor once from a richly-provisioned machine; teams
can build a private `names.db` from their own library for richer in-house
coverage.

- **Entry point:** `raven packages build-shipped-db` (maintainer/CI-only — the
  shipped binary itself is **network-free**; the workflow uses `curl` to fetch
  r-universe JSON into a directory that the command then transforms). Code:
  `cli/packages.rs`, `package_db/{merge,runiverse}.rs`.
- **Embedded base packages (ADR 1):** all 14 of R's base-priority packages
  (`installed.packages(priority="base")`) are compiled into the binary as a
  `// @generated` per-package table in
  `embedded_base.rs` / `embedded_base_generated.rs`. Regenerate with
  `raven packages build-embedded-base --reference-lib <DIR>`. `initialize()`
  loads every package into the per-package cache (datasets → `lazy_data`) so
  `library(grid)` etc. resolve offline, but only the 7 default-attached packages
  (`get_fallback_base_packages()`: `base`, `methods`, `utils`, `grDevices`,
  `graphics`, `stats`, `datasets`) seed the flat always-in-scope `base_exports`
  set + `base_packages`. `names.db` excludes all base-priority packages
  post-merge (the `build-shipped-db` filter strips everything embedded, via
  `embedded_base_packages()`). A real R install
  still wins.
- **Delivery (decision #14):** one sidecar — `names.db` + checksums — lives on a
  **GitHub Release** (moving `names-db` tag) — durable across runs, unlike a
  per-run CI artifact. `raven packages update` is the explicit network boundary for
  source/Cargo installs and should be part of CI image setup/cache warmup, not
  normal LSP startup, completion, hover, package lookup, or `raven check`. A
  `workflow_dispatch` + scheduled job
  (`.github/workflows/build-names-db.yml`; weekly schedule `0 6 * * 1`) downloads
  the current asset (the seed), rebuilds via the shared
  `scripts/build-names-db.sh`, and re-uploads. `release-build.yml` downloads the
  same asset to place `names.db` exe-relative next to the binary in the release
  archives; the VSIX omits it (VS Code users resolve their locally installed
  packages via Tier 1). A Git LFS seed is committed at
  `crates/raven/data/names-db-seed.db` for bootstrap/disaster-recovery only (not a
  build input). Located via the Tier 3 candidate locator — `RAVEN_NAMES_DB`
  override, then user data, then exe-relative. **Not** `include_bytes!` (avoids
  binary bloat), **not** committed to git (except tiny back-compat fixtures).
- The scheduled `build-names-db.yml` workflow stays on the default branch so GitHub Actions can run its cron, but its `actions/checkout` step is pinned to the protected `names-db-builder` branch. That branch is the production source line for the DB builder; merge only reviewed, release-compatible DB-builder changes into it.
- `release-build.yml` downloads the current `names-db` Release asset once, validates it with the just-tagged Raven source via `raven packages validate-shipped-db`, uploads that validated file as a workflow artifact, and every platform package bundles that artifact. This prevents a mutable Release asset from changing between validation and packaging.
- **Replacing the file (Windows mmap lock):** while `names.db` is mapped, Windows
  holds the file open (`CreateFileMapping` keeps a handle), so it cannot be
  overwritten in place. Writers (the bundle step, and any future in-process
  refresh) must use **atomic rename** — write `names.db.tmp`, then rename over the
  old file. On POSIX the rename succeeds even with the old inode still mapped
  (readers keep the old mapping until they re-open); on Windows an in-process
  refresh must **unmap → replace → remap**, tolerating a brief window with no
  mapping. This is a solved pattern (SQLite, clangd) but is called out so the
  implementation doesn't assume in-place overwrite works everywhere.
- **Growth bound:** append-only means the file grows monotonically, but slowly —
  at CRAN's ~2k-packages/year rate, ~1.7 MB/year, so a ~20–25 MB database stays
  under ~40 MB a decade out. Names-only storage keeps the bound comfortable; no
  pruning is planned.

### Dependency on #350 (package-dataset resolution)

`PackageRecord` captures `lazy_data`. [raven#350](https://github.com/jbearak/raven/issues/350)
(landed) wired dataset resolution into `collect_exports_recursive`, so a Tier 2/3
record's `lazy_data` is folded into the resolvable set automatically — *non-base*
package datasets resolve in CI with no extra work in this subsystem. (Base
datasets come via the embedded base table, above.)

### Testing approach

- **Runtime tempdir fixtures** for round-trip tests (write → open → lookup) of
  both encodings, plus bad-magic / version-skew / payload-tamper rejection.
- **Committed back-compat fixtures** (decision #15): tiny `names.db` +
  `.raven/packages.json` under `crates/raven/tests/fixtures/package_db/` guard
  format back-compat ("old fixtures still load").
- **No-R consumer integration test** (`tests/package_db_consumer.rs`): empty
  libpaths, `library(dplyr); mutate(...)` yields no undefined-variable;
  `library(dpylr)` behaves per the names-vs-install-status split.
- **Build-side differential** (deferred to the `build-names-db` job, where R + a
  sample corpus are available): diff `names.db` against `getNamespaceExports()`.
- **Generation round-trip** (on a machine with R): generate `.raven/packages.json`,
  read it back, assert parity with the live Tier 1 result.

## Other subsystems

Brief orientation for modules outside the cross-file and package-library subsystems.

- **`package_state/`** — Derived state for R package mode. Owns workspace detection result, namespace model, per-file facts (exported symbols, roxygen tags), and the aggregate scope contribution. Fully derive-based: `derive_package_state()` recomputes the entire `PackageState` from inputs.
- **`package_namespace.rs`** — R package workspace detection (DESCRIPTION-based) and namespace model. Detects roxygen-managed packages by scanning for `#' @export` in `R/*.R` files.
- **`help/`** — R help text and HTML rendering. `text` submodule provides Rd2txt for hover/completion; `html` submodule shells out to R's `tools::Rd2HTML` for the webview help panel. Results are cached via `HtmlHelpCache`.
- **`libpath_watcher.rs`** — Filesystem watcher for `.libPaths()` directories using the `notify` crate. Watches recursively, debounces events, diffs directory snapshots, and emits `LibpathEvent::Changed` with added/removed/touched package deltas.
- **`qualified_resolve.rs`** — Resolves the RHS of `$` and `@` operators for go-to-definition. Collects member-assignment candidates from the defining file and cross-file scope contributors, validates via re-resolution, and tie-breaks by dependency-graph distance.
- **`parameter_resolver.rs`** — Resolves function parameter info for completion suggestions. Extracts parameters from AST for user-defined functions; queries R subprocess `formals()` for package functions. Uses an LRU cache for subprocess results.
- **`roxygen.rs`** — Parses roxygen2 (`#'`) and plain comment blocks above function definitions. Extracts title, description, and `@param` entries for hover and completion documentation.
- **`content_provider.rs`** — Unified file access abstraction. Respects the "open docs are authoritative" rule: open documents are read from the document store; closed files fall through to disk/cache.
- **`editors/vscode/src/knit/knit-output-panel.ts`** — Per-source-path webview-panel registry for the `Raven: Knit` output viewer. Keyed by `sourceUri.fsPath` (aligned with the in-flight gate in `knit-commands.ts`). Tracks a `previewColumn` static so new panels stack as tabs in a single column rather than scattering; `recomputePreviewColumn` runs on every `onDidChangeViewState` / `onDidDispose` and adopts a surviving panel's column when the recorded one empties. The companion `help/help-panel.ts` remains a singleton (one R-help context per session is the right shape for that domain). See `docs/superpowers/specs/2026-05-17-knit-panel-per-file-design.md`.
- **`editors/vscode/src/viewer-tab-icon.ts`** + **`version-gate.ts`** — Editor-tab icons for the four webview viewers, assigned via `WebviewPanel.iconPath`. Codicon ids: help → `question`, data → `table`, plot → `graph`, knit → `book`. `WebviewPanel.iconPath` only honors a `ThemeIcon` at runtime on VSCode ≥ 1.110 (microsoft/vscode#282608); Raven's engine and `@types/vscode` floors both stay at `^1.82.0`, so `viewerTabIcon` returns `undefined` on older hosts (leaving the default page icon) and `applyViewerTabIcon` is the single helper callers should use. `applyViewerTabIcon` centralizes the locally widened `WebviewPanel.iconPath` cast required because the 1.82 typings only accept image `Uri` icons even though VSCode ≥ 1.110 accepts a `ThemeIcon` at runtime. `version-gate.ts` stays free of any `vscode` import so the pure `meetsMinVersion` is bun-testable (`tests/bun/version-gate.test.ts`).

## Coding conventions (repo-level)

- Avoid `bail!`; prefer explicit `return Err(anyhow!(...))`.
- Prefer `log::trace!` in hot/verbose paths.
- Avoid blocking filesystem I/O on request handlers; use async or `spawn_blocking`.
- Be careful with UTF-16 vs byte offsets: convert before constructing tree-sitter `Point`s.

## Testing notes

- Unit tests live alongside modules under `#[cfg(test)]`.
- Property-based tests use `proptest`.
- Integration tests live in `crates/raven/tests/` (performance budgets, libpath watching, indentation). These require `--features test-support`.
- Bun tests (`tests/bun/`) cover TypeScript extension logic: plot viewer, data viewer, help viewer, send-to-R, config validation.
- VS Code extension tests (`editors/vscode/src/test/`) use `@vscode/test-cli` with Mocha.

### AST inspection utility

For quickly validating tree-sitter node kinds, use the `inspect_ast()` helper (see `crates/raven/src/handlers.rs`). Run with `--nocapture` to print.

## Learnings

Canonical list: `AGENTS.md`. Prefer code comments over Learnings entries — see `AGENTS.md` header for the policy.
