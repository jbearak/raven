# Development moves: batch E

## From docs/hover.md

- R hover resolution order is implemented in `crates/raven/src/handlers.rs::hover` (the user page used to say so). Keep `docs/hover.md` § Resolution order in sync with that function.
- Hover and the diagnostics pass share the structural-label predicate (`is_structural_non_reference`); hover layers its own "resolve-or-suppress, never resolve-or-attribute" carve-outs on top (named-argument → user formal, parameter → `@param`, local `$`/`@` member via the go-to-definition resolver). The rule exists to prevent the old misleading `from {base}` attribution on labels.
- JAGS signature help tracks call context lexically, uses UTF-16 cursor positions, and never consults the temporary R parse tree or starts R/JAGS subprocesses.

## From docs/syntax-highlighting.md

- R semantic tokens come from the tree-sitter parse; in `.Rmd`/`.qmd` the document is walked with the same chunk detector the outline uses, each R chunk body is parsed in isolation, and tokens are rebased onto document coordinates.
- Vendored grammars live in `editors/vscode/syntaxes/r.tmLanguage.json` and `editors/vscode/syntaxes/rmd.tmLanguage.json`; provenance and the sync procedure are in `editors/vscode/syntaxes/SOURCE.md`. Background: `vscode.r` and `REditorSupport.r-syntax` have no `main`, so VS Code defaults them to `extensionKind: "ui"`; the built-in is synced from REditorSupport via `vscode-grammar-updater`.
- `contributes.grammars` maps the `quarto` language ID to the vendored R Markdown grammar (`text.html.markdown.rmarkdown`). The old user page said "Raven does not ship a quarto grammar"; the rewritten page now says `.qmd` falls back to the R Markdown grammar.

## From docs/document-outline.md

- JAGS/Stan block detection is text-based pattern matching with brace-depth tracking (unclosed block extends to EOF).
- The old troubleshooting step "status bar shows Raven" had no backing code: the extension creates no status-bar item for the language server (only the debugger's breakpoint item). The user page now points at the **Raven** output channel.

## From docs/indentation.md

- Syntax-aware indentation is the LSP `textDocument/onTypeFormatting` handler (first trigger `\n`, more triggers `)`, `]`, `}`), sharing the indentation lint's structural analysis. It returns no edits when the client inserts tabs.
