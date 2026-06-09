# Plan: finish F2 suppression overhaul + multi-agent review + push PR #420

Self-contained handoff for a fresh session. Branch: **`prod-test`**. This
continues `docs/superpowers/plans/2026-06-09-followup-features-and-review.md`
(read it for the original F1–F4 framing and the review/PR sections — its
decisions remain FINAL). F1, F3, F4, and the **foundation of F2** are already
implemented, committed, and green; this plan finishes F2, then runs the
multi-agent review loop and updates/pushes PR #420.

**Run non-blocking throughout (every phase).** Never pause to wait on the
maintainer mid-run. On any question/ambiguity/judgment call, make the smallest
reasonable decision, record it on a single **deferred-questions list**, and keep
going. Surface that list once, at the very end, as a closing summary. The only
thing that legitimately halts progress is a hard blocker (gates can't be made
green, or an unresolvable corpus regression) — and even then, exhaust
alternatives first.

---

## Where things stand (already committed on `prod-test`)

Commits since the plan baseline (newest last):
- `effdde24` **F1** — data.table by-reference class detection (`setDT`/`setDF`/`setattr`).
- `63f71710` **F4** — narrow dev-context injection scope.
- `4cf4bab1` **F3** — scope `exported_interface` consumers to top-level exports.
- `8824555a` **F2 foundation** — canonical diagnostic-code namespace + `# raven:` primary suppression namespace.
- `a9ce71c1` **corpus** — re-triage of the 51 F4-surfaced `inst/` diagnostics.

**All gates green at this checkpoint:** `cargo fmt --all --check`,
`cargo clippy --workspace --all-targets --features test-support -- -D warnings`,
full `cargo test -p raven` (all unit/integration targets + 55 doctests),
root `bun test` (1321 pass), and the strict three-group corpus
(`RAVEN_CORPUS_GROUPS=base,recommended,tidyverse cargo test -p raven --test package_corpus package_corpus_selected -- --ignored`, ~7.5 min).

### F1 — DONE
`crates/raven/src/handlers.rs`. `NseAnalysis` gained
`class_transitions: HashMap<String, Vec<(usize, DataTableClass)>>` (sorted
ascending by byte). `class_transition_before(name, pos)` resolves the class
as-of a `[`'s position; `subset_object_data_table_class` consults it before the
flat constructor sets. Transitions recorded in `collect_nse_facts` at top level
via `by_reference_class_transition()` / `setattr_class_transition()`
(`setDT`→DataTable, `setDF`→NonDataTable, `setattr(x,"class",v)` by textual
match of `data.table`/`data.frame`/`tbl_df`). 5 tests (`nse_setdt_*`,
`nse_setdf_*`, `nse_setattr_*`). Docs: `diagnostics.md`, `r-package-dev.md`.

### F3 — DONE
`crates/raven/src/cross_file/scope.rs`. New canonical accessor
`pub fn top_level_interface(artifacts) -> HashMap<Arc<str>, ScopedSymbol>`
(filters `exported_interface` by `live_top_level_exports`, rm-aware,
function-scope-filtered). Both `interface_hash` sites now hash it instead of the
full map. `handlers.rs::collect_workspace_symbols_from_artifacts` skips names
not in `live_top_level_exports` (top-level-only Cmd+T). 3 tests.

### F4 — DONE
`crates/raven/src/package_state/mod.rs`. `is_dev_context_path` set =
`{demo, data-raw, vignettes, man}` (dropped `inst`, `revdep`). `is_r_source_path`
returns `Test` for `inst/tinytest/` and `inst/unitTests/`.
`is_testthat_or_testit_test` left testthat/testit-only. Tests in `mod.rs` +
`scope.rs`; docs `r-package-dev.md`. Corpus re-triage added 51
`known_false_positive` entries (50 `inst/` package-own refs + 1 `tools/R/install.R`
svn-trunk drift).

### F2 — FOUNDATION DONE, remainder below
Committed:
- **`crates/raven/src/diagnostic_code.rs`** (declared in `lib.rs`): one unified
  kebab-case namespace. Consts `UNDEFINED_VARIABLE`, `SYNTAX_ERROR`
  (+`SYNTAX_ERROR_CHILDREN`), `UNRESOLVED_SOURCE_PATH`,
  `ASSIGN_TO_STRING_LITERAL`, `PACKAGE_NOT_INSTALLED`, `UNUSED_SUPPRESSION`;
  `ANALYZER_CODES`, `LINT_CODES`. Functions `normalize()` (→kebab),
  `to_lint_rule_id()` (→snake, for `.lintr`/config/`Diagnostic.code` lookup),
  `parent()` and `suppresses()` (cascading sub-kinds). 5 tests.
- **`# raven:` primary namespace** in all three recognizers, `@lsp-ignore`/
  `nolint` retained as permanent aliases:
  - `linting/nolint.rs`: `NolintMarker::File`; `classify_raven()` handles
    `ignore`/`-next`/`-start`/`-end`/`-file` + optional `[code]`. **`[code]` is
    currently parsed but blanket-per-line** (interim, same as `# nolint: rule`).
  - `cross_file/directive.rs`: `raven_ignore` + `raven_ignore_next` regexes;
    `@lsp-`-only pre-filter widened to also admit `raven:`. Line/next only.
  - `handlers.rs::classify_lsp_ignore_marker`: recognizes `# raven: ignore`/
    `-next` (+`[code]`) on the AST suppression path.
  - Docs: `directives.md` Ignore section rewritten; `linting.md` suppression
    matrix gained `# raven:` rows.

---

## Decisions (FINAL — resolved with maintainer this session)

1. **`man/*.Rd` examples**: ACCEPTABLE as-is. No `.Rd` parsing/`\examples{}`
   extraction exists; `man/` stays in the dev-context set but only affects
   `.R`/`.Rmd` files there. Do NOT build `.Rd` example scoping.
2. **Per-code `[code]` must be FINISHED** (no longer interim). The `[code]`
   selector must actually *target* a single diagnostic code (with cascading
   sub-kinds via `diagnostic_code::suppresses`), in both the lint track and the
   analyzer track. This is the first remaining task below.
3. **`setattr(x,"class",…)` textual heuristic**: FINE as implemented.
4. **`tools/R/install.R` corpus entry / svn-trunk drift**: OK.

## Gates (keep green before every commit; TDD throughout)
`cargo fmt --all` · `cargo clippy --workspace --all-targets --features test-support -- -D warnings` · `cargo test -p raven` · root `bun test` · strict three-group corpus. Commit at sensible checkpoints.

VS Code settings invariant (AGENTS.md): any new LSP-exposed setting must be wired
in `editors/vscode/package.json` + `editors/vscode/src/initializationOptions.ts`
+ `SETTINGS_MAPPING`/tests in `editors/vscode/src/test/settings.test.ts`, then
regenerate `bun editors/vscode/scripts/generate-settings-reference.mjs` (gated by
`tests/bun/settings-reference.test.ts`).

---

## REMAINING F2 WORK (implement all; TDD; suggested build order)

### Step 1 — Per-code enforcement (decision #2)
The blocker: analyzer diagnostics currently emit `code: None`. To target by code
you must first give them codes, then teach every suppression site to consult the
directive's `[code]` against the diagnostic's code via
`diagnostic_code::suppresses(suppression_code, diagnostic_code)`.

1a. **Assign `Diagnostic.code` to analyzer diagnostics** using the
`diagnostic_code` consts. Construction sites (search `..Default::default()` on
`Diagnostic` and the messages):
- undefined-variable: `handlers.rs` ~line 5847 (`message: "Undefined variable: …"`)
  → `code: Some(NumberOrString::String(UNDEFINED_VARIABLE.into()))`.
- invalid-assignment-target → `ASSIGN_TO_STRING_LITERAL`.
- missing/unresolved source path → `UNRESOLVED_SOURCE_PATH`.
- missing package (`library(notInstalled)`) → `PACKAGE_NOT_INSTALLED`.
- syntax errors (`collect_syntax_errors`) → `SYNTAX_ERROR` or a concrete child
  from `SYNTAX_ERROR_CHILDREN` where the kind is known.
  Lint rules already emit snake_case `rule_ids` codes — leave them; the
  kebab/snake bridge is `diagnostic_code::{normalize,to_lint_rule_id}`.
  Guard against the corpus normalizer in `tests/package_corpus.rs` (it already
  expects `code: "undefined-variable"`).

1b. **Carry the `[code]` selector through the parsers.** Today the recognizers
discard `[code]`. Extend them to capture the code string:
- `cross_file/types.rs`: `ignored_lines`/`ignored_next_lines` are
  `HashSet<u32>`. Either change to `HashMap<u32, LineSuppression>` where
  `LineSuppression` is `All | Codes(Vec<String>)`, or add parallel maps. Update
  `is_line_ignored` → `is_line_ignored_for_code(meta, line, code: Option<&str>)`
  that returns true when the line carries a blanket ignore OR a code-specific
  ignore whose code `suppresses` the diagnostic's code.
- `cross_file/directive.rs`: capture the `[code]` group from `raven_ignore`/
  `raven_ignore_next` (and add an optional `[code]` to the `@lsp-ignore`/
  `ignore_next` regexes per the plan: "`@lsp-ignore` also gains an optional
  `[code]` form").
- `handlers.rs`: the three analyzer enforcement sites are
  `is_line_ignored(&snapshot.directive_meta, …)` at **~4869** (library/missing-
  package), **~5104**, **~5578** (undefined-variable). Pass the diagnostic's code
  so per-code matching applies. Also the AST path
  `lsp_ignored_lines_from_tree`/`classify_lsp_ignore_marker` (~11085/11159) for
  invalid-assignment-target — return the code set, match against
  `ASSIGN_TO_STRING_LITERAL`.
- `linting/nolint.rs`: `Suppressions` currently exposes `is_suppressed(line)`.
  Add `is_suppressed_code(line, rule_id)` and have the **20** rule files under
  `linting/rules/*.rs` (each already knows its `rule_ids::X`) call it. Keep
  `is_suppressed` for blanket. Store per-line code sets parsed from `[code]` and
  `# nolint: rule_a, rule_b` (the existing nolint rule filter — wire it through
  too, since the infra now exists). Match with `diagnostic_code::suppresses` so
  both spellings and the `syntax-error` cascade work.

Tests: `# raven: ignore[undefined-variable]` suppresses an undefined-variable
diagnostic but NOT a co-located lint diagnostic; `ignore[line-length]` suppresses
only the line-length lint; `ignore[syntax-error]` covers a child kind; a bare
`ignore` still blankets; `@lsp-ignore[undefined-variable]` works.

### Step 2 — Analyzer-track file-level + block/range
`# raven: ignore-file` / `ignore-file[code]` (header-only per `directives.md`
header rules) and `# raven: ignore-start` … `# raven: ignore-end`
(+optional `[code]`) for the analyzer diagnostics (lint track already has these
via `nolint.rs`). Needs directive range tracking in `CrossFileMetadata`
(`cross_file/types.rs`) — add a file-level flag/codeset and a list of
(start_line, end_line, codeset) ranges; fold into `is_line_ignored_for_code`.
Mirror the unterminated-`start`→EOF behavior of `nolint.rs`.

### Step 3 — `expect` flavor + `unused-suppression` + global setting
Two-flavor model (Rust/TS style):
- `# raven: ignore[...]` / `@lsp-ignore` — **silent**; never warns if it
  suppressed nothing (like `#[allow]` / `@ts-ignore`).
- `# raven: expect[...]` — asserts a diagnostic WILL be suppressed; if it
  suppressed nothing, emit **`unused-suppression`** (`UNUSED_SUPPRESSION`, **HINT**
  severity), on by default for `expect` only (like `#[expect]` /
  `@ts-expect-error`).
- Project setting **`raven.diagnostics.reportUnusedSuppressions` (default OFF)**
  extends the `unused-suppression` sweep to ALL `ignore`/`@lsp-ignore`/`nolint`
  directives (Pyright-style). Wire per the VS Code settings invariant above.

**Implementation note (critical):** the suppression pipeline must **record, per
directive, the set of diagnostics it actually removed**, so `unused-suppression`
fires precisely when that set is empty (and `expect` requires it non-empty).
This is a pipeline change in both tracks: when a diagnostic is suppressed,
attribute it to the directive (by line + matched code) and mark that directive
"used". After the pass, any `expect` (or, under the global setting, any ignore)
with no attributions emits `unused-suppression` at the directive's own range.
`HINT` severity → does NOT gate `raven check --max-severity error` by default.

### Step 4 — Chunk-level suppression for `.Rmd`/`.qmd`
Both forms (maintainer confirmed):
- a knitr **chunk option**: ```` ```{r, raven.ignore=TRUE} ```` (and a per-code
  variant, e.g. `raven.ignore="undefined-variable"`); AND
- an **in-chunk directive**: `# raven: ignore-chunk` (or reuse `ignore-start/end`
  within the chunk body). Suppresses diagnostics for that chunk only.
Chunk masking lives in `cross_file/` (Rmd/qmd extraction) and `chunks.rs`.
Suppress by mapping the chunk's line range to the existing range-suppression
machinery from Step 2.

### Step 5 — Docs rewrite
- `docs/diagnostics.md`: enumerate the canonical kebab-case code set
  (`undefined-variable`, `syntax-error`(+children), `unresolved-source-path`,
  `assign-to-string-literal`, `package-not-installed`, `unused-suppression`,
  plus the lint codes), and document the `expect` flavor + `unused-suppression`.
- `docs/directives.md`: file/block/chunk forms + per-code now enforced (drop the
  "staged"/"interim" caveats once Steps 1–4 land).
- `docs/linting.md`: update the matrix (per-code now enforced; `# nolint: rule`
  now honored).
- `docs/chunks.md`: chunk-level suppression.
- `docs/configuration.md` + regenerate `docs/settings-reference.md` for the new
  setting.

---

## MULTI-AGENT REVIEW (after F2; report-only) — task 12
Carry over verbatim from the original plan's "MULTI-AGENT REVIEW" section: run
the **7 parallel report-only reviewer agents** over the entire `main…prod-test`
diff (treat `tests/fixtures/package_corpus/*.toml` as data, not line-review),
orchestrator synthesizes + applies fixes (TDD, gates green, strict corpus green),
re-run until **two consecutive passes yield zero actionable findings from every
agent**. The seven agents: (1) repo coding-standards/AGENTS.md invariants incl.
the settings-wiring invariant, (2) LSP best practices + suppression-syntax UX,
(3) performance, (4) simplification, (5) docs, (6) high-altitude architecture,
(7) cross-cutting sweep given the other six's findings. Also re-verify
CodeRabbit's prior findings (old `run_check` exit-status check, `classify_observed`
perf nitpick, two then-stale tests) against current HEAD. Park
subjective/out-of-scope items on the deferred-questions list; don't pause.

## THEN: PR #420 — task 13
- Rewrite the PR **title** to something descriptive (CodeRabbit flagged
  "prod test" as vague); **preserve commit history** (no squash).
- Rewrite the PR **description** to the expanded scope, framed on Raven's
  diagnostic-quality + features (the ~38 genuine upstream bugs are background,
  not the headline).
- Push. **Wait for CodeRabbit's fresh review**, then act on its feedback
  (synthesize, fix, keep gates + corpus green).

---

## Key files / pointers (line numbers as of commit `a9ce71c1`)
- diagnostic codes: `crates/raven/src/diagnostic_code.rs` (`normalize` ~94,
  `to_lint_rule_id` ~101, `parent` ~106, `suppresses` ~120).
- lint suppression: `crates/raven/src/linting/nolint.rs`
  (`from_text` ~39, `is_suppressed` ~109, `enum NolintMarker` ~114,
  `classify_raven` ~284). Rule consumers: 20 files in `linting/rules/*.rs`
  calling `suppressions.is_suppressed(line)`.
- analyzer directives: `crates/raven/src/cross_file/directive.rs`
  (`raven_ignore`/`raven_ignore_next` fields ~21, regex init ~124, parse ~315/324,
  `is_line_ignored` ~382). Metadata: `cross_file/types.rs`
  (`ignored_lines`/`ignored_next_lines` ~41/43).
- analyzer enforcement: `crates/raven/src/handlers.rs` `is_line_ignored` sites at
  ~4869 (library/missing-package), ~5104, ~5578 (undefined-variable); AST path
  `lsp_ignored_lines_from_tree` ~11085, `classify_lsp_ignore_marker` ~11159;
  undefined-variable construction ~5847.
- corpus: `crates/raven/tests/package_corpus.rs` (env `RAVEN_CORPUS_GROUPS`,
  `RAVEN_CORPUS_ALLOW_UNCLASSIFIED=1` to collect-not-fail, `RAVEN_CORPUS_KEEP_TEMP`;
  report at `target/package-corpus/latest.json`; the ignored
  `package_corpus_selected` test). Fixtures:
  `tests/fixtures/package_corpus/{known_false_positives,accepted_real_diagnostics}.toml`.
- settings wiring: `editors/vscode/package.json`,
  `editors/vscode/src/initializationOptions.ts`,
  `editors/vscode/src/test/settings.test.ts`, settings-reference generator.

## Deferred-questions list (carry forward; append new items)
- (resolved) man/.Rd, setattr heuristic, tools/install.R drift — see Decisions.
- The `[code]` blanket-interim note in `linting.md` must be removed once Step 1
  lands.


---

## PROGRESS UPDATE — Steps 1 & 2 DONE (commit `b8ec2b77` on `prod-test`)

**Status:** fmt clean, clippy clean (`--all-targets --features test-support`),
full `cargo test -p raven --features test-support` green (4631 lib + all
integration targets + 55 doctests). `bun test` and the strict three-group corpus
**NOT yet re-run since this commit** — run them before the review phase (see
"Gates not yet re-run" below).

### Step 1 — per-code enforcement: DONE
- **`cross_file/types.rs`**: added `enum LineSuppression { All, Codes(Vec<String>) }`
  with `covers(Option<&str>)` (blanket covers all; `Codes` covers via
  `diagnostic_code::suppresses`, and only when the diagnostic code is `Some`) and
  `merge()`. Added `struct SuppressionRange { start, end, what }`. Changed
  `ignored_lines`/`ignored_next_lines` from `HashSet<u32>` to
  `HashMap<u32, LineSuppression>`; added `ignored_file: Option<LineSuppression>`
  and `ignored_ranges: Vec<SuppressionRange>` (both `#[serde(default)]`).
- **`cross_file/directive.rs`**: ignore regexes now capture an optional `[code]`
  (group 1); added `raven_ignore_start`/`raven_ignore_end`/`raven_ignore_file`
  regexes and `@lsp-ignore[code]` / `@lsp-ignore-next[code]`. Helpers
  `parse_suppression_codes`, `insert_line_suppression`. New public
  `is_line_ignored_for_code(meta, line, code: Option<&str>)`; `is_line_ignored`
  kept as the **blanket-only** shim (`code: None`, so only `All` matches).
- **`handlers.rs`**: assigned `Diagnostic.code` to analyzer diagnostics —
  `UNDEFINED_VARIABLE` (undefined-variable + "used before available"),
  `PACKAGE_NOT_INSTALLED`, `ASSIGN_TO_STRING_LITERAL` (all invalid-assignment
  targets), `UNRESOLVED_SOURCE_PATH` (both standalone + snapshot missing-file
  collectors, incl. "outside workspace"/"parent not found"), `SYNTAX_ERROR`
  (umbrella, all syntax-error pushes). The 3 enforcement sites now call
  `is_line_ignored_for_code(.., Some(code))`. The AST invalid-assignment path
  (`lsp_ignored_lines_from_tree` / `visit_comments_for_ignore` /
  `classify_comment_for_ignore` / `classify_lsp_ignore_marker`) now produces a
  `HashMap<u32, LineSuppression>` and matches against `ASSIGN_TO_STRING_LITERAL`.
- **`linting/nolint.rs`**: `Suppressions` stores `HashMap<u32, LineSuppression>`;
  markers carry codes (`NolintMarker::{Line,Start,NextLine,File}(LineSuppression)`,
  `End`). New `is_suppressed_code(line, rule_id)`; `is_suppressed` is now
  `#[cfg(test)]`-only (blanket "any entry"). `# nolint: rule` and `[code]`
  selectors are now honored **per-rule**. All 20 rule files call
  `is_suppressed_code(line, rule_ids::X)`.
- **Tests**: unit (`directive.rs`, `nolint.rs`, AST path in `handlers.rs`) + new
  e2e `crates/raven/tests/suppression_per_code.rs` (5 tests, `raven check`).

### Step 2 — analyzer file-level + block/range: DONE (folded into Step 1)
`# raven: ignore-file[code]` (recognized **anywhere**, not header-only — see
decision below), `# raven: ignore-start[code]` … `# raven: ignore-end` (block,
inclusive of directive lines, unterminated → EOF). All flow through
`is_line_ignored_for_code` (checks file, line, next-line, then ranges).

### Decisions made this session (smallest-reasonable, append to deferred list)
1. **"used before available"** diagnostic carries `UNDEFINED_VARIABLE` (plan
   grouped sites 5104/5578 as undefined-variable). Suppress with
   `ignore[undefined-variable]`.
2. **All invalid-assignment-target diagnostics** (incl. ERROR "Cannot assign to
   NULL/NA/...") share the `ASSIGN_TO_STRING_LITERAL` code — the canonical
   namespace has no finer code for them. `ignore[assign-to-string-literal]`
   covers the whole family.
3. **Syntax errors** carry the umbrella `SYNTAX_ERROR` only; the concrete
   `SYNTAX_ERROR_CHILDREN` (`unclosed-paren`, …) are defined but **not emitted**,
   so `ignore[unclosed-paren]` won't match while `ignore[syntax-error]` covers
   all. (Syntax errors are not wired into any suppression enforcement site
   anyway — codes are for reporting/consistency.) Revisit if child-targeting is
   wanted.
4. **`ignore-file` is recognized anywhere**, not header-only as the plan
   suggested, to stay consistent with the existing lint-track behavior in
   `nolint.rs`. (Existing lint-track `ignore-file` tests all place it on line 0,
   so this is consistent.) Revisit if header-only is required.

### Gates not yet re-run since `b8ec2b77`
- `bun test` (root) — Step 1-2 are Rust-only, no TS touched, so expected green;
  confirm anyway.
- Strict three-group corpus
  (`RAVEN_CORPUS_GROUPS=base,recommended,tidyverse cargo test -p raven --features
  test-support --test package_corpus package_corpus_selected -- --ignored`,
  ~7.5 min). Diagnostics now carry `code`, but corpus matching is by
  message+range (the `ObservedDiagnostic.code` field is informational), so no
  regression expected — **verify**.

### Remaining: Step 3, 4, 5, then review (task 12) + PR (task 13)
- **Step 3 (expect + unused-suppression + global setting)** — NOT started. The
  pipeline must record per-directive whether it suppressed ≥1 diagnostic. The
  inline-filter architecture (each diagnostic checks `is_line_ignored*`) does not
  attribute suppression to directives. Suggested approach: expose the full set of
  parsed directives (line, kind, codes, `is_expect`) on both tracks; compute the
  "raw" (pre-suppression) diagnostics; a directive is *used* iff some raw
  diagnostic on its target line is covered by it. `expect` with empty coverage →
  `unused-suppression` (HINT) at the directive range; under
  `raven.diagnostics.reportUnusedSuppressions` (default OFF) the sweep extends to
  all ignore directives. Add `expect` parsing to all three recognizers
  (`nolint.rs`, `directive.rs`, AST `classify_lsp_ignore_marker`). Wire the VS
  Code setting per the AGENTS.md 3-place invariant + regenerate settings-ref.
- **Step 4 (chunk-level for Rmd/qmd)** — knitr chunk option `raven.ignore=TRUE`
  (and per-code) + in-chunk `# raven: ignore-chunk`; map chunk line range onto
  the Step-2 `SuppressionRange` machinery. Lives in `cross_file/` Rmd extraction
  + `chunks.rs`.
- **Step 5 (docs)** — `diagnostics.md` (enumerate canonical codes + expect +
  unused-suppression), `directives.md` (drop "interim/staged" caveats, document
  file/block/chunk + per-code now enforced), `linting.md` (per-code now enforced;
  `# nolint: rule` now honored — remove the blanket-interim note), `chunks.md`,
  `configuration.md` + regenerate `settings-reference.md`.
