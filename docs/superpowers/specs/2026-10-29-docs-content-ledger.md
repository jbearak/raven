# Docs redesign: content-preservation ledger

Base: `6c7871aac52a75305cb9996412e905e7524618a0`. One row per H2/H3 section at the base commit. Disposition is one of: **kept**, **moved** (destination `page#anchor`), **internal** (moved to development.md), or **duplicate** (destination is the surviving home). Nothing is dropped unless it is a duplicate or internal.

## Batch A: README.md, editors/vscode/README.md, and new pages

### README.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Intro paragraphs (scope model, NSE, R session features, editors, status, Sight) | moved | Tagline and tested demo at the top; NSE pointer moved to the "What you get" bullet; status line to Documentation; Sight kept |
| Features (`#features`) | kept | "What you get" (`<a id="features">`) |
| Code intelligence (`#code-intelligence`) | kept | "Analysis" and "Navigation and editing" groups (`<a id>` kept); JAGS/Stan anchors kept |
| R session integration (`#r-session-integration`) | kept | "R session (VS Code)" group (`<a id>` kept) |
| How Raven Differs (`#how-raven-differs`) | kept | "Why static analysis" (`<a id>` kept), four one-sentence bullets; full rationale single-homed in comparison.md#why-raven-exists |
| Coexistence paragraphs under How Raven Differs | duplicate | coexistence.md (single home of `raven.rConsole.activation`), linked from "Works with your setup" |
| Installation (`#installation`) | kept | Installation |
| Editors (`#editors`) | kept | Installation bullets; `<a id="editors">` kept |
| Command line (`#command-line`) | kept | Command line |
| CI (`#ci`) | moved | One line + link to ci.md (`<a id="ci">` kept) |
| Documentation (`#documentation`) | kept | Documentation, now pointing at the hub (docs/README.md) |
| Development (`#development`) | kept | One line to development.md (`<a id="development">` kept) |
| Provenance (`#provenance`) | kept | Verbatim |
| License (`#license`) | kept | Verbatim |

### editors/vscode/README.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Intro paragraphs | kept | Rewritten lead; same demo as the root README; "Works with vscode-R and Positron" |
| Features (`#features`) | kept | "What you get", identical link set to the root README (readme-parity test) |
| Code intelligence (`#code-intelligence`) | kept | `<a id>` kept |
| R session integration (`#r-session-integration`) | kept | `<a id>` kept; the stale "supports R, arf, and radian" console line corrected to match r-console.md |
| Settings (`#settings`) | kept | "Settings and documentation", links settings-reference.md (`<a id>` kept) |
| Coexistence with vscode-R and Positron (`#coexistence-with-vscode-r-and-positron`) | kept | "Works with vscode-R and Positron" (`<a id>` kept); details in coexistence.md |
| More Information (`#more-information`) | kept | "Settings and documentation" (`<a id>` kept) |
| License (`#license`) | kept | |

### New pages

getting-started.md, coming-from.md, troubleshooting.md, and faq.md are new. They link to existing content and introduce no behavior claims that aren't stated on the linked pages, except the troubleshooting log instructions (`raven.trace.server`, the Raven output channel, `RUST_LOG`), which were checked against `editors/vscode/src/extension.ts` and `crates/raven/src/main.rs`.

## Batch B

### docs/diagnostics.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Quick Reference (`#quick-reference`) | kept | Recipes table `## Common fixes`, `<a id="quick-reference">`. All eight bullets kept as rows. |
| Diagnostic codes (`#diagnostic-codes`) | kept | `## Diagnostic codes` index table (code, default severity, suppressible, setting), then one `###` per code. Selector no-op rule moved to `#silence-one-code`. Lint-code sentence moved to `#style-lints`. |
| Suppressing diagnostics (`#suppressing-diagnostics`) | kept | Merged with `## Suppression` into the single `## Suppressing diagnostics` home. `expect` text in `#get-told-when-a-suppression-goes-stale`. Full ignore syntax (line, selector, file/block, expect) and the lintr suppression matrix are now here too (were in directives.md and linting.md). |
| Diagnostic Categories (`#diagnostic-categories`) | kept | `<a id>` on `## Diagnostic codes`; each category became its code's section. |
| &nbsp;&nbsp;Parse Errors (`#parse-errors`) | kept | `#syntax-error` (`<a id="parse-errors">`); message table in its `<details>`; chained comparison row became `### chained-comparison`. |
| &nbsp;&nbsp;JAGS and Stan Parse Errors (`#jags-and-stan-parse-errors`) | kept | Use-it summary in `### JAGS and Stan` (`#jags-and-stan`); exact rules in `## Details` › `### JAGS and Stan parse errors` (heading keeps the slug) with `<details>`. Exit-code and "settings don't disable registration" paragraphs in `#jags-and-stan`. |
| &nbsp;&nbsp;Stan Undeclared Variables (`#stan-undeclared-variables`) | kept | `## Details` › `### Stan undeclared variables` (heading keeps slug); exact scoping rules in `<details>`. Bound example `diag-stan-undeclared-variable`. |
| &nbsp;&nbsp;Undefined Variables (`#undefined-variables`) | kept | `### undefined-variable` (`<a id="undefined-variables">`). "What suppresses it" + runtime-binding list + load_all + Windows builtins in `<details>` "What counts as a definition". "Never checked" kept in body. Call-arguments, magrittr, Shiny, foreach, targets subsections each in their own `<details>` with their legacy `<a id>`. Opt-out settings in **Setting**. `# raven: nse` + NSE footer paragraph in call-arguments `<details>`. NSE **Limitations** paragraph split: data.table / `:=` / `let()` caveats to `## Limitations`; the policy-table coverage catalogue moved to non-standard-evaluation.md (staged in `moves/non-standard-evaluation.md`). |
| &nbsp;&nbsp;Package Diagnostics (`#package-diagnostics`) | kept | Table rows became `### package-not-installed` (`<a id="package-diagnostics">`), `### package-outside-active-library`, `### namespace-member-not-found`. |
| &nbsp;&nbsp;Package names vs. install status (`#package-names-vs-install-status`) | kept | `## Details` › `### Package names vs. install status` (slug kept). Per-mode table kept with `<a id="per-mode-behavior">`. renv-outside-library paragraph moved into `package-outside-active-library` `<details>`. Accepted gap moved to `## Limitations` bullet with `<a id="accepted-gap">`. |
| &nbsp;&nbsp;Namespace member references (pkg::member) (`#namespace-member-references-pkgmember`) | kept | `### namespace-member-not-found` (`<a id>`), completeness rules in `<details>`. Issue #503/#505 references reworded as user behavior ("appears after background loading … including in other open documents"; "a precise check for data members is planned"). |
| &nbsp;&nbsp;Cross-File Diagnostics (`#cross-file-diagnostics`) | kept | Table split: missing file → `### unresolved-source-path`; case mismatch → `### source-path-case-mismatch` (subsection "Source path case mismatch" in `<details>`); circular/max-depth/redundant → `### Circular dependency, chain depth, and redundant directives` (`<a id="cross-file-diagnostics">`); out-of-scope → `undefined-variable` (it carries that code). Optional-source guard paragraph in `unresolved-source-path`. Non-suppressibility in each section and the suppression intro. |
| &nbsp;&nbsp;Assignment Targets (`#assignment-targets`) | kept | `### assign-to-string-literal` (`<a id="assignment-targets">`); tier table kept; "Not flagged" list in `<details>`. |
| &nbsp;&nbsp;Semantic Warnings (`#semantic-warnings`) | kept | `### mixed-logical` (`<a id="semantic-warnings">`) and `### condition-assignment`; suppression and settings in each. |
| &nbsp;&nbsp;Style Lints (`#style-lints`) | kept (condensed) | `### Style lints`: master switch, 18 rules, information default, `raven (lint)` source, code table linking each linting.md rule section. The per-rule trigger prose, infix-spaces, commented-code, and object-name paragraphs/NOTE are duplicates of linting.md `#infix-spaces`, `#commented-code`, `#object-names` (linting.md is more detailed). Lint suppression bullets merged into `#suppressing-diagnostics`. |
| Suppression (`#suppression`) | duplicate | Merged into `#suppressing-diagnostics`; `<a id="suppression">` on it. |
| &nbsp;&nbsp;Per-Line: # raven: ignore (`#per-line--raven-ignore`) | kept | `### Silence a line` with `<a id="per-line--raven-ignore">`. |
| &nbsp;&nbsp;Per-Symbol: Declaration Directives (`#per-symbol-declaration-directives`) | kept | `### Declare a symbol instead` with `<a id>`. |
| &nbsp;&nbsp;Per-Category: Configuration (`#per-category-configuration`) | kept | `### Turn a category off` with `<a id>`; JSON snippet wrapped in `{}` so it parses. |
| Cross-File Behavior (`#cross-file-behavior`) | kept | `### When dependencies change` under `## What you see`, `<a id="cross-file-behavior">`. |
| JAGS and Stan (`#jags-and-stan`) | kept | `### JAGS and Stan` under `## Diagnostics in other file types` (slug kept); merged with the use-level JAGS/Stan text. |
| R Markdown and Quarto (`#r-markdown-and-quarto`) | kept | `### R Markdown and Quarto` (slug kept). |
| &nbsp;&nbsp;Parameterized reports (params) (`#parameterized-reports-params`) | kept | `#### Parameterized reports (params)` (slug kept). |

#### Corpus examples created

`diag-undefined-variable`, `diag-syntax-error`, `diag-chained-comparison`, `diag-unresolved-source-path`, `diag-box-module-not-found`, `diag-box-export-not-found`, `diag-import-module-not-found`, `diag-assign-to-string-literal`, `diag-mixed-logical`, `diag-condition-assignment`, `diag-unused-suppression`, `diag-circular-dependency`, `diag-redundant-directive`, `diag-stan-undeclared-variable` (own `raven.toml`), `diag-jags-syntax-error` (own `raven.toml`), plus for cli.md: `usage-error`, `version`, `check-help`, `check-json`, `exit-on-errors-only`.

#### Exempt codes

| Code | Reason |
|---|---|
| `source-path-case-mismatch` | Severity is host-derived (info on macOS, warning on Linux), so output differs between contributors and CI. |
| `box-module-case-mismatch` | Message contains absolute paths. |
| `import-module-case-mismatch` | Message contains absolute paths; severity host-derived. |
| `import-export-not-found` | Needs a package export snapshot; examples run with packages disabled. |
| `package-not-installed` | Needs a configured R library (and `raven check` hides it by default). |
| `package-outside-active-library` | Needs an renv project plus an outside library. |
| `namespace-member-not-found` | Needs package export metadata; with packages disabled even `base::nosuchthing` is silent. |
| Max chain depth exceeded | `raven check` with `crossFile.maxChainDepth = 2` on a 4-file chain printed only a stderr note, no diagnostic; not shown. |
| Out-of-scope `undefined-variable` | Not given its own example; see the possible duplicate-report bug in the final report. |

## Batch C

### docs/cross-file.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) Cross-File & Package Awareness (`#cross-file--package-awareness`) | kept | H1 is now "Cross-file analysis"; legacy slug as inline `<a id>` at the end of the lead. New bound example `cross-file-source-order`. |
| How It Works (`#how-it-works`) | kept | `## How it works` (slug unchanged). |
| Automatic source() Detection (`#automatic-source-detection`) | kept | `## Automatic source() detection` (slug unchanged) is now a "you write → Raven does" table. Exact rules for `system.file()`, computed-path folding (incl. `readLines` handling), optional `file.exists()` guards, `list.files()` loops, `local`/`chdir`/`sys.source()`, and `local = TRUE` are in `## Details` › `### How Raven reads source() calls`, one `<details>` each. Issue #638 reference dropped. The debug-log/no-editor-hint rationale for list.files is condensed to user behavior (detail in dev-moves). |
| &nbsp;&nbsp;Shiny application loading (`#shiny-application-loading`) | kept | `## Details` › `### Shiny application loading` (slug unchanged); summary paragraph plus `<details>` with every layout rule. Watch-root internals reworded as user behavior. |
| &nbsp;&nbsp;R Markdown / Quarto chunks (`#r-markdown--quarto-chunks`) | kept | Same heading under `## Automatic source() detection`, split into two paragraphs. |
| Package Awareness (`#package-awareness`) | kept | `## Package awareness` (slug unchanged). p_load paragraphs moved to `## Details` › `### pacman::p_load()` `<details>`. TIP and .Rprofile pointer kept. |
| &nbsp;&nbsp;How It Works (`#how-it-works-1`) | kept | `<a id="how-it-works-1">` on the "When you write library(dplyr)" list inside `## Package awareness` (duplicate heading removed). |
| &nbsp;&nbsp;When Raven calls R (`#when-raven-calls-r`) | kept | `## Details` › `### When Raven calls R`. |
| &nbsp;&nbsp;Resolving exports without R (`#resolving-exports-without-r`) | kept | `## Details` › `### Resolving exports without R`. "Tier 1/2/3" labels replaced by "installed packages / repo database / names.db"; every fact kept. |
| &nbsp;&nbsp;Base Packages (`#base-packages`) | kept | `## Details` › `### Base packages`. LazyData and `data()` rules in two `<details>`. The parent-file `data()` scope-limit blockquote moved to `## Limitations` (bullet). |
| &nbsp;&nbsp;devtools::load_all() — Virtual Attached Package (`#devtoolsload_all--virtual-attached-package`) | kept | `## Details` › `### devtools::load_all() as an attached package` with `<a id>` for the legacy slug (heading em dash removed). |
| &nbsp;&nbsp;Position-Aware Loading (`#position-aware-loading`) | kept | Same heading under `## Package awareness`. |
| &nbsp;&nbsp;Function-Scoped Loading (`#function-scoped-loading`) | kept | Same heading under `## Package awareness`. |
| &nbsp;&nbsp;Meta-Package Support (`#meta-package-support`) | kept | Same heading; one-line pointer to Availability vs. ownership added. |
| &nbsp;&nbsp;Availability vs. ownership (`#availability-vs-ownership`) | kept | `## Details` › same heading. |
| &nbsp;&nbsp;Cross-File Package Propagation (`#cross-file-package-propagation`) | kept | Same heading under `## Package awareness`. |
| &nbsp;&nbsp;Supported Call Patterns (`#supported-call-patterns`) | kept | Same heading and table; rows link to the Details sections. Base-package list surfaced here as one line. |
| &nbsp;&nbsp;Apply-Family Loads (`#apply-family-loads`) | kept | `## Details` › same heading; vector and `assign()` destination rules in `<details>`. |
| &nbsp;&nbsp;Deterministic Package-Loader Loops (`#deterministic-package-loader-loops`) | kept | `## Details` › same heading; loop rules in `<details>`. |
| &nbsp;&nbsp;targets::tar_option_set() Worker Packages (`#targetstar_option_set-worker-packages`) | kept | `## Details` › same heading; "Details:" bullets in `<details>`. |
| &nbsp;&nbsp;targets::tar_source() Scripts (`#targetstar_source-scripts`) | kept | `## Details` › same heading; three `<details>` (calls/order, live updates, scripts run in more than one batch). URI-keyed graph / `PathContext` wording reworded as user behavior; internals to dev-moves. Also a `## Limitations` bullet. |
| &nbsp;&nbsp;tarchetypes target factories and report documents (`#tarchetypes-target-factories-and-report-documents`) | kept | `## Details` › same heading; H4s `static-target-declarations`, `static-tar_map-names`, `connected-r-markdown-and-quarto-documents` kept as headings. Revalidation/target-authority paragraph in `<details>`, reworded as "rechecks". |
| &nbsp;&nbsp;Keeping Packages in Sync (`#keeping-packages-in-sync`) | kept | Same heading under `## Package awareness`; watcher settings also in `## Settings`. |
| Module & import systems (`#module--import-systems`) | kept | Same H2, short pointer to modules.md. |
| NSE directive propagation (`#nse-directive-propagation`) | kept | Same H2 (use-it summary). The graph/path/revalidation/precedence paragraph moved to `## Details` › `### How NSE declarations propagate` `<details>`; "revalidation-consistent neighborhood" restated as "ancestors and everything they or the file source". |
| Self-contained sourced files (# raven: self-contained) (`#self-contained-sourced-files--raven-self-contained`) | kept | Same H2, condensed to three paragraphs; full semantics stay in directives.md. |
| Position-Aware Scope (`#position-aware-scope`) | kept | `## Where symbols become visible` › `### Position-aware scope`; one-paragraph `local = TRUE` summary added linking Details. |
| Symbol Recognition (`#symbol-recognition`) | kept | Under `## Where symbols become visible`. |
| &nbsp;&nbsp;Symbol Removal (rm/remove) (`#symbol-removal-rmremove`) | kept | Same slug ("Symbol removal (`rm`/`remove`)"). |
| How This Feeds Into Features (`#how-this-feeds-into-features`) | kept | Same H2; Go to definition and Hover now linked. |
| Advanced (`#advanced`) | kept | `<a id="advanced">` at the top of `## Details`. |
| &nbsp;&nbsp;Backward Dependency Modes (`#backward-dependency-modes`) | kept | Moved up to `## When Raven can't see the link` › same heading (task-oriented). |
| &nbsp;&nbsp;Open buffers, disk state, and closing files (`#open-buffers-disk-state-and-closing-files`) | kept | `## Details` › same heading; alias-aware open-buffer paragraph split into bullets in `<details>`; Rmd language-memory paragraph in its own `<details>`. Canonicalization rationale condensed (dev-moves). |
| &nbsp;&nbsp;Traversal budgets in large workspaces (`#traversal-budgets-in-large-workspaces`) | kept | `## Details` › same heading; budgets also in `## Settings`. |
| &nbsp;&nbsp;Path Resolution (`#path-resolution`) | kept | Promoted to `## Path resolution` (use-it): three base rules + two pointers. Exact rules: `## Details` › `### Implicit testthat/testit working directory` (`#implicit-testthattestit-working-directory`) and `### Case-only mismatches` (`#case-only-mismatches`), slugs unchanged. The intro "Case-only filename mismatches" paragraph from Automatic source() Detection merged into `### Case-only mismatches`. |
| &nbsp;&nbsp;Global Symbol Hoisting (`#global-symbol-hoisting`) | kept | Moved to `## Where symbols become visible` › same heading; settings-reference link added. |
| &nbsp;&nbsp;$ and @ Member Resolution (`#-and--member-resolution`) | kept | `## Details` › "`$` and `@` member resolution" (slug unchanged). |
| (new) Settings, Limitations, See also | added | Settings table links settings-reference.md. Limitations collects: dynamic paths, lapply/sapply/walk source idioms, lexical folding, data() alias expansion in backward children (was a blockquote), tar_source multi-run,. |

### docs/directives.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (new) summary table | added | One row per directive family linking its section. |
| General Syntax (`#general-syntax`) | kept | Same heading; `self-contained` added to the header-only list (its own section already said header-only). |
| Forward Directives (`#forward-directives`) | kept | Same heading. Path resolution now names the workspace-root fallback and links cross-file.md#path-resolution; redundant-directive pointer added. |
| Backward Directives (`#backward-directives`) | kept | Same heading. `assumeCallSite` now spelled as `raven.crossFile.assumeCallSite` (default `"end"`); case-leniency/no-fallback note added with link. |
| Working Directory Directives (`#working-directory-directives`) | kept | Same heading; one sentence added that a cd disables the workspace-root fallback and overrides the implicit testthat WD (both from cross-file.md). |
| &nbsp;&nbsp;Working Directory Inheritance (`#working-directory-inheritance`) | kept | Same heading. |
| Self-Contained Sourced Files (`#self-contained-sourced-files`) | kept | Same heading; "backward parent-prefix walk / canonical caller-independent inputs" reworded as "scope depends only on the file and the files it sources". |
| Declaration Directives (`#declaration-directives`) | kept | Same heading. |
| &nbsp;&nbsp;Variable Declarations (`#variable-declarations`) | kept | Same heading. |
| &nbsp;&nbsp;Function Declarations (`#function-declarations`) | kept | Same heading. |
| &nbsp;&nbsp;NSE Declarations (`#nse-declarations`) | kept | Same heading; qualified/unqualified override rules as bullets. "synchronous diagnostic pass" reworded as "Raven's diagnostics know export names but not formals". H4s `-raven-nse-is-deliberately-coarse` and `-raven-nse-propagates-across-the-source-graph` kept with their text; propagation precedence rules as bullets. |
| &nbsp;&nbsp;Position-Aware Behavior (`#position-aware-behavior`) | kept | Same heading. |
| &nbsp;&nbsp;Cross-File Inheritance (`#cross-file-inheritance`) | kept | Same heading. |
| &nbsp;&nbsp;Use Cases (`#use-cases`) | kept | Same heading. |
| Ignore Directives (`#ignore-directives`) | duplicate | Single home is diagnostics.md#suppressing-diagnostics (per moves/directives.md). Now a short table of forms linking each diagnostics.md anchor; Stan note is a one-line pointer to diagnostics.md#stan-undeclared-variables. |
| &nbsp;&nbsp;Line and next-line (`#line-and-next-line`) | duplicate | Table row with `<a id>` → diagnostics.md#per-line--raven-ignore. |
| &nbsp;&nbsp;Per-code selector (`#per-code-selector`) | duplicate | Table row with `<a id>` → diagnostics.md#silence-one-code. |
| &nbsp;&nbsp;File and block forms (`#file-and-block-forms`) | duplicate | Table row with `<a id>` → diagnostics.md#silence-a-block-or-a-whole-file. |
| &nbsp;&nbsp;expect — assert that a suppression is used (`#expect--assert-that-a-suppression-is-used`) | duplicate | Table row with `<a id>` → diagnostics.md#get-told-when-a-suppression-goes-stale. |
| &nbsp;&nbsp;Chunk-level suppression (R Markdown / Quarto) (`#chunk-level-suppression-r-markdown--quarto`) | duplicate | Table row with `<a id>` → chunks.md#suppressing-diagnostics-in-a-chunk. |

### docs/non-standard-evaluation.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (lead + examples) | kept | New bound example `nse-data-mask` (with() + paste typo) first; the dplyr/ggplot2/select examples kept; the old `with()` example replaced by the bound one. |
| What Raven Checks (`#what-raven-checks`) | kept | Same heading. |
| How Raven Recognizes NSE (`#how-raven-recognizes-nse`) | kept | Same heading. |
| When Raven Needs a Hint (`#when-raven-needs-a-hint`) | kept | Same heading. |
| Declaring NSE From a Package (`#declaring-nse-from-a-package`) | kept | Same heading. |
| &nbsp;&nbsp;Declaring data.table-style [ semantics (`#declaring-datatable-style--semantics`) | kept | Same heading; exact limits (bare-name gating, data.frame family, setDF/setattr, `[[`, size limits, data.table built in, schema note) in one `<details>`. |
| Choosing the Right Escape Hatch (`#choosing-the-right-escape-hatch`) | kept | Same heading; first three paragraphs became a table; broad opt-out paragraph kept. |
| Limitations (`#limitations`) | kept | `## Limitations` bullets; the policy-table catalogue from moves/non-standard-evaluation.md integrated as `### What the built-in table covers` with a `<details>` list (every item kept). |
| Toward NSE Metadata (`#toward-nse-metadata`) | kept | Moved before `## Settings` to satisfy template order. |
| (new) Settings, See also | added | Settings table for the two call-argument/bracket-index switches. |

### docs/modules.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) Module & import systems (`#module--import-systems`) | kept | H1 is now "box and import modules" (manifest title); legacy slug as inline `<a id>` in the lead. Example bound to existing corpus `diag-box-export-not-found`. |
| box modules (box::use()) (`#box-modules-boxuse`) | kept | Same heading; new H3s "Exports", "Rhino applications", "Custom search paths". `.Rprofile` path grammar, `R_BOX_PATH`, root search order, and `.Rprofile`/prelude independence moved to `## Details` › `### Search path rules` `<details>`; watcher/live-update paragraphs (incl. rhino.yml watching) in a second `<details>`. `box.searchPaths` also in `## Settings`. |
| import package (import::from()) (`#import-package-importfrom`) | kept | Same heading; here/from/into split into separate bullets. |
| What is not covered (`#what-is-not-covered`) | kept | Now `## Limitations` with `<a id="what-is-not-covered">`. |

### docs/rprofile.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) `.Rprofile` Startup Prelude (`#rprofile-startup-prelude`) | kept | H1 is now ".Rprofile startup files" (manifest title); legacy slug as inline `<a id>` in the lead. New illustrative R example (not CLI output). |
| What Raven Reads (`#what-raven-reads`) | kept | Same heading. |
| What Contributes To Scope (`#what-contributes-to-scope`) | kept | Same heading; source-detection link now also points at folding rules. |
| devtools::load_all() in .Rprofile (`#devtoolsload_all-in-rprofile`) | kept | Same heading. |
| Where It Applies (`#where-it-applies`) | kept | Same heading. |
| Safety Model (`#safety-model`) | kept | Same heading. |
| Live Updates (`#live-updates`) | kept | Same heading. |
| Configuration (`#configuration`) | kept | Now `## Settings` with `<a id="configuration">`. |
| Static box search paths (`#static-box-search-paths`) | kept | Same heading; now before Settings for template order; link retargeted to modules.md#custom-search-paths. |

### docs/r-package-dev.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) R Package Development (`#r-package-development`) | kept | H1 is now "Package development"; legacy slug inline `<a id>` in the lead. The `.gitignore` discovery paragraph that preceded the lead moved to the end of `## How it works`. New "a file in → sees" table. |
| How It Works (`#how-it-works`) | kept | Same heading. |
| What's Supported (`#whats-supported`) | kept | Now `## What each directory sees` with `<a id="whats-supported">`. |
| &nbsp;&nbsp;Mutual Visibility (`#mutual-visibility`) | kept | Same heading. |
| &nbsp;&nbsp;Internal data (R/sysdata.rda) (`#internal-data-rsysdatarda`) | kept | Same heading. |
| &nbsp;&nbsp;Namespace runtime bindings (`#namespace-runtime-bindings`) | kept | Moved to `## Details` › same heading; limits list in `<details>`. |
| &nbsp;&nbsp;Non-portable R6 classes (`#non-portable-r6-classes`) | kept | Moved to `## Details` › same heading; scope/forms in `<details>`. |
| &nbsp;&nbsp;Tests directory awareness (`#tests-directory-awareness`) | kept | Same heading; H4s `implicit-librarytestthat-under-teststestthat` and `helper-and-setup-files-teststestthathelperr-setupr` kept. Helper rules (incl. library attach, same-directory scope, teardown) as bullets in `<details>`; issue #638 dropped. |
| &nbsp;&nbsp;Dev-context directories (demo/, data-raw/, vignettes/, man/) (`#dev-context-directories-demo-data-raw-vignettes-man`) | kept | Same heading. |
| &nbsp;&nbsp;Scripts that call devtools::load_all() (`#scripts-that-call-devtoolsload_all`) | kept | Same heading; H4s `transitive-propagation-through-source-chains`, `r-source-changes-trigger-diagnostics-refresh`, `go-to-definition-for-load_all-internals` kept. |
| Ordinary scripts in package workspaces (`#ordinary-scripts-in-package-workspaces`) | kept | Same heading. |
| &nbsp;&nbsp;load_all() vs. library() (`#load_all-vs-library`) | kept | Same heading. |
| &nbsp;&nbsp;Build commands (`#build-commands`) | kept | Promoted to `## Build commands`. The `raven.rConsoleEnabled && raven.isRPackage` when-clause and the restated `raven.rConsole.activation` rule replaced by a link to coexistence.md (single home); context keys to dev-moves. H3s `terminal-routing`, `install-and-restart-semantics` kept. |
| &nbsp;&nbsp;testthat problem matcher (`#testthat-problem-matcher`) | kept | Promoted to `## testthat problem matcher`. |
| &nbsp;&nbsp;Roxygen Namespace Tags (`#roxygen-namespace-tags`) | kept | Under new `## Imports from NAMESPACE, roxygen, and DESCRIPTION`. |
| &nbsp;&nbsp;NAMESPACE + roxygen merge (`#namespace--roxygen-merge`) | kept | Same, under the imports H2. |
| &nbsp;&nbsp;data.table [ detection in package mode (`#datatable--detection-in-package-mode`) | kept | Same, under the imports H2. |
| &nbsp;&nbsp;Shipping NSE metadata with your package (`#shipping-nse-metadata-with-your-package`) | kept | Same, under the imports H2. |
| &nbsp;&nbsp;Live Updates (`#live-updates`) | kept | Same, under the imports H2. |
| Generating a package database for CI (`#generating-a-package-database-for-ci`) | kept | Same heading; Tier 2/3 labels replaced by "repo database" / "names.db". |
| Configuration (`#configuration`) | kept | Now `## Settings` with `<a id="configuration">`. |
| Comparison with Script Mode (`#comparison-with-script-mode`) | kept | Same heading. |
| Behavior: Non-Package NAMESPACE Files (`#behavior-non-package-namespace-files`) | kept | `## Details` › "A NAMESPACE file without DESCRIPTION" with `<a id>`. |
| &nbsp;&nbsp;NAMESPACE without DESCRIPTION no longer suppresses diagnostics (`#namespace-without-description-no-longer-suppresses-diagnostics`) | kept | `<a id>` on the same content (merged into the section above). |
| Known Limitations (`#known-limitations`) | kept | Now `## Limitations` with `<a id="known-limitations">`; installed-package goto bullet added (from load_all section). |
| Troubleshooting (`#troubleshooting`) | kept | Same heading; moved before Settings for template order. |

### docs/cross-file-analysis-performance.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) Speeding Up Cross-File Analysis (`#speeding-up-cross-file-analysis`) | kept | H1 is now "Performance on large projects" (manifest label); legacy slug inline `<a id>` in the lead. Intro split: the fan-out explanation is now `## Where the cost comes from`. |
| What Changes (`#what-changes`) | kept | Same heading. |
| Good Fits (`#good-fits`) | kept | Same heading. |
| Bad Fits (`#bad-fits`) | kept | Same heading. |
| When a File Has External Inputs (`#when-a-file-has-external-inputs`) | kept | Same heading. |
| R Workflow Guidance (`#r-workflow-guidance`) | kept | Same heading. |
| Syntax (`#syntax`) | kept | Same heading. |
| See Also (`#see-also`) | kept | Same slug; traversal-budgets link added. |

## Batch D

### docs/ci.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Recommended setup (`#recommended-setup`) | kept | ci.md#recommended-setup. The freeze/commit snippet and `--report-uninstalled` advice moved down to ci.md#choose-where-package-names-come-from |
| GitHub Actions (`#github-actions`) | kept | ci.md#github-actions (heading text unchanged) |
| Bitbucket Pipelines (`#bitbucket-pipelines`) | kept | ci.md#bitbucket-pipelines (heading text unchanged); LFS note to Details |
| Running Raven and Sight together (`#running-raven-and-sight-together`) | kept | ci.md#running-raven-and-sight-together |
| &nbsp;&nbsp;GitHub Actions (`#github-actions-1`) | kept | renamed "Both checkers on GitHub Actions"; `<a id="github-actions-1">` |
| &nbsp;&nbsp;Bitbucket Pipelines (`#bitbucket-pipelines-1`) | kept | renamed "Both checkers on Bitbucket Pipelines"; `<a id="bitbucket-pipelines-1">` |
| What fails the build (`#what-fails-the-build`) | kept | ci.md#what-fails-the-build; style-gating part split into new ci.md#gate-on-style |
| (intro, untitled) | kept | new heading ci.md#what-ci-is |
| (new) Why `raven check` belongs in CI | moved in | from cli.md#why-raven-analyzes-r-without-running-it |
| (new) Choose where package names come from | moved in | from cli.md#package-metadata-strategies (list + table); `<a id="package-metadata-strategies">` also here |
| (new) Gate on style | moved in | ci.md "What fails the build" lint paragraph + cli.md `raven lint` GitHub Actions snippet (#github-actions-example-1) |
| (new) Details | moved in | setup-raven description, cargo-install note, apt repo trust model (from cli.md GitHub/Bitbucket examples), installing R in CI, LFS note |

### docs/linting.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Quick start (`#quick-start`) | kept | linting.md#quick-start, rewritten as three ways to enable; auto/.lintr opt-in rules moved to "When linting is on" |
| Master switch (raven.linting.enabled) (`#master-switch-ravenlintingenabled`) | kept | renamed "When linting is on"; `<a id>` kept |
| &nbsp;&nbsp;Behavior matrix (`#behavior-matrix`) | kept | moved to linting.md Details, heading kept, table visible |
| &nbsp;&nbsp;"auto" and REditorSupport / Positron (`#auto-and-reditorsupport--positron`) | kept | heading kept under "When linting is on" |
| Settings reference by rule (`#settings-reference-by-rule`) | kept | renamed "Rules"; `<a id>`; rule table merges the old Migrating mapping table (adds codes) |
| &nbsp;&nbsp;Line length … Spaces inside (all rule H3s) | kept | headings kept; "Raven:/lintr equivalent:" bullets folded into prose and the Rules table |
| &nbsp;&nbsp;Object names (`#object-names`) | kept | long rules in `<details>` |
| &nbsp;&nbsp;Indentation (`#indentation`) | kept | infix-style examples in `<details>` |
| Migrating from .lintr (`#migrating-from-lintr`) | kept | mapping table merged into Rules table; parse details and object_name_linter parsing in `<details>` |
| &nbsp;&nbsp;Exclusions (`#exclusions`) | kept | |
| Gaps vs lintr (`#gaps-vs-lintr`) | kept | heading unchanged (Marketplace link) |
| &nbsp;&nbsp;Filling the gaps with lintr itself (`#filling-the-gaps-with-lintr-itself`) | kept | |
| Suppression matrix (`#suppression-matrix`) | duplicate | diagnostics.md#suppressing-diagnostics (batch B holds the full matrix and notes); linting.md keeps "Suppressing lints" with `<a id="suppression-matrix">`, a pointer, and lint-specific per-rule semantics |
| Performance and scope notes (`#performance-and-scope-notes`) | kept | split: limitations to "## Limitations" (`<a id>` here), R Markdown + no-R-process notes to Details; parser-pool detail internal (dev-moves/D.md) |
| See also (`#see-also`) | kept | |

### docs/configuration.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Project config: raven.toml (`#project-config-raventoml`) | kept | |
| &nbsp;&nbsp;Discovery (`#discovery`) | kept | |
| &nbsp;&nbsp;Precedence (`#precedence`) | kept | added a worked example and the raven.toml-vs-.lintr rule (from linting.md) |
| &nbsp;&nbsp;Schema (`#schema`) | kept | |
| &nbsp;&nbsp;Per-file overrides (`#per-file-overrides`) | kept | |
| &nbsp;&nbsp;Project exclusions (`#project-exclusions`) | kept | exact rules in `<details>` |
| &nbsp;&nbsp;Live reload (`#live-reload`) | kept | reconciliation internals to dev-moves/D.md |
| Diagnostics (`#diagnostics`) | duplicate | settings-reference.md; anchor on "Settings by area" row; nuances in "Notes on individual settings › Diagnostics settings" |
| Cross-File Settings (`#cross-file-settings`) | duplicate | settings-reference.md; anchor on row; nuances in notes `<details>` |
| &nbsp;&nbsp;On-demand indexing (`#on-demand-indexing`) | duplicate | same row; nuance kept in notes |
| &nbsp;&nbsp;Cache sizes (`#cache-sizes`) | duplicate | same row; UI-minimum vs server-minimum nuance kept in notes |
| Diagnostic Severity Settings (`#diagnostic-severity-settings`) | duplicate | settings-reference.md; anchor on Diagnostics row; nuances (caseMismatch auto, mixedLogical, reportUnusedSuppressions) in notes |
| Package Settings (`#package-settings`) | duplicate | settings-reference.md; anchor on row; rPath/radian nuance in notes |
| &nbsp;&nbsp;Refresh Command (`#refresh-command`) | kept | under "## Commands" |
| Scaffold Commands (`#scaffold-commands`) | kept | under "## Commands" |
| R Console Activation (`#r-console-activation`) | duplicate | coexistence.md (single home of `raven.rConsole.activation`); anchor on row |
| Plot Settings (`#plot-settings`) | duplicate | settings-reference.md + plot-viewer.md; anchor on row; nuance in notes |
| Help Viewer Settings (`#help-viewer-settings`) | duplicate | settings-reference.md + help-viewer.md; anchor on row; nuance in notes |
| Symbol Settings (`#symbol-settings`) | duplicate | settings-reference.md; anchor on row; range in notes |
| Completion Settings (`#completion-settings`) | duplicate | settings-reference.md; anchor on row |
| Indentation Settings (`#indentation-settings`) | duplicate | settings-reference.md + indentation.md; anchor on row; alias, formatOnType snippet, infix advice in notes |
| Linting Settings (`#linting-settings`) | duplicate | settings-reference.md + linting.md; anchor on row; master-switch summary, readHomeLintr, objectName nuances in notes |
| Editor Integration Settings (VS Code only) (`#editor-integration-settings-vs-code-only`) | duplicate | settings-reference.md; anchor on row; rename note in notes |
| Server Settings (`#server-settings`) | kept | anchor on row; text in new "## Server binary" |
| Box module search paths (`#box-module-search-paths`) | kept | |
| (new) Settings in other editors | new | short section on client settings vs raven.toml |

### docs/cli.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Ubuntu installation (`#ubuntu-installation`) | kept | |
| Why Raven analyzes R without running it (`#why-raven-analyzes-r-without-running-it`) | moved | ci.md#why-raven-check-belongs-in-ci; `<a id>` + pointer in cli.md |
| raven check (`#raven-check`) | kept | `check --help` output bound to corpus `check-help` |
| &nbsp;&nbsp;Workspace and paths (`#workspace-and-paths`) | kept | exclusion matching, JAGS/Stan, tar_source in `<details>`; tar_source internals to dev-moves/D.md |
| &nbsp;&nbsp;Options (`#options`) | kept | renamed "Check options"; `<a id="options">`; `exit-on-errors-only` example added |
| &nbsp;&nbsp;R and packages (`#r-and-packages`) | kept | warming details in `<details>` |
| &nbsp;&nbsp;Missing-package reporting in CI (`#missing-package-reporting-in-ci`) | kept | |
| &nbsp;&nbsp;File encoding (`#file-encoding`) | kept | |
| &nbsp;&nbsp;Exit codes (`#exit-codes`) | kept | `usage-error` example added |
| CI examples (`#ci-examples`) | moved | ci.md; `<a id>` + pointer |
| &nbsp;&nbsp;Package metadata strategies (`#package-metadata-strategies`) | moved | ci.md#choose-where-package-names-come-from; `<a id>` in both pages |
| &nbsp;&nbsp;GitHub Actions example (`#github-actions-example`) | duplicate | ci.md#github-actions; `<a id>` + pointer; setup-raven/cargo notes to ci.md Details |
| &nbsp;&nbsp;Bitbucket Pipelines example (`#bitbucket-pipelines-example`) | duplicate | ci.md#bitbucket-pipelines; `<a id>` + pointer; apt trust-model note to ci.md Details |
| &nbsp;&nbsp;Scope (`#scope`) | kept | renamed "R Markdown and Quarto files" under raven check; `<a id="scope">` |
| raven lint (`#raven-lint`) | kept | |
| &nbsp;&nbsp;Options (`#options-1`) | kept | "Lint options"; `<a id>` |
| &nbsp;&nbsp;File encoding (`#file-encoding-1`) | kept | "Lint file encoding"; `<a id>` |
| &nbsp;&nbsp;Exit codes (`#exit-codes-1`) | kept | "Lint exit codes"; `<a id>` |
| &nbsp;&nbsp;GitHub Actions example (`#github-actions-example-1`) | moved | ci.md#gate-on-style; `<a id>` + pointer |
| &nbsp;&nbsp;Scope (`#scope-1`) | kept | "Files `raven lint` reads"; `<a id>` |
| raven console (`#raven-console`) | kept | |
| raven packages (`#raven-packages`) | kept | |
| &nbsp;&nbsp;raven packages fetch (`#raven-packages-fetch`) | kept | sub-headings kept (`#options-2` as "Fetch options", `#additive-merge--existing-records-always-win` as "Existing records always win") |
| &nbsp;&nbsp;raven packages freeze (`#raven-packages-freeze`) | kept | `#options-3` as "Freeze options" |
| &nbsp;&nbsp;raven packages update (`#raven-packages-update`) | kept | |
| Output formats (`#output-formats`) | kept | `check-json` example added |
| &nbsp;&nbsp;Output streams (`#output-streams`) | kept | NSE footer heading renamed "NSE footer" with `<a id="nse-discoverability-footer">` |
| Color output (`#color-output`) | kept | |
| Appendix: maintainer and advanced topics (`#appendix-maintainer-and-advanced-topics`) | internal | dev-moves/D.md; anchor now on the kept `--base-url` section |
| &nbsp;&nbsp;Self-hosting names.db with --base-url (`#self-hosting-namesdb-with---base-url`) | kept | user-facing; now an H4 under `raven packages update` |
| &nbsp;&nbsp;raven packages build-shipped-db (`#raven-packages-build-shipped-db`) | internal | dev-moves/D.md; `<a id>` on "Maintainer commands" pointer |
| &nbsp;&nbsp;raven packages validate-shipped-db (`#raven-packages-validate-shipped-db`) | internal | dev-moves/D.md; `<a id>` on pointer |
| &nbsp;&nbsp;raven packages build-embedded-base (`#raven-packages-build-embedded-base`) | internal | dev-moves/D.md; `<a id>` on pointer |
| (new) `raven --stdio` | new | short section |

### docs/package-database.md

| Section | Disposition | Destination / notes |
|---|---|---|
| The three tiers (`#the-three-tiers`) | kept | rewritten as "How Raven finds a package's exports"; `<a id>`; tier table split into the lead table and the numbered list |
| &nbsp;&nbsp;Exports completeness (`#exports-completeness`) | kept | Details "When Raven reports a missing `pkg::member`"; `<a id>`; internals (`PackageInfo`, `namespace_member_status_sync`, `insert_package`) to dev-moves/D.md |
| Tier 2 — the committed .raven/packages.json (`#tier-2--the-committed-ravenpackagesjson`) | kept | "Commit a project snapshot"; `<a id>` |
| &nbsp;&nbsp;Generating it (`#generating-it`) | kept | used-set list, Base-7 skipping, renv-first order are duplicates of cli.md#raven-packages-freeze (kept there; `:::` note added to cli.md) |
| &nbsp;&nbsp;Regeneration is a no-op when unchanged (`#regeneration-is-a-no-op-when-unchanged`) | kept | paragraph under Generating it; `<a id>` |
| &nbsp;&nbsp;Two producers, one artifact (`#two-producers-one-artifact`) | kept | "`freeze` or `fetch`"; `<a id>`; "one model, one reader, one writer" to dev-moves |
| &nbsp;&nbsp;Version skew is explained, not silently dropped (`#version-skew-is-explained-not-silently-dropped`) | kept | "When the snapshot can't be read"; `<a id>` |
| Tier 3 — names.db database (`#tier-3--namesdb-database`) | kept | Details "The downloaded database (`names.db`)"; `<a id>`; build bullets in `<details>` |
| &nbsp;&nbsp;Data source and acknowledgement (`#data-source-and-acknowledgement`) | kept | heading unchanged (README link); "We" reworded to "Raven"; script link made absolute |
| Base packages and datasets (`#base-packages-and-datasets`) | kept | Details; `<a id>`; dataset collection in `<details>`; build-shipped-db sentence to dev-moves |
| Names vs. install status (`#names-vs-install-status`) | kept | |
| Fidelity caveats (`#fidelity-caveats`) | kept | "## Limitations"; `<a id>` |
| See also (`#see-also`) | kept | build-shipped-db/build-embedded-base mention dropped (maintainer-only) |

## Batch E

### docs/editor-integrations.md

H1 is now `# Editor setup` (manifest title); `<a id="editor-integrations">` keeps the old H1 slug.

| Section | Disposition | Destination / notes |
|---|---|---|
| Getting the binary (`#getting-the-binary`) | kept | `## Getting the binary` (slug kept). README link made absolute (`blob/main/README.md#command-line`), plus link to cli.md. |
| VS Code (`#vs-code`) | kept | `## VS Code, Cursor, Positron, and VSCodium` with `<a id="vs-code">`. Install/Configure/Verify/What you get. Cursor/Positron/VSCodium Open VSX + `.vsix` wording taken from README `#editors`. `r.lsp.enabled` kept as one line + link to coexistence.md. `editor.snippetSuggestions` moved to snippets.md `#sort-or-hide-snippets` (linked). |
| Zed (`#zed`) | kept | `## Zed` (slug kept); snippet unchanged. Added install step (Zed's R extension provides the `r_language_server` slot the snippet overrides) and verify step (`debug: open language server logs`). |
| Neovim (`#neovim`) | kept | `## Neovim` (slug kept). Added Neovim 0.11+ `vim.lsp.config`/`vim.lsp.enable` snippet (verified headless against Neovim 0.12.6 + installed raven: 1 client attached, `undefined_thing is not defined` diagnostic) and an nvim-lspconfig custom-server snippet for older Neovim. Old `vim.lsp.start` snippet kept, wrapped in a `FileType` autocmd so it actually runs per buffer. |
| (new) Helix | new | `## Helix`: `languages.toml` snippet for `r` and `rmarkdown`; verify with `hx --health r`. Not tested locally (no `hx`). |
| (new) Emacs (eglot) | new | `## Emacs (eglot)`: `eglot-server-programs` snippet for `ess-r-mode`/`r-mode`; verify with mode line + `M-x eglot-events-buffer`. Not tested locally (no ESS). |
| Generic LSP Client (`#generic-lsp-client`) | kept | `## Any other LSP client` with `<a id="generic-lsp-client">`. File-extension and JAGS-dialect paragraph kept verbatim in meaning. |
| Agent Integration (`#agent-integration`) | kept | `## AI coding agents` with `<a id="agent-integration">`. |
| &nbsp;&nbsp;Claude Code (`#claude-code`) | kept | slug kept |
| &nbsp;&nbsp;OpenCode (`#opencode`) | kept | slug kept |
| &nbsp;&nbsp;Kiro CLI (`#kiro-cli`) | kept | slug kept |
| &nbsp;&nbsp;Crush (`#crush`) | kept | slug kept |
| Project configuration (`#project-configuration`) | kept | slug kept |
| Troubleshooting (`#troubleshooting`) | kept | Symptom/fix table. JAGS/Stan diagnostics bullet → `## Details` › `### JAGS and Stan diagnostics are off by default` (with a `toml` snippet). inotify bullet → `## Details` › `### Package watching on Linux`. |
| (new) Feature availability | new | `## Feature availability` matrix; sources listed in the batch report. |

### docs/indentation.md

H1 now `# Indentation`; `<a id="smart-indentation">` keeps the old H1 slug. New lead example: the built-in cascade vs Raven's one-level chain (from the old "Infix examples" off-mode and statement-level paragraphs).

| Section | Disposition | Destination / notes |
|---|---|---|
| Overview (`#overview`) | kept | `## How it works` with `<a id="overview">`. Mechanism table and NOTE kept; "LSP `onTypeFormatting`" restated as on-type formatting from the language server. Added one line linking the editor-integrations feature matrix. |
| Configuration (`#configuration`) | kept | `<a id="configuration">` on `## Choose an argument style`. |
| &nbsp;&nbsp;Auto-indentation settings (`#auto-indentation-settings`) | kept | Settings table → `## Settings`; argument-style explanation and examples → `## Choose an argument style` (`<a id>`); infix bullets → `## Choose an infix style`, with an aligned/indented before/after. |
| &nbsp;&nbsp;Corresponding lint settings (`#corresponding-lint-settings`) | kept | `## Match your lint settings` with `<a id>`. Unit-sharing / `.lintr` mapping paragraph → `## Details` › `### How auto-indent picks the indentation unit`. |
| &nbsp;&nbsp;Why Raven's defaults differ (`#why-ravens-defaults-differ`) | kept | `## Details` › `### Why Raven's defaults differ` (slug kept). The CI-project recommendation (set both infix settings to `indented`, match `lintr` indent, `editor.tabSize`) moved up into `## Match your lint settings`. "Raven's authors find" restated as the reason without attribution. |
| &nbsp;&nbsp;Permanent compatibility alias (`#permanent-compatibility-alias`) | kept | `## Details` › same heading (slug kept). |
| &nbsp;&nbsp;Disabling syntax-aware indentation (`#disabling-syntax-aware-indentation`) | kept | `## Turn syntax-aware indentation off` with `<a id>`; added a `"[r]"` `editor.formatOnType` JSON snippet. |
| Infix examples (`#infix-examples`) | kept | slug kept. The "off" cascade example moved to the page lead; `argumentStyle = off` line moved to `## Choose an argument style`. |
| Assignment continuations (`#assignment-continuations`) | kept | slug kept |
| Brace blocks (`#brace-blocks`) | kept | slug kept |
| When syntax-aware indentation cannot answer (`#when-syntax-aware-indentation-cannot-answer`) | kept | `## Limitations` with `<a id>`. |
| Troubleshooting (`#troubleshooting`) | kept | slug kept |

### docs/completion.md

| Section | Disposition | Destination / notes |
|---|---|---|
| What's Offered (`#whats-offered`) | kept | slug kept; bold labels removed from table. New "You type → Raven offers" lead table built from the page's own examples. |
| Position-Aware Filtering (`#position-aware-filtering`) | kept | slug kept; `rm()` rule also stated here. |
| Package Completions (`#package-completions`) | kept | slug kept |
| &nbsp;&nbsp;Namespace-Qualified Completions (pkg::) (`#namespace-qualified-completions-pkg`) | kept | slug kept. Background metadata loading, datasets, `exportPattern()` (~6%), and `pkg:::` → `<details>` in the same section. "Crucially" dropped. |
| &nbsp;&nbsp;box Namespace and Attached Completions (`#box-namespace-and-attached-completions`) | kept | slug kept |
| Function Parameter Completions (`#function-parameter-completions`) | kept | slug kept; setting also in `## Settings`. |
| File Path Completions (`#file-path-completions`) | kept | slug kept |
| $ Member Completions (`#-member-completions`) | kept | slug kept |
| Cross-File Completions (`#cross-file-completions`) | kept | slug kept |
| R Markdown / Quarto (`#r-markdown--quarto`) | kept | `## R Markdown and Quarto` with `<a id="r-markdown--quarto">`. |
| JAGS and Stan (`#jags-and-stan`) | kept | slug kept. Catalog provenance paragraphs (JAGS 4.3.2, stanc3 2.39.1/2.39.0) → `## Details` `<details>`. |
| Scope Rules Summary (`#scope-rules-summary`) | kept | `## Details` › `### Scope rules summary` (slug kept). |

### docs/hover.md

| Section | Disposition | Destination / notes |
|---|---|---|
| What You See (`#what-you-see`) | kept | slug kept. Lead example is the old scope-aware-attribution code. |
| JAGS Hover (`#jags-hover`) | kept | slug kept. "UTF-16 cursor positions without consulting the temporary R parse tree" dropped as internal (see dev-moves). |
| Stan Hover (`#stan-hover`) | kept | slug kept |
| Resolution Order (`#resolution-order`) | kept | `## Details` › `### Resolution order` (slug kept). Source-path sentence and "structural-label predicate" / "resolve-or-suppress" jargon restated as user behavior (see dev-moves). |
| &nbsp;&nbsp;box module members (`#box-module-members`) | kept | `## Details` › same heading (slug kept). |
| File Location Lines (`#file-location-lines`) | kept | slug kept; three cases as a table. |
| Declared Symbols (`#declared-symbols`) | kept | slug kept |
| Package Exports and the Help-Panel Link (`#package-exports-and-the-help-panel-link`) | kept | slug kept |
| Scope-Aware Package Attribution (`#scope-aware-package-attribution`) | kept | slug kept; the `library()`/`require()`/`loadNamespace()` attach-signal sentence from the old lead moved here. |
| With REditorSupport Also Installed (`#with-reditorsupport-also-installed`) | kept | slug kept; `guess_namespace` / `utils::help((topic))` mechanism trimmed to user behavior, comparison.md link kept for the mechanism. |
| Limits (`#limits`) | kept | `## Limitations` with `<a id="limits">`. |
| Related (`#related`) | kept | `## See also` with `<a id="related">`. Diagnostics and completion links dropped from See also (both linked in the body). |

### docs/go-to-definition.md

| Section | Disposition | Destination / notes |
|---|---|---|
| What You Can Jump To (`#what-you-can-jump-to`) | kept | slug kept. Lead example is the old cross-file example. |
| Position-Aware Resolution (`#position-aware-resolution`) | kept | slug kept |
| Cross-File Navigation (`#cross-file-navigation`) | kept | slug kept |
| $ and @ Member Resolution (`#-and--member-resolution`) | kept | slug kept. The exhaustive "which subscripts navigate" list → `## Details` › `### Which subscripts navigate` (also linked from find-references.md). |
| Declared Symbols (`#declared-symbols`) | kept | slug kept; added the contrast with hover (hover.md already stated it). |
| File Path Navigation (`#file-path-navigation`) | kept | slug kept; "AST-detected" dropped. |
| &nbsp;&nbsp;box module paths and exports (`#box-module-paths-and-exports`) | kept | slug kept; "cycle guards" → "stopping safely if a chain loops". |
| load_all() Internals (`#load_all-internals`) | kept | `## Package code under load_all()` with `<a id="load_all-internals">`. "Goto into external/installed packages" paragraph merged into `## Package exports` (duplicate). |
| Package Exports (`#package-exports`) | kept | slug kept; merged with the installed-packages paragraph from load_all. |
| R Markdown and Quarto (`#r-markdown-and-quarto`) | kept | slug kept |
| JAGS and Stan (`#jags-and-stan`) | kept | slug kept; bullets → table. JAGS fallback exclusion rule → `## Details` › `### JAGS fallback occurrences`. |
| Related (`#related`) | kept | `## See also` with `<a id="related">`. |

### docs/find-references.md

| Section | Disposition | Destination / notes |
|---|---|---|
| How It Works (`#how-it-works`) | kept | slug kept. Lead example is the old Cross-File Scoping example. |
| Cross-File Scoping (`#cross-file-scoping`) | kept | slug kept; example moved to lead. |
| Scope and pooling (`#scope-and-pooling`) | kept | slug kept |
| &nbsp;&nbsp;Selective-import member identity (`#selective-import-member-identity`) | kept | slug kept. The R Markdown blockquote that followed it → new `## R Markdown and Quarto`. |
| Workspace Symbols (Cmd/Ctrl+T) (`#workspace-symbols-cmdctrlt`) | kept | slug kept; setting → `## Settings`; link to document-outline `#workspace-symbol-search`. |
| JAGS and Stan (`#jags-and-stan`) | kept | slug kept |
| Go-to-Definition (`#go-to-definition`) | duplicate | `<a id="go-to-definition">` on `## See also`; the sentence is the See also entry. |

### docs/document-outline.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Overview (`#overview`) | kept | `## What appears in the outline` with `<a id="overview">`. Lead example added (subset of the old "Organizing a large analysis script" example). |
| Accessing the Outline (`#accessing-the-outline`) | kept | slug kept |
| R Code Sections (`#r-code-sections`) | kept | slug kept |
| &nbsp;&nbsp;Section Syntax (`#section-syntax`) | kept | slug kept |
| &nbsp;&nbsp;Heading Levels (`#heading-levels`) | kept | slug kept |
| &nbsp;&nbsp;Section Ranges (`#section-ranges`) | kept | slug kept |
| &nbsp;&nbsp;Invalid Sections (`#invalid-sections`) | kept | slug kept |
| R Markdown / Quarto Chunks (`#r-markdown--quarto-chunks`) | kept | `## R Markdown and Quarto chunks` with `<a id>`. `OBJECT` → "object". Example fence changed to 5 backticks. |
| R Markdown / Quarto Headings (`#r-markdown--quarto-headings`) | kept | `## R Markdown and Quarto headings` with `<a id>`. The old ```` ```rmd ```` example was broken (inner chunk fences closed it, which is why a stray `## Methods` heading existed); now a 5-backtick fence. "Details:" bullets kept as plain bullets. |
| Methods (`#methods`) | duplicate | This slug came from the broken fence above (a `## Methods` line inside the example). It now resolves to `### Methods` under Symbol types. |
| &nbsp;&nbsp;# %% cells in .R files (`#--cells-in-r-files`) | kept | Moved under `## R Markdown and Quarto chunks` (slug kept); Note → GitHub `[!NOTE]`. |
| Symbol Types (`#symbol-types`) | kept | slug kept; summary table added; "Icon:/Detail:/Name:" bold lines restated as sentences. |
| &nbsp;&nbsp;Functions (`#functions`) | kept | slug kept |
| &nbsp;&nbsp;Variables (`#variables`) | kept | slug kept; `SymbolKind::FIELD` → "Field icon". |
| &nbsp;&nbsp;Value-typed variables (`#value-typed-variables`) | kept | slug kept; classification order now linked to `#wrong-symbol-typeicon` (duplicate). |
| &nbsp;&nbsp;Constants (`#constants`) | kept | slug kept |
| &nbsp;&nbsp;Classes (`#classes`) | kept | slug kept |
| &nbsp;&nbsp;Methods (`#methods-1`) | kept | `### Methods` with `<a id="methods-1">`. |
| &nbsp;&nbsp;Generics (`#generics`) | kept | slug kept |
| Hierarchical Nesting (`#hierarchical-nesting`) | kept | slug kept |
| JAGS and Stan Model Structure (`#jags-and-stan-model-structure`) | kept | slug kept |
| &nbsp;&nbsp;JAGS Blocks (`#jags-blocks`) | kept | slug kept |
| &nbsp;&nbsp;Stan Blocks (`#stan-blocks`) | kept | slug kept |
| &nbsp;&nbsp;Decorative Comment Headings (`#decorative-comment-headings`) | kept | slug kept |
| &nbsp;&nbsp;Loops (`#loops`) | kept | slug kept |
| &nbsp;&nbsp;Example (`#example`) | kept | slug kept; "text-based pattern matching with brace-depth tracking" restated as behavior (dev-moves). |
| Workspace Symbol Search (`#workspace-symbol-search`) | kept | slug kept |
| Configuration (`#configuration`) | kept | `## Settings` with `<a id="configuration">`. |
| &nbsp;&nbsp;Workspace Symbol Limit (`#workspace-symbol-limit`) | kept | `<a id>` on the Settings table; JSON snippet duplicate of the troubleshooting one, dropped. |
| Examples (`#examples`) | kept | slug kept |
| &nbsp;&nbsp;Organizing a Large Analysis Script (`#organizing-a-large-analysis-script`) | kept | slug kept |
| Troubleshooting (`#troubleshooting`) | kept | slug kept |
| &nbsp;&nbsp;Outline view is empty (`#outline-view-is-empty`) | kept | slug kept. "status bar shows Raven" replaced: the extension creates no status-bar item for the server; now "the Raven channel in the Output panel". |
| &nbsp;&nbsp;Sections not appearing in outline (`#sections-not-appearing-in-outline`) | kept | slug kept |
| &nbsp;&nbsp;Symbols showing at wrong level (`#symbols-showing-at-wrong-level`) | kept | slug kept |
| &nbsp;&nbsp;Workspace symbol search returns too few results (`#workspace-symbol-search-returns-too-few-results`) | kept | slug kept |
| &nbsp;&nbsp;Wrong symbol type/icon (`#wrong-symbol-typeicon`) | kept | slug kept |

### docs/syntax-highlighting.md

| Section | Disposition | Destination / notes |
|---|---|---|
| R (`#r`) | kept | slug kept. "via the tree-sitter AST" → "from the parsed code"; "chunk detector … tree-sitter … rebases" → user behavior. |
| Rendered HTML (Raven: Knit Preview) (`#rendered-html-raven-knit-preview`) | kept | `## Rendered HTML in Knit Preview` with `<a id>`. |
| &nbsp;&nbsp;Why Raven vendors the R and R Markdown grammars (`#why-raven-vendors-the-r-and-r-markdown-grammars`) | kept | `## Details` › same heading (slug kept). `extensionKind`/UI-host/workspace-host explanation restated in user terms; vendored file paths and SOURCE.md pointer → dev-moves. Quarto-grammar sentence → `## Limitations`, corrected (see report). |
| R Package Development Files (`#r-package-development-files`) | kept | slug kept |
| &nbsp;&nbsp;DCF (DESCRIPTION, .Rproj, .lintr) (`#dcf-description-rproj-lintr`) | kept | `### DCF files: …` with `<a id>`. |
| &nbsp;&nbsp;NAMESPACE (`#namespace`) | kept | slug kept |
| &nbsp;&nbsp;Rd (.Rd, .rd) (`#rd-rd-rd`) | kept | `### Rd files: …` with `<a id>`. |
| &nbsp;&nbsp;.Rbuildignore (`#rbuildignore`) | kept | `### .Rbuildignore files` with `<a id>`. |
| JAGS and Stan (`#jags-and-stan`) | kept | slug kept |
| &nbsp;&nbsp;JAGS (`#jags`) | kept | slug kept; "all eight case variants" → "in any letter case". |
| &nbsp;&nbsp;Stan (`#stan`) | kept | slug kept |

### docs/snippets.md

| Section | Disposition | Destination / notes |
|---|---|---|
| R Markdown and Quarto (`#r-markdown-and-quarto`) | kept | slug kept. Prefix lists expanded into tables from the snippet JSON files. Gating of R snippets in `.Rmd`/`.qmd` on `raven.rConsole.activation` kept as one sentence + coexistence link. Pointers to `editors/vscode/snippets/*.json` dropped (every snippet is now listed). |
| (new) R snippets, Sort or hide snippets, Limitations | new | `editor.snippetSuggestions` advice moved here from editor-integrations.md. |

## Batch F

### docs/r-console.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) R Console (`#r-console`) | kept | H1 "R console" (same slug). Intro restated as lead + "you do → Raven does" table. Activation NOTE replaced by one sentence linking coexistence.md#the-ravenrconsoleactivation-setting. |
| R Terminal Profile (`#r-terminal-profile`) | kept | Renamed "Open an R terminal"; `<a id="r-terminal-profile">` above it. |
| &nbsp;&nbsp;Choosing the R program (`#choosing-the-r-program`) | kept | Same heading. |
| Raven's console (`#ravens-console`) | kept | Same heading. |
| &nbsp;&nbsp;Editing (`#editing`) | kept | Bold labels dropped, em dashes removed. |
| &nbsp;&nbsp;Completion (`#completion`) | kept | Split into two paragraphs. |
| &nbsp;&nbsp;Colored output (`#colored-output`) | kept | |
| &nbsp;&nbsp;Running code from the editor (`#running-code-from-the-editor`) | kept | |
| &nbsp;&nbsp;Debugging (`#debugging`) | kept | Pointer to debugger.md. |
| &nbsp;&nbsp;Outside VS Code (`#outside-vs-code`) | kept | |
| Keyboard Shortcuts (`#keyboard-shortcuts`) | kept | Tip converted to prose; adds links to chunks/keybinding-comparison. |
| Commands (`#commands`) | kept | |
| &nbsp;&nbsp;Quick Inspection Commands (`#quick-inspection-commands`) | kept | Sentence case; same slug. |
| Editor Toolbar (`#editor-toolbar`) | kept | The 300-word paragraph became a per-file-type table plus three short paragraphs. Terminal-command id list kept. |
| Statement Detection (`#statement-detection`) | kept | |
| Cursor Advancement (`#cursor-advancement`) | kept | |
| Send Method (`#send-method`) | kept | |
| &nbsp;&nbsp;Why auto switches to a temp file for larger blocks (`#why-auto-switches-to-a-temp-file-for-larger-blocks`) | kept | Same heading; comparison link moved to the end. |
| Configuration Options (`#configuration-options`) | kept | Now `## Settings`; `<a id="configuration-options">` above it. Activation row reduced to a link to coexistence.md. |

### docs/debugger.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) Debugger (`#debugger`) | kept | Intro split: lead sentence + paragraph; Windows/platform note moved to Limitations. |
| Getting started (`#getting-started`) | kept | First section; requirement sentence added at top linking Limitations. |
| What you can do while stopped (`#what-you-can-do-while-stopped`) | kept | "Run R code" row split in two (terminal `Browse[1]>` row) to keep cells ≤40 words. |
| Breakpoints (`#breakpoints`) | kept | Function-breakpoint binding rules moved from the table cell into a new `### Function breakpoints` subsection on the same page. |
| &nbsp;&nbsp;When a breakpoint takes effect (`#when-a-breakpoint-takes-effect`) | kept | |
| &nbsp;&nbsp;Stepping (`#stepping`) | kept | |
| Errors, warnings and interrupts (`#errors-warnings-and-interrupts`) | kept | |
| Hover and the Variables view never run your code (`#hover-and-the-variables-view-never-run-your-code`) | kept | |
| Settings (`#settings`) | kept | |
| What the debugger changes in your R session (`#what-the-debugger-changes-in-your-r-session`) | moved | debugger.md#what-the-debugger-changes-in-your-r-session (now an H3 under `## Details`; same slug). |
| Limitations (`#limitations`) | kept | Gains the platform bullet (macOS/Linux only; Raven's console only). |

### docs/plot-viewer.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) Plot Viewer (`#plot-viewer`) | kept | Lead + example table; activation NOTE replaced by link to coexistence.md. |
| Prerequisites (`#prerequisites`) | kept | |
| Behavior (`#behavior`) | kept | Renamed "View and save plots"; `<a id="behavior">`. Toolbar bullet split into a list. `aria-label`/`title` detail stated as "accessible labels for screen readers". |
| Color theme (`#color-theme`) | kept | `Memento` → "remembered across VS Code sessions"; CSS variable names replaced by "editor's foreground color". |
| &nbsp;&nbsp;Known limitations (`#known-limitations`) | kept | Now `## Limitations`; `<a id="known-limitations">`. |
| &nbsp;&nbsp;Substrate (for the curious) (`#substrate-for-the-curious`) | kept | Now `### How the theme toggle reaches the plot` under Details; `<a id="substrate-for-the-curious">`. Style-attribute migration detail → dev-moves/F.md. |
| Settings (`#settings`) | kept | "No separate enable toggle" sentence kept, pointing at coexistence. |
| Troubleshooting (`#troubleshooting`) | kept | Moved above Settings (template order). Activation bullet → link to coexistence.md. |

### docs/data-viewer.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) Data Viewer (`#data-viewer`) | kept | Hard-wrapped paragraphs unwrapped throughout. |
| Why we built this (`#why-we-built-this`) | duplicate | Lead + example paragraph (Arrow on disk, viewport reads, labels). The REditorSupport `sess` comparison already lives in comparison.md#data-viewer; anchor kept as `<a id="why-we-built-this">` above the example. |
| What it shows (`#what-it-shows`) | kept | |
| Triggering (`#triggering`) | kept | Renamed "Open a data frame"; `<a id="triggering">`. |
| Toolbar (`#toolbar`) | kept | Hysteresis detail → "doesn't flicker". |
| &nbsp;&nbsp;Labels (`#labels`) | kept | |
| &nbsp;&nbsp;Format (`#format`) | kept | |
| &nbsp;&nbsp;Columns popover (`#columns-popover`) | kept | "panel-name + schema hash" → "panel name and the data's column layout" (throughout). |
| &nbsp;&nbsp;Selection and copy (`#selection-and-copy`) | kept | |
| &nbsp;&nbsp;Keyboard shortcuts (`#keyboard-shortcuts`) | kept | Renamed "Grid shortcuts" (duplicate heading); `<a id="keyboard-shortcuts">`. Explanatory paragraph after the table dropped as duplicate of the table rows. |
| Sorting (`#sorting`) | kept | Menu prose became a list. |
| &nbsp;&nbsp;NA / NaN (`#na--nan`) | kept | Renamed "Missing values in sorts"; `<a id="na--nan">`. |
| &nbsp;&nbsp;Labels and Format (`#labels-and-format`) | kept | Renamed "Sorting with Labels and Format"; `<a id="labels-and-format">`. |
| &nbsp;&nbsp;Persistence (`#persistence`) | kept | Renamed "Saved sorts"; `<a id="persistence">`. |
| &nbsp;&nbsp;Reopening with a saved sort or filter (`#reopening-with-a-saved-sort-or-filter`) | kept | |
| &nbsp;&nbsp;Sort indicator (`#sort-indicator`) | kept | Merged into Sorting (chip-strip text was duplicate); `Sorting…` pill paragraph keeps `<a id="sort-indicator">`. |
| Filtering (`#filtering`) | kept | |
| &nbsp;&nbsp;Per-type predicates (`#per-type-predicates`) | kept | "value dictionary shipped/unshipped" → "levels available to the panel / very many levels". |
| &nbsp;&nbsp;NA / NaN (`#na--nan-1`) | kept | Renamed "Missing values in filters"; `<a id="na--nan-1">`. |
| &nbsp;&nbsp;Labels and Format (`#labels-and-format-1`) | kept | Renamed "Filtering with Labels and Format"; `<a id="labels-and-format-1">`. |
| &nbsp;&nbsp;Chip strip (`#chip-strip`) | kept | |
| &nbsp;&nbsp;Composition (`#composition`) | kept | |
| &nbsp;&nbsp;Filter indicator (`#filter-indicator`) | kept | Duplicate "chips in the toolbar" sentence dropped. |
| &nbsp;&nbsp;Persistence (`#persistence-1`) | kept | Renamed "Saved filters"; `<a id="persistence-1">`. |
| &nbsp;&nbsp;Keyboard shortcuts (`#keyboard-shortcuts-1`) | kept | Renamed "Filter shortcuts"; `<a id="keyboard-shortcuts-1">`. |
| Settings (`#settings`) | kept | Moved after Troubleshooting (template order). |
| How it works (`#how-it-works`) | internal | User-facing summary kept as `### How it works` under Details (same slug); HTTP route, payload, JS decoder, schema-level JSON metadata → dev-moves/F.md. |
| Requirements (`#requirements`) | kept | Moved to the top of the page. |
| Troubleshooting (`#troubleshooting`) | kept | Activation bullet → link to coexistence.md. |

### docs/help-viewer.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) R Help Viewer (`#r-help-viewer`) | kept | H1 "R help viewer" (same slug). |
| Why we built this (`#why-we-built-this`) | kept | One-sentence lead + example table + scope paragraph; `<a id="why-we-built-this">` after the lead. Activation NOTE → one sentence + coexistence link. |
| How to open it (`#how-to-open-it`) | kept | |
| Navigation (`#navigation`) | kept | Custom URL scheme detail → dev-moves/F.md; user fact ("operator topics navigate correctly") kept. |
| What works (`#what-works`) | kept | Exact link-resolution rules (Rd2HTML mis-attribution fallback, manual allowlist, stripped footer links) moved into a `<details>` under Details. |
| v1 Limitations (`#v1-limitations`) | kept | Now `## Limitations`; `<a id="v1-limitations">`. "ammonia" → "sanitized". First person removed. |
| Configuration (`#configuration`) | kept | Now `## Settings`; `<a id="configuration">`. |
| Manual smoke test plan (`#manual-smoke-test-plan`) | internal | dev-moves/F.md "Help viewer smoke test". `<a id="manual-smoke-test-plan">` kept on `## Details`. |

### docs/chunks.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) R Code Chunks (`#r-code-chunks`) | kept | H1 "R code chunks" (same slug). Lead + example; long gating NOTE → one paragraph linking coexistence.md#what-steps-aside-and-what-doesnt. |
| Chunk forms (`#chunk-forms`) | kept | |
| Language features inside chunks (`#language-features-inside-chunks`) | kept | |
| &nbsp;&nbsp;Cross-file resolution from chunks (`#cross-file-resolution-from-chunks`) | kept | |
| &nbsp;&nbsp;Suppressing diagnostics in a chunk (`#suppressing-diagnostics-in-a-chunk`) | kept | Chunk-specific, so kept here; links diagnostics.md for general suppression. Suggested a diagnostics.md recipe link in moves/diagnostics.md. |
| Keyboard shortcuts (`#keyboard-shortcuts`) | kept | |
| Commands (`#commands`) | kept | |
| CodeLens buttons (`#codelens-buttons`) | kept | |
| Chunk options (`#chunk-options`) | kept | Exact `#|` YAML parsing rules moved into a `<details>` under Details. |
| Highlighting (`#highlighting`) | kept | |
| Plain .R cell mode (`#plain-r-cell-mode`) | kept | |
| &nbsp;&nbsp;Section dividers as cell boundaries (`#section-dividers-as-cell-boundaries`) | kept | |
| &nbsp;&nbsp;Active-cell border (`#active-cell-border`) | kept | |
| Limitations (`#limitations`) | kept | First bullet corrected: `.qmd` is handled by Raven's Quarto Preview/Render (old text said Raven defers to quarto.quarto). New `## Settings` table added before it. |

### docs/knit.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) R Markdown knit (`#r-markdown-knit`) | kept | H1 renamed to manifest title "R Markdown preview and export"; `<a id="r-markdown-knit">` after the lead. Intro bullets → `## Preview a document`. |
| When the command is available (`#when-the-command-is-available`) | kept | Activation restatement → one sentence + coexistence link. |
| What it does, step by step (`#what-it-does-step-by-step`) | kept | Now `### What it does, step by step` under Details (same slug). Step 11 (panel/toolbar/theme/copy) became `## The preview panel` and `### Apply VS Code theme`; image inlining, temp-dir layout/cleanup, theme mapping, R expression in `<details>` blocks. Internals → dev-moves/F.md. |
| Exporting (`#exporting`) | kept | Deferred-feature refusal (step 3) restated here. |
| &nbsp;&nbsp;YAML output options (`#yaml-output-options`) | kept | |
| Settings (`#settings`) | kept | Activation row removed; one-sentence pointer instead. |
| &nbsp;&nbsp;Fonts (`#fonts`) | kept | Same heading (cited by post-knit-renderer.ts). Rejection rules moved into a `<details>` under Details. `onDidChangeConfiguration` / JSON-schema `pattern` → dev-moves. |
| What Raven does not do (`#what-raven-does-not-do`) | kept | Now `## Limitations`; `<a id="what-raven-does-not-do">`. |

### docs/quarto.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) Quarto preview and render (`#quarto-preview-and-render`) | kept | Command list became an example table. |
| Why Raven includes a Quarto workflow (`#why-raven-includes-a-quarto-workflow`) | kept | Renamed "When to use these commands"; `<a id="why-raven-includes-a-quarto-workflow">`. Shortened; detail stays in coexistence.md#coexistence-with-the-quarto-extension. Theme paragraph merged into Apply VS Code theme. tarchetypes paragraph → `### targets pipelines` under Details. |
| Requirements and Quarto discovery (`#requirements-and-quarto-discovery`) | kept | |
| Commands (`#commands`) | kept | |
| &nbsp;&nbsp;Quarto Preview (`#quarto-preview`) | kept | Readiness steps summarized; URL validation moved into Security model; stdout/stderr control-sequence stripping and probe cancellation → dev-moves/F.md. |
| &nbsp;&nbsp;Stop Quarto Preview (`#stop-quarto-preview`) | kept | |
| &nbsp;&nbsp;Quarto Render (`#quarto-render`) | kept | |
| &nbsp;&nbsp;Show Quarto Output (`#show-quarto-output`) | kept | |
| Apply VS Code theme (`#apply-vs-code-theme`) | kept | Proxy/bridge paragraph moved into Security model. |
| &nbsp;&nbsp;Fonts (`#fonts`) | kept | |
| Preview ownership and keying (`#preview-ownership-and-keying`) | kept | Now an H3 under Details (same slug). |
| Security model (`#security-model`) | kept | Now an H3 under Details (same slug); absorbs the proxy/theme-bridge description. |
| Settings (`#settings`) | kept | |
| Troubleshooting (`#troubleshooting`) | kept | Moved above Settings (template order). |
| &nbsp;&nbsp;Start with the output channel (`#start-with-the-output-channel`) | kept | |
| &nbsp;&nbsp;The preview panel is blank (`#the-preview-panel-is-blank`) | kept | "injected theme bridge has not confirmed" → "page hasn't responded to Raven". |
| &nbsp;&nbsp;Preview reports HTTP 404 (`#preview-reports-http-404`) | kept | |
| Limitations (`#limitations`) | kept | |

### docs/keybinding-comparison.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) Chunk Keybinding Comparison (`#chunk-keybinding-comparison`) | kept | Sentence case, same slug. Reference breadcrumb; lead sentence added. |
| Design principles (`#design-principles`) | kept | Bold/em-dash labels rewritten as sentences. |
| Raven keybindings (`#raven-keybindings`) | kept | |
| Cross-tool comparison (`#cross-tool-comparison`) | kept | |
| &nbsp;&nbsp;Execution shortcuts (`#execution-shortcuts`) | kept | |
| &nbsp;&nbsp;Navigation shortcuts (`#navigation-shortcuts`) | kept | |
| &nbsp;&nbsp;Key differences from each tool (`#key-differences-from-each-tool`) | kept | "**vs. X** —" labels → "X is/uses …" sentences. |
| Migration notes (`#migration-notes`) | kept | "previously used in Raven" → "in earlier Raven versions". |

## Batch G

### docs/comparison.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Language intelligence (`#language-intelligence`) | kept | comparison.md#language-intelligence. Air/Jarl paragraph moved to new `## Linters and formatters` (same page) with a lintr/Jarl/Air table. |
| &nbsp;&nbsp;When to choose Raven for language intelligence (`#when-to-choose-raven-for-language-intelligence`) | kept | Same heading. Ark source line-range links replaced by "As of this writing, Ark …" statements; Ark repo root linked in the at-a-glance table. Long paragraph split. |
| &nbsp;&nbsp;Why Raven exists (`#why-raven-exists`) | kept | Promoted to H2 near the top (slug unchanged). Single detailed home of the four "why static analysis" consequences; first person ("I'd written") rewritten as "its author". |
| &nbsp;&nbsp;What REditorSupport's language server offers that Raven doesn't (`#what-reditorsupports-language-server-offers-that-raven-doesnt`) | kept | Same heading. |
| R session integration (`#r-session-integration`) | kept | "We chose … our team" rewritten in third person; "these comparisons are based on reading upstream sources" note moved up under the at-a-glance table. |
| &nbsp;&nbsp;R console (`#r-console`) | kept | `vscode-R/src/rTerminal.ts` link text became "Its terminal code"; arf issue number dropped from link text. |
| &nbsp;&nbsp;Debugger (`#debugger`) | kept | Unchanged table. |
| &nbsp;&nbsp;Data viewer (`#data-viewer`) | kept | Split into short paragraphs; filtering prose became a table plus one Raven paragraph. "our own smoke tests" → "Raven's smoke tests". |
| &nbsp;&nbsp;Hover help (`#hover-help`) | kept | |
| &nbsp;&nbsp;What REditorSupport's VS Code extension offers that Raven doesn't (`#what-reditorsupports-vs-code-extension-offers-that-raven-doesnt`) | kept | |
| Coexistence (`#coexistence`) | duplicate | coexistence.md. Anchor kept as `<a id="coexistence">` above `## See also`, which links coexistence.md. |
| (H1) Comparison with Other R Tools (`#comparison-with-other-r-tools`) | kept | H1 renamed to manifest title "How Raven compares"; old slug kept as `<a id>` at the end of the lead line. |

### docs/coexistence.md

| Section | Disposition | Destination / notes |
|---|---|---|
| (H1) Coexistence with Other R Extensions (`#coexistence-with-other-r-extensions`) | kept | H1 renamed to manifest title "Using Raven with other R tools"; old slug as `<a id>` on the lead line. Activation matrix added as the example. |
| The raven.rConsole.activation setting (`#the-ravenrconsoleactivation-setting`) | kept | Same heading; now the single home of `raven.rConsole.activation`. Gathered: reload-window prompt and re-evaluation when vscode-R is enabled/disabled (from extension code), "no separate plot/data viewer toggle" (plot-viewer.md, data-viewer.md), R package build commands gated (r-package-dev.md), Markdown `.md` Run Chunk lens gated (chunks.md), `raven.rmdKnit.enabled` (old coexistence text). New `## Why Raven's console stepped aside` landing section for the notification/setting-description link. |
| What steps aside and what doesn't (`#what-steps-aside-and-what-doesnt`) | kept | Now H3 under the setting; merged with the old "unaffected" paragraph and snippets.md facts. |
| Who benefits from Raven's R console? (`#who-benefits-from-ravens-r-console`) | kept | H3, question mark dropped (slug unchanged). |
| Language servers: Raven alone vs. both (`#language-servers-raven-alone-vs-both`) | kept | H3 under new `## Run Raven next to vscode-R` with a recipes table (`r.lsp.enabled`, `r.lsp.diagnostics`, `raven.linting.enabled`, `raven.rConsole.activation`). |
| Coexistence with the Quarto extension (`#coexistence-with-the-quarto-extension`) | kept | Renamed `## Run Raven next to the Quarto extension`; old slug as `<a id>`. Upstream-fix rationale moved into a `<details>` under `## Details`. |
| &nbsp;&nbsp;.Rmd / .Rmarkdown files belong to the rmd language (`#rmd--rmarkdown-files-belong-to-the-rmd-language`) | kept | Same heading; short use-it text kept, resolver/`editorLangId` mechanics moved into a `<details>` under `## Details`. |
| (new) Run Raven in Positron; Run Raven next to lintr, Jarl, or Air; Settings; See also | new | |

### docs/limitations.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Language server (`#language-server`) | kept | One/two-sentence items; Stan, native-routine, symlink, and member-navigation exact rules into a `<details>`. Internal wording (URI spellings, graph, caches, indexes) restated as user behavior. |
| box module system (box::use) (`#box-module-system-boxuse`) | kept | Bulleted; case/ambiguity rules into `<details>`. |
| import package (`#import-package`) | kept | Bulleted; unmodeled-argument list and export-completeness rule into `<details>`. |
| targets and tarchetypes (`#targets-and-tarchetypes`) | kept | Bulleted; exact `tar_map()`, report, `tar_load()` rules into `<details>`. |
| R6 classes (`#r6-classes`) | kept | Bulleted; inherited-member exclusions and 32-class / 4,096-entry bounds into `<details>`. |
| R Markdown / Quarto (`#r-markdown--quarto`) | kept | Bulleted; knitr comparison and Quarto Preview specifics into `<details>`. |
| R-session features (`#r-session-features`) | kept | |
