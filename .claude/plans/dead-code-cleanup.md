# Dead-code cleanup plan

_Generated 2026-06-05 from a parallel dead-code sweep: 7 read-only static-analysis agents (one per subsystem cluster) cross-referencing the `pub`/`pub(crate)` surface, 1 compile-driven agent in an isolated worktree that stripped all `#[allow(dead_code)]` and let rustc soundly report what's dead, and 2 markdown agents._

## Why this needed agents (and what "dead" means here)

`cargo clippy -- -D warnings` already gates CI, so simple *private* dead code is gone. What remains hides behind two blind spots:

1. **6 file-level `#![allow(dead_code)]`** — `package_library.rs`, `r_subprocess.rs`, `namespace_parser.rs`, `workspace_index.rs`, `document_store.rs`, `cross_file/mod.rs` — plus ~64 scattered `#[allow(dead_code)]`. The compiler is silenced there, so dead code accumulates silently.
2. **`pub`/`pub(crate)` items** rustc treats as reachable API and never flags, even when nothing in the repo (lib, `main.rs`, tests, benches, examples — there is no external consumer) references them.

The compile-driven agent handles blind spot #1 soundly; the static agents handle #2 by counting real references.

## What is already clean (no action)

- **`linting/`** — all 20 rules registered, all `rule_id` constants used, zero dead items, zero allows. Clean.
- **`package_db/`** (binary/json/merge/model/renv_lock/runiverse/embedded_base) — clean; `embedded_base_generated.rs` is `// @generated` data, live.
- **`config_file/`, `completion_context.rs`, `qualified_resolve.rs`, `roxygen.rs`, `r_env.rs`, `package_state/derive|digest|event`, `namespace_parser.rs`, `cli/`, `chunks.rs`, `utf16.rs`, `extract_op.rs`, `file_type.rs`, builtin/keyword tables** — clean.
- **Docs** — all 29 user-facing `docs/*.md`: zero broken links, zero references to removed settings/CLI flags/directives/symbols, `settings-reference.md` matches `package.json` (the two "init-only" settings are intentional). README/AGENTS/CONTEXT/NOTICE/editors `*.md`: clean.
- **Plan/spec archives** — `.kiro/specs/` and `docs/superpowers/specs/` are cited as authoritative rationale from live code comments and `docs/development.md`; **do not bulk-delete**. `.kiro/specs/` (115 files, 36 dirs) has *selective*-prune potential only, low priority. All other archive dirs: keep.

---

## Phase 1 — Compiler-confirmed dead (sound; lowest risk)

These produced a real `dead_code` warning once the silencing allow was removed. rustc proves no path (production or test) keeps them alive in the relevant build. Delete the item **and its now-orphaned unit tests**.

### 1a. `indentation/context.rs` operator-classification cluster — the headline (~300 LOC + tests)
A self-contained block of AST/operator helpers with unit tests but **zero production callers**; members only call each other or are exercised by their own tests. Delete the whole cluster + its tests:
`is_pipe_operator`, `is_special_operator`, `is_continuation_binary_operator`, `is_continuation_operator`, `is_call_node`, `is_arguments_node`, `get_operator_type`, `node_text`, `find_enclosing_arguments`, `find_enclosing_call`, `find_innermost_context_node`, `find_matching_opener` (lines ~37–360).
- Keep `find_parent`, `find_enclosing_brace_list`, `ChainWalker`, `get_line_indent`, the `is_*` predicates the formatter actually calls — those are live.
- Also remove `IndentationContext.tree` field (line ~1608; doc-comment says "currently unused… for future") and the `tree,` assignment in `new()`.

### 1b. `document_store.rs`
- `wait_for_next` (~266), `evict_if_needed` (~779), `evict_lru` — never used (`evict_lru_excluding` is the live evictor).

### 1c. `package_library.rs`
- `load_package_from_filesystem` (~1401) — never used (surfaced only when the file-level allow was removed).

### 1d. `file_path_intellisense.rs`
- `is_within_workspace` (1508, "Reserved for future use") and test helper `create_test_completion_item_with_prefix` (3174) — neither ever called.

### 1e. `cross_file/property_tests.rs` (test-support)
- `linear_scan_innermost`, `path_with_optional_spaces`, `DirectiveChangeOp` (enum), `num_statements` field — dead test helpers.

**Gate after 1a–1e:** `cargo fmt --all` → `cargo clippy --workspace --all-targets --features test-support -- -D warnings` → `cargo test` (or nextest). All green.

---

## Phase 2 — `pub`-surface dead (high confidence; rustc can't prove)

Zero references anywhere in the repo; rustc leaves them unflagged only because they're `pub`/reachable-API. Safe to delete; verify with the same gate (and, ideally, by confirming no warning *reappears* when you also remove the blanket allow — see Phase 4).

- **`handlers.rs`**: `diagnostics_async` + its only callee `collect_missing_file_diagnostics_async` (2-item cluster; a design spec already labels `diagnostics_async` dead). `DefinitionInfo.column` field (write-only; never read) + its assignments.
- **`state.rs`**: `Document::contents_hash` (311), `WorldState::index_workspace` (1092) + `index_directory` (1223) (cluster — `index_directory` is called only by `index_workspace`).
- **`document_store.rs`**: `pinned_len`, `is_pinned`, `config`.
- **`workspace_index.rs`** (top-level): `WorkspaceIndex::is_pinned`.
- **`cross_file/`**: `file_cache::get_file_snapshot`, `CrossFileWorkspaceIndex::collect_exported_symbols`, `CrossFileWorkspaceIndex::is_pinned`, free `content_provider::path_exists` (distinct from the live method), `types::tree_sitter_point_to_lsp_position`.
- **`cross_file/dependency.rs` superseded `UpdateResult` fields** (was Phase 5 — now resolved): `UpdateResult.unresolved_forward_paths` and `UpdateResult.redundant_directives`, plus the types `UnresolvedForwardPath`, `UnresolvedReason`, `RedundantDirective`. The doc comments say "stored for diagnostic emission in handlers.rs (_Requirements 3.3 / 6.2_)", but **those diagnostics are emitted by a different, live path** — `collect_redundant_directive_diagnostics_from_snapshot` recomputes redundancy from `snapshot.cross_file_graph.get_dependencies(uri)`, and the missing-file collectors re-resolve + disk-check — neither reads these fields. They're dead remnants of a superseded "compute-during-update, store-on-`UpdateResult`" design. This is *not* a feature gap. Deletion is slightly more than a field removal — also delete the producer blocks in `update_file` (the `result.unresolved_forward_paths.push(...)` at ~885 and `result.redundant_directives.push(...)` at ~1034) and update the 3 test assertions that read `unresolved_forward_paths` (~2982/3029/3071). `redundant_directives` has no reader at all (not even tests). Keep the live `UpdateResult` fields `diagnostics` and `edges_changed`.
- **`package_library.rs`**: `get_cached_combined_exports`.
- **`package_namespace.rs`**: `detect_package_workspace_with_content` (already `#[allow(dead_code)]`; only named in a spec).
- **`perf.rs`**: `TimingGuard::with_threshold` (+ `threshold_warn_ms` field + the `Drop` warn-branch it gates) and `record_first_diagnostic` (+ `first_diagnostic_duration` field) — a never-wired timing feature ("will be wired in when diagnostic timing is added").

**Gate:** same as Phase 1.

---

## Phase 3 — Test-only clusters (judgment calls; delete code + tests together)

These are reachable only from `#[cfg(test)]`. They're "tested but unused in production." Recommend deletion unless a test is asserting a contract you want to preserve — decide per cluster. Each is self-contained.

1. **`state.rs` legacy `Library`/`Package` store** — `Package`, `Library`, `Library::{new,get,list_packages}`, `Package::load`, the local `parse_dcf_field`/`parse_namespace_exports`/`parse_index` (shadow the live ones elsewhere), and the `WorldState::library` field + its init in `WorldState::new`. Superseded by `PackageLibrary`; kept alive by exactly one integration test (`test_package_exports_loaded`). **Highest-value Phase-3 removal.** Also `WorldState::open_document` ("Retained for tests"; production uses `open_document_with_language_id`).
2. **`cross_file/parent_resolve.rs` test-only API** — `resolve_parent`, `resolve_parent_with_content` (+inner `Candidate`), `resolve_multiple_source_calls`, `compute_metadata_fingerprint`, `compute_reverse_edges_hash`, plus `cache::ParentResolution` enum, `dependency::resolve_parent_working_directory` + `_with_depth` (production calls the `_with_visited` leaf directly), `DependencyGraph::update_file_simple`, `scope::scope_at_position_with_deps`, `FunctionScopeInterval::as_tuple`, `types::ForwardSourceKey` + `ForwardSource::to_key`.
3. **`r_subprocess.rs` batch-init cluster** — `initialize_batch`, `BatchInitResult` (+`all_base_exports`), `parse_batch_init_output`. Also test-only: `get_base_packages`, `get_package_depends`. ⚠️ Safety-critical module — confirm no intended-future R-subprocess path before deleting.
4. **`package_namespace.rs` test-only detector + its vestigial field** — `detect_package_workspace` (the `pub` "test-only legacy detector"; only its own `#[cfg(test)]` tests call it) together with `detect_package_workspace_with_content` (already listed in Phase 2 — fully dead). Once both are gone, `PackageWorkspace.roxygen_managed` and the `detect_roxygen_usage` helper are dead too: production `derive.rs` only ever constructs `roxygen_managed: false` and nothing reads it; it is set meaningfully *only* inside those two detectors. Remove the field + helper as part of this deletion (also drops them from the derived `PartialEq`/`Eq`). _(This is the second half of the old Phase 5.)_
5. **Assorted test-only accessors** — `DocumentStore::{wait_for_update,has_update_tracker,update_revision,metrics}` + `DocumentStoreMetrics`; `WorkspaceIndex::{get_if_fresh,get_ready_updates,cancel_pending_update,has_pending_update,pending_update_count,get_pending_update_time,invalidate_all,cap getter}` + `WorkspaceIndexMetrics`; `content_provider::{DefaultContentProvider::new, ContentProvider::is_open}`; `package_state::r_file_facts()` accessor; `package_library::{cached_package_names,set_base_exports}`.

**Gate:** same; plus re-run the affected module's tests after deleting their dead subjects.

---

## Phase 4 — Allow-attribute hygiene + close the blind spot (the durable win)

This is what prevents the whole problem from recurring.

1. **Remove the 6 file-level `#![allow(dead_code)]`** once Phases 1–3 land. After the dead items are gone, the remaining items in those files are genuinely live or legitimately test-only.
2. **Remove the ~41 stale per-item `#[allow(dead_code)]`** (compiler confirmed they produce no warning — the item is reachable). Notably: `package_library.rs:230` `r_subprocess` field ("Will be used in task 3.3" — now read in 5 places), `content_provider.rs:78` `AsyncContentProvider` (used via `&impl` in production), `help/html.rs:{23,35,63}`, `help/text.rs:482` `extract_signature_from_help` (live in `handlers.rs`), `handlers.rs:{4278,11504}`.
3. **For the items that are legitimately test-only but `pub`** (kept that way for benches/examples/integration tests in sibling targets — e.g. `handlers::diagnostics`, `goto_definition`, `Backend::new`, `LibpathEvent::affected_packages`, `RESERVED_WORDS`): once the blanket allow is gone they'll warn in the plain lib build. Convert each deliberately — `#[cfg(any(test, feature = "test-support"))]`, or a *narrow* per-item `#[allow(dead_code)]` with an **accurate** one-line reason (not the stale "task N" comments). Don't reintroduce a blanket allow.

**Gate (the real proof):** with all file-level + stale allows removed, `cargo clippy --workspace --all-targets --features test-support -- -D warnings` must be clean. That clean run is the regression guard: future dead code now fails CI in these files instead of accumulating.

---

## Phase 5 — Resolved (was "uncertain")

The two code items originally parked here were investigated and are **safe deletes, not open questions** — both folded into the phases above:

- **`UpdateResult.unresolved_forward_paths` / `redundant_directives`** → Phase 2. Verified that the user-facing diagnostics they were designed to feed are emitted by a *separate, live* snapshot-based path (`collect_redundant_directive_diagnostics_from_snapshot` + the missing-file collectors), which never read these fields. Dead remnants of a superseded design; **not** a feature gap. Delete (with their producer push-sites and 3 test assertions).
- **`PackageWorkspace.roxygen_managed`** (+ `detect_roxygen_usage`) → Phase 3, cluster 4. Vestige of the test-only detectors; production hardcodes it `false` and never reads it. Dies with `detect_package_workspace` / `detect_package_workspace_with_content`.

The only thing that remains genuinely optional:

- **`.kiro/specs/` selective prune** — a few of the 36 subdirs are cited from live code/docs (so no bulk delete); the rest could be pruned, but the payoff is low and it's pure archive churn, not code. **Recommendation: skip** unless you specifically want to tidy the archive; if so, do it in its own commit, separate from any code change.

There is no remaining "decide later" code. Every Rust finding now has a verdict and a home in Phases 1–4.

---

## Suggested execution order & PR slicing

Land as small, independently reviewable PRs so each clippy gate is a clean checkpoint:

1. **PR 1** — Phase 1 (compiler-confirmed). Biggest LOC win (`indentation/context.rs`), lowest risk.
2. **PR 2** — Phase 2 (`pub`-surface dead), incl. the superseded `UpdateResult` fields.
3. **PR 3** — Phase 3 cluster 1 (`state.rs` Library/Package) — self-contained, high value.
4. **PR 4** — Phase 3 clusters 2–5 (`parent_resolve`, `r_subprocess` batch-init, `package_namespace` detectors + `roxygen_managed`, assorted accessors).
5. **PR 5** — Phase 4 (strip blanket + stale allows, convert test-only `pub` items). Do this last so the dead code is already gone; this PR makes the lint sound going forward.

Phase 5 carries no code (resolved into the above). The optional `.kiro/specs/` archive prune, if done at all, is its own commit and doesn't block any of these.

Every PR: `cargo fmt --all` then `cargo clippy --workspace --all-targets --features test-support -- -D warnings` then the test suite — per `CLAUDE.md` CI gates.
