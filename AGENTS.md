This file is intentionally short: a map to the docs and a list of invariants that span multiple systems. Invariants tied to one function or module belong as a doc comment on that function or module, not here.

## CI gates (keep green before committing)

Rust changes must pass two gates in `.github/workflows/integration.yml`, both pinned to toolchain `1.96.0` so results are reproducible:

- **Formatting** — `cargo +1.96.0 fmt --all --check`. Always run `cargo fmt --all` before committing; never hand-format around it.
- **Clippy** — `cargo +1.96.0 clippy --workspace --all-targets --features test-support -- -D warnings`. Zero warnings: every clippy/rustc warning is an error, across lib, tests, benches, and examples.

Both block merge. Fix the underlying issue rather than suppressing it; when a lint is a genuine, deliberate exception, use a narrowly-scoped `#[allow(...)]` with a one-line reason. Project-wide exceptions live in `crates/raven/Cargo.toml` `[lints]` (currently only `field_reassign_with_default`).

## What to read

User-facing:
- `README.md`
- `docs/cross-file.md`
- `docs/r-package-dev.md`
- `docs/package-database.md`
- `docs/directives.md`
- `docs/diagnostics.md`
- `docs/linting.md`
- `docs/completion.md`
- `docs/hover.md`
- `docs/go-to-definition.md`
- `docs/find-references.md`
- `docs/indentation.md`
- `docs/syntax-highlighting.md`
- `docs/snippets.md`
- `docs/r-console.md`
- `docs/chunks.md`
- `docs/knit.md`
- `docs/plot-viewer.md`
- `docs/data-viewer.md`
- `docs/help-viewer.md`
- `docs/document-outline.md`
- `docs/cli.md`
- `docs/editor-integrations.md`
- `docs/coexistence.md`
- `docs/configuration.md`
- `docs/settings-reference.md`
- `docs/comparison.md`
- `docs/limitations.md`

Maintainer/internal:
- `docs/development.md`

Code (authoritative for behavior):
- Cross-file: `crates/raven/src/cross_file/` — module docs in `scope.rs`, `revalidation.rs`, `dependency.rs`, `path_resolve.rs`.
- Indentation: `crates/raven/src/indentation/`
- Linting: `crates/raven/src/linting/` — opt-in lintr-equivalent rules in Rust, gated by `state.lint_config`. Honors `# nolint` / `# nolint start/end` and `# @lsp-ignore` / `# @lsp-ignore-next`.
- Packages / R subprocess: `crates/raven/src/package_library.rs`, `crates/raven/src/r_subprocess.rs` — the `r_subprocess` module doc spells out the safety invariants every R-subprocess caller must follow.
- Diagnostic collectors: `crates/raven/src/handlers.rs` — `is_structural_non_reference` is the single source of truth for "structural identifier; not a reference".
- Config layering: `crates/raven/src/config_file/mod.rs` — `recompute_parsed_configs` is the only writer of the parsed config fields; callers mutate the raw layers and then call it.
- Knit pipeline (TS): `editors/vscode/src/knit/` — each file documents its own role and invariants at module level (`yaml-frontmatter.ts`, `r-expression.ts`, `knit-engine.ts`, `post-knit-renderer.ts`, `render-html.ts`, `grammar-registry.ts`, `code-highlighter.ts`, `knit-paths.ts`, `knit-output-panel.ts`, `knit-output.ts`, `operation-controller.ts`, `vscode-theme-palette.ts`).
- Plot viewer (TS): `editors/vscode/src/plot/` — `PlotViewerPanel`, `sanitize_svg`, `App.svelte`, and `state.ts` document their own invariants.

## Documentation requirements

When making significant changes:

1. Update the relevant user-facing docs under `docs/` (and `README.md` if appropriate) when user-visible behavior changes.
2. For changes to internal architecture, caching, performance, or debugging guidance, update `docs/development.md`.
3. For invariants tied to a specific function or module, write/expand the doc comment **on that function or module** rather than adding to Learnings here.

## Key invariants (do not regress)

Each item below either spans multiple systems or is a discipline that applies in many places. Per-function invariants live in doc comments next to the function, not in this list.

- **Path resolution**
  - Backward directives (`@lsp-sourced-by`, `@lsp-run-by`, `@lsp-included-by`) resolve relative to the file's directory and **ignore `@lsp-cd`** (`PathContext::new`).
  - Forward directives (`@lsp-source`, `@lsp-run`, `@lsp-include`) and AST-detected `source()` calls **respect `@lsp-cd`** when present (`PathContext::from_metadata`).
  - See `crates/raven/src/cross_file/path_resolve.rs` and `docs/cross-file.md`.

- **Workspace-root fallback**
  - For AST-detected `source()` calls AND forward directives (`@lsp-source`, `@lsp-run`, `@lsp-include`), and only when no `@lsp-cd` is explicitly or inheritedly in effect. Forward directives are semantically equivalent to `source()` calls and must resolve identically.
  - Must hold uniformly across dependency-graph resolution, scope resolution, missing-file diagnostics, file-path go-to-definition, and path completion. Never apply to backward directives.

- **Diagnostics publishing monotonicity**
  - Diagnostics publish monotonically by document version. Dependency-triggered revalidation may republish at the same version via the force-republish mechanism, but never older.
  - Production commit paths MUST use `CrossFileDiagnosticsGate::try_consume_publish` (atomic). The `can_publish` + `record_publish` pair is racy and is for advisory pre-flight checks and tests only — see the gate's own doc comments for the TOCTOU details.

- **LRU caches under locks**
  - Read locks: `peek()` (no promotion). Write locks: `push()` (eviction/promotion).

- **Locking discipline in cross-file work**
  - Diagnostic computation and the libpath consumer's "which docs are affected" filter MUST NOT hold the `WorldState` read lock across cross-file scope resolution. Snapshot inputs (artifacts, metadata, graph clone, config) under the lock, drop the guard, then iterate — otherwise concurrent `did_change` writers starve.

## Learnings

Items here have no natural code home — they span multiple systems, depend on environment, or are recurring LLM mistakes the user has explicitly flagged. Anything tied to a specific function belongs as a doc comment there instead.

### Cross-cutting code

- **tower-lsp 0.20** defaults to `buffer_unordered(4)` for all messages. Without `.concurrency_level(1)`, `did_change` notifications can be processed out of order, corrupting incremental text sync.
- **Module declarations**: `crates/raven/src/lib.rs` owns the entire module tree; declare a new top-level module there. `crates/raven/src/main.rs` is a thin shim that `use`s the library crate (`raven::cli`, `raven::backend`) — do NOT re-declare modules in it. Re-declaring them builds the whole crate a second time as a separate bin-crate module tree (a full duplicate compile + a duplicated unit-test run), which is exactly what the shim removed.
- **VS Code settings sync**: a new LSP-exposed setting must be wired in three places together — `editors/vscode/package.json` (schema), the shared init-options factory at `editors/vscode/src/initializationOptions.ts` (used by both runtime and tests), and `SETTINGS_MAPPING` plus any named-value tests in `editors/vscode/src/test/settings.test.ts`. After editing `package.json`, regenerate the alphabetical settings index with `bun editors/vscode/scripts/generate-settings-reference.mjs`; the drift test `tests/bun/settings-reference.test.ts` gates this on CI.
- **`executeCommandProvider.commands`** must remain `vec![]` if the VS Code extension also registers commands manually via `vscode.commands.registerCommand` — `vscode-languageclient`'s `ExecuteCommandFeature` auto-registers each entry, causing "command already exists" crashes at startup. The server still handles `workspace/executeCommand` regardless.
- **VS Code language-scoped settings** like `[r]` editor overrides: read `config.inspect(...).globalValue` instead of merged `config.get(...)` before a global `config.update(...)`; otherwise workspace or folder overrides leak into global user settings.
- **File-type tracking** for non-R languages: track file type on the document itself, not solely from URI extensions — untitled buffers rely on `languageId`, and extension contributions should include mixed-case extensions when backend matching is case-insensitive.
- **Vendored R + R Markdown grammars** are registered in `editors/vscode/package.json` as `contributes.grammars` so the knit pipeline can reach them on remote extension hosts (Remote SSH / Dev Container / WSL / Codespaces), where UI-only sibling grammar extensions are invisible. See `editors/vscode/syntaxes/SOURCE.md` for the rationale and the touchpoints that must stay in lockstep (manifest, `grammar-registry.ts` priority lists, vendored files, user-facing docs); `tests/bun/grammar-contribution-paths.test.ts` gates the manifest paths on CI.

### Environment / tooling

- **VS Code test races**: `showTextDocument(doc)`'s promise resolves before VS Code finishes promoting the editor to active, and a focused webview can leave `activeTextEditor` `undefined`. Tests whose command handlers read `activeTextEditor` must call `awaitActive(editor)` (see `editors/vscode/src/test/helper.ts`) after `showTextDocument` and before each `executeCommand`.
- **Linux inotify**: libpath watching is recursive (one watch per descendant directory, ~10–20 per installed package). On old distros capped at the legacy 8192 default, warn users to raise `fs.inotify.max_user_watches`.
- **DOMPurify pin**: `dompurify` lives in `editors/vscode/package.json` (NOT the root) and is exact-pinned (no `^`). A version bump must re-pass `tests/bun/plot-webview-sanitize.test.ts`. Do NOT add `@types/dompurify` — the package ships its own types.

### Test harness

- **Bun test discovery** must NOT recurse into `editors/vscode/src/test` or `editors/vscode/out/test`; those are Mocha/`vscode-test` suites. Invoke them via a wrapper subprocess test from the root.
- **VS Code test compile** runs before `vscode-test`, so dependency type-resolution breakage in `node_modules` can make root `bun test` fail before any VS Code tests run.
- **`tests/bun/tsconfig.json`** exists only so VS Code's TS language server can resolve `bun:test` and bare imports like `fast-check` (whose `node_modules` lives under `editors/vscode/`) — bun itself runs the suite without it. The `include` list is deliberately narrow because several bun test files have long-standing latent type errors. Add a file there only after `./editors/vscode/node_modules/.bin/tsc --project tests/bun/tsconfig.json --noEmit` stays clean.
