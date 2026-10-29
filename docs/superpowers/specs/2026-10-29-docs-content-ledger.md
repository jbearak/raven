# Docs redesign: content-preservation ledger

Base: `6c7871aac52a75305cb9996412e905e7524618a0`. One row per H2/H3 section at the base commit. Disposition is one of: **kept**, **moved** (destination `page#anchor`), **internal** (moved to development.md), or **duplicate** (destination is the surviving home). Nothing is dropped unless it is a duplicate or internal.

## README.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Features (`#features`) | | |
| &nbsp;&nbsp;Code intelligence (`#code-intelligence`) | | |
| &nbsp;&nbsp;R session integration (`#r-session-integration`) | | |
| How Raven Differs (`#how-raven-differs`) | | |
| Installation (`#installation`) | | |
| &nbsp;&nbsp;Editors (`#editors`) | | |
| &nbsp;&nbsp;Command line (`#command-line`) | | |
| &nbsp;&nbsp;CI (`#ci`) | | |
| Documentation (`#documentation`) | | |
| Development (`#development`) | | |
| Provenance (`#provenance`) | | |
| License (`#license`) | | |

## editors/vscode/README.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Features (`#features`) | | |
| &nbsp;&nbsp;Code intelligence (`#code-intelligence`) | | |
| &nbsp;&nbsp;R session integration (`#r-session-integration`) | | |
| Settings (`#settings`) | | |
| Coexistence with vscode-R and Positron (`#coexistence-with-vscode-r-and-positron`) | | |
| More Information (`#more-information`) | | |
| License (`#license`) | | |

## docs/editor-integrations.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Getting the binary (`#getting-the-binary`) | | |
| VS Code (`#vs-code`) | | |
| Zed (`#zed`) | | |
| Neovim (`#neovim`) | | |
| Generic LSP Client (`#generic-lsp-client`) | | |
| Agent Integration (`#agent-integration`) | | |
| &nbsp;&nbsp;Claude Code (`#claude-code`) | | |
| &nbsp;&nbsp;OpenCode (`#opencode`) | | |
| &nbsp;&nbsp;Kiro CLI (`#kiro-cli`) | | |
| &nbsp;&nbsp;Crush (`#crush`) | | |
| Project configuration (`#project-configuration`) | | |
| Troubleshooting (`#troubleshooting`) | | |

## docs/ci.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Recommended setup (`#recommended-setup`) | | |
| GitHub Actions (`#github-actions`) | | |
| Bitbucket Pipelines (`#bitbucket-pipelines`) | | |
| Running Raven and Sight together (`#running-raven-and-sight-together`) | | |
| &nbsp;&nbsp;GitHub Actions (`#github-actions-1`) | | |
| &nbsp;&nbsp;Bitbucket Pipelines (`#bitbucket-pipelines-1`) | | |
| What fails the build (`#what-fails-the-build`) | | |

## docs/diagnostics.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Quick Reference (`#quick-reference`) | | |
| Diagnostic codes (`#diagnostic-codes`) | | |
| Suppressing diagnostics (`#suppressing-diagnostics`) | | |
| Diagnostic Categories (`#diagnostic-categories`) | | |
| &nbsp;&nbsp;Parse Errors (`#parse-errors`) | | |
| &nbsp;&nbsp;JAGS and Stan Parse Errors (`#jags-and-stan-parse-errors`) | | |
| &nbsp;&nbsp;Stan Undeclared Variables (`#stan-undeclared-variables`) | | |
| &nbsp;&nbsp;Undefined Variables (`#undefined-variables`) | | |
| &nbsp;&nbsp;Package Diagnostics (`#package-diagnostics`) | | |
| &nbsp;&nbsp;Package names vs. install status (`#package-names-vs-install-status`) | | |
| &nbsp;&nbsp;Namespace member references (pkg::member) (`#namespace-member-references-pkgmember`) | | |
| &nbsp;&nbsp;Cross-File Diagnostics (`#cross-file-diagnostics`) | | |
| &nbsp;&nbsp;Assignment Targets (`#assignment-targets`) | | |
| &nbsp;&nbsp;Semantic Warnings (`#semantic-warnings`) | | |
| &nbsp;&nbsp;Style Lints (`#style-lints`) | | |
| Suppression (`#suppression`) | | |
| &nbsp;&nbsp;Per-Line: # raven: ignore (`#per-line--raven-ignore`) | | |
| &nbsp;&nbsp;Per-Symbol: Declaration Directives (`#per-symbol-declaration-directives`) | | |
| &nbsp;&nbsp;Per-Category: Configuration (`#per-category-configuration`) | | |
| Cross-File Behavior (`#cross-file-behavior`) | | |
| JAGS and Stan (`#jags-and-stan`) | | |
| R Markdown and Quarto (`#r-markdown-and-quarto`) | | |
| &nbsp;&nbsp;Parameterized reports (params) (`#parameterized-reports-params`) | | |

## docs/cross-file.md

| Section | Disposition | Destination / notes |
|---|---|---|
| How It Works (`#how-it-works`) | | |
| Automatic source() Detection (`#automatic-source-detection`) | | |
| &nbsp;&nbsp;Shiny application loading (`#shiny-application-loading`) | | |
| &nbsp;&nbsp;R Markdown / Quarto chunks (`#r-markdown--quarto-chunks`) | | |
| Package Awareness (`#package-awareness`) | | |
| &nbsp;&nbsp;How It Works (`#how-it-works-1`) | | |
| &nbsp;&nbsp;When Raven calls R (`#when-raven-calls-r`) | | |
| &nbsp;&nbsp;Resolving exports without R (`#resolving-exports-without-r`) | | |
| &nbsp;&nbsp;Base Packages (`#base-packages`) | | |
| &nbsp;&nbsp;devtools::load_all() — Virtual Attached Package (`#devtoolsload_all--virtual-attached-package`) | | |
| &nbsp;&nbsp;Position-Aware Loading (`#position-aware-loading`) | | |
| &nbsp;&nbsp;Function-Scoped Loading (`#function-scoped-loading`) | | |
| &nbsp;&nbsp;Meta-Package Support (`#meta-package-support`) | | |
| &nbsp;&nbsp;Availability vs. ownership (`#availability-vs-ownership`) | | |
| &nbsp;&nbsp;Cross-File Package Propagation (`#cross-file-package-propagation`) | | |
| &nbsp;&nbsp;Supported Call Patterns (`#supported-call-patterns`) | | |
| &nbsp;&nbsp;Apply-Family Loads (`#apply-family-loads`) | | |
| &nbsp;&nbsp;Deterministic Package-Loader Loops (`#deterministic-package-loader-loops`) | | |
| &nbsp;&nbsp;targets::tar_option_set() Worker Packages (`#targetstar_option_set-worker-packages`) | | |
| &nbsp;&nbsp;targets::tar_source() Scripts (`#targetstar_source-scripts`) | | |
| &nbsp;&nbsp;tarchetypes target factories and report documents (`#tarchetypes-target-factories-and-report-documents`) | | |
| &nbsp;&nbsp;Keeping Packages in Sync (`#keeping-packages-in-sync`) | | |
| Module & import systems (`#module--import-systems`) | | |
| NSE directive propagation (`#nse-directive-propagation`) | | |
| Self-contained sourced files (# raven: self-contained) (`#self-contained-sourced-files--raven-self-contained`) | | |
| Position-Aware Scope (`#position-aware-scope`) | | |
| Symbol Recognition (`#symbol-recognition`) | | |
| &nbsp;&nbsp;Symbol Removal (rm/remove) (`#symbol-removal-rmremove`) | | |
| How This Feeds Into Features (`#how-this-feeds-into-features`) | | |
| Advanced (`#advanced`) | | |
| &nbsp;&nbsp;Backward Dependency Modes (`#backward-dependency-modes`) | | |
| &nbsp;&nbsp;Open buffers, disk state, and closing files (`#open-buffers-disk-state-and-closing-files`) | | |
| &nbsp;&nbsp;Traversal budgets in large workspaces (`#traversal-budgets-in-large-workspaces`) | | |
| &nbsp;&nbsp;Path Resolution (`#path-resolution`) | | |
| &nbsp;&nbsp;Global Symbol Hoisting (`#global-symbol-hoisting`) | | |
| &nbsp;&nbsp;$ and @ Member Resolution (`#-and--member-resolution`) | | |

## docs/non-standard-evaluation.md

| Section | Disposition | Destination / notes |
|---|---|---|
| What Raven Checks (`#what-raven-checks`) | | |
| How Raven Recognizes NSE (`#how-raven-recognizes-nse`) | | |
| When Raven Needs a Hint (`#when-raven-needs-a-hint`) | | |
| Declaring NSE From a Package (`#declaring-nse-from-a-package`) | | |
| &nbsp;&nbsp;Declaring data.table-style [ semantics (`#declaring-datatable-style--semantics`) | | |
| Choosing the Right Escape Hatch (`#choosing-the-right-escape-hatch`) | | |
| Limitations (`#limitations`) | | |
| Toward NSE Metadata (`#toward-nse-metadata`) | | |

## docs/r-package-dev.md

| Section | Disposition | Destination / notes |
|---|---|---|
| How It Works (`#how-it-works`) | | |
| What's Supported (`#whats-supported`) | | |
| &nbsp;&nbsp;Mutual Visibility (`#mutual-visibility`) | | |
| &nbsp;&nbsp;Internal data (R/sysdata.rda) (`#internal-data-rsysdatarda`) | | |
| &nbsp;&nbsp;Namespace runtime bindings (`#namespace-runtime-bindings`) | | |
| &nbsp;&nbsp;Non-portable R6 classes (`#non-portable-r6-classes`) | | |
| &nbsp;&nbsp;Tests directory awareness (`#tests-directory-awareness`) | | |
| &nbsp;&nbsp;Dev-context directories (demo/, data-raw/, vignettes/, man/) (`#dev-context-directories-demo-data-raw-vignettes-man`) | | |
| &nbsp;&nbsp;Scripts that call devtools::load_all() (`#scripts-that-call-devtoolsload_all`) | | |
| Ordinary scripts in package workspaces (`#ordinary-scripts-in-package-workspaces`) | | |
| &nbsp;&nbsp;load_all() vs. library() (`#load_all-vs-library`) | | |
| &nbsp;&nbsp;Build commands (`#build-commands`) | | |
| &nbsp;&nbsp;testthat problem matcher (`#testthat-problem-matcher`) | | |
| &nbsp;&nbsp;Roxygen Namespace Tags (`#roxygen-namespace-tags`) | | |
| &nbsp;&nbsp;NAMESPACE + roxygen merge (`#namespace--roxygen-merge`) | | |
| &nbsp;&nbsp;data.table [ detection in package mode (`#datatable--detection-in-package-mode`) | | |
| &nbsp;&nbsp;Shipping NSE metadata with your package (`#shipping-nse-metadata-with-your-package`) | | |
| &nbsp;&nbsp;Live Updates (`#live-updates`) | | |
| Generating a package database for CI (`#generating-a-package-database-for-ci`) | | |
| Configuration (`#configuration`) | | |
| Comparison with Script Mode (`#comparison-with-script-mode`) | | |
| Behavior: Non-Package NAMESPACE Files (`#behavior-non-package-namespace-files`) | | |
| &nbsp;&nbsp;NAMESPACE without DESCRIPTION no longer suppresses diagnostics (`#namespace-without-description-no-longer-suppresses-diagnostics`) | | |
| Known Limitations (`#known-limitations`) | | |
| Troubleshooting (`#troubleshooting`) | | |

## docs/modules.md

| Section | Disposition | Destination / notes |
|---|---|---|
| box modules (box::use()) (`#box-modules-boxuse`) | | |
| import package (import::from()) (`#import-package-importfrom`) | | |
| What is not covered (`#what-is-not-covered`) | | |

## docs/rprofile.md

| Section | Disposition | Destination / notes |
|---|---|---|
| What Raven Reads (`#what-raven-reads`) | | |
| What Contributes To Scope (`#what-contributes-to-scope`) | | |
| devtools::load_all() in .Rprofile (`#devtoolsload_all-in-rprofile`) | | |
| Where It Applies (`#where-it-applies`) | | |
| Safety Model (`#safety-model`) | | |
| Live Updates (`#live-updates`) | | |
| Configuration (`#configuration`) | | |
| Static box search paths (`#static-box-search-paths`) | | |

## docs/linting.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Quick start (`#quick-start`) | | |
| Master switch (raven.linting.enabled) (`#master-switch-ravenlintingenabled`) | | |
| &nbsp;&nbsp;Behavior matrix (`#behavior-matrix`) | | |
| &nbsp;&nbsp;"auto" and REditorSupport / Positron (`#auto-and-reditorsupport--positron`) | | |
| Settings reference by rule (`#settings-reference-by-rule`) | | |
| &nbsp;&nbsp;Line length (`#line-length`) | | |
| &nbsp;&nbsp;Trailing whitespace (`#trailing-whitespace`) | | |
| &nbsp;&nbsp;Tab characters (`#tab-characters`) | | |
| &nbsp;&nbsp;Trailing blank lines (`#trailing-blank-lines`) | | |
| &nbsp;&nbsp;Assignment operator (`#assignment-operator`) | | |
| &nbsp;&nbsp;Object names (`#object-names`) | | |
| &nbsp;&nbsp;Infix spaces (`#infix-spaces`) | | |
| &nbsp;&nbsp;Commented code (`#commented-code`) | | |
| &nbsp;&nbsp;Quotes (`#quotes`) | | |
| &nbsp;&nbsp;Commas (`#commas`) | | |
| &nbsp;&nbsp;T / F symbol (`#t--f-symbol`) | | |
| &nbsp;&nbsp;Semicolon (`#semicolon`) | | |
| &nbsp;&nbsp;Equals NA (`#equals-na`) | | |
| &nbsp;&nbsp;Object length (`#object-length`) | | |
| &nbsp;&nbsp;Vector logic (`#vector-logic`) | | |
| &nbsp;&nbsp;Function left parentheses (`#function-left-parentheses`) | | |
| &nbsp;&nbsp;Spaces inside (`#spaces-inside`) | | |
| &nbsp;&nbsp;Indentation (`#indentation`) | | |
| Migrating from .lintr (`#migrating-from-lintr`) | | |
| &nbsp;&nbsp;Exclusions (`#exclusions`) | | |
| Gaps vs lintr (`#gaps-vs-lintr`) | | |
| &nbsp;&nbsp;Filling the gaps with lintr itself (`#filling-the-gaps-with-lintr-itself`) | | |
| Suppression matrix (`#suppression-matrix`) | | |
| Performance and scope notes (`#performance-and-scope-notes`) | | |
| See also (`#see-also`) | | |

## docs/indentation.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Overview (`#overview`) | | |
| Configuration (`#configuration`) | | |
| &nbsp;&nbsp;Auto-indentation settings (`#auto-indentation-settings`) | | |
| &nbsp;&nbsp;Corresponding lint settings (`#corresponding-lint-settings`) | | |
| &nbsp;&nbsp;Why Raven's defaults differ (`#why-ravens-defaults-differ`) | | |
| &nbsp;&nbsp;Permanent compatibility alias (`#permanent-compatibility-alias`) | | |
| &nbsp;&nbsp;Disabling syntax-aware indentation (`#disabling-syntax-aware-indentation`) | | |
| Infix examples (`#infix-examples`) | | |
| Assignment continuations (`#assignment-continuations`) | | |
| Brace blocks (`#brace-blocks`) | | |
| When syntax-aware indentation cannot answer (`#when-syntax-aware-indentation-cannot-answer`) | | |
| Troubleshooting (`#troubleshooting`) | | |

## docs/completion.md

| Section | Disposition | Destination / notes |
|---|---|---|
| What's Offered (`#whats-offered`) | | |
| Position-Aware Filtering (`#position-aware-filtering`) | | |
| Package Completions (`#package-completions`) | | |
| &nbsp;&nbsp;Namespace-Qualified Completions (pkg::) (`#namespace-qualified-completions-pkg`) | | |
| &nbsp;&nbsp;box Namespace and Attached Completions (`#box-namespace-and-attached-completions`) | | |
| Function Parameter Completions (`#function-parameter-completions`) | | |
| File Path Completions (`#file-path-completions`) | | |
| $ Member Completions (`#-member-completions`) | | |
| Cross-File Completions (`#cross-file-completions`) | | |
| R Markdown / Quarto (`#r-markdown--quarto`) | | |
| JAGS and Stan (`#jags-and-stan`) | | |
| Scope Rules Summary (`#scope-rules-summary`) | | |

## docs/hover.md

| Section | Disposition | Destination / notes |
|---|---|---|
| What You See (`#what-you-see`) | | |
| JAGS Hover (`#jags-hover`) | | |
| Stan Hover (`#stan-hover`) | | |
| Resolution Order (`#resolution-order`) | | |
| &nbsp;&nbsp;box module members (`#box-module-members`) | | |
| File Location Lines (`#file-location-lines`) | | |
| Declared Symbols (`#declared-symbols`) | | |
| Package Exports and the Help-Panel Link (`#package-exports-and-the-help-panel-link`) | | |
| Scope-Aware Package Attribution (`#scope-aware-package-attribution`) | | |
| With REditorSupport Also Installed (`#with-reditorsupport-also-installed`) | | |
| Limits (`#limits`) | | |
| Related (`#related`) | | |

## docs/go-to-definition.md

| Section | Disposition | Destination / notes |
|---|---|---|
| What You Can Jump To (`#what-you-can-jump-to`) | | |
| Position-Aware Resolution (`#position-aware-resolution`) | | |
| Cross-File Navigation (`#cross-file-navigation`) | | |
| $ and @ Member Resolution (`#-and--member-resolution`) | | |
| Declared Symbols (`#declared-symbols`) | | |
| File Path Navigation (`#file-path-navigation`) | | |
| &nbsp;&nbsp;box module paths and exports (`#box-module-paths-and-exports`) | | |
| load_all() Internals (`#load_all-internals`) | | |
| Package Exports (`#package-exports`) | | |
| R Markdown and Quarto (`#r-markdown-and-quarto`) | | |
| JAGS and Stan (`#jags-and-stan`) | | |
| Related (`#related`) | | |

## docs/find-references.md

| Section | Disposition | Destination / notes |
|---|---|---|
| How It Works (`#how-it-works`) | | |
| Cross-File Scoping (`#cross-file-scoping`) | | |
| Scope and pooling (`#scope-and-pooling`) | | |
| &nbsp;&nbsp;Selective-import member identity (`#selective-import-member-identity`) | | |
| Workspace Symbols (Cmd/Ctrl+T) (`#workspace-symbols-cmdctrlt`) | | |
| JAGS and Stan (`#jags-and-stan`) | | |
| Go-to-Definition (`#go-to-definition`) | | |

## docs/document-outline.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Overview (`#overview`) | | |
| Accessing the Outline (`#accessing-the-outline`) | | |
| R Code Sections (`#r-code-sections`) | | |
| &nbsp;&nbsp;Section Syntax (`#section-syntax`) | | |
| &nbsp;&nbsp;Heading Levels (`#heading-levels`) | | |
| &nbsp;&nbsp;Section Ranges (`#section-ranges`) | | |
| &nbsp;&nbsp;Invalid Sections (`#invalid-sections`) | | |
| R Markdown / Quarto Chunks (`#r-markdown--quarto-chunks`) | | |
| R Markdown / Quarto Headings (`#r-markdown--quarto-headings`) | | |
| Methods (`#methods`) | | |
| &nbsp;&nbsp;# %% cells in .R files (`#--cells-in-r-files`) | | |
| Symbol Types (`#symbol-types`) | | |
| &nbsp;&nbsp;Functions (`#functions`) | | |
| &nbsp;&nbsp;Variables (`#variables`) | | |
| &nbsp;&nbsp;Value-typed variables (`#value-typed-variables`) | | |
| &nbsp;&nbsp;Constants (`#constants`) | | |
| &nbsp;&nbsp;Classes (`#classes`) | | |
| &nbsp;&nbsp;Methods (`#methods-1`) | | |
| &nbsp;&nbsp;Generics (`#generics`) | | |
| Hierarchical Nesting (`#hierarchical-nesting`) | | |
| JAGS and Stan Model Structure (`#jags-and-stan-model-structure`) | | |
| &nbsp;&nbsp;JAGS Blocks (`#jags-blocks`) | | |
| &nbsp;&nbsp;Stan Blocks (`#stan-blocks`) | | |
| &nbsp;&nbsp;Decorative Comment Headings (`#decorative-comment-headings`) | | |
| &nbsp;&nbsp;Loops (`#loops`) | | |
| &nbsp;&nbsp;Example (`#example`) | | |
| Workspace Symbol Search (`#workspace-symbol-search`) | | |
| Configuration (`#configuration`) | | |
| &nbsp;&nbsp;Workspace Symbol Limit (`#workspace-symbol-limit`) | | |
| Examples (`#examples`) | | |
| &nbsp;&nbsp;Organizing a Large Analysis Script (`#organizing-a-large-analysis-script`) | | |
| Troubleshooting (`#troubleshooting`) | | |
| &nbsp;&nbsp;Outline view is empty (`#outline-view-is-empty`) | | |
| &nbsp;&nbsp;Sections not appearing in outline (`#sections-not-appearing-in-outline`) | | |
| &nbsp;&nbsp;Symbols showing at wrong level (`#symbols-showing-at-wrong-level`) | | |
| &nbsp;&nbsp;Workspace symbol search returns too few results (`#workspace-symbol-search-returns-too-few-results`) | | |
| &nbsp;&nbsp;Wrong symbol type/icon (`#wrong-symbol-typeicon`) | | |

## docs/syntax-highlighting.md

| Section | Disposition | Destination / notes |
|---|---|---|
| R (`#r`) | | |
| Rendered HTML (Raven: Knit Preview) (`#rendered-html-raven-knit-preview`) | | |
| &nbsp;&nbsp;Why Raven vendors the R and R Markdown grammars (`#why-raven-vendors-the-r-and-r-markdown-grammars`) | | |
| R Package Development Files (`#r-package-development-files`) | | |
| &nbsp;&nbsp;DCF (DESCRIPTION, .Rproj, .lintr) (`#dcf-description-rproj-lintr`) | | |
| &nbsp;&nbsp;NAMESPACE (`#namespace`) | | |
| &nbsp;&nbsp;Rd (.Rd, .rd) (`#rd-rd-rd`) | | |
| &nbsp;&nbsp;.Rbuildignore (`#rbuildignore`) | | |
| JAGS and Stan (`#jags-and-stan`) | | |
| &nbsp;&nbsp;JAGS (`#jags`) | | |
| &nbsp;&nbsp;Stan (`#stan`) | | |

## docs/snippets.md

| Section | Disposition | Destination / notes |
|---|---|---|
| R Markdown and Quarto (`#r-markdown-and-quarto`) | | |

## docs/r-console.md

| Section | Disposition | Destination / notes |
|---|---|---|
| R Terminal Profile (`#r-terminal-profile`) | | |
| &nbsp;&nbsp;Choosing the R program (`#choosing-the-r-program`) | | |
| Raven's console (`#ravens-console`) | | |
| &nbsp;&nbsp;Editing (`#editing`) | | |
| &nbsp;&nbsp;Completion (`#completion`) | | |
| &nbsp;&nbsp;Colored output (`#colored-output`) | | |
| &nbsp;&nbsp;Running code from the editor (`#running-code-from-the-editor`) | | |
| &nbsp;&nbsp;Debugging (`#debugging`) | | |
| &nbsp;&nbsp;Outside VS Code (`#outside-vs-code`) | | |
| Keyboard Shortcuts (`#keyboard-shortcuts`) | | |
| Commands (`#commands`) | | |
| &nbsp;&nbsp;Quick Inspection Commands (`#quick-inspection-commands`) | | |
| Editor Toolbar (`#editor-toolbar`) | | |
| Statement Detection (`#statement-detection`) | | |
| Cursor Advancement (`#cursor-advancement`) | | |
| Send Method (`#send-method`) | | |
| &nbsp;&nbsp;Why auto switches to a temp file for larger blocks (`#why-auto-switches-to-a-temp-file-for-larger-blocks`) | | |
| Configuration Options (`#configuration-options`) | | |

## docs/debugger.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Getting started (`#getting-started`) | | |
| What you can do while stopped (`#what-you-can-do-while-stopped`) | | |
| Breakpoints (`#breakpoints`) | | |
| &nbsp;&nbsp;When a breakpoint takes effect (`#when-a-breakpoint-takes-effect`) | | |
| &nbsp;&nbsp;Stepping (`#stepping`) | | |
| Errors, warnings and interrupts (`#errors-warnings-and-interrupts`) | | |
| Hover and the Variables view never run your code (`#hover-and-the-variables-view-never-run-your-code`) | | |
| Settings (`#settings`) | | |
| What the debugger changes in your R session (`#what-the-debugger-changes-in-your-r-session`) | | |
| Limitations (`#limitations`) | | |

## docs/plot-viewer.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Prerequisites (`#prerequisites`) | | |
| Behavior (`#behavior`) | | |
| Color theme (`#color-theme`) | | |
| &nbsp;&nbsp;Known limitations (`#known-limitations`) | | |
| &nbsp;&nbsp;Substrate (for the curious) (`#substrate-for-the-curious`) | | |
| Settings (`#settings`) | | |
| Troubleshooting (`#troubleshooting`) | | |

## docs/data-viewer.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Why we built this (`#why-we-built-this`) | | |
| What it shows (`#what-it-shows`) | | |
| Triggering (`#triggering`) | | |
| Toolbar (`#toolbar`) | | |
| &nbsp;&nbsp;Labels (`#labels`) | | |
| &nbsp;&nbsp;Format (`#format`) | | |
| &nbsp;&nbsp;Columns popover (`#columns-popover`) | | |
| &nbsp;&nbsp;Selection and copy (`#selection-and-copy`) | | |
| &nbsp;&nbsp;Keyboard shortcuts (`#keyboard-shortcuts`) | | |
| Sorting (`#sorting`) | | |
| &nbsp;&nbsp;NA / NaN (`#na--nan`) | | |
| &nbsp;&nbsp;Labels and Format (`#labels-and-format`) | | |
| &nbsp;&nbsp;Persistence (`#persistence`) | | |
| &nbsp;&nbsp;Reopening with a saved sort or filter (`#reopening-with-a-saved-sort-or-filter`) | | |
| &nbsp;&nbsp;Sort indicator (`#sort-indicator`) | | |
| Filtering (`#filtering`) | | |
| &nbsp;&nbsp;Per-type predicates (`#per-type-predicates`) | | |
| &nbsp;&nbsp;NA / NaN (`#na--nan-1`) | | |
| &nbsp;&nbsp;Labels and Format (`#labels-and-format-1`) | | |
| &nbsp;&nbsp;Chip strip (`#chip-strip`) | | |
| &nbsp;&nbsp;Composition (`#composition`) | | |
| &nbsp;&nbsp;Filter indicator (`#filter-indicator`) | | |
| &nbsp;&nbsp;Persistence (`#persistence-1`) | | |
| &nbsp;&nbsp;Keyboard shortcuts (`#keyboard-shortcuts-1`) | | |
| Settings (`#settings`) | | |
| How it works (`#how-it-works`) | | |
| Requirements (`#requirements`) | | |
| Troubleshooting (`#troubleshooting`) | | |

## docs/help-viewer.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Why we built this (`#why-we-built-this`) | | |
| How to open it (`#how-to-open-it`) | | |
| Navigation (`#navigation`) | | |
| What works (`#what-works`) | | |
| v1 Limitations (`#v1-limitations`) | | |
| Configuration (`#configuration`) | | |
| Manual smoke test plan (`#manual-smoke-test-plan`) | | |

## docs/chunks.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Chunk forms (`#chunk-forms`) | | |
| Language features inside chunks (`#language-features-inside-chunks`) | | |
| &nbsp;&nbsp;Cross-file resolution from chunks (`#cross-file-resolution-from-chunks`) | | |
| &nbsp;&nbsp;Suppressing diagnostics in a chunk (`#suppressing-diagnostics-in-a-chunk`) | | |
| Keyboard shortcuts (`#keyboard-shortcuts`) | | |
| Commands (`#commands`) | | |
| CodeLens buttons (`#codelens-buttons`) | | |
| Chunk options (`#chunk-options`) | | |
| Highlighting (`#highlighting`) | | |
| Plain .R cell mode (`#plain-r-cell-mode`) | | |
| &nbsp;&nbsp;Section dividers as cell boundaries (`#section-dividers-as-cell-boundaries`) | | |
| &nbsp;&nbsp;Active-cell border (`#active-cell-border`) | | |
| Limitations (`#limitations`) | | |

## docs/knit.md

| Section | Disposition | Destination / notes |
|---|---|---|
| When the command is available (`#when-the-command-is-available`) | | |
| What it does, step by step (`#what-it-does-step-by-step`) | | |
| Exporting (`#exporting`) | | |
| &nbsp;&nbsp;YAML output options (`#yaml-output-options`) | | |
| Settings (`#settings`) | | |
| &nbsp;&nbsp;Fonts (`#fonts`) | | |
| What Raven does not do (`#what-raven-does-not-do`) | | |

## docs/quarto.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Why Raven includes a Quarto workflow (`#why-raven-includes-a-quarto-workflow`) | | |
| Requirements and Quarto discovery (`#requirements-and-quarto-discovery`) | | |
| Commands (`#commands`) | | |
| &nbsp;&nbsp;Quarto Preview (`#quarto-preview`) | | |
| &nbsp;&nbsp;Stop Quarto Preview (`#stop-quarto-preview`) | | |
| &nbsp;&nbsp;Quarto Render (`#quarto-render`) | | |
| &nbsp;&nbsp;Show Quarto Output (`#show-quarto-output`) | | |
| Apply VS Code theme (`#apply-vs-code-theme`) | | |
| &nbsp;&nbsp;Fonts (`#fonts`) | | |
| Preview ownership and keying (`#preview-ownership-and-keying`) | | |
| Security model (`#security-model`) | | |
| Settings (`#settings`) | | |
| Troubleshooting (`#troubleshooting`) | | |
| &nbsp;&nbsp;Start with the output channel (`#start-with-the-output-channel`) | | |
| &nbsp;&nbsp;The preview panel is blank (`#the-preview-panel-is-blank`) | | |
| &nbsp;&nbsp;Preview reports HTTP 404 (`#preview-reports-http-404`) | | |
| Limitations (`#limitations`) | | |

## docs/directives.md

| Section | Disposition | Destination / notes |
|---|---|---|
| General Syntax (`#general-syntax`) | | |
| Forward Directives (`#forward-directives`) | | |
| Backward Directives (`#backward-directives`) | | |
| Working Directory Directives (`#working-directory-directives`) | | |
| &nbsp;&nbsp;Working Directory Inheritance (`#working-directory-inheritance`) | | |
| Self-Contained Sourced Files (`#self-contained-sourced-files`) | | |
| Declaration Directives (`#declaration-directives`) | | |
| &nbsp;&nbsp;Variable Declarations (`#variable-declarations`) | | |
| &nbsp;&nbsp;Function Declarations (`#function-declarations`) | | |
| &nbsp;&nbsp;NSE Declarations (`#nse-declarations`) | | |
| &nbsp;&nbsp;Position-Aware Behavior (`#position-aware-behavior`) | | |
| &nbsp;&nbsp;Cross-File Inheritance (`#cross-file-inheritance`) | | |
| &nbsp;&nbsp;Use Cases (`#use-cases`) | | |
| Ignore Directives (`#ignore-directives`) | | |
| &nbsp;&nbsp;Line and next-line (`#line-and-next-line`) | | |
| &nbsp;&nbsp;Per-code selector (`#per-code-selector`) | | |
| &nbsp;&nbsp;File and block forms (`#file-and-block-forms`) | | |
| &nbsp;&nbsp;expect — assert that a suppression is used (`#expect--assert-that-a-suppression-is-used`) | | |
| &nbsp;&nbsp;Chunk-level suppression (R Markdown / Quarto) (`#chunk-level-suppression-r-markdown--quarto`) | | |

## docs/configuration.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Project config: raven.toml (`#project-config-raventoml`) | | |
| &nbsp;&nbsp;Discovery (`#discovery`) | | |
| &nbsp;&nbsp;Precedence (`#precedence`) | | |
| &nbsp;&nbsp;Schema (`#schema`) | | |
| &nbsp;&nbsp;Per-file overrides (`#per-file-overrides`) | | |
| &nbsp;&nbsp;Project exclusions (`#project-exclusions`) | | |
| &nbsp;&nbsp;Live reload (`#live-reload`) | | |
| Diagnostics (`#diagnostics`) | | |
| Cross-File Settings (`#cross-file-settings`) | | |
| &nbsp;&nbsp;On-demand indexing (`#on-demand-indexing`) | | |
| &nbsp;&nbsp;Cache sizes (`#cache-sizes`) | | |
| Diagnostic Severity Settings (`#diagnostic-severity-settings`) | | |
| Package Settings (`#package-settings`) | | |
| &nbsp;&nbsp;Refresh Command (`#refresh-command`) | | |
| Scaffold Commands (`#scaffold-commands`) | | |
| R Console Activation (`#r-console-activation`) | | |
| Plot Settings (`#plot-settings`) | | |
| Help Viewer Settings (`#help-viewer-settings`) | | |
| Symbol Settings (`#symbol-settings`) | | |
| Completion Settings (`#completion-settings`) | | |
| Indentation Settings (`#indentation-settings`) | | |
| Linting Settings (`#linting-settings`) | | |
| Editor Integration Settings (VS Code only) (`#editor-integration-settings-vs-code-only`) | | |
| Server Settings (`#server-settings`) | | |
| Box module search paths (`#box-module-search-paths`) | | |

## docs/settings-reference.md

| Section | Disposition | Destination / notes |
|---|---|---|

## docs/cli.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Ubuntu installation (`#ubuntu-installation`) | | |
| Why Raven analyzes R without running it (`#why-raven-analyzes-r-without-running-it`) | | |
| raven check (`#raven-check`) | | |
| &nbsp;&nbsp;Workspace and paths (`#workspace-and-paths`) | | |
| &nbsp;&nbsp;Options (`#options`) | | |
| &nbsp;&nbsp;R and packages (`#r-and-packages`) | | |
| &nbsp;&nbsp;Missing-package reporting in CI (`#missing-package-reporting-in-ci`) | | |
| &nbsp;&nbsp;File encoding (`#file-encoding`) | | |
| &nbsp;&nbsp;Exit codes (`#exit-codes`) | | |
| CI examples (`#ci-examples`) | | |
| &nbsp;&nbsp;Package metadata strategies (`#package-metadata-strategies`) | | |
| &nbsp;&nbsp;GitHub Actions example (`#github-actions-example`) | | |
| &nbsp;&nbsp;Bitbucket Pipelines example (`#bitbucket-pipelines-example`) | | |
| &nbsp;&nbsp;Scope (`#scope`) | | |
| raven lint (`#raven-lint`) | | |
| &nbsp;&nbsp;Options (`#options-1`) | | |
| &nbsp;&nbsp;File encoding (`#file-encoding-1`) | | |
| &nbsp;&nbsp;Exit codes (`#exit-codes-1`) | | |
| &nbsp;&nbsp;GitHub Actions example (`#github-actions-example-1`) | | |
| &nbsp;&nbsp;Scope (`#scope-1`) | | |
| raven console (`#raven-console`) | | |
| raven packages (`#raven-packages`) | | |
| &nbsp;&nbsp;raven packages fetch (`#raven-packages-fetch`) | | |
| &nbsp;&nbsp;raven packages freeze (`#raven-packages-freeze`) | | |
| &nbsp;&nbsp;raven packages update (`#raven-packages-update`) | | |
| Output formats (`#output-formats`) | | |
| &nbsp;&nbsp;Output streams (`#output-streams`) | | |
| Color output (`#color-output`) | | |
| Appendix: maintainer and advanced topics (`#appendix-maintainer-and-advanced-topics`) | | |
| &nbsp;&nbsp;Self-hosting names.db with --base-url (`#self-hosting-namesdb-with---base-url`) | | |
| &nbsp;&nbsp;raven packages build-shipped-db (`#raven-packages-build-shipped-db`) | | |
| &nbsp;&nbsp;raven packages validate-shipped-db (`#raven-packages-validate-shipped-db`) | | |
| &nbsp;&nbsp;raven packages build-embedded-base (`#raven-packages-build-embedded-base`) | | |

## docs/keybinding-comparison.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Design principles (`#design-principles`) | | |
| Raven keybindings (`#raven-keybindings`) | | |
| Cross-tool comparison (`#cross-tool-comparison`) | | |
| &nbsp;&nbsp;Execution shortcuts (`#execution-shortcuts`) | | |
| &nbsp;&nbsp;Navigation shortcuts (`#navigation-shortcuts`) | | |
| &nbsp;&nbsp;Key differences from each tool (`#key-differences-from-each-tool`) | | |
| Migration notes (`#migration-notes`) | | |

## docs/comparison.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Language intelligence (`#language-intelligence`) | | |
| &nbsp;&nbsp;When to choose Raven for language intelligence (`#when-to-choose-raven-for-language-intelligence`) | | |
| &nbsp;&nbsp;Why Raven exists (`#why-raven-exists`) | | |
| &nbsp;&nbsp;What REditorSupport's language server offers that Raven doesn't (`#what-reditorsupports-language-server-offers-that-raven-doesnt`) | | |
| R session integration (`#r-session-integration`) | | |
| &nbsp;&nbsp;R console (`#r-console`) | | |
| &nbsp;&nbsp;Debugger (`#debugger`) | | |
| &nbsp;&nbsp;Data viewer (`#data-viewer`) | | |
| &nbsp;&nbsp;Hover help (`#hover-help`) | | |
| &nbsp;&nbsp;What REditorSupport's VS Code extension offers that Raven doesn't (`#what-reditorsupports-vs-code-extension-offers-that-raven-doesnt`) | | |
| Coexistence (`#coexistence`) | | |

## docs/coexistence.md

| Section | Disposition | Destination / notes |
|---|---|---|
| The raven.rConsole.activation setting (`#the-ravenrconsoleactivation-setting`) | | |
| What steps aside and what doesn't (`#what-steps-aside-and-what-doesnt`) | | |
| Who benefits from Raven's R console? (`#who-benefits-from-ravens-r-console`) | | |
| Language servers: Raven alone vs. both (`#language-servers-raven-alone-vs-both`) | | |
| Coexistence with the Quarto extension (`#coexistence-with-the-quarto-extension`) | | |
| &nbsp;&nbsp;.Rmd / .Rmarkdown files belong to the rmd language (`#rmd--rmarkdown-files-belong-to-the-rmd-language`) | | |

## docs/limitations.md

| Section | Disposition | Destination / notes |
|---|---|---|
| Language server (`#language-server`) | | |
| box module system (box::use) (`#box-module-system-boxuse`) | | |
| import package (`#import-package`) | | |
| targets and tarchetypes (`#targets-and-tarchetypes`) | | |
| R6 classes (`#r6-classes`) | | |
| R Markdown / Quarto (`#r-markdown--quarto`) | | |
| R-session features (`#r-session-features`) | | |

## docs/package-database.md

| Section | Disposition | Destination / notes |
|---|---|---|
| The three tiers (`#the-three-tiers`) | | |
| &nbsp;&nbsp;Exports completeness (`#exports-completeness`) | | |
| Tier 2 — the committed .raven/packages.json (`#tier-2--the-committed-ravenpackagesjson`) | | |
| &nbsp;&nbsp;Generating it (`#generating-it`) | | |
| &nbsp;&nbsp;Regeneration is a no-op when unchanged (`#regeneration-is-a-no-op-when-unchanged`) | | |
| &nbsp;&nbsp;Two producers, one artifact (`#two-producers-one-artifact`) | | |
| &nbsp;&nbsp;Version skew is explained, not silently dropped (`#version-skew-is-explained-not-silently-dropped`) | | |
| Tier 3 — names.db database (`#tier-3--namesdb-database`) | | |
| &nbsp;&nbsp;Data source and acknowledgement (`#data-source-and-acknowledgement`) | | |
| Base packages and datasets (`#base-packages-and-datasets`) | | |
| Names vs. install status (`#names-vs-install-status`) | | |
| Fidelity caveats (`#fidelity-caveats`) | | |
| See also (`#see-also`) | | |

## docs/cross-file-analysis-performance.md

| Section | Disposition | Destination / notes |
|---|---|---|
| What Changes (`#what-changes`) | | |
| Good Fits (`#good-fits`) | | |
| Bad Fits (`#bad-fits`) | | |
| When a File Has External Inputs (`#when-a-file-has-external-inputs`) | | |
| R Workflow Guidance (`#r-workflow-guidance`) | | |
| Syntax (`#syntax`) | | |
| See Also (`#see-also`) | | |

