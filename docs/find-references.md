# Find references

[Docs](README.md) › Navigation and editing

Find references lists every place a name appears in your project, definitions and uses alike, not only in the current file.

```r
# main.R
source("utils.R")
result <- helper_function(42)  # reference
```

```r
# utils.R
helper_function <- function(x) { x * 2 }  # definition
```

Find references on `helper_function` in either file returns both locations.

## How it works

Press Shift+F12, or right-click and choose **Find All References**. Raven:

1. takes the name at the cursor
2. searches the current file, every other open file, and every indexed file in the workspace for that name
3. returns every match, both definitions (assignments, function parameters) and uses

The search matches names, not scope. It doesn't check `source()` links or where in the file the cursor is. The exception is members imported through `box::use()` or supported `import::` calls: Raven follows them to their exact definition or package export and leaves out unrelated members with the same name. See [Scope and pooling](#scope-and-pooling) and [Selective-import member identity](#selective-import-member-identity).

## Cross-file scoping

Because the search covers every open and indexed file, a definition in one file and its uses in another come back together, whether or not a `source()` call connects the files.

## Scope and pooling

Unlike completion and diagnostics, find references doesn't use `source()` links or position-aware scope. Every name in the workspace that matches is returned, so:

- Definitions (the left side of assignments, function parameters) are listed alongside uses.
- Same-named symbols in files that no `source()` path connects are pooled together, not treated as different symbols.
- `` x$`name` ``, `x@name`, `x[["name"]]`, and a `name =` constructor argument all pool together, because the search matches the member name and not the operator. Running find references on any one returns the others.

The `[[` form counts only for a single literal string subscript, the same rule [go to definition](go-to-definition.md#which-subscripts-navigate) uses. `x[[i]]`, `x[[1]]`, `x["name"]`, and computed, named, or multi-argument subscripts aren't matched. A string that isn't a `[[` subscript is never a reference.

For a result tied to one symbol's definition, use [go to definition](go-to-definition.md), which does follow scope and `source()` links.

### Selective-import member identity

For a member of a local module imported through a static [`box::use()`](modules.md#box-modules-boxuse) or a supported [`import::` call](modules.md#import-package-importfrom), Raven starts from the original definition and keeps only the occurrences that resolve to it. Results can include access through `$`, `@`, or literal `[["name"]]` where the syntax allows it, named and wildcard attachments, renamed local bindings, re-export chains, and the definition itself in open or indexed files.

Selected members of installed packages have no source to navigate to, so Raven matches on the package and exported name instead. Renamed bindings and their uses stay linked to the original export. Unrelated local bindings, or imports of the same name from another package, are left out. References that don't come from a selective import keep the broad pooling described above.

## R Markdown and Quarto

Find references works inside R chunks of `.Rmd`, `.Rmarkdown`, and `.qmd` documents. All R chunks count as one script, so references span chunks. On prose, YAML, or a non-R chunk, it returns nothing.

## Workspace symbols (Cmd/Ctrl+T)

To search for a symbol by name across the project, press Cmd+T (Ctrl+T on Windows and Linux). This searches every indexed symbol in the workspace by name, regardless of `source()` links. [Document outline](document-outline.md#workspace-symbol-search) describes the search in more detail.

## JAGS and Stan

In `.stan`, `.jags`, `.bugs`, and `.bug` files, find references returns every occurrence of the name across all open or indexed files of the same language. The JAGS extensions are matched case-insensitively and mean strict JAGS, not general OpenBUGS, WinBUGS, MultiBUGS, or NIMBLE compatibility. As with R, this is a plain name match: results are collected by name across all Stan files, or all JAGS files, in the workspace.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `raven.symbols.workspaceMaxResults` | `1000` | Maximum number of workspace symbol (Cmd/Ctrl+T) results |

See [Settings reference](settings-reference.md) for every setting.

<a id="go-to-definition"></a>

## See also

- [Go to definition](go-to-definition.md), which jumps to a symbol's definition instead of listing its uses
- [Document outline](document-outline.md)
- [box and import modules](modules.md)
