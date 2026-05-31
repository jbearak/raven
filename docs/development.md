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

> **Status: planned — tracking [the CI package-exports DB work]. Not yet available in a released build.**

To allow Raven to resolve package export names and lazy-loaded datasets in CI environments where R and packages are not installed, Raven implements an ordered, three-tier fallback mechanism for export resolution.

### Architectural Tiers

1. **Tier 1 (Installed library):** The live, on-disk installed package path. This is the authoritative path and is always consulted first.
2. **Tier 2 (Repository Database):** A committed, diff-friendly JSON database at `.raven/packages.json` generated by the user (`raven packages freeze`). This captures the \"frozen\" state of Tier 1 packages used or declared in the repository.
3. **Tier 3 (Shipped Database):** A Raven-bundled, read-only binary database (`names.db`) built weekly from CRAN/Bioconductor and a reference-R seed. This provides a global fallback for almost all CRAN and Bioconductor packages.

### The `package_db` Module and Encodings

The `package_db` module manages serializable package export records and the metadata providers that read them.

- **`PackageRecord` Model:** The common, on-disk projection of `PackageInfo`. It stores `name`, `exports`, `depends`, and `lazy_data`. To remain diff-friendly and deterministic, all vectors within `PackageRecord` are normalized to be sorted and unique. Meta-package properties (like `attached_packages`) are re-derived dynamically from the package name on load rather than serialized.
- **Tier 2 JSON Format:** Stored at `.raven/packages.json`. It contains a `schema_version` (checked for compatibility on read) and a `provenance` block recording the generator metadata. On write, the list of packages is sorted by name so that git diffs are minimal.
- **Tier 3 Binary Container (`names.db`):** Uses a custom memory-mapped container format for maximum efficiency:
  ```text
  MAGIC        8 bytes  = b\"RAVNDB\\0\\0\"
  version      u32      = FORMAT_VERSION
  header_len   u32      = byte length of the postcard-encoded header
  header       header_len bytes (postcard-encoded ShippedDbHeader)
  payload      concatenated postcard-encoded PackageRecord elements
  ```
- **Error Handling (Explain-and-Continue):** Readers return typed errors (`Absent`, `UnsupportedSchema` / `UnsupportedFormat`, or `Corrupt`). If a database is present but unreadable (e.g. written by a newer Raven version with an incompatible schema), the system logs a stderr warning in the CLI or sends a `window/showMessage` warning in the language server, then continues gracefully by falling back to the next tier, rather than hard-failing.

### Seam and Resolution Flow

The `PackageLibrary` consults the `PackageMetadataProvider` trait seam synchronously when resolving package exports.
- **Seam Hook:** The hook is placed only inside `get_package()` when the local package directory is not found (a Tier 1 miss).
- **Caching:** Resolved Tier 2 and Tier 3 package records are inserted into the in-memory `PackageLibrary` cache. The hot path remains `try_read` and lock-free against the in-memory cache.
- **Install-Status Invariant:** The provider fallback is only used for export and lazy-data resolution. The `package_exists()` function, which determines package install-status (driving missing-package diagnostics), strictly queries Tier 1 (disk/R) and never consults fallback providers.
- **Prefetching:** `prefetch_packages()` does not need to change because it relies on `get_all_exports()`, which recurses through `get_package()`, naturally benefiting from the fallback providers.

### Performance Discipline

Tier 3 (`names.db`) performance is highly optimized:
- **Lazy Decoding:** The database index is loaded and parsed once when opened, while individual package records are memory-mapped and decoded lazily off the hot path.
- **Off-Thread Opening:** Opening the binary file and verifying its `blake3` checksum takes ~10–20 ms, which is run off the async thread using `spawn_blocking` to avoid blocking the LSP's reactive loop.

### Tier 3 Build Pipeline

The shipped Tier 3 database is built weekly via a GitHub Actions workflow (`build-names-db.yml`) and published as a GitHub Release (with the moving tag `names-db`).
- **Data Merging:** The build merges:
  1. A prior `names.db` seed downloaded from the release (guaranteeing append-only behavior).
  2. A reference-R capture of the build/maintainer machine's entire installed library.
  3. API-fetched package metadata from both CRAN and Bioconductor r-universe hosts.
- **Precedence:** Precedence is ordered as: `Reference-R > r-universe > retained-from-prior`. Packages are never dropped, preserving custom or internal packages.
- **Base Exports Companion:** A companion `base-exports.json` file is compiled from the reference-R capture and bundled. When R is completely absent in CI, `initialize()` merges this file's symbols and base datasets (e.g., `mtcars`) into the flat base-exports set so they resolve seamlessly.

### Testing Strategy

- **Round-Trip Tests:** Ensure `PackageRecord` normalizes, encodes, and decodes without loss.
- **Compatibility Fixtures:** Tiny pre-built JSON and binary databases are committed under `tests/fixtures/package_db/` to act as regression guards ensuring newer versions of Raven can still load older database schemas.
- **No-R Consumer Integration Test:** Recreates the CI environment (empty libpaths, no R) and asserts that the undefined-variable warning is suppressed for symbols in a package resolved via Tier 3, while `package_exists` still correctly returns false.

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
