# Directives

Raven recognizes special comment directives that provide hints the static analyzer cannot infer on its own. Directives cover cross-file relationships, working directory context, symbol declarations, and diagnostic suppression.

## General Syntax

**`# raven:` is the canonical prefix for every directive family** — cross-file relationships, working directory, declarations, and diagnostic suppression alike. The legacy **`@lsp-`** prefix remains a permanent, backward-compatible alias for every directive: `# raven: source utils.R` and `# @lsp-source utils.R` are exactly equivalent, as are `# raven: sourced-by ../main.R` / `# @lsp-sourced-by ../main.R`, `# raven: cd /data` / `# @lsp-cd /data`, and so on. You never need to mix the two; pick `# raven:` for new code.

All directives must appear on their own comment line (starting with `#`, optionally indented). They are not recognized in trailing comments like `x <- 1 # raven: source file.R`. The exceptions are the line-level ignore markers `# raven: ignore` / `# raven: expect` (and their aliases `@lsp-ignore` / `@lsp-expect`), which work as trailing comments.

All directives support optional colon and quotes:
```r
# raven: sourced-by ../main.R
# raven: sourced-by: "../main.R"
# raven: sourced-by: '../main.R'
```

**Header-only directives:** Backward directives and working directory directives must appear in the **file header** — the region of consecutive blank and comment lines at the top of the file, before any code. They are ignored if placed after the first line of code. Forward directives, declaration directives, and ignore directives can appear anywhere.

## Forward Directives

Declare that this file sources another file. Useful when the path is dynamic or conditional:

```r
# raven: source utils/helpers.R
# raven: run utils/helpers.R        # synonym
# raven: include utils/helpers.R    # synonym
# @lsp-source utils/helpers.R       # alias (also @lsp-run / @lsp-include)
```

Symbols from the target file become available after the directive's line. Optional `line=` parameter overrides the call-site:

```r
# raven: source utils/helpers.R line=25
# Symbols from helpers.R become available at line 25 (not at this directive's line)
```

```r
# raven: source utils/helpers.R line=eof
# Symbols become available at end of file (line=end is an accepted synonym)
```

**Path resolution:** Forward directives respect `# raven: cd` (same as `source()` calls).

## Backward Directives

Declare that this file is sourced by another file (header-only):

```r
# raven: sourced-by ../main.R
# raven: run-by ../main.R        # synonym
# raven: included-by ../main.R   # synonym
# @lsp-sourced-by ../main.R      # alias (also @lsp-run-by / @lsp-included-by)
```

Optional parameters:
- `line=N` — 1-based line number in parent where the source() call occurs
- `line=eof` or `line=end` — use scope at end of parent file
- `match="pattern"` — text pattern to locate the source() call in parent

```r
# raven: sourced-by ../main.R line=15
```

```r
# raven: sourced-by ../main.R line=eof
# Sees all symbols defined in main.R, including those from other sourced files
```

```r
# raven: sourced-by ../main.R match="source("
# Searches for "source(" in main.R and uses the first match
```

**Call-site inference:** When neither `line=` nor `match=` is specified, Raven scans the parent for `source()` calls referencing this file. If none found, the configured default (`assumeCallSite`) is used.

**Path resolution:** Backward directives resolve relative to the file's own directory and **ignore** `# raven: cd`.

**Per-file opt-out of auto mode:** If a file has explicit `# raven: sourced-by` directives, auto-inferred backward edges are disabled for that file.

## Working Directory Directives

Set working directory context for path resolution (header-only):

```r
# raven: cd /data/scripts
# raven: working-directory /data/scripts   # synonym
# raven: working-dir /data/scripts         # synonym
# raven: current-directory /data/scripts   # synonym
# raven: current-dir /data/scripts         # synonym
# raven: wd /data/scripts                  # synonym
# @lsp-cd /data/scripts                    # alias (every synonym also has an @lsp- form)
```

Path interpretation:
- Paths starting with `/` are workspace-root-relative (e.g., `/data` → `<workspace>/data`)
- Other paths are file-relative (e.g., `../shared` → parent directory's `shared`)

**What it affects:**

| Directive Type | Uses the `cd` directive? |
|---|---|
| Forward (`source` / `run` / `include`) | **Yes** |
| `source()` calls | **Yes** |
| Backward (`sourced-by` / `run-by` / `included-by`) | **No** |

### Working Directory Inheritance

When a child file uses a backward directive without its own `cd` directive, it inherits the working directory from its parent. Inheritance is transitive. An explicit `cd` directive in the child always takes precedence.

```r
# parent.R
# raven: cd /data/project
source("child.R")
```

```r
# child.R
# raven: run-by ../parent.R
# Inherits /data/project from parent
source("utils.R")  # Resolves to <workspace>/data/project/utils.R
```

## Declaration Directives

Declare symbols created dynamically that the parser cannot detect. These suppress false-positive "undefined variable" diagnostics for symbols from `eval()`, `assign()`, `load()`, or external data loading.

Declaration directives work in any R file, whether or not it participates in cross-file chains.

### Variable Declarations

```r
# raven: var myvar
# raven: variable myvar           # synonym
# raven: declare-var myvar        # synonym
# raven: declare-variable myvar   # synonym
# @lsp-var myvar                  # alias (every synonym also has an @lsp- form)
```

### Function Declarations

```r
# raven: func myfunc
# raven: function myfunc          # synonym
# raven: declare-func myfunc      # synonym
# raven: declare-function myfunc  # synonym
# @lsp-func myfunc                # alias (every synonym also has an @lsp- form)
```

### Position-Aware Behavior

Declared symbols are available starting from the next line (line N+1):

```r
# raven: var data_from_api
x <- data_from_api  # OK: in scope (next line after directive)
```

```r
x <- data_from_api  # ERROR: used before declaration
# raven: var data_from_api
```

### Cross-File Inheritance

Declarations propagate to sourced child files when declared before the `source()` call:

```r
# parent.R
# raven: var shared_data
source("child.R")  # child.R can use shared_data
```

### Use Cases

```r
# Dynamic assignment
assign(paste0("var_", i), value)
# raven: var var_1
# raven: var var_2

# Loading data from external sources
load("data.RData")
# raven: var model_fit
# raven: var training_data

# eval() with constructed expressions
eval(parse(text = code_string))
# raven: func dynamic_function
```

## Ignore Directives

Raven's primary suppression namespace is **`# raven:`**. It works both in the
editor (LSP) and in `raven check`, and covers **all** diagnostics — the
always-on analyzer diagnostics ([Diagnostics](diagnostics.md)) and the opt-in
[style/lint rules](linting.md) alike. The legacy `@lsp-ignore` /
`@lsp-ignore-next` markers remain permanent aliases for the line and next-line
forms.

### Line and next-line

```r
x <- foo # raven: ignore    # Trailing form: suppresses diagnostics on this line
# raven: ignore-next        # Standalone form: suppresses diagnostics on the next line

x <- foo # @lsp-ignore      # Alias of `# raven: ignore`
# @lsp-ignore-next          # Alias of `# raven: ignore-next`
```

A standalone `# raven: ignore` (or `# @lsp-ignore`) on its own line has no
effect — comment lines carry no diagnostics. Use the `-next` form to suppress
the following line, or place the marker as a trailing comment on the line you
want suppressed. The plain `ignore` / `@lsp-ignore` line forms may appear as
trailing comments; the `-next`, file, and block forms must be standalone (on
their own line) — a trailing `x <- 1 # raven: ignore-next` is silently
ignored.

### Per-code selector

An optional `[code]` selector narrows a suppression to one or more diagnostic
codes, e.g. `# raven: ignore[undefined-variable]` or
`x <- foo # @lsp-ignore[undefined-variable]`. List several codes
comma-separated: `# raven: ignore[undefined-variable, line-length]`. The codes
are the kebab-case names listed in [Diagnostics](diagnostics.md) and the lint
rule names in [Linting](linting.md) (both `kebab-case` and lintr's `snake_case`
spelling are accepted). A bare `# raven: ignore` with no selector suppresses
every diagnostic on the target line. The selector is **enforced**: a
`[code]` directive leaves diagnostics with other codes in place.

### File and block forms

```r
# raven: ignore-file                     # suppress the whole file
# raven: ignore-file[undefined-variable] # …only this code

# raven: ignore-start                    # open a block
x <- foo
y <- bar
# raven: ignore-end                      # close it (inclusive of both directive lines)
```

These cover both the analyzer diagnostics and the lint rules. An unterminated
`ignore-start` extends to the end of the file. For lintr compatibility,
`# nolint` / `# nolint start` / `# nolint end` also remain (lint diagnostics
only) — see the [Linting suppression matrix](linting.md).

### `expect` — assert that a suppression is used

Every form above also comes in an **`expect`** flavor: `# raven: expect`,
`# raven: expect-next`, `# raven: expect[code]`, `# raven: expect-file`,
`# raven: expect-start` / `# raven: expect-end`, and the `@lsp-expect` /
`@lsp-expect-next` aliases. `expect` suppresses exactly like `ignore`, but it
also **asserts that it actually suppressed something**: if an `expect`
directive matches no diagnostic, Raven reports an
[`unused-suppression`](diagnostics.md) hint at the directive's line. This
mirrors Rust's `#[expect]` and TypeScript's `@ts-expect-error`: use `ignore`
for a silent suppression, `expect` when you want to be told once the underlying
diagnostic is gone so the now-stale directive can be removed.

```r
result <- compute() # raven: expect[undefined-variable]
# If `compute` later becomes defined/imported, the expect no longer suppresses
# anything and Raven flags it as an unused suppression (a HINT) — your cue to
# delete the directive.
```

A plain `ignore` is never reported as unused by default. Set
[`raven.diagnostics.reportUnusedSuppressions`](configuration.md) to `true` to
extend the unused-suppression sweep to **every** ignore directive
(Pyright-style), not just `expect`.

### Chunk-level suppression (R Markdown / Quarto)

Inside `.Rmd` / `.qmd` documents you can suppress a whole chunk with the knitr
chunk option `raven.ignore` or the in-chunk `# raven: ignore-chunk` directive.
See [Code chunks](chunks.md#suppressing-diagnostics-in-a-chunk).


