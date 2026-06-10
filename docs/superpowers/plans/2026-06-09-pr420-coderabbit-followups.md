# Plan: resolve PR #420 follow-ups (F2 session decisions + deferred CodeRabbit findings)

Self-contained handoff for a fresh session. Branch: **`prod-test`** (PR #420).
HEAD at handoff: `789108d6`. The maintainer wants **everything deferred by the
F2 suppression session resolved in this same PR** (no tracking issues). "Nothing
is too small or too difficult to handle immediately."

This plan covers three things:

1. **F2 session decisions to revisit** (Group F) — judgment calls the F2 session
   made on a "smallest-reasonable" basis. They are not bugs, but the maintainer
   should confirm or change each; two are genuinely actionable.
2. **A placement decision** (Group H) — whether the two security-hardening
   commits already on the branch stay in this PR.
3. **The 10 deferred CodeRabbit findings** (Groups A–E) — all in subsystems the
   F2 work did **not** author (the `system.file()` resolver, the package-state
   watcher / sysdata scan, and the NSE argument-policy table), so read the
   surrounding code before touching it.

Background context lives in
`docs/superpowers/plans/2026-06-09-f2-suppression-completion-and-review.md`
(the F2 plan; its "Decisions" + "PROGRESS UPDATE" sections explain the choices
referenced in Group F).

## Working discipline

- **Verify each finding against current code first.** Line numbers below are
  from `4140412a` and may drift — anchor on the named functions. If a finding is
  already fixed or no longer applies, skip it and note why on the deferred list
  at the bottom.
- **TDD.** Add a failing test (or extend an existing one) before each fix where
  practical; the modules below all have unit tests in-file or in `crates/raven/tests`.
- **Gates (keep green before every commit):** `cargo fmt --all`,
  `cargo clippy --workspace --all-targets --features test-support -- -D warnings`,
  `cargo test -p raven --features test-support`, root `bun test`. The
  `system.file()` group (Group A + Group C) and any change under
  `cross_file/path_resolve.rs`/`source_detect.rs` affect cross-file edges, so
  **re-run the strict corpus** before finalizing:
  `RAVEN_CORPUS_GROUPS=base,recommended,tidyverse cargo test -p raven --features test-support --test package_corpus package_corpus_selected -- --ignored` (~8 min).
- **Release-only test target (don't skip):** `crates/raven/tests/performance_budgets.rs`
  is gated `#![cfg(not(debug_assertions))]`, so a default debug `cargo test`
  **never compiles it** — CI builds it in release (the `PERF_BIN` step). A struct
  change can therefore pass every debug gate and still break CI (this exact thing
  happened: `PackageInputs` gained `dataset_names`/`sysdata_names` and the perf
  test wasn't updated — fixed in `4e2fcd32`). Before pushing, run a release
  compile of the perf target:
  `cargo test -p raven --release --features test-support --test performance_budgets --no-run`.
  Several Group-E changes touch `package_state` (`PackageInputs`, watcher/sysdata)
  — re-check this after them.
- Commit at sensible checkpoints (one per group is fine). Preserve history.
- **Non-blocking:** on any ambiguity make the smallest reasonable decision,
  record it on the deferred list, keep going.

## When done

Push to `origin/prod-test`, then post a PR comment replying to CodeRabbit
summarizing what was fixed (reference each finding), and `@coderabbitai review`
to get a fresh pass. Keep gates + strict corpus green.

---

## Group A — `system.file()` resolution lifecycle (findings 1–4)

**The hard group.** Symptom across all four: indexed `source(system.file(...))`
edges resolve against an **empty `lib_paths()` snapshot** (because resolution
runs before `PackageLibrary` is populated) and/or are never resolved on certain
indexing paths, so `resolved_uri` stays `None` and the transitive cross-file walk
stops at the first hop until some later reindex.

Key players:
- `state.rs:1037` `pub fn resolve_system_file_in_workspace(&mut self)` — the
  whole-workspace resolver helper.
- `backend.rs:1264` `async fn ensure_package_library_initialized(&self) -> bool`
  — the gate that populates `state.package_library` / `lib_paths()`.
- `cross_file::resolve_system_file_sources(meta, ws_name, ws_root, lib_paths)`
  (`cross_file/path_resolve.rs`) — per-file resolver; needs non-empty `lib_paths`
  for installed-package (branch-2) targets. Workspace-package (branch-1) targets
  resolve without `lib_paths`.
- on-demand indexers: `backend.rs:6161` `index_file_on_demand`, `6495`
  `index_file_on_demand_with_inherited_wd`.
- existing `resolve_system_file_sources` call sites in `backend.rs`: ~2986,
  3406 (`did_open` re-enrich), 3567 (`did_change`), 3862 (`did_save`), 5000.

### Finding 1 — `backend.rs:1749`: delay workspace resolution until library ready
`resolve_system_file_in_workspace()` is called from a startup / package-mode
seeding path before `ensure_package_library_initialized()` has committed
`state.package_library`. Installed-package `system.file()` sources therefore
resolve against empty `lib_paths()` and stay unresolved in closed-file metadata.

**Fix options (pick the smallest that holds):**
- Guard: make `resolve_system_file_in_workspace` (or this call site) a no-op /
  re-schedulable when `state.package_library.lib_paths().is_empty()`, and ensure
  it is re-invoked once the library becomes ready (the libpath-watcher /
  post-init path already re-resolves — confirm and reuse it). Workspace-package
  (branch-1) targets still resolve fine even with empty lib_paths, so a guard
  must not regress those — keep resolving branch-1, defer only branch-2.
- Or move the call to run after `ensure_package_library_initialized()` resolves.

Check whether `state.rs:1037` already re-runs on libpath-ready; if so, the
startup call at `1749` may just be premature and removable. Verify with a test:
open a workspace whose file does `source(system.file("x.R", package="installed"))`
and assert the edge resolves after init (not only after a later edit).

### Finding 2 — `backend.rs` on-demand metadata missing `resolved_uri`
`index_file_on_demand` (6161) and `index_file_on_demand_with_inherited_wd`
(6495) store metadata after `enrich_metadata_with_inherited_wd(...)` but **never
run `resolve_system_file_sources(...)`**. A closed child that itself contains
`source(system.file(...))` stops the transitive on-demand walk at the first hop.

**Fix (CodeRabbit's minimal shape):** after the `enrich_metadata_with_inherited_wd`
call in each function, add:
```rust
let ws = state.package_state.workspace();
crate::cross_file::resolve_system_file_sources(
    &mut cross_file_meta,
    ws.map(|w| w.name.as_str()),
    ws.map(|w| w.root.as_path()),
    state.package_library.lib_paths(),
);
```
(Confirm the exact accessor names — `state.package_state.workspace()`, `w.name`,
`w.root` — against current code; adjust if the API differs.) Gate on
library-readiness consistent with Finding 1 so it doesn't resolve against empty
`lib_paths` either.

### Finding 3 — open-document resolution before library readiness
At the `did_open` / `did_change` / `did_save` `resolve_system_file_sources`
sites (~3406, 3567, 3862), `state.package_library.lib_paths()` can still be
empty: `did_open` only calls `ensure_package_library_initialized()` later, and
`did_change` never forces it first. An early open/edit relying only on
`source(system.file(...))` keeps `resolved_uri = None` until the next edit.

**Fix:** ensure the package library is initialized (await
`ensure_package_library_initialized()`) **before** these `resolve_system_file_sources`
calls, or re-resolve after it completes. Mind async ordering and the locking
discipline in AGENTS.md (don't hold the `WorldState` write lock across the await;
snapshot, drop, then resolve). A single shared helper that "ensure-ready →
resolve" used by Findings 1–3 is ideal.

### Finding 4 — `check.rs:1206`: test helper drift from `run()`
`collect_diagnostics_blocking()` (`cli/check.rs:1197`) calls
`maybe_init_r(&mut state, &root)` at 1206 but, unlike `run()` (which calls
`state.resolve_system_file_in_workspace()` at `check.rs:296`), never resolves
workspace `system.file()` edges — so helper-based regression tests pass against
stale graph state.

**Fix:** add `state.resolve_system_file_in_workspace();` right after the
`maybe_init_r(...)` call in `collect_diagnostics_blocking()` (and after any
package-mode setup), matching `run()`. Trivial.

**Group A tests:** add an integration test (e.g. extend
`crates/raven/tests/system_file_source.rs`) proving an installed-package
`source(system.file(...))` edge resolves on first `did_open` / first
`raven check`, and that a closed child's nested `system.file()` source is walked
transitively. Re-run the strict corpus (system.file edges feed scope).

---

## Group B — chunk `eval=FALSE` guard placement (finding 5)

**`chunks.rs:321`** (`r_chunk_body_range`, line 314). The function early-returns
`None` for `chunk.eval_disabled`, but it is the shared "is this line an R body?"
predicate used by `mask_to_r` (378), `position_in_r_chunk_body` (483),
`append_chunk_suppressions` (666), and `semantic_tokens_for_rmd_document`
(`handlers.rs:872`). Returning `None` therefore disables **all** downstream
tooling (completion, signature help, semantic tokens, on-type indentation) for
display-only `eval=FALSE` chunks — not just diagnostics, which is the only thing
that should be suppressed (their bodies may be intentionally malformed).

**Fix:** remove the `eval_disabled` guard from `r_chunk_body_range` so it returns
the body range for `eval=FALSE` chunks, and move the blanking into `mask_to_r`
(and/or a diagnostics-only helper) so only the masked/diagnostics view blanks
them. Concretely: in `mask_to_r`, when iterating chunks, additionally blank the
body lines of an `eval_disabled` chunk; leave `r_chunk_body_range` returning the
range so position-gated editor features still see the body.

**Caveat / verify:** there are existing tests that assert `eval=FALSE` bodies are
blanked in `mask_to_r` (`mask_blanks_eval_false_chunk`, `mask_blanks_eval_f_chunk`,
`mask_blanks_eval_false_with_other_options`) — these must stay green. And confirm
the diagnostics path still skips `eval=FALSE` bodies (it analyzes the masked
text, which will still be blank, so diagnostics remain suppressed — good).
Decide whether `append_chunk_suppressions` should still skip `eval=FALSE` chunks
(it currently does via `r_chunk_body_range`): once the guard moves, it will start
producing ranges for them — harmless (already blanked) but add a guard there if
you want to keep behavior identical. Add a test that an `eval=FALSE` chunk body
line is reported as an R body by `position_in_r_chunk_body` after the change.

---

## Group C — `system.file()` `lib.loc` / `fsep` (finding 6)

**`source_detect.rs:298`** `try_parse_system_file_call` (struct at
`source_detect.rs:19` `SystemFileCall`). It stores only `parts` + `package` and
silently ignores other named args (`mustWork`, `lib.loc`, `fsep`). Downstream
`resolve_system_file` searches the workspace layout / configured `lib_paths`
with no way for `lib.loc` or `fsep` to affect resolution, so a call using them
can be resolved to the **wrong file**.

**Fix (conservative, smallest):** in `try_parse_system_file_call`, detect a named
arg whose name is `lib.loc` or `fsep` (the named-arg handling is the
`child.child_by_field_name("name")` branch around lines 321/351) and **bail**
(`return None`) so `SystemFileCall` only represents calls we can resolve
correctly. `mustWork` does not affect path layout, so it can stay ignored.
(Modeling `lib.loc`/`fsep` through resolution is the larger alternative — prefer
rejection unless modeling is cheap.)

**Tests:** extend the `system.file` parsing tests in `source_detect.rs` (and/or
`crates/raven/tests/system_file_source.rs`) to assert that
`system.file("x.R", package="p", lib.loc=foo)` and `... fsep="/"` are not parsed
as resolvable `SystemFileCall`s. Re-run the strict corpus.

---

## Group D — NSE `survival::tmerge` argument policy (finding 7)

**`nse.rs`**, the `"tmerge"` arm of the per-callee `ArgPolicy::per_formal(...)`
table (the table starts ~line 100; `per_formal` is at `nse.rs:78`). `tmerge`'s
real signature is `tmerge(data1, data2, id, ..., tstart, tstop, options)` — it
has named formals **after** `...`. The current policy lists only
`["data1","data2","id","..."]`, so `per_formal_mask()` treats `tstart`/`tstop`/
`options` as captured `...` and suppresses them (because `captured_dots = true`).

**Fix:** update the `tmerge` `per_formal(...)` call's formals list to
`["data1","data2","id","...","tstart","tstop","options"]`, keeping the same
masked list (`["id"]`) and the same trailing boolean. Find the exact arm first
(grep `tmerge` in `nse.rs`; it wasn't in the first 130 lines of the table dump,
so it's further down).

**Tests:** the existing `survival_tmerge` tests only cover `id` + `...` terms.
Add coverage asserting a bare undefined symbol passed as `tstart=`/`tstop=`/
`options=` is **flagged** (not suppressed), while the data-masked `id` term and
`...` event terms stay suppressed.

---

## Group E — package-state watcher + sysdata safety (findings 8, 9, 10)

### Finding 8 — `event.rs:198` `translate_watched_directory` ignores `data-raw/`
`is_tracked_package_dir` (`event.rs:254`) and `translate_watched_directory`
(`event.rs:198`) never admit `data-raw/`, so a **directory** watch event
(adding/removing a generator script via a dir notification) leaves
sysdata-derived bindings stale until a later full refresh. (The file-level branch
at ~191 already rescans `sysdata_names`.)

**Fix (CodeRabbit's diff):** in `translate_watched_directory`, after the `data`
dir branch, add a `data-raw` branch that sets
`inputs.sysdata_names = super::sysdata::scan_sysdata_generating_scripts(root)`
and returns `Some(PackageInputDelta::DataDirChanged)`; and in
`is_tracked_package_dir`, add `data_raw_dir = root.join("data-raw")` to the
accepted set (`== data_raw_dir || starts_with(&data_raw_dir)`).

**Test:** the `event.rs` tests should cover a `data-raw/` directory event
producing `DataDirChanged` and refreshing `sysdata_names` (mirror the existing
`data/` directory-event test).

### Finding 9 — `sysdata.rs:29` `scan_dir_recursive` follows directory symlinks
`scan_dir_recursive` uses `path.is_dir()` (line 36), which follows symlinks; a
repo with `data-raw/loop -> ..` drives unbounded recursion / stack overflow.

**Fix:** use `entry.file_type()` and descend only when `file_type.is_dir() &&
!file_type.is_symlink()` (or track visited canonical paths). Smallest is the
`file_type` check.

**Test:** add a unit test that creates a `data-raw` dir with a symlinked
subdirectory pointing to an ancestor and asserts `scan_dir_recursive` /
`scan_sysdata_generating_scripts` terminates and skips it. (Use `std::os::unix`
symlink; gate the test on `cfg(unix)`.)

### Finding 10 — `sysdata.rs:291`/`321`: `.onLoad` extraction too permissive
`try_extract_assign_call` (line 291) and `try_extract_dollar_assignment`
(line 321) record symbols for **any** `assign(..., envir = ...)` and **any** `$`
assignment inside the hook, so local writes like `assign("tmp", 1, envir = e)` or
`cache$foo <- 1` get promoted into `onload_symbols` and **mute real
undefined-variable diagnostics package-wide**.

**Fix:** only collect when the target env is namespace-like:
- `try_extract_assign_call`: find the `envir` named arg and proceed only if its
  value is the identifier `ns` or a `topenv(...)` call (allow common namespace
  wrappers); otherwise return without inserting.
- `try_extract_dollar_assignment`: proceed only if the receiver (`children[0]`)
  is the identifier `ns` or a `topenv(...)` call.
Use the existing `node_text` / `child_by_field_name` / kind helpers.

**Caveat:** confirm what env name the `.onLoad`/`.onAttach` hook parameter is
actually bound to in this codebase's extraction (it may not literally be `ns`);
match the hook's first formal name rather than hardcoding `ns` if that's how the
extractor identifies the namespace env. Add tests: a namespace-targeted
`assign("foo", ..., envir = <ns>)` / `<ns>$bar <- ...` is collected; a local
`assign("tmp", 1, envir = e)` / `cache$foo <- 1` is **not**.

---

## Group F — F2 session decisions to revisit

These are choices the F2 session made on a "smallest-reasonable" basis (recorded
as Decisions 5–10 + the Step-3 note in the F2 plan). Confirm or change each. Two
(F-1, F-2) are genuinely actionable; the rest are confirm-or-document.

### F-1 — `expect[<non-suppressible-code>]` always reports `unused-suppression`
Only `LINT_CODES` + `SUPPRESSIBLE_ANALYZER_CODES` (`undefined-variable`,
`assign-to-string-literal`, `package-not-installed`) are actually suppressible.
`syntax-error`, `unresolved-source-path`, and the dependency-graph codes are
not. So `# raven: expect[syntax-error]` can never match anything and emits a
**perpetual** `unused-suppression` HINT — confusing (it reads as "remove this"
even though the code was never suppressible).

**Recommended fix (small, in `handlers.rs::collect_unused_suppression_diagnostics`):**
when a directive's `what` is `Codes(cs)` and **none** of `cs` is suppressible
(not in `LINT_CODES` ∪ `SUPPRESSIBLE_ANALYZER_CODES`, accounting for
`syntax-error` umbrella children via `diagnostic_code`), **skip** the
unused-suppression report for that directive — it's "not applicable", not
"unused". Add a `diagnostic_code::is_suppressible(code) -> bool` helper. Leave a
blanket `expect` (`All`) as-is (it legitimately reports unused when the line had
no suppressible diagnostic). Tests: `expect[syntax-error]` produces **no**
`unused-suppression`; `expect[undefined-variable]` on a clean line still does.

### F-2 — `reportUnusedSuppressions` is LSP-only (no `raven.toml` / CLI)
The setting is parsed only in `backend.rs` from LSP init options, not in
`config_file/mod.rs`, so `raven check` users cannot enable the global
ignore-sweep. (`expect` itself works in `raven check` without the setting; only
the *all-ignores* sweep is gated.) Note **all** `diagnostics.*` severities are
currently LSP-only too, so this is a consistency question.

**Decide:** (a) leave LSP-only (document it), or (b) layer it through
`config_file` so `raven.toml` `[diagnostics] reportUnusedSuppressions = true`
works for CLI. If (b): wire it into the config_file parse path that populates
`CrossFileConfig` for the CLI (`cli/check.rs`), mirroring how lint config is
layered; add a CLI e2e test (the suppression e2e harness in
`crates/raven/tests/suppression_per_code.rs` can write a `raven.toml`). Smallest-
reasonable: (a) unless CLI parity is explicitly wanted.

### F-3 — `# nolint` excluded from the unused-suppression sweep
The sweep is driven solely by the analyzer-track `# raven:` / `@lsp-` directive
enumeration (`CrossFileMetadata::suppression_directives`); bare lintr `# nolint`
/ `# nolint start` directives are never reported as unused, even under the
global setting. Pyright sweeps lint-suppression equivalents too.

**Decide:** confirm (lintr-compat aliases stay silent) or extend the enumeration
to `# nolint` directives. Smallest-reasonable: confirm + document; extending
needs a parallel enumeration in `linting/nolint.rs` feeding the sweep.

### F-4 — chunk suppressions are `Ignore`-flavored only
`raven.ignore` / `# raven: ignore-chunk` always behave as silent `ignore`; there
is no asserting chunk form. **Decide:** confirm (an `expect` inside a chunk body
still works as a normal line/next directive) or add an asserting chunk option.
Smallest-reasonable: confirm + document.

### F-5 — `expect` mirrors every `ignore` form (incl. `@lsp-expect`)
Completeness decision; no action expected. Confirm the surface
(`# raven: expect`, `-next`, `-start/-end`, `-file`, `@lsp-expect`,
`@lsp-expect-next`) is the intended one.

---

## Group H — placement of the two security-hardening commits

The F2 session, while acting on CodeRabbit, also committed two **security**
fixes that live in the `system.file` / `sysdata` subsystems rather than the F2
suppression feature (commit `2decdc70`):
- `path_resolve.rs` — reject path-escaping `system.file()` components (`..`,
  absolute, drive prefix) via `system_file_relative_path`.
- `sysdata.rs:456` — escape the sysdata path into a safe R string literal before
  `load("…")`.

Because the maintainer has chosen to resolve the rest of the `system.file` /
`sysdata` findings **in this same PR** (this plan), keeping these two fixes in
PR #420 is now consistent — **recommended decision: keep them in-PR.** Only
revisit (revert into a separate PR) if PR #420 is later split by subsystem. No
action needed unless that split happens; recorded here so the choice is explicit
rather than implicit.

---

## Suggested order

0. **Group F + Group H** — make the decisions first (they may change scope: e.g.
   F-1 is a small code fix; F-2 may add config wiring). Record each on the
   deferred list with the chosen option.
1. **Group D** (tmerge) and **Group E findings 8–9** — small, isolated, low risk.
2. **Group E finding 10** (.onLoad scoping) — needs care to identify the ns env.
3. **Group C** (lib.loc/fsep rejection) — small, but corpus-affecting.
4. **Group B** (eval=FALSE guard move) — watch the existing mask tests.
5. **Group A** (system.file lifecycle) — the biggest; do last so the corpus
   re-run at the end covers Groups A + C together.

Then: full gates + strict corpus, push, reply to CodeRabbit, `@coderabbitai review`.

## Deferred-questions list (append as you go)
- **F-2 (decided: option a — leave LSP-only, document):** `reportUnusedSuppressions` stays editor-only. All `diagnostics.*` severity settings are likewise editor-only — this is consistent. Added "Editor-only" note to `docs/configuration.md`. Wiring it through `config_file` for CLI would be feasible but is not justified until explicitly requested.
- **F-3 (confirmed: `# nolint` excluded from sweep):** `# nolint` / `# nolint start/end` directives are handled entirely in the lint track's own `Suppressions` system (`linting/nolint.rs`) and are never pushed to `suppression_directives`. They are therefore invisible to the unused-suppression sweep by design — lintr-compat aliases stay silent.
- **F-4 (confirmed: chunk suppressions are Ignore-flavored only):** `append_chunk_suppressions` in `chunks.rs` hardcodes `SuppressionFlavor::Ignore`, so chunk-level directives (`raven.ignore=…`, `# raven: ignore-chunk`) never report unused unless the global `reportUnusedSuppressions` sweep is on. An `expect` written inside a chunk body works as a normal per-line directive. No change needed.
- **F-5 (confirmed: `expect` surface is intended):** The surface (`# raven: expect`, `-next`, `-start`/`-end`, `-file`, `@lsp-expect`, `@lsp-expect-next`) mirrors every `ignore` form. Confirmed as complete and intentional.
- **H (decided: KEEP the two security-hardening commits in PR #420):** The two security fixes (path-escape rejection in `system_file_relative_path` and sysdata path escaping in `.onLoad` extraction) touch the same `system.file`/sysdata subsystems that Groups A, C, and E address in this same PR. Keeping them here is consistent; they'd only be reverted into a separate PR if PR #420 were split by subsystem, which is not planned.
- **D (corpus regression fixed: tmerge captured corrected to [id,tstart,tstop]):** The plan's original `captured=["id"]` was wrong — corpus is ground truth. In `survival::tmerge`, `tstart` and `tstop` are data-masked (column expressions evaluated within `data1`), so they must be suppressed. `options` remains checked (plain control list).
- **C (corpus regression fixed: lib.loc/fsep partial-accept):** Blanket `lib.loc`/`fsep` rejection regressed the cluster→Matrix `test-tools-1.R` source edge (`lib.loc=.Library`). Fix: accept when value is a standard-library reference (`.Library`, `.Library.site`, `.libPaths()`) or default fsep (`"/"`); reject other values.
