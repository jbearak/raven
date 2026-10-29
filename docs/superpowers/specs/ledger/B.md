# Ledger: batch B

## docs/diagnostics.md

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

### Corpus examples created

`diag-undefined-variable`, `diag-syntax-error`, `diag-chained-comparison`, `diag-unresolved-source-path`, `diag-box-module-not-found`, `diag-box-export-not-found`, `diag-import-module-not-found`, `diag-assign-to-string-literal`, `diag-mixed-logical`, `diag-condition-assignment`, `diag-unused-suppression`, `diag-circular-dependency`, `diag-redundant-directive`, `diag-stan-undeclared-variable` (own `raven.toml`), `diag-jags-syntax-error` (own `raven.toml`), plus for cli.md: `usage-error`, `version`, `check-help`, `check-json`, `exit-on-errors-only`.

### Exempt codes

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
