# Find References

Raven locates all usages of a symbol across the dependency graph — not just the current file.

## How It Works

When you invoke Find References (Shift+F12 / right-click → Find All References), Raven:
1. Identifies the symbol at the cursor
2. Determines which files are reachable through the dependency graph
3. Returns all reference sites across those files

## Cross-File Scoping

References are found across files connected by `source()` calls and directives:

```r
# main.R
source("utils.R")
result <- helper_function(42)  # ← reference
```

```r
# utils.R
helper_function <- function(x) { x * 2 }  # ← definition
```

Invoking Find References on `helper_function` in either file returns both locations.

## Reachability

Two references to the same name are considered the same symbol if they are **mutually reachable** through the dependency graph. Files that are not connected (no `source()` path between them) are treated as having distinct symbols — even if the names match.

This prevents pooling of coincidentally same-named symbols across unrelated analyses.

## Workspace Symbols (Cmd/Ctrl+T)

For project-wide symbol search without scoping constraints, use **Cmd/Ctrl+T**. This searches all indexed symbols across the workspace by name, regardless of dependency relationships.

The maximum number of results is configurable via `raven.symbols.workspaceMaxResults` (default: 1000).

## Go-to-Definition

Go-to-definition (Cmd-click / F12) navigates to the symbol's definition, following `source()` chains across files. If a symbol is defined in a sourced file, Raven jumps directly to that file and line.

For `$` member access (`foo$bar`), go-to-definition resolves `bar` as a member of `foo` — see [$ and @ Member Resolution](cross-file.md#-and--member-resolution).
