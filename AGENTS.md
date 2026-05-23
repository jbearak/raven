# AGENTS.md - LLM Guidance for Raven

This file is intentionally short: a map to the docs and a short list of invariants that are easy to regress.

IMPORTANT: Treat this as a living document, but **prefer code comments over Learnings entries**. Most subtle invariants belong as doc comments on the function or module they constrain — that's where they stay accurate as the code evolves and where the LLM will see them while editing the relevant code. Add a bullet to **"Learnings"** below only when the knowledge has no natural code home (it spans multiple systems, depends on environment, or is a recurring LLM mistake the user has explicitly flagged).

## What to read (in order)

User-facing:
- `README.md`
- `docs/cross-file.md`
- `docs/r-package-dev.md`
- `docs/directives.md`
- `docs/diagnostics.md`
- `docs/linting.md`
- `docs/indentation.md`
- `docs/syntax-highlighting.md`
- `docs/r-console.md`
- `docs/chunks.md`
- `docs/knit.md`
- `docs/plot-viewer.md`
- `docs/data-viewer.md`
- `docs/help-viewer.md`
- `docs/document-outline.md`
- `docs/coexistence.md`
- `docs/configuration.md`

Maintainer/internal:
- `docs/development.md`

Code (authoritative for behavior):
- Cross-file: `crates/raven/src/cross_file/` — see module docs in `scope.rs`, `revalidation.rs`, `dependency.rs` for `ScopeEvent`, `ScopeStream`, `ParentPrefixCache`, `compute_interface_hash`, `compute_affected_dependents_after_edit`, etc.
- Indentation: `crates/raven/src/indentation/`
- Linting (style/lint diagnostics): `crates/raven/src/linting/` — opt-in lintr-equivalent rules in Rust, gated by `state.lint_config`. Honors `# nolint` / `# nolint start/end` and `# @lsp-ignore` / `# @lsp-ignore-next`.
- Packages: `crates/raven/src/package_library.rs`, `crates/raven/src/r_subprocess.rs`
- Diagnostic collectors: `crates/raven/src/handlers.rs` — `is_structural_non_reference` predicate is the single source of truth for "structural identifier; not a reference".
- Knit pipeline: `editors/vscode/src/knit/` — `yaml-frontmatter.ts` (gate), `r-expression.ts` (knitr::knit call), `knit-engine.ts` (subprocess), `post-knit-renderer.ts` (live VS Code wiring), `render-html.ts` (pure orchestration), `grammar-registry.ts` (vscode-textmate lookup), `code-highlighter.ts` (GitHub palette + LSP overlay), `knit-paths.ts` (file-name derivation), `knit-output-panel.ts` (webview shell).

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

- **Project config layering**
  - `WorldState` stores both `raw_client_settings` and `raw_project_settings` as `serde_json::Value`s.
  - `config_file::recompute_parsed_configs(state)` is the only function that should write to `state.lint_config` / `cross_file_config` / etc. after a settings change.
  - Callers (`initialize`, `did_change_configuration`, `did_change_watched_files`) must mutate the raw layers and then call `recompute_parsed_configs`, never the parsers directly.

- **Knit pipeline (HTML-only)**
  - `Raven: Knit` only supports HTML outputs. The supported allow-list lives in `editors/vscode/src/knit/yaml-frontmatter.ts` (`SUPPORTED_HTML_FORMATS`). Anything else is refused via a synthesized `Blocker` (`buildNonHtmlFormatBlocker` in `knit-commands.ts`) with a copy-paste `rmarkdown::render` command. The blocker's R command MUST escape the YAML `format` through `escapeRString` — never interpolate raw.
  - The R subprocess calls `knitr::knit` directly (not `rmarkdown::render`). The expression sets `knitr::opts_knit$set(root.dir = <root or getwd()>)`, runs `knitr::knit(input = ..., output = ..., envir = new.env(), quiet = TRUE)`, and emits `cat('Output created: ', out, '\n', sep = '')` so the existing `parseRenderedOutputPath` regex keeps working.
  - The post-knit `<basename>.html` is written via temp-file + `fs.promises.rename` (in `post-knit-renderer.ts:writeFileAtomic`). Direct `fs.writeFile` to the destination is forbidden — a concurrent re-knit could overlap the panel's sync `readFileSync` and yield a truncated read.
  - `createGrammarRegistry` is cached process-wide and invalidated by `vscode.extensions.onDidChange`. Don't rebuild per knit; the WASM init is expensive.
  - R-grammar resolution priority MUST flow through both `pickContribution` AND the `byScopeName` map. Two passes in `collectGrammarContributions` ensure `Registry.loadGrammar(scopeName)` resolves the same contribution that `scopeNameFor` would pick.
  - `GrammarRegistry.extractWithTheme` is the ONLY caller of vscode-textmate's `setTheme` / `tokenizeLine2`. It serializes concurrent extractions via an internal promise chain so two panels never see each other's theme between `setTheme` and the matching `tokenizeLine2` reads. The Knit highlighter path (`tokenizeLineForLanguage`) uses raw scope chains and is not affected by `setTheme`. Do not add a second `tokenizeLine2` caller without serializing through `extractWithTheme`.
  - The "Apply VS Code theme" toggle resolves a real palette from the active theme's TextMate `tokenColors` via `vscode-theme-palette.ts` and pushes it into the webview via a `__ravenVscodeThemePalette` postMessage. The webview's accept-regex `^(?:--raven-(?:bg|fg|c-[a-z]+): #(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6,8}); ?)+$` is the trust boundary between extension-host string assembly and `style.textContent` injection. It must stay in lockstep with `HEX_COLOR_RE` in `vscode-theme-palette.ts` (both accept exactly the 3/4/6/8-digit hex forms CSS supports). If you change the shape `paletteCssDeclarations` (in `knit-output.ts`) emits, update both regexes in the same commit or the toggle silently degrades to the GitHub palette.

- **Rmd/Quarto semantic tokens**
  - `semantic_tokens_for_rmd_document` (in `crates/raven/src/handlers.rs`) walks chunks via `chunks::detect_chunks`, parses each R chunk body in isolation with `tree_sitter_r`, and rebases each token's line by `header_line + 1`. Lines are split on `\n` with trailing `\r` stripped so CRLF documents flow cleanly through the parser. Non-R chunk languages (`is_r_chunk_language` matches only `"r"` and `"rscript"`) are skipped — never widen this without explicit thought about what knitr engines actually evaluate as R.
  - The custom request `raven/semanticTokensForRString` exists for the knit-output webview pipeline to tokenize rendered code blocks without requiring the source document to be open as an LSP document. Keep its legend (single `function` entry) in sync with `textDocument/semanticTokens/full`.

- **Package-mode scope contribution**
  - `PackageScopeContribution`'s `r_internal_symbols`, `imported_symbols`, `test_helper_symbols`, and `test_attached_packages` are injected into the queried file's scope by `append_package_contribution` (recursive path, depth 0) and `ScopeStream::snapshot()` (streaming path). Both gate on `is_r_source_path(uri, root)`: files under `R/` see `r_internal_symbols` + `imported_symbols`; files under `tests/testthat/` see those PLUS `test_helper_symbols` (per-helper-path keyed so a helper does not self-inject) PLUS `test_attached_packages` (added to `scope.inherited_packages`, modelling `testthat::test_check`'s implicit `library(testthat)`). Files outside `R/` / `tests/testthat/` get NO contribution.
  - `ScopeStream::is_visible` and `symbol_for` must consult the pre-computed `contribution_symbol_names` after frame/prefix checks, otherwise out-of-scope diagnostics misattribute contribution-provided names to forward `source()` calls.
  - Test-only contributions (`test_helper_symbols`, `test_attached_packages`) MUST stay invisible to `R/` files. Mirror the gate by branching on `RFileKind::Test` inside the injection helpers, not by re-deriving the test-dir check from the path.

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
- **VS Code settings sync**: a new LSP-exposed setting must be wired in three places together — `editors/vscode/package.json` (schema), the shared init-options factory at `editors/vscode/src/initializationOptions.ts` (used by both `extension.ts` at runtime and `settings.test.ts` in tests), and the `SETTINGS_MAPPING` plus any named-value tests in `editors/vscode/src/test/settings.test.ts`. Don't reintroduce a separate runtime builder in `extension.ts` — it should keep delegating to `buildInitializationOptions`, so master defaults (e.g. `diagnostics.enabled`, cache forwarding) can't drift between runtime and tests. After editing `package.json`, regenerate the alphabetical settings index with `bun editors/vscode/scripts/generate-settings-reference.mjs`; the drift test `tests/bun/settings-reference.test.ts` gates this on CI.
- **`executeCommandProvider.commands`** must remain `vec![]` if the VS Code extension also registers commands manually via `vscode.commands.registerCommand` — `vscode-languageclient`'s `ExecuteCommandFeature` auto-registers each entry, causing "command already exists" crashes at startup. The server still handles `workspace/executeCommand` regardless.
- **VS Code language-scoped settings** like `[r]` editor overrides: read `config.inspect(...).globalValue` instead of merged `config.get(...)` before a global `config.update(...)`; otherwise workspace or folder overrides leak into global user settings.
- **File-type tracking** for non-R languages: track file type on the document itself, not solely from URI extensions — untitled buffers rely on `languageId`, and VS Code extension contributions should include mixed-case extensions when backend matching is case-insensitive.

### Environment / tooling

- **macOS FSEvents** callbacks don't fire when the process is sandboxed by Claude Code; integration tests that depend on filesystem notifications require the sandbox to be disabled for the test runner (they pass fine in normal CI). Tests that genuinely cannot run under the sandbox (e.g. the 700K-row data-viewer scroll smoke tests, the knit iframe-load probe) self-skip via `isClaudeCodeSandbox()` in `editors/vscode/src/test/helper.ts` so a local run reports "skipped (sandbox)" rather than a flaky timeout failure.
- **VS Code suite cumulative state** can make `vscode.window.activeTextEditor` racy: `showTextDocument(doc)`'s promise resolves before VS Code finishes promoting the editor to active, and a focused webview can leave `activeTextEditor` `undefined`. Tests whose command handlers read `activeTextEditor` (e.g. the chunks suite's `run_chunk`) must call `awaitActive(editor)` after `showTextDocument` and before each `executeCommand`. See the helper in `editors/vscode/src/test/helper.ts` and the `execute_chunk_command` wrapper in `chunks.test.ts`.
- **Linux inotify**: libpath watching is recursive (one watch per descendant directory, ~10–20 per installed package). On old distros capped at the legacy 8192 default, warn users to raise `fs.inotify.max_user_watches`.

### Test harness

- **Bun test discovery** must NOT recurse into `editors/vscode/src/test` or `editors/vscode/out/test`; those are Mocha/`vscode-test` suites. Invoke them via a wrapper subprocess test from the root.
- **VS Code test compile** runs before `vscode-test`, so dependency type-resolution breakage in `node_modules` can make root `bun test` fail before any VS Code tests run.

### Markdown / doc maintenance

- Add language identifiers (e.g. `text`) to ASCII diagram/timeline fences to satisfy markdownlint (MD040).
- Keep doc comments and markdown examples aligned with current behavior; normalize markdown table spacing to match project lint expectations.
