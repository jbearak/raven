# Ledger: batch D

## docs/ci.md

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

## docs/linting.md

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

## docs/configuration.md

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

## docs/cli.md

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

## docs/package-database.md

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
