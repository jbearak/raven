# AGENTS.md - LLM Guidance for Raven

This file is intentionally short: a map to the docs and a short list of invariants that are easy to regress.

IMPORTANT: Treat this as a living document, but **prefer code comments over Learnings entries**. Most subtle invariants belong as doc comments on the function or module they constrain — that's where they stay accurate as the code evolves and where the LLM will see them while editing the relevant code. Add a bullet to **"Learnings"** below only when the knowledge has no natural code home (it spans multiple systems, depends on environment, or is a recurring LLM mistake the user has explicitly flagged).

## What to read (in order)

User-facing:
- `README.md`
- `docs/cross-file.md`
- `docs/directives.md`
- `docs/diagnostics.md`
- `docs/indentation.md`
- `docs/document-outline.md`
- `docs/configuration.md`

Maintainer/internal:
- `docs/development.md`

Code (authoritative for behavior):
- Cross-file: `crates/raven/src/cross_file/` — see module docs in `scope.rs`, `revalidation.rs`, `dependency.rs` for `ScopeEvent`, `ScopeStream`, `ParentPrefixCache`, `compute_interface_hash`, `compute_affected_dependents_after_edit`, etc.
- Indentation: `crates/raven/src/indentation/`
- Packages: `crates/raven/src/package_library.rs`, `crates/raven/src/r_subprocess.rs`
- Diagnostic collectors: `crates/raven/src/handlers.rs` — `is_structural_non_reference` predicate is the single source of truth for "structural identifier; not a reference".

## Documentation requirements

When making significant changes:

1. Update the relevant user-facing docs under `docs/` (and `README.md` if appropriate) when user-visible behavior changes.
2. For changes to internal architecture, caching, performance, or debugging guidance, update `docs/development.md`.
3. For invariants tied to a specific function or module, write/expand the doc comment **on that function or module** rather than adding to Learnings here.
4. Keep this file's pointers, "Key invariants", and "Learnings" sections accurate over time.

## Key invariants (do not regress)

- **Path resolution**
  - Backward directives (`@lsp-sourced-by`, `@lsp-run-by`, `@lsp-included-by`) must resolve relative to the file's directory and **ignore `@lsp-cd`** (`PathContext::new`).
  - Forward directives (`@lsp-source`, `@lsp-run`, `@lsp-include`) and AST-detected `source()` calls must **respect `@lsp-cd`** when present (`PathContext::from_metadata`).
  - See `crates/raven/src/cross_file/path_resolve.rs` and `docs/cross-file.md`.

- **Workspace-root fallback**
  - Workspace-root fallback resolution is for **AST-detected `source()` calls only**, and only when there is **no explicit or inherited working directory** (file lacks `@lsp-cd` and no parent provides one).
  - Never apply workspace-root fallback to backward directives.
  - The same rule must hold across dependency-graph resolution, scope resolution, file-path go-to-definition, and path completion.

- **LRU caches under locks**
  - Under read locks, use `peek()` (no promotion) to keep reads concurrent.
  - Under write locks, use `push()` (eviction/promotion happens there).

- **Diagnostics publishing**
  - Diagnostics must be published monotonically by document version.
  - Dependency-triggered revalidation may republish at the same version via the explicit force-republish mechanism (`CrossFileDiagnosticsGate::mark_force_republish`), but never older versions.
  - Production publish paths must use `CrossFileDiagnosticsGate::try_consume_publish` (atomic predicate + version update + force-marker decrement). Pairing `can_publish` with `record_publish` is a TOCTOU race — that pair is for advisory pre-flight checks and tests only.

- **R subprocess safety**
  - Validate user-controlled inputs (e.g. package names) before using them.
  - Wrap all R subprocess calls with `tokio::time::timeout()` to prevent a hung R process from blocking the LSP.
  - Avoid interpolating user-controlled strings into R code; pass values as command args. R's `help()` uses NSE for the `package` argument — wrap variables in parens to force evaluation: `help(topic, package = (pkg))`.

- **Locking discipline in cross-file work**
  - Diagnostic computation and the libpath consumer's "which docs are affected" filter must NOT hold the `WorldState` read lock across cross-file scope resolution. Snapshot the inputs (artifacts, metadata, graph clone, config) under the lock, then release the guard before iterating; otherwise concurrent `did_change` writers starve.

## Quick commands

- Debug build: `cargo build -p raven`
- Release build: `cargo build --release -p raven`
- Tests: `cargo test -p raven`
- Benchmarks: `cargo bench --bench startup`

## Learnings

Items here have no natural code home. For invariants tied to a specific function, prefer a doc comment on that function — `git log` and existing module docs in `cross_file/scope.rs`, `cross_file/revalidation.rs`, `handlers.rs`, `package_library.rs`, `document_store.rs`, and `libpath_watcher.rs` already capture most subtle scope/diagnostics/package invariants.

### Cross-cutting code

- **tower-lsp 0.20** defaults to `buffer_unordered(4)` for all messages. Without `.concurrency_level(1)`, `did_change` notifications can be processed out of order, corrupting incremental text sync.
- **Module declarations**: when adding a top-level module to the `raven` crate, declare it in BOTH `crates/raven/src/lib.rs` AND `crates/raven/src/main.rs` — the lib and bin targets have separate module trees.
- **VS Code settings sync**: a new LSP-exposed setting must be wired in three places together — `editors/vscode/package.json` (schema), `editors/vscode/src/extension.ts` (initialization-options forwarding), and the shared init-options factory used by `editors/vscode/src/test/settings.test.ts`. Avoid duplicating the init-options builder between runtime and tests so master defaults (e.g. `diagnostics.enabled`, cache forwarding) cannot drift.
- **`executeCommandProvider.commands`** must remain `vec![]` if the VS Code extension also registers commands manually via `vscode.commands.registerCommand` — `vscode-languageclient`'s `ExecuteCommandFeature` auto-registers each entry, causing "command already exists" crashes at startup. The server still handles `workspace/executeCommand` regardless.
- **VS Code language-scoped settings** like `[r]` editor overrides: read `config.inspect(...).globalValue` instead of merged `config.get(...)` before a global `config.update(...)`; otherwise workspace or folder overrides leak into global user settings.
- **File-type tracking** for non-R languages: track file type on the document itself, not solely from URI extensions — untitled buffers rely on `languageId`, and VS Code extension contributions should include mixed-case extensions when backend matching is case-insensitive.

### Environment / tooling

- **macOS FSEvents** callbacks don't fire when the process is sandboxed by Claude Code; integration tests that depend on filesystem notifications require the sandbox to be disabled for the test runner (they pass fine in normal CI).
- **Linux inotify**: libpath watching is recursive (one watch per descendant directory, ~10–20 per installed package). On old distros capped at the legacy 8192 default, warn users to raise `fs.inotify.max_user_watches`.

### Test harness

- **Bun test discovery** must NOT recurse into `editors/vscode/src/test` or `editors/vscode/out/test`; those are Mocha/`vscode-test` suites. Invoke them via a wrapper subprocess test from the root.
- **VS Code test compile** runs before `vscode-test`, so dependency type-resolution breakage in `node_modules` can make root `bun test` fail before any VS Code tests run.

### Markdown / doc maintenance

- Add language identifiers (e.g. `text`) to ASCII diagram/timeline fences to satisfy markdownlint (MD040).
- Keep doc comments and markdown examples aligned with current behavior; normalize markdown table spacing to match project lint expectations.
