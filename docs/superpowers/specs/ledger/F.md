# Ledger: batch F

## docs/r-console.md

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

## docs/debugger.md

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

## docs/plot-viewer.md

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

## docs/data-viewer.md

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

## docs/help-viewer.md

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

## docs/chunks.md

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

## docs/knit.md

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

## docs/quarto.md

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

## docs/keybinding-comparison.md

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
