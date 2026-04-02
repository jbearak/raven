# Bugfix Requirements Document

## Introduction

Go-to-references and find-references (and other tree-dependent LSP features like go-to-definition, hover, and document symbols) do not work in `.jags`, `.bugs`, and `.stan` files. The `parse_document` function in `state.rs` explicitly returns `None` for JAGS and Stan file types, which prevents a tree-sitter AST from being produced. All tree-dependent LSP handlers bail out early when `doc.tree` is `None`, making these features completely non-functional for JAGS/Stan files.

This contradicts the original jags-stan-support design which states: "All other LSP features (find references, go to definition, hover, document symbols) continue to use the R tree-sitter parser unchanged — they already work on a best-effort basis since the parser produces partial ASTs for non-R syntax."

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a find-references request is received for a JAGS file (`.jags` or `.bugs`) THEN the system returns no references because `parse_document` returns `None` and the `references` handler bails out at `doc.tree.as_ref()?`

1.2 WHEN a find-references request is received for a Stan file (`.stan`) THEN the system returns no references because `parse_document` returns `None` and the `references` handler bails out at `doc.tree.as_ref()?`

1.3 WHEN a go-to-definition request is received for a JAGS file THEN the system returns no definition because `parse_document` returns `None` and the `goto_definition` handler bails out at `doc.tree.as_ref()?`

1.4 WHEN a go-to-definition request is received for a Stan file THEN the system returns no definition because `parse_document` returns `None` and the `goto_definition` handler bails out at `doc.tree.as_ref()?`

1.5 WHEN a hover request is received for a JAGS file THEN the system returns no hover information because `parse_document` returns `None`

1.6 WHEN a hover request is received for a Stan file THEN the system returns no hover information because `parse_document` returns `None`

1.7 WHEN a document-symbols request is received for a JAGS file THEN the system returns no symbols because `parse_document` returns `None`

1.8 WHEN a document-symbols request is received for a Stan file THEN the system returns no symbols because `parse_document` returns `None`

### Expected Behavior (Correct)

2.1 WHEN a find-references request is received for a JAGS file THEN the system SHALL parse the file with the R tree-sitter parser (producing a best-effort partial AST) and attempt to return reference locations

2.2 WHEN a find-references request is received for a Stan file THEN the system SHALL parse the file with the R tree-sitter parser (producing a best-effort partial AST) and attempt to return reference locations

2.3 WHEN a go-to-definition request is received for a JAGS file THEN the system SHALL parse the file with the R tree-sitter parser and attempt to return definition locations on a best-effort basis

2.4 WHEN a go-to-definition request is received for a Stan file THEN the system SHALL parse the file with the R tree-sitter parser and attempt to return definition locations on a best-effort basis

2.5 WHEN a hover request is received for a JAGS file THEN the system SHALL parse the file with the R tree-sitter parser and attempt to return hover information on a best-effort basis

2.6 WHEN a hover request is received for a Stan file THEN the system SHALL parse the file with the R tree-sitter parser and attempt to return hover information on a best-effort basis

2.7 WHEN a document-symbols request is received for a JAGS file THEN the system SHALL parse the file with the R tree-sitter parser and attempt to return document symbols on a best-effort basis

2.8 WHEN a document-symbols request is received for a Stan file THEN the system SHALL parse the file with the R tree-sitter parser and attempt to return document symbols on a best-effort basis

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an R file (`.r`, `.R`, `.rmd`, `.Rmd`, `.qmd`) is opened or edited THEN the system SHALL CONTINUE TO parse it with the R tree-sitter parser and produce a full AST as before

3.2 WHEN a diagnostics request is received for a JAGS or Stan file THEN the system SHALL CONTINUE TO return an empty diagnostics list (diagnostics suppression must not be affected by the parse fix)

3.3 WHEN a completion request is received for a JAGS file THEN the system SHALL CONTINUE TO return JAGS-specific completions (JAGS builtins, keywords, file-local symbols) and exclude R-specific items

3.4 WHEN a completion request is received for a Stan file THEN the system SHALL CONTINUE TO return Stan-specific completions (Stan builtins, keywords, file-local symbols) and exclude R-specific items

3.5 WHEN workspace indexing encounters JAGS or Stan files THEN the system SHALL CONTINUE TO index them and include their symbols in cross-file references
