# Plan: resolve ALL tidyverse corpus false positives

Address every known-FP category from the tidyverse triage
(`docs/superpowers/plans/2026-06-08-tidyverse-triage.md`) — 1463 diagnostics —
regardless of value-to-effort. Each category becomes a workstream with a
concrete static approach, TDD, and an honest note on any residual tail that is
genuinely beyond static reach.

The 20 accepted-real diagnostics (string-literal assignment, mixed `&`/`|`) are
CORRECT and must keep firing — no workstream may suppress them.

## Guiding constraints
- Bias to zero false positives, but NEVER mask a real bug. Where a mechanism
  could over-suppress, gate it narrowly and add a no-leak / still-flagged test.
- Follow AGENTS.md. Per-function invariants go in doc comments; user-visible
  behavior updates `docs/`.
- TDD every workstream (red→green). Gates per stage: `cargo fmt --all --check`;
  `cargo clippy --workspace --all-targets --features test-support -- -D warnings`;
  `cargo test -p raven`; root `bun test`.
- Re-measure the corpus between workstreams that overlap (datasets vs
  data-masking; dev-dir injection vs package-fn references) so wins aren't
  double-counted and residue is visible.
- Do NOT commit unless asked.

---

## Workstream A — R6 `self` / `private` / `super` scope (226)
**Root cause:** method bodies inside `R6Class(public=list(...), private=list(...),
active=list(...))` reference `self`/`private`/`super`, injected by R6 at
construction.
**Approach:** a syntax-based recognizer (mirrors the S4 `setMethod`
special-variable handling and Shiny deferred-scope). Detect `R6Class(...)` /
`R6::R6Class(...)`. For each function value inside the `public`/`private`/`active`
list arguments, model its body as having `self`, `private`, `super` in scope.
No R6 metadata required. A top-level local named `R6Class` disables the
treatment. Fields/methods accessed as `self$x` / `private$y` are member access
(RHS of `$`) and already unchecked — only the pronouns need injecting.
**Files:** `cross_file/scope.rs` (or a small `r6.rs` helper) + `handlers.rs`
special-variable path. **Tests:** pronoun resolves inside public/private/active
method; nested helper fn; shadow disables; a genuine undefined inside a method
still flags. **Risk:** low.

## Workstream B — trust `importFrom` symbol names without install (57)
**Root cause:** `importFrom(pkg, fn)` (NAMESPACE or roxygen `@importFrom`) names
the exact symbol `fn`, but Raven currently leaves `fn` unresolved when `pkg`
isn't installed. The explicit symbol name is known regardless of install status.
**Approach:** INVESTIGATE first (`package_state` imported-symbol derivation +
`namespace_parser.rs`): confirm whether `importFrom` symbols are dropped when the
source package can't be found. Fix so an explicitly-named `importFrom(pkg, fn)` /
`@importFrom pkg fn` always contributes `fn` to package scope, install-independent.
(Whole-package `import(pkg)` legitimately still needs `pkg`'s export list — leave
that to the existing tiered export resolution; only the *named* form is in scope
here.) **Files:** `namespace_parser.rs`, `package_state/*`. **Tests:** named
importFrom resolves with the source package absent; `import(pkg)` unaffected;
no leak of unnamed imports. **Risk:** low; arguably a correctness fix.

## Workstream C — top-level control-flow & conditional definitions (28+)
**Root cause:** vendored standalone files define helpers conditionally
(`if (!exists("is_true")) is_true <- function(...) ...`; `na_chr`,
`deferred_run`). R executes top-level `if`/`for`/`while` bodies in the calling
environment, so the `<-` binds at top level — but Raven only treats
unconditional top-level assignments as definitions.
**Approach:** in the scope model, treat an assignment that sits at top level but
inside a top-level control-flow construct (`if`/`else`/`for`/`while`/`repeat`
block, and the `{ }` of same) as a top-level binding, visible from that
statement onward. Handle the `if (!exists("x")) x <- ...` idiom specifically and
the general case. **Files:** `cross_file/scope.rs` (artifact walk). **Tests:**
conditional def resolves later in file; `if(!exists)` idiom; binding still not
visible *before* its statement; nested-inside-function assignments stay local.
**Risk:** medium — must not promote function-local assignments. Add explicit
negative tests.

## Workstream D — package's own `data/` datasets, exposed package-wide (~300)
**Root cause:** `library(pkg)` (in a prior vignette chunk / test) makes the
package's lazy-loaded datasets (`mpg`, `diamonds`, `starwars`, `relig_income`,
…) available as bare names; Raven doesn't know them.
**Approach:** index the analyzed package's own `data/` directory — dataset names
= file stems of `data/*.{rda,RData,rds,tab,txt,csv}` plus top-level object names
created by `data/*.R` scripts — and expose them as package-internal symbols
visible wherever the package is loaded (R/, tests/, vignettes/, inst/, demo/,
data-raw/). Reuses the `data()` recognizer's name-binding notion but for
LazyData (no explicit `data()` call). **Cross-package datasets** (`lung` from a
Suggested package): when that package is installed, read its `data/` dir from
`lib_paths` after a `library(thatpkg)`/`Suggests` link; otherwise leave as
residue. **Files:** `package_state/*` (new data-symbol set on
`PackageScopeContribution`), `cross_file/scope.rs` injection. **Tests:** own
dataset resolves in a vignette/test; `data/*.R`-defined name resolves;
non-dataset bare name still flags; cross-package dataset resolves from a fake
lib_path. **Risk:** medium (don't over-broadly suppress real typos — only inject
actual dataset names found on disk).

## Workstream E — package-context injection for dev-script dirs (~120 + refs)
**Root cause:** scripts under `inst/`, `demo/`, `data-raw/`, `vignettes/`,
`revdep/` reference the package's own functions without `library()`; they run in
the loaded-package dev context but currently get no package-internal scope.
**Approach:** extend the one-way R/-visibility (already given to `R/`,
`tests/testthat`, plain `tests/`) to these dev-context locations: they SEE
`R/` top-level symbols + NAMESPACE imports; their defs never leak into `R/`; they
don't see each other. **Decision (approved):** these directories' scripts run with the package loaded
(vignette/example/dev-context), so injecting the package's `R/` symbols is
appropriate. Keep it one-way (their defs never leak into `R/`), package-mode
only, and KEEP genuine-undefined detection: a symbol that is not a package
export/import still flags inside `inst/`/`demo/`/etc. Confirm via the corpus
over-suppression guard that no accepted-real vanishes.
**Files:** `package_state/mod.rs` (`is_r_source_path` classification),
`cross_file/scope.rs`. **Tests:** package fn resolves in inst/demo/data-raw/
vignette; genuine undefined still flags; no leak into R/.

## Workstream F — cross-chunk scope in one document + man/ examples (~200)
**Root cause:** vignette `.Rmd`/`.qmd` and `man/*.Rd` `\examples{}` define
objects in an early chunk/line and use them later; the largest "runtime context"
sub-bucket includes `man/` rlang Rmds (106) and prior-chunk vignette vars.
**Approach:** INVESTIGATE current behavior — whether Raven already threads
top-level bindings across chunks of the SAME document, and how the corpus feeds
vignettes (per-chunk vs concatenated). Ensure earlier-chunk top-level bindings
are visible to later chunks of the same file (ordered concatenation semantics),
and that `man/*.Rd` example blocks are analyzed with package scope (the package
is loaded when examples run) — likely folds into Workstream E's package-context
injection plus chunk threading. **Files:** chunk handling in `cross_file` /
handlers; `man/` `.Rd` example extraction. **Tests:** var from chunk 1 resolves
in chunk 3; man example using a package export resolves; a genuine undefined in a
later chunk still flags. **Risk:** medium; investigation-gated.

## Workstream G — `.onLoad` bindings + `sysdata.rda` names (AST-first, R fallback) (62)
**Root cause:** internal objects from `R/sysdata.rda` (cli's `symbol`,
`spinners`, …) or created in `.onLoad()` are available to all package code.
**Decision (approved):** prefer STATIC extraction; do NOT hand-write a binary
RData parser. `sysdata.rda` is created by a call whose arguments are the object
names, so scan the source for it first and only fall back to R.
1. **AST-first — read the generating call:** scan the package source (notably
   `data-raw/**/*.R`, but anywhere not built) for the literal idioms that create
   internal data and take the named objects as sysdata symbols:
   - `usethis::use_data(a, b, internal = TRUE)` / `use_data(... internal = TRUE)`
     → `a`, `b` (only when `internal = TRUE`; without it the objects go to
     `data/`, which Workstream D already handles);
   - `save(a, b, file = ".../R/sysdata.rda")` and `save(list = c("a","b"),
     file = …)` → the listed names.
   Pure AST, no R, works in R-less CI. This covers GitHub-checkout sources
   (where `data-raw/` is present) — including ALL the triage's sysdata FPs
   (cli, googlesheets4, googledrive, lubridate are all GitHub sources).
2. **R fallback — only when AST finds nothing AND R is available:** CRAN
   tarballs strip `data-raw/` via `.Rbuildignore` (so the generating call is
   gone) but ship the built `R/sysdata.rda`. In that case run a single cached
   `e <- new.env(); load(<sysdata>, e); cat(ls(e), sep="\n")` through the
   existing `r_subprocess` metadata path (same carve-out as `.libPaths()` /
   `exportPattern`; `load()` restores objects, does not execute user functions).
   Cache by file digest. FAIL-SOFT: no R → unresolved (residue).
3. **`.onLoad`/`.onAttach` bindings via pure AST:** top-level `assign("x", …,
   envir=…)` and `ns$x <- …` / `topenv()$x <- …` inside those hooks bind `x`.
**Files:** `package_state`/source scan for the `use_data`/`save` extraction;
`package_library.rs`/`r_subprocess.rs` for the cached fallback; `cross_file/
scope.rs` for the `.onLoad` recognizer. **Tests:** `use_data(x, y, internal =
TRUE)` in `data-raw/` → `x`,`y` resolve (no R); `save(z, file="R/sysdata.rda")`
→ `z`; `use_data(d)` WITHOUT internal does NOT feed sysdata (it's `data/`);
`.onLoad` `assign`/`ns$` binds; R-fallback test (skip-gated) for a committed
`sysdata.rda` fixture with no generating script; absent everything is a no-op.
**Risk:** low for AST; low-medium for the gated fallback (reuses infra).

## Workstream H — Rmd chunk-extraction syntax artifacts (4–5)
**Root cause:** `dtplyr/vignettes/benchmark.R`, `tidyr` & `readxl` vignette Rmds
emit "missing `(`/`{`/unclosed `(`" — Raven's chunk/code extraction produces
malformed R for certain chunk shapes.
**Approach:** reproduce each, find the extraction bug (likely chunk-option or
inline-code handling), fix it so the reconstructed R parses. **Files:** chunk
extraction in `editors`/`cross_file` (locate via the failing files). **Tests:**
each offending chunk shape extracts to valid R. **Leave as known-FP:** rlang
`test-deparse.R` (3, intentionally malformed) — genuinely correct diagnostics on
deliberately-broken fixtures.

## Workstream I — small tail (8 + 2 + 3)
- **rlang `ffi_*` (8):** registered via `useDynLib`/`.Call` native routine
  registration at load. Investigate whether `useDynLib(pkg, .registration=TRUE)`
  symbol names are statically knowable; if not, this stays residue (document it).
- **lubridate `.Generic` (2):** extend the existing `.Generic`/`.Method`/`.Class`
  handling to the remaining S4 group-generic context. Likely a 1-line widening +
  test.
- **`.github/` file-not-found (3):** relative path resolved from a runtime CWD.
  Either exclude `.github/` from the proactive workspace scan or accept as
  known-FP. Decide during implementation; prefer excluding `.github/` (it is not
  package code).

---

## Orchestration & ordering
Workstreams are mostly independent but several touch `cross_file/scope.rs`
(A, C, D, E) and `package_state` (B, D, E, G). To avoid working-tree and
fixture conflicts, run in **sequenced** stages, re-measuring the corpus at the
checkpoints marked ★:

1. **A** (R6) — isolated recognizer.
2. **B** (importFrom) — package_state/namespace.
3. **C** (conditional defs) — scope model.
4. **D** (own datasets) ★ re-measure (overlaps F/E dataset refs).
5. **E** (dev-dir injection) ★ re-measure (overlaps F package-fn refs, D).
6. **F** (cross-chunk + man) ★ re-measure.
7. **G** (sysdata/.onLoad) — isolated new reader.
8. **H** (chunk extraction) — isolated.
9. **I** (tail) — isolated.
10. **Consolidated regen + verify**: rerun
    `RAVEN_CORPUS_GROUPS=base,recommended,tidyverse` (allow-unclassified) →
    regenerate `known_false_positives.toml` keeping only still-observed entries;
    confirm zero stale accepted-reals (all 187 across groups), zero
    'Cannot resolve path'; over-suppression guard (no accepted-real vanished in
    any group); strict mode passes.
11. **Docs**: `diagnostics.md` (R6 pronouns, conditional defs, sysdata/.onLoad
    awareness), `cross-file.md` (cross-chunk threading), `r-package-dev.md`
    (dev-dir + dataset visibility, importFrom-without-install). Update
    `limitations.md` with the honest residue (Workstream I `ffi_*`, truly
    dynamic cross-chunk/data-masked tail, cross-package datasets when the
    Suggested package isn't installed).
12. **Independent reviewer** APPROVES with full cargo + bun gates and the
    three-group strict mode.

Each workstream stage: implement (TDD) → fmt/clippy/`cargo test -p raven` green,
NO corpus run inside the stage except the ★ re-measures and the final regen.

## Expected residue (acceptable known-FPs after all workstreams)
- rlang `ffi_*` native routines (if `useDynLib` names aren't statically derivable).
- `R/sysdata.rda` names ONLY in the narrow case where the generating
  `use_data`/`save` call is absent from the source (e.g. a CRAN tarball with
  `data-raw/` stripped) AND R is unavailable. With either the source script or R
  present, they resolve via Workstream G.
- Cross-package datasets/symbols from Suggested packages that are NOT installed
  in the analysis environment.
- Genuinely dynamic cross-chunk/data-masked values that no ordered-concatenation
  model can resolve, and intentionally-malformed test fixtures (`test-deparse.R`).
- `.github/` runtime-CWD path cases if not excluded.
These remain documented known-FPs, not failures.

## Success criteria
The overwhelming majority of the 1463 tidyverse known-FPs resolve; the remainder
is a small, explicitly-documented residue. base+recommended not regressed; all
187 accepted-reals still fire; all gates + three-group strict mode green.
