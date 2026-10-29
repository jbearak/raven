# Ledger: batch E

## docs/editor-integrations.md

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

## docs/indentation.md

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

## docs/completion.md

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

## docs/hover.md

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

## docs/go-to-definition.md

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

## docs/find-references.md

| Section | Disposition | Destination / notes |
|---|---|---|
| How It Works (`#how-it-works`) | kept | slug kept. Lead example is the old Cross-File Scoping example. |
| Cross-File Scoping (`#cross-file-scoping`) | kept | slug kept; example moved to lead. |
| Scope and pooling (`#scope-and-pooling`) | kept | slug kept |
| &nbsp;&nbsp;Selective-import member identity (`#selective-import-member-identity`) | kept | slug kept. The R Markdown blockquote that followed it → new `## R Markdown and Quarto`. |
| Workspace Symbols (Cmd/Ctrl+T) (`#workspace-symbols-cmdctrlt`) | kept | slug kept; setting → `## Settings`; link to document-outline `#workspace-symbol-search`. |
| JAGS and Stan (`#jags-and-stan`) | kept | slug kept |
| Go-to-Definition (`#go-to-definition`) | duplicate | `<a id="go-to-definition">` on `## See also`; the sentence is the See also entry. |

## docs/document-outline.md

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

## docs/syntax-highlighting.md

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

## docs/snippets.md

| Section | Disposition | Destination / notes |
|---|---|---|
| R Markdown and Quarto (`#r-markdown-and-quarto`) | kept | slug kept. Prefix lists expanded into tables from the snippet JSON files. Gating of R snippets in `.Rmd`/`.qmd` on `raven.rConsole.activation` kept as one sentence + coexistence link. Pointers to `editors/vscode/snippets/*.json` dropped (every snippet is now listed). |
| (new) R snippets, Sort or hide snippets, Limitations | new | `editor.snippetSuggestions` advice moved here from editor-integrations.md. |
