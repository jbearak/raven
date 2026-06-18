# .Rprofile prelude & script-scope visibility design

Date: 2026-06-17
Status: Design (pre-implementation)
Motivating case: a "hybrid" repo (`~/repos/worldwide`) — a valid R package
(DESCRIPTION with `Package:`, NAMESPACE, functions in `R/`) whose actual work
lives in non-standard `scripts/` directories. A project-root `.Rprofile` does
`source("R/functions.r")` at startup, so every script runs with the package's
functions defined. Raven flagged an internal (non-exported) function `r.bind`,
used from `scripts/data/outcomes/abortions.r`, as an undefined variable.

## Summary

This spec combines two complementary pieces of work into one deliverable:

1. **Documentation** of the existing, correct visibility boundary: files
   outside a package's standard directories see the package only through
   `library()` / `load_all()` / `source()` / `# raven:` directives, and
   `library()` exposes only *exported* symbols. Today's docs assume the reader
   already knows the export/internal distinction; we make it explicit.

2. **A new feature** — model a workspace-root `.Rprofile` as a *script-scope
   prelude*: statically parse its top-level `source()`, `library()`/`require()`,
   and assignment statements and treat the resulting symbols as in scope for the
   files where R would actually have sourced `.Rprofile`. This closes the
   false-positive gap in the motivating case **without a per-file directive**,
   because modeling `.Rprofile` is exactly what R does at startup.

The two pieces ship together: the docs explain the boundary and the escape
hatches *today*; the feature removes the need for the manual escape hatch in the
most common hybrid layout.

## Background: the current behavior is correct

Raven activates package mode when the workspace root has a `DESCRIPTION` with a
parseable `Package:` field. In package mode, files outside `R/` get one-way read
access to package symbols only in the *standard* dev directories
(`demo/`, `data-raw/`, `vignettes/`, `man/`), tests, and `load_all()` scripts
(`is_dev_context_path` in `crates/raven/src/package_state/mod.rs`). `scripts/`
is deliberately not on that list.

This is sound and should not change:

- **It matches R.** Running `Rscript scripts/data/outcomes/abortions.r` in a
  clean session errors with "could not find function 'r.bind'". A `DESCRIPTION`
  at the root does not change that — `R CMD build`/`check`/`devtools` never load
  `scripts/`. The worldwide repo only works because its `.Rprofile` sources the
  functions first, which is a *runtime* convention, not a package fact.
- **The alternative is unsound.** Making `scripts/` a blanket dev-context dir
  would suppress *genuine* undefined-variable diagnostics for the far more
  common case: a standalone script that simply forgot its `library(pkg)`. That
  trades a true positive (fixable with one annotation) for a class of silent
  false negatives.
- **It matches the ecosystem.** `lintr::object_usage_linter` only resolves
  symbols when the package is installed or `load_all()`-ed; it does not follow
  `.Rprofile`/`source()` into `scripts/` either. Users live with this and file
  the same kind of complaints (lintr #482, #1127; the `box.linters` package
  exists to paper over cross-file resolution). Raven is consistent, not an
  outlier.

The gap is not in the rule; it is that (a) the docs assume knowledge the reader
may not have, and (b) the single most common hybrid layout — a project that
loads its helpers via `.Rprofile` — has no zero-config resolution path.

## Part A — Documentation

### Where

Add a new section to `docs/r-package-dev.md` titled **"Files outside the package
directories"** (placed after the dev-context/`load_all()` sections, before
"Build commands"). Cross-link it from the troubleshooting entry
"False positives persist…".

### Two mental models (state both explicitly)

Readers arrive with one of two models, and the doc should name both so the
reader can locate themselves:

- **"This is a real R package."** A diagnostic on a function used from
  `scripts/` is *correct and expected*: `scripts/` is not a package directory,
  `library()` exposes only exports, and `R CMD check` never runs `scripts/`.
- **"This is an analysis project that borrows package scaffolding"** (research
  compendia — `rrtools`, `rcompendium`, ropensci's `rrrpkg`; the worldwide
  case). Here the function genuinely *is* defined at runtime (via `.Rprofile`
  or a bootstrap `source()`), so the diagnostic reads as a false positive.

### The visibility table

Replace the implicit assumption with an explicit table. The three rows are R-
accurate (verified against *Writing R Extensions*, the `::`/`:::` help, and the
`pkgload`/`devtools` `load_all` reference) and match Raven's own behavior
(verified empirically — see "Validation" below):

| How a file outside the package dirs obtains your functions | What becomes visible |
|---|---|
| `library(yourpkg)` | **Only exported** symbols (`@export` / `NAMESPACE`). Requires the package installed. Internals need `yourpkg:::name`. |
| `devtools::load_all()` / `pkgload::load_all()` | **Exported and internal** `R/` symbols — `load_all()`'s `export_all = TRUE` default copies *all* objects into scope. This is why code can pass under `load_all()` but fail under `library()` / `R CMD check`. |
| `source("R/...")` | **All top-level definitions** become globals — there is no export concept; `source()` has nothing to do with packages. |
| A `# raven: source R/...` directive | Path-resolution equivalent of `source()` — Raven follows it (and its transitive `source()` chain) to bring those top-level defs into scope. |

### The `load_all` / `library` trap (call it out)

Add a short callout: the most common R packaging surprise is that
`devtools::load_all()` makes *internal* functions usable by bare name (default
`export_all = TRUE`), so code that "works in development" can fail under
`library()` or `R CMD check`. `@export` alone does **not** make a function
visible to a `scripts/` file — that file still needs `library()` (which exposes
only exports) or `load_all()`/`source()`/a directive.

### Worked recipe (the worldwide pattern)

Show the directive fix and note the forthcoming `.Rprofile` modeling:

```r
# raven: source R/functions.r      # at the top of a scripts/ file
```

> If your project loads its helpers via a workspace-root `.Rprofile` (e.g.
> `source("R/functions.r")`), Raven models that automatically — see
> "`.Rprofile` prelude" below. The directive remains available for projects
> that load functions some other way, or when `.Rprofile` modeling is disabled.

## Part B — `.Rprofile` prelude modeling

### User-visible behavior

When a workspace-root `.Rprofile` exists, Raven statically reads its top-level
statements and treats the symbols they introduce as in scope for the files where
R would have sourced `.Rprofile`. In the worldwide repo this means
`scripts/data/outcomes/abortions.r` resolves `r.bind` (and every other helper)
with **no directive**, because `.Rprofile` does `source("R/functions.r")` and
`R/functions.r` sources `R/r.bind.r`.

Concretely, the prelude contributes:

- Names assigned at top level in `.Rprofile` (`x <- ...`, `x = ...`,
  `x <<- ...`, and `assign("x", ...)` with a literal name).
- Packages attached by top-level `library(pkg)` / `require(pkg)` — their exports
  become available by bare name (same machinery as helper-file `library()`
  attachment already used under `tests/testthat/`).
- Top-level defs reachable through `source("path")` calls in `.Rprofile`, when
  the path is a static literal — resolved with Raven's existing path resolution
  and workspace-root fallback, and followed transitively through the resulting
  files' own `source()` calls.

### R-fidelity grounding

This is not a heuristic; it mirrors R's startup. Per R's `?Startup`: after
`.Renviron` and the site profile, R sources the user profile — `R_PROFILE_USER`,
else `./.Rprofile` (current directory), else `~/.Rprofile` — **first match
wins**. In the canonical project workflow (RStudio Projects, or `R`/`Rscript`
launched from the project root), `./.Rprofile` is the project file, and it runs
before any script. The symbols it defines are exactly what an interactive
session or a from-root `Rscript` sees. Modeling them statically reproduces what
the live-session tools (RStudio, Positron/Ark) get "for free" by executing the
profile — without executing anything.

### Core constraints (non-negotiable)

1. **Static parse only — never execute.** `.Rprofile` is arbitrary R that may do
   network/file/destructive I/O. Parse the AST; extract only top-level
   `library`/`require`, top-level assignments with literal names, and top-level
   `source()` of literal paths. Never `eval`. (Consistent with the
   `r_subprocess` safety discipline.)

2. **Additive / suppressive only — never generate new diagnostics.** The prelude
   may *suppress* "undefined variable" false positives and *enrich* completion /
   hover. It must never *introduce* a diagnostic. This makes the unavoidable
   cwd-dependence unsoundness fail safe: if `.Rprofile` would not actually run
   for some invocation (e.g. `Rscript subdir/x.R` from elsewhere), the worst case
   is Raven stays quiet about a symbol, never that it fabricates an error.

### Applicability rule (which files get the prelude)

The prelude applies to files whose realistic execution context is one where R
sources `.Rprofile` (interactive / `Rscript`-from-root), and is withheld from
files whose canonical execution context is a clean, profile-suppressed session
driven by `R CMD check` / `build`. R's `?Startup` is explicit that
`R CMD check`/`build` "do not always read the standard startup files," and
`devtools` suppresses the user profile in its child processes — so a symbol that
only exists because of `.Rprofile` is a genuine bug in those contexts, and
masking it would cause CI/CRAN failures.

**Withhold the prelude from** (in package mode):

- `R/*.R` — loaded into the package namespace via `loadNamespace`; `.Rprofile`
  is not sourced then.
- Test files — `tests/testthat/`, `tests/testit/`, plain `tests/*.R`, and
  installed suites `inst/tinytest/` / `inst/unitTests/`. Run under
  `R CMD check` / `devtools::test()` with the profile suppressed.
- Built/checked dev dirs — `vignettes/`, `man/` examples, `demo/`. Rebuilt by
  `R CMD build` / run by `R CMD check`.

**Apply the prelude to** everything else under the workspace, including the
package-mode non-standard locations:

- `scripts/` (the motivating case), `data-raw/` (dev-only, `.Rbuildignore`d,
  run interactively from root), plain `inst/` scripts, `tools/`, `debug/`,
  arbitrary dirs, and all files in **script mode**.

#### The exclusion is gated on package mode, not on the `R/` path

This is the load-bearing correction. The justification for withholding the
prelude is namespace / `R CMD check` semantics, which **only exist in package
mode**. When the workspace is *not* in package mode (no `DESCRIPTION` with
`Package:`, or `raven.packages.packageMode: "disabled"`), a directory named
`R/` is just a directory of scripts — there is no namespace, nothing runs it
under `R CMD check`, and `.Rprofile` *is* sourced before running those files
from the root. So in script mode the prelude applies to `R/` like any other
directory. Gate the exclusion on the active package-mode flag, not on the path.

#### The tests asymmetry (why this rule is principled, not arbitrary)

A test file *keeps* its existing one-way package-`R/` visibility but does **not**
receive the `.Rprofile` prelude. That is not inconsistent — it tracks what is
actually loaded when the test runs:

- Under `devtools::test()` / `R CMD check`, the package **is** loaded (so `R/`
  symbols are real → Raven shows them) but `.Rprofile` is **not** sourced (so
  `.Rprofile` symbols are not real → Raven must not show them).
- For a `scripts/` file the reverse holds: `.Rprofile` **is** sourced (→ prelude
  applies) but the package is **not** auto-loaded (→ the file still gets nothing
  from `R/` unless it calls `library()`/`load_all()`/`source()`).

The single rule is "model what is in scope in this file's real run context,"
applied consistently in both directions.

### What to skip / be careful about

- **renv.** `renv::init()` writes a `.Rprofile` whose entire content is often
  just `source("renv/activate.R")`, which defines no user-facing globals (it
  manipulates the library path via internal machinery). Recognize the
  `renv/activate.R` path and do **not** follow it for symbol extraction; do not
  error if it is missing. Other statements layered after the renv line are the
  interesting ones.
- **Match Raven's normal scope construction.** Harvest the names `.Rprofile`
  introduces using the same top-level scope extraction Raven already applies to
  any script (its `top_level_defs`). That deliberately *includes* names assigned
  inside top-level control flow: `if (cond) a <- 1 else a <- 2` binds `a` either
  way, and `if (interactive()) x <- ...` binds `x` in exactly the interactive
  sessions this feature targets. Harvesting them is both consistent with how
  Raven scopes every other file (diverging would be surprising) and fail-safe
  under the suppressive-only rule — over-harvesting can only suppress a false
  positive, never fabricate one. Assignments inside *function bodies* are local
  and are not harvested, again identical to Raven's normal scoping. The only
  static restriction is on `source()` / `library()` *arguments*: follow them only
  when the path/package is a literal (a dynamic `source(paste0(...))` cannot be
  resolved statically).
- **`source()` following budget.** Follow `source()` only for static literal
  paths, reusing the existing path-resolution + workspace-root fallback. Bound
  recursion using the existing cross-file traversal budgets so a profile that
  sources a large helper tree cannot blow up indexing.
- **Project `.Rprofile` only.** Model the workspace-root `.Rprofile`, never
  `~/.Rprofile` (machine-specific, non-portable, and shadowed by a project file
  when one exists).

### Architecture / integration points

The feature plugs into existing machinery; no new subsystem is required. (Line
numbers are as of this writing; navigate by symbol.)

- **Detection & read at startup.** Read the workspace-root `.Rprofile` when
  package/workspace inputs are first assembled, mirroring how DESCRIPTION /
  NAMESPACE are parsed and how `scan_own_package_data_dir`
  (`crates/raven/src/package_state/mod.rs`) scans `data/`. Parse the AST with the
  existing tree-sitter pipeline and extract the prelude symbols + attached
  packages + resolved `source()` targets.
- **Carry the symbols.** Add an `rprofile_symbols` set (and an attached-packages
  set) to the package/scope contribution struct (`PackageScopeContribution` in
  `crates/raven/src/package_state/`), alongside the existing
  `r_internal_symbols`, `imported_symbols`, `test_helper_symbols`, etc.
- **Inject.** Merge the prelude symbols at the same Phase 5a injection site where
  `load_all()` internals already merge — `append_package_contribution`
  (`crates/raven/src/cross_file/scope.rs`, ~`6865`; called ~`6646`) — guarded by
  the applicability rule above (apply unless the file is a namespace/test/built-
  dir file in package mode). Attached packages from `.Rprofile` go through the
  same path that helper-file `library()` attachment already uses.
- **Watch for revalidation.** Add `.Rprofile` to the watched-file set next to
  DESCRIPTION / NAMESPACE (`crates/raven/src/package_state/event.rs`) so editing
  it re-triggers diagnostics, with a `PackageInputDelta::RProfileChanged`-style
  delta. The interface hash must include the prelude inputs so dependents
  revalidate on a `.Rprofile` edit.

### Configuration

Add a setting, default on:

| Setting | Default | Description |
|---|---|---|
| `raven.packages.modelRprofile` | `true` | Model a workspace-root `.Rprofile`'s top-level `source()`/`library()`/assignments as a script-scope prelude. |

Wire it through all three places required for an LSP-exposed setting:
`editors/vscode/package.json`, `editors/vscode/src/initializationOptions.ts`,
and `SETTINGS_MAPPING` in `editors/vscode/src/test/settings.test.ts`; then
regenerate the settings reference
(`bun editors/vscode/scripts/generate-settings-reference.mjs`). Document under
"Configuration" in `docs/r-package-dev.md` and in the settings reference.

### Prior art

No static R tool does this today: REditorSupport/languageserver reads
`.Rprofile` only for its own `options(languageserver.*)` config, not for
symbols; lintr does not follow it (hence the false-positive complaints); Air is a
formatter. The live-session tools (RStudio, Positron/Ark) recognize `.Rprofile`
symbols only because R actually executed the profile in the session. The closest
precedent for "init-defined implicit globals" in an LSP is lua-language-server's
`diagnostics.globals` / runtime presets — declared, not executed. A *static*
prelude model is mildly novel for R but defensible given the constraints above,
and it closes exactly the gap lintr is repeatedly criticized for.

## Validation (already performed)

Empirically confirmed with the prebuilt binary against a temp package
(`Package: testpkg`, `NAMESPACE` exporting only `foo`, `R/foo.R` defining `foo`
plus internal `bar`), and against the motivating repo:

- `devtools::load_all()` / `pkgload::load_all()` in a non-`R/` script → both
  `foo` and `bar` resolve (`0 issues`). Confirms the "exported and internal" row.
- `# raven: source ../R/foo.R` → all top-level defs resolve. Confirms the
  directive row.
- In worldwide: adding `# raven: source R/functions.r` to a `scripts/` file
  takes it from 14 issues (incl. `r.bind` undefined) to **0 issues**; removing it
  brings the diagnostics back. Confirms causation and the directive recipe.

(`library(testpkg)` against a not-installed package could not be exercised
end-to-end; the "exports only" semantics are authoritative from *Writing R
Extensions* and the `::`/`:::` help.)

## Acceptance tests

Targets for the implementation plan (script-mode and package-mode fixtures):

1. **Resolution via `.Rprofile` source().** Workspace with root `.Rprofile`
   doing `source("R/functions.r")`, a `scripts/foo.R` using a function defined
   in `R/functions.r` → no undefined-variable diagnostic.
2. **Resolution via `.Rprofile` assignment.** `.Rprofile` with `my_helper <-
   function() {}`; a `scripts/foo.R` calling `my_helper()` → no diagnostic.
3. **Resolution via `.Rprofile` library().** `.Rprofile` with `library(stringr)`;
   `scripts/foo.R` using `str_to_sentence()` → no diagnostic.
4. **Package-mode exclusion — `R/`.** Package mode, `.Rprofile` defines `zz`;
   `R/uses_zz.R` references `zz` → diagnostic **still fires** (namespace files do
   not get the prelude).
5. **Package-mode exclusion — tests.** Same `.Rprofile`; `tests/testthat/test-x.R`
   references `zz` → diagnostic **still fires**.
6. **Script-mode `R/` inclusion.** Workspace with **no** `DESCRIPTION` (or
   `packageMode: "disabled"`), `.Rprofile` defines `zz`, `R/uses_zz.R` references
   `zz` → **no** diagnostic (R/ is ordinary scripts here).
7. **renv no-op.** `.Rprofile` containing only `source("renv/activate.R")` →
   no crash, no spurious symbols, and a genuinely undefined variable in a script
   still flags.
8. **No fabricated diagnostics.** Removing `.Rprofile` never *adds* a diagnostic
   that was absent with it (suppressive-only invariant).
9. **Live update.** Editing `.Rprofile` (adding/removing a def) revalidates
   dependent scripts at the next version without an editor restart.
10. **`raven check` parity.** All of the above hold under `raven check`, not just
    the editor.
11. **Conditional top-level assignment.** `.Rprofile` with
    `if (interactive()) helper <- function() {}` (or an `if/else` binding the
    same name on both branches); a `scripts/foo.R` calling `helper()` → no
    diagnostic, matching Raven's normal conditional-assignment scoping.

## Out of scope / follow-ups

- `~/.Rprofile` (user-home) modeling — non-portable; explicitly excluded.
- Modeling `Rprofile.site` / `.Renviron`.
- Executing `.Rprofile` or any dynamic evaluation.
- `Collate:`-style ordering of prelude `source()` targets.
- Branch-sensitive scope (e.g. treating `if (interactive())` bodies as
  interactive-only). We deliberately do *not* do this: prelude assignments are
  harvested unconditionally, matching Raven's normal scope construction.

## Resolved decisions

1. **`vignettes/` / `man/` / `demo/` exclusion** — **excluded** along with `R/`
   and tests. They fail on a clean CRAN build just like tests, so masking a
   `.Rprofile` symbol there would hide a real failure.
2. **Conditional / `if (interactive())` assignments** — **harvested
   unconditionally**, using Raven's normal top-level scope construction. Skipping
   them would (a) emit false positives for names that are in fact bound on every
   branch (`if (cond) a <- 1 else a <- 2`), and (b) diverge from how Raven scopes
   every other file. Suppressive-only makes over-harvesting safe.
3. **Default on vs. off** — **default `true`**. The feature is suppressive-only
   and matches R startup semantics.
4. **Attached-package scope** — `.Rprofile` `library()` attachments follow the
   **same applicability rule as symbols** (apply to script-mode files and to
   package-mode non-namespace/non-test/non-built-dir files; withhold from `R/` in
   package mode, tests, and built dirs).
