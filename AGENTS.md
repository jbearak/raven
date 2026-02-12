# AGENTS.md - LLM Guidance for Raven

This file is intentionally short. It’s a map to the docs and a short list of invariants that are easy to regress.

IMPORTANT: Treat this as a living document. When you fix a subtle bug or a recurring LLM mistake, update **"Learnings"** (and keep the pointers and invariants current) as part of the same change.

## What to read (in order)

User-facing:
- `README.md`
- `docs/cross-file.md`
- `docs/declaration-directives.md`
- `docs/packages.md`
- `docs/indentation.md`
- `docs/document-outline.md`
- `docs/configuration.md`

Maintainer/internal:
- `docs/development.md`

Code (authoritative for behavior):
- Cross-file: `crates/raven/src/cross_file/`
- Indentation: `crates/raven/src/indentation/`
- Packages: `crates/raven/src/package_library.rs`, `crates/raven/src/r_subprocess.rs`

Reference implementation:
- `sight/` (git submodule) is the TypeScript reference implementation for several cross-file UX patterns.

## Documentation requirements

When making significant changes:

1. Update the relevant user-facing docs under `docs/` (and `README.md` if appropriate) when user-visible behavior changes.
2. For changes to internal architecture, caching, performance, or debugging guidance, update `docs/development.md`.
3. If you discover a new non-obvious pitfall (especially something an LLM got wrong), add it to **"Learnings"** in this file.
4. Prefer documenting invariants next to the code they constrain (module docs / comments) when that is the most durable place.
5. Keep this file’s pointers, “Key invariants”, and “Learnings” sections accurate over time.

## Key invariants (do not regress)

- **Path resolution**
  - Backward directives (`@lsp-sourced-by`, `@lsp-run-by`, `@lsp-included-by`) must resolve relative to the file’s directory and **ignore `@lsp-cd`** (`PathContext::new`).
  - Forward directives (`@lsp-source`, `@lsp-run`, `@lsp-include`) and AST-detected `source()` calls must **respect `@lsp-cd`** when present (`PathContext::from_metadata`).
  - See `crates/raven/src/cross_file/path_resolve.rs` and `docs/cross-file.md`.

- **Workspace-root fallback**
  - Workspace-root fallback resolution is for **AST-detected `source()` calls only**, and only when there is **no explicit or inherited working directory**.
  - Never apply workspace-root fallback to backward directives.

- **LRU caches under locks**
  - Under read locks, use `peek()` (no promotion) to keep reads concurrent.
  - Under write locks, use `push()` (eviction/promotion happens there).

- **Diagnostics publishing**
  - Diagnostics must be published monotonically by document version.
  - Dependency-triggered revalidation may republish at the same version via an explicit “force republish” mechanism, but never older versions.

- **R subprocess safety**
  - Validate user-controlled inputs (e.g., package names) before using them.
  - Use timeouts for all subprocess calls.
  - Avoid interpolating user-controlled strings into R code.

## Quick commands

- Debug build: `cargo build -p raven`
- Release build: `cargo build --release -p raven`
- Tests: `cargo test -p raven`
- Benchmarks: `cargo bench --bench startup`

## Learnings

- When building a new struct from `&T`, avoid `..*ref`/`..ref` in struct update syntax; clone the base (`..ref.clone()`) or construct fields explicitly.
- In tests that locate identifiers in generated code, avoid substring matches (e.g., `inner_func` inside `outer_func`). Prefer delimiter-aware search or node positions from the AST.
- Don’t recurse on identifier nodes just to “keep traversal going” — they have no children and the extra recursion can be removed for clarity.
- Avoid blocking filesystem I/O on LSP request threads; if a fallback check is needed, do it off-thread and revalidate via cache updates.
- Guard against deadlocks by avoiding nested async lock acquisition (especially around background indexer/state access).
- Use `saturating_add` (or equivalent) for sentinel end-of-line columns to prevent overflow.
- Don’t “paper over” missing files: file-existence checks must preserve accurate diagnostics instead of always returning `true`.
- Validate user-controlled package names/paths and skip suspicious values before using them in indexing or diagnostics.
- Avoid `expect()` in long-lived server paths (e.g., parser init); propagate errors with `Option`/`Result` instead.
- When adding new enum variants used in test match expressions, update all test helpers to keep matches exhaustive.
- Avoid hard-coded line/column positions in property tests; compute stable positions from the generated code or parsed nodes.
- When using `tokio::sync::watch`, guard waiters with in-flight state or revisions so late callers don’t hang on `changed()`.
- When using `u32::MAX` as an EOF sentinel, ensure function-scope filtering treats it as “outside any function” to avoid leaking locals.
- Distinguish “full EOF” (both line and column MAX) from end-of-line sentinels so scope filtering doesn’t drop function-local symbols at call sites.
- In proptest, prefer `prop_assume!` for invalid generated cases instead of returning early with non-unit values.
- Keep requirements docs aligned with the actual API surface (e.g., static construction vs insertion guarantees).
- Convert UTF-16 columns to byte offsets before constructing tree-sitter `Point`s; avoid mixing column units.
- When expanding point windows by a byte, advance to the next UTF-8 boundary to avoid mid-codepoint positions.
- Watch for O(n²) scope detection or duplicate-detection paths in large files; prefer indexed lookups when possible.
- Avoid duplicating local-scoping condition logic across functions; centralize to reduce drift.
- Be careful with hover/definition range calculations at line boundaries to avoid off-by-one bugs or invalid points.
- For removal events, use strict position comparisons (before, not at) to avoid removing symbols at their definition position.
- In hot scope-resolution paths, avoid repeated scans over large lists (e.g., function scopes per event); pre-compute mappings or cache lookups to prevent O(R·F) regressions.
- Keep doc comments and markdown examples aligned with current behavior (e.g., list= string literals support).
- Normalize markdown table spacing to match project lint expectations when adding spec tables.
- Avoid interpolating user-controlled strings into R code; pass help topics/packages as command args instead.
- R's `help()` function uses non-standard evaluation (NSE) for the `package` argument; wrap variables in parentheses to force evaluation: `help(topic, package = (pkg))` not `help(topic, package = pkg)`.
- Add language identifiers (e.g., `text`) to ASCII diagram/timeline fences to satisfy markdownlint (MD040).
- `tree_sitter::Tree` implements `Clone`; preserve ASTs in cloned index entries when reference searches depend on them.
- For intentionally-unused public APIs, either wire them into a caller or add a localized `#[allow(dead_code)]` with a brief comment to avoid warning noise.
- Base exports must be gated by `package_library_ready` to avoid using empty exports before R subprocess initialization completes.
- When adding parameters to scope resolution functions, update all callers including test helpers.
- For unannotated codebases (no @lsp-cd directives), use workspace-root fallback for source() path resolution - many R projects assume scripts run from the project root.
- The workspace-root fallback should ONLY apply when the file has no explicit @lsp-cd and no inherited working directory from parent chain; don't override intentional working directory configuration.
- When profiling LSP startup, use binary mode (not `text=True`) in Python subprocess calls - text mode can cause 30+ second delays due to buffering/encoding issues with LSP protocol.
- Profile with realistic workspaces: a workspace with many `library()` calls across files reveals bottlenecks that toy examples miss.
- Package export prefetching happens in background after `did_open` returns, but diagnostics wait for it - batch queries to minimize wait time.
- Filter already-cached packages before querying R to avoid redundant subprocess calls.
- 94% of CRAN packages use explicit `export()` directives (roxygen2); only ~6% use `exportPattern()`. Static NAMESPACE parsing eliminates R subprocess calls for most packages.
- The `base` package is special: it has no NAMESPACE file (only DESCRIPTION and INDEX). Handle this by checking for DESCRIPTION existence, not just NAMESPACE.
- INDEX files provide ~95% accuracy for packages using `exportPattern()` when R subprocess is unavailable - they list documented exports.
- Tiered loading (static → R → INDEX fallback) provides both speed and accuracy: sub-5ms for 94% of packages, accurate exports for all.
- When parsing structured R output (markers like `__PKG:name__`), handle missing end markers gracefully to avoid losing partial results.
- Always wrap R subprocess calls with `tokio::time::timeout()` to prevent hung R processes from blocking the LSP indefinitely.
- When iterating over identifiers in a file for diagnostics, cache scope resolution results by line number — the cross-file scope is identical for all identifiers on the same line, so calling `get_cross_file_scope()` per-identifier is wasteful.
- Pre-compute a line-offset index (`Vec<usize>` of line start positions) to avoid repeated `text.lines().nth(row)` calls, which are O(n) each time.
- Use `HashSet` for membership checks in hot loops (package deduplication, workspace imports); `Vec::contains()` is O(n) and adds up quickly in completion/diagnostic paths.
- For background work queues, maintain a companion `HashSet` of pending URIs alongside the `VecDeque` to enable O(1) duplicate detection instead of O(n) `iter().any()` scans.
- Unbounded caches (`HashMap` with no eviction) are a memory leak in long-running LSP sessions. Always set a maximum size or use time-based expiry.
- When multiple AST traversals extract different kinds of symbols (assignments, S4 methods), merge them into a single recursive walk to avoid redundant tree iteration.
- Add early termination to workspace symbol collection (`break` when `max_results` reached) to avoid collecting thousands of symbols only to truncate them.
- Use `Arc<str>` for frequently-cloned string fields (like `ScopedSymbol.name`) and corresponding HashMap keys to reduce O(n) String allocations to O(1) atomic refcount increments.
- When converting a HashMap key type from `String` to `Arc<str>`, lookups via `.get()` and `.contains_key()` need `&str` arguments (e.g., `var.as_str()`) since `HashMap<Arc<str>, _>` implements `Borrow<str>`.
- `Arc<str>` does NOT have a stable `.as_str()` method (it's behind the `str_as_str` feature gate); use `&*arc` instead to get a `&str` reference.
- The `lru` crate's `LruCache::new()` requires `NonZeroUsize`; always clamp capacity with `.unwrap_or()` to a sensible default to avoid panics.
- `LruCache` doesn't derive `Debug`; implement `Debug` manually using `finish_non_exhaustive()` when wrapping in a struct.
- Use `peek()` (not `get()`) for LRU reads under `RwLock` read locks — `get()` promotes the entry (mutates) and requires `&mut self`, while `peek()` takes `&self` and keeps reads concurrent.
- When migrating from reject-at-limit to LRU eviction, update property tests: entries can be silently evicted, so "was_present" tracking based on prior inserts becomes unreliable.
- Tree-sitter wraps incomplete expressions inside blocks (e.g., `x <-` inside `if (TRUE) { }`) in a single ERROR node spanning the entire block. Use content-line detection to place diagnostics on the first line with actual code content (not structural keywords or braces). When *emitting* diagnostics, emit once per ERROR node and do not recurse into ERROR children to avoid duplicates (but content-line detection may need to traverse ERROR subtrees to find the first content token).
- Backward directives and working directory directives are header-only: they must appear before any code (matching Sight). When tracking the header boundary in the parsing loop, check *before* the `@lsp-` pre-filter so code lines without directives still end the header.
- VS Code auto-closing pairs (e.g., `(` → `()`) mean that when `onTypeFormatting` fires after Enter, the closing delimiter is already present in the document. A line containing only a closing delimiter (with optional whitespace) should be treated as "inside parens/braces" for indentation, not as a "closing delimiter line" — the delimiter was pushed down by the Enter press and the user wants content-level indentation.
- "Ambiguous parent" diagnostics are misleading: a file being sourced by multiple parents is a valid use case, not an error. The diagnostic was removed entirely (previously controlled by `ambiguous_parent_severity` config).
- Backward and forward directives support `line=eof` and `line=end` as synonyms for "use scope at end of file" — useful when a parent file sources multiple helpers and child functions need access to all of them.
- `detect_cycle` returns the closing edge (from a different file), not an edge from the queried file. Diagnostic positions from the closing edge are invalid for the queried file. Always use an outgoing edge from the diagnosed file for positioning.
