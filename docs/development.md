# Development Notes

This document is for contributors/maintainers (and LLMs) working on Raven’s Rust codebase. User-facing behavior is documented in `README.md` and `docs/`.

## Where to look first

User-facing docs:
- `README.md`
- `docs/cross-file.md`
- `docs/declaration-directives.md`
- `docs/packages.md`
- `docs/configuration.md`

Key code entry points:
- Cross-file metadata extraction: `crates/raven/src/cross_file/mod.rs` (`extract_metadata()`)
- Dependency graph: `crates/raven/src/cross_file/dependency.rs`
- Scope artifacts + interface hash: `crates/raven/src/cross_file/scope.rs`
- Path resolution: `crates/raven/src/cross_file/path_resolve.rs`
- Real-time updates / diagnostics gating: `crates/raven/src/cross_file/revalidation.rs`
- On-demand background indexing: `crates/raven/src/cross_file/background_indexer.rs`
- Package loading: `crates/raven/src/package_library.rs`

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
- Tests: `cargo test -p raven`
- Benchmarks: `cargo bench --bench startup`
- Run (stdio): `RAVEN_PERF=1 cargo run -p raven -- --stdio`

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

### jemalloc heap profiling

> **Note:** These features are not wired up in the repository by default. Follow the steps below to add them locally when you need to profile.

[jemalloc](https://github.com/jemalloc/jemalloc) provides detailed heap profiling with allocation backtraces. This is the best option for finding where memory is allocated in a running Raven process.

**1. Add jemalloc as a feature-gated dependency** in `crates/raven/Cargo.toml`:

```toml
[features]
jemalloc = ["tikv-jemallocator", "tikv-jemalloc-ctl"]

[dependencies]
tikv-jemallocator = { version = "0.5", features = ["profiling"], optional = true }
tikv-jemalloc-ctl = { version = "0.5", optional = true }
```

**2. Set jemalloc as the global allocator** (gated behind the feature) in `src/main.rs`:

```rust
#[cfg(feature = "jemalloc")]
#[global_allocator]
static ALLOC: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;
```

**3. Build and run with profiling enabled:**

```bash
cargo build --release -p raven --features jemalloc

# Enable jemalloc profiling via environment variable
MALLOC_CONF="prof:true,prof_prefix:raven" \
  ./target/release/raven analysis-stats /path/to/workspace
```

This produces `raven.<pid>.<seq>.heap` files in the current directory.

**4. Analyze the heap dump** with `jeprof` (ships with jemalloc):

```bash
# Text summary of top allocators
jeprof --show_bytes ./target/release/raven raven.*.heap

# Generate a PDF call graph
jeprof --pdf ./target/release/raven raven.*.heap > heap.pdf
```

### dhat (DHAT) heap profiling

[dhat](https://docs.rs/dhat) is a Rust-native heap profiler that records every allocation and produces a JSON file viewable in an interactive viewer. It's simpler to set up than jemalloc profiling and works on all platforms.

**1. Add dhat as a feature-gated dependency** in `crates/raven/Cargo.toml`:

```toml
[features]
dhat = ["dep:dhat"]

[dependencies]
dhat = { version = "0.3", optional = true }
```

**2. Add the dhat allocator and profiler** (gated behind the feature) in `src/main.rs`:

```rust
#[cfg(feature = "dhat")]
#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;
```

Then at the top of `main()`:

```rust
#[cfg(feature = "dhat")]
let _profiler = dhat::Profiler::new_heap();
```

The profiler writes `dhat-heap.json` on drop (when the process exits).

**3. Build and run:**

```bash
cargo build --release -p raven --features dhat
./target/release/raven analysis-stats /path/to/workspace
```

**4. View the results** in the [DHAT viewer](https://nnethercote.github.io/dh_view/dh_view.html):

Open the viewer in a browser and load the generated `dhat-heap.json` file. The viewer shows allocation trees, byte counts, and block counts — useful for finding allocation-heavy code paths.

### When to use which

| Tool | Best for | Platform | Overhead |
|------|----------|----------|----------|
| `analysis-stats` | Quick RSS check, phase-level timing | All (Linux/macOS) | None |
| jemalloc | Detailed allocation backtraces, leak detection | Linux/macOS | Moderate |
| dhat | Per-allocation tracking, interactive viewer | All | High (2–3× slowdown) |

For routine checks, start with `analysis-stats`. For deeper investigation, use jemalloc (production-like overhead) or dhat (most detail, highest overhead).

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

For **AST-detected `source()` calls only**, Raven attempts:
1. File-relative resolution
2. If the file does not exist *and* there is no explicit/inherited working directory: try workspace-root-relative resolution

This fallback must **not** apply to backward directives.

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

All R subprocess calls must:
- validate user-controlled inputs (package names, paths)
- use timeouts to avoid hangs

See `crates/raven/src/package_library.rs` and `crates/raven/src/r_subprocess.rs`.

## Coding conventions (repo-level)

- Avoid `bail!`; prefer explicit `return Err(anyhow!(...))`.
- Prefer `log::trace!` in hot/verbose paths.
- Avoid blocking filesystem I/O on request handlers; use async or `spawn_blocking`.
- Be careful with UTF-16 vs byte offsets: convert before constructing tree-sitter `Point`s.

## Testing notes

- Unit tests live alongside modules under `#[cfg(test)]`.
- Property-based tests use `proptest`.

### AST inspection utility

For quickly validating tree-sitter node kinds, use the `inspect_ast()` helper (see `crates/raven/src/handlers.rs`). Run with `--nocapture` to print.

## Learnings

Canonical list: `AGENTS.md`.

When a learning is best kept next to the code it constrains, add/expand a localized module doc/comment and keep the corresponding `AGENTS.md` entry as a pointer.
