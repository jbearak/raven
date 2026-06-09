# Plan: followup features + multi-agent review (then push PR #420)

Self-contained handoff for a fresh session. Branch: **`prod-test`**. Everything
below is **before pushing** — implement all feature work, run the multi-agent
review to two consecutive clean passes, THEN update PR #420 and push.

Decisions in this plan are FINAL (agreed with the maintainer). Don't relitigate;
if something is genuinely ambiguous, make the smallest reasonable choice and note
it.

## Where things stand
- This branch already landed a large package-corpus FP-hardening effort: 9
  workstreams (R6 pronouns, dataset/dev-dir visibility, sysdata, `.Generic`,
  chunk-extraction, etc.), a critical **function-local leak fix**
  (`extract_top_level_defs` now uses `live_top_level_exports`; commit
  `c48dd1bc`), and a re-triage of the diagnostics that fix surfaced.
- Fixtures now: `known_false_positives.toml` = 2372, `accepted_real_diagnostics.toml`
  = 224 (the growth includes ~38 genuine upstream bugs the leak had been masking).
- **Strict three-group corpus passes**:
  `RAVEN_CORPUS_GROUPS=base,recommended,tidyverse cargo test -p raven --test package_corpus package_corpus_selected -- --ignored` (~7–8 min). Keep it green.
- Background/history: `docs/superpowers/plans/2026-06-08-tidyverse-full-resolution.md`
  and `2026-06-08-tidyverse-triage.md`. PR is **#420** (`prod-test` → `main`);
  CodeRabbit last reviewed an *old* commit (`fadcfaa`) — its findings predate the
  workstreams and are likely superseded; re-review will happen after we push.

## Gates (per AGENTS.md — keep green before every commit)
`cargo fmt --all` · `cargo clippy --workspace --all-targets --features test-support -- -D warnings` (zero warnings) · `cargo test -p raven` · root `bun test`. TDD
throughout (red→green→refactor). Update `docs/` for user-visible behavior. The
maintainer has authorized the agent to commit at sensible checkpoints.

VS Code settings invariant (AGENTS.md): any new LSP-exposed setting must be wired
in `editors/vscode/package.json` + `editors/vscode/src/initializationOptions.ts`
+ `SETTINGS_MAPPING`/tests in `editors/vscode/src/test/settings.test.ts`, then
regenerate `bun editors/vscode/scripts/generate-settings-reference.mjs` (gated by
`tests/bun/settings-reference.test.ts`).

---

## FEATURE WORK (implement all; TDD)

### F1 — data.table by-reference class detection (`setDT`/`setDF`/`setattr`)
Today `NseAnalysis` (`crates/raven/src/handlers.rs`, `DataTableClass` enum /
`data_table_objects`) classifies a variable as a data.table only from its
*defining RHS* (`x <- as.data.table(...)`). In-place converters that don't
reassign are missed, so `x[i, j]` wrongly checks the `j` expression.
**Do:** treat a statement-level `setDT(x)` / `setDF(x)` / `setattr(x, "class",
...)` as a **class-transition event** that flips `x`'s `DataTableClass` from that
statement forward (analogous to how `load()` bindings become visible "from the
call onward"). `setkey/setorder/setindex` are already NSE-policy in `nse.rs`;
this completes the by-reference surface. Tests: `setDT(x)` then `x[, newcol :=
val]` doesn't flag `newcol`/`val`; `setDF(x)` flips back; a genuine undefined in
a non-data.table `[` still flags. Update `docs/diagnostics.md` and
`docs/r-package-dev.md` (data.table section).

### F2 — Suppression-syntax overhaul (the big one)
**Namespaces (all retained):**
- **`# raven:` is the new PRIMARY namespace** (works for both the LSP and `raven
  check`; the `lsp-` prefix is legacy since `raven check` isn't an LSP).
- **`@lsp-ignore` / `@lsp-ignore-next` remain permanent aliases** (maintainer
  uses them; parity with the Sight Stata LSP). Don't remove or deprecate-warn.
- **`# nolint` / `# nolint start` / `# nolint end` remain**, scoped to the
  **style/lint diagnostics gated by `raven.linting.enabled`** (lintr compat).
  See `crates/raven/src/linting/nolint.rs`.

**Four capabilities (all in scope):**
1. **Per-code targeting**: `# raven: ignore[undefined-variable]` (and `-next`).
   Bare form = blanket (all diagnostics on the target line). `@lsp-ignore` also
   gains an optional `[code]` form.
2. **File-level**: `# raven: ignore-file` / `# raven: ignore-file[code]` (header
   directive — see header-only rules in `docs/directives.md`).
3. **Block/range**: `# raven: ignore-start` … `# raven: ignore-end` (optionally
   `[code]`). Mirrors the existing lint `nolint start/end` but for general
   diagnostics.
4. **Stale-suppression detection — two-flavor model (Rust/TS style):**
   - `# raven: ignore[...]` — **silent**; never warns if it suppresses nothing
     (like `#[allow]` / `@ts-ignore`). Same for `@lsp-ignore`.
   - `# raven: expect[...]` — asserts a diagnostic WILL be suppressed here; if it
     suppresses nothing, emit **`unused-suppression`** (hint severity), **on by
     default for `expect` only** (like `#[expect]` / `@ts-expect-error`).
   - Plus a project setting **`raven.diagnostics.reportUnusedSuppressions`
     (default OFF)** that extends the `unused-suppression` check to ALL
     `ignore`/`@lsp-ignore`/`nolint` directives (Pyright-style global sweep).
     Wire per the VS Code settings invariant above.

**Chunk-level suppression for `.Rmd`/`.qmd` (both forms — maintainer confirmed):**
- a knitr **chunk option** (e.g. ```` ```{r, raven.ignore=TRUE} ```` or a
  per-code variant), AND
- an **in-chunk directive** (`# raven: ignore-chunk` or reuse `ignore-start/end`
  within the chunk body). Suppresses diagnostics for that chunk only.

**Diagnostic code naming (kebab-case, grounded in Pyrefly/rust-analyzer/ESLint):**
- kebab-case, descriptive, no opaque numbers (TS numeric codes are the
  anti-pattern). Support **cascading sub-kinds** à la Pyrefly (`syntax-error`
  umbrella over `unclosed-paren`/`missing-brace`; suppressing the parent
  suppresses children).
- ONE unified code namespace for analyzer diagnostics AND lint rules. Re-express
  the existing lint `rule_ids` (`crates/raven/src/linting/rule_ids.rs`) in
  kebab-case. Nothing external depends on current IDs, so renaming is fine.
- Enumerate the canonical set in `docs/diagnostics.md` (e.g. `undefined-variable`,
  `unused-suppression`, `syntax-error`(+children), `unresolved-source-path`,
  `assign-to-string-literal`, `mixed-logical`, plus lint rules `line-length`,
  `object-name`, `infix-spaces`, …).

**Touch points:** `crates/raven/src/cross_file/directive.rs` (directive parsing
incl. header-only rules), `crates/raven/src/linting/nolint.rs`, the diagnostic
suppression application in `crates/raven/src/handlers.rs` and `cli/check.rs`,
chunk masking in `cross_file/` (Rmd/qmd). Docs: rewrite the Ignore-directives
section of `docs/directives.md`, update `docs/linting.md`, `docs/diagnostics.md`,
`docs/chunks.md`, `docs/configuration.md` + settings reference. Keep existing
`@lsp-ignore`/`nolint` tests green and add full coverage for the new forms.

### F3 — `exported_interface` footgun cleanup
The dangerous correctness misuse is already fixed (`c48dd1bc`) and the field doc
is hardened (committed with this plan). Remaining (perf + correctness, but they
touch revalidation — do carefully with tests):
- Audit every consumer of `exported_interface` (see `crates/raven/src/cross_file/
  scope.rs` field doc). The cross-file scope path already avoids it correctly.
- **`interface_hash`**: should reflect only the file's *top-level* exports
  (function-scope-filtered) so a function-local rename doesn't trigger dependent
  revalidation. Filtering here is a correctness+perf win — verify no revalidation
  regressions.
- **Cmd+T workspace symbols** (`collect_workspace_symbols_from_artifacts` in
  `handlers.rs`): currently surfaces function-local names. Decide
  top-level-only (recommended) and test.
- Consider providing a single canonical accessor so future "exports" consumers
  can't reach for the flat map.

### F4 — dev-context injection scope (FINAL decisions)
In `crates/raven/src/package_state/mod.rs` (`is_dev_context_path`,
`is_r_source_path`, `RFileKind`, `is_testthat_or_testit_test`) and
`package_state/derive.rs`:
- **Dev-context set becomes: `demo/`, `vignettes/`, `data-raw/`, `man/`** (all
  "package is loaded when this runs"). One-way package R/ visibility as today.
- **Drop `inst/` and `revdep/`** from blanket dev-context injection.
- **Promote `inst/tinytest/` and `inst/unitTests/` to `Test`-kind** (one-way
  package visibility + test-framework awareness, like `tests/testthat/`) — these
  are real installed test suites run with the package loaded. (Plain `inst/`
  example/shiny scripts now rely on explicit `library()`/directives like any
  other script.)
- Tests: package fn resolves in `demo/`/`vignettes/`/`data-raw/`/`man` and in
  `inst/tinytest`; a bare reference in `inst/rmarkdown/templates/.../skeleton.Rmd`
  is NOT silenced; `inst/extdata` non-R untouched; no leak into `R/`. Update
  `docs/r-package-dev.md`.

---

## MULTI-AGENT REVIEW (after F1–F4; report-only)
Run a **parallel** set of reviewer subagents over the **entire PR diff**
(`main…prod-test`). Reviewers **report findings only** — the orchestrator
synthesizes and applies fixes. Agents (don't drop any; they're probabilistic and
convergence across agents is signal):
1. Repo coding-standards conformance (AGENTS.md invariants, module/doc-comment
   conventions, error handling, settings-wiring invariant).
2. LSP best practices (protocol correctness, diagnostic/code-action ergonomics,
   suppression-syntax UX vs. the researched norms).
3. Performance (run faster primary, less memory secondary). May run criterion
   benchmarks — allowed to take the time it needs.
4. Simplification (duplication, unnecessary nesting, dead code).
5. Docs (accuracy, adequacy, best practices; the rewritten suppression/diagnostic
   docs especially).
6. High-altitude / big-picture architecture scan.
7. Final cross-cutting sweep that is **given the other six agents' findings** and
   looks for what they missed / cross-cutting themes.

**Loop:** synthesize findings → apply fixes (TDD, gates green, corpus strict
green) → re-run all agents. **Done when two CONSECUTIVE passes yield ZERO findings
from every agent.** Adjust the agent set between iterations if you learn a better
decomposition (maintainer's explicit latitude).

## THEN: PR #420
- Rewrite the PR **title** (CodeRabbit flagged "prod test" as vague) to something
  descriptive; **preserve commit history** (no squash).
- Rewrite the PR **description** to the expanded scope, **framed on Raven's
  diagnostic-quality + features**; the ~38 genuine upstream bugs surfaced are
  **background**, not the headline.
- Push. **Wait for CodeRabbit's fresh review**, then act on its feedback
  (synthesize, fix, keep gates + corpus green).

## Key files / pointers
- data.table: `handlers.rs` (`NseAnalysis`, `DataTableClass`), `nse.rs`.
- suppression: `cross_file/directive.rs`, `linting/nolint.rs`, `handlers.rs`,
  `cli/check.rs`, `linting/rule_ids.rs`; Rmd/qmd masking in `cross_file/`.
- exported_interface: `cross_file/scope.rs`, `roxygen.rs::extract_top_level_defs`.
- dev-dirs: `package_state/mod.rs`, `package_state/derive.rs`.
- corpus: `crates/raven/tests/package_corpus.rs` (env `RAVEN_CORPUS_GROUPS`,
  `RAVEN_CORPUS_ALLOW_UNCLASSIFIED`, `RAVEN_CORPUS_KEEP_TEMP`; the run is the
  ignored `package_corpus_selected` test).
- settings wiring: `editors/vscode/package.json`,
  `editors/vscode/src/initializationOptions.ts`,
  `editors/vscode/src/test/settings.test.ts`, settings-reference generator.
