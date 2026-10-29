# Ledger: batch G

## docs/comparison.md

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

## docs/coexistence.md

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

## docs/limitations.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Language server (`#language-server`) | kept | One/two-sentence items; Stan, native-routine, symlink, and member-navigation exact rules into a `<details>`. Internal wording (URI spellings, graph, caches, indexes) restated as user behavior. |
| box module system (box::use) (`#box-module-system-boxuse`) | kept | Bulleted; case/ambiguity rules into `<details>`. |
| import package (`#import-package`) | kept | Bulleted; unmodeled-argument list and export-completeness rule into `<details>`. |
| targets and tarchetypes (`#targets-and-tarchetypes`) | kept | Bulleted; exact `tar_map()`, report, `tar_load()` rules into `<details>`. |
| R6 classes (`#r6-classes`) | kept | Bulleted; inherited-member exclusions and 32-class / 4,096-entry bounds into `<details>`. |
| R Markdown / Quarto (`#r-markdown--quarto`) | kept | Bulleted; knitr comparison and Quarto Preview specifics into `<details>`. |
| R-session features (`#r-session-features`) | kept | |
