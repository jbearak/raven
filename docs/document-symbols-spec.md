# Document & Workspace Symbols: Improvement Spec

## Background

Raven currently returns flat `SymbolInformation[]` via `DocumentSymbolResponse::Flat` for `textDocument/documentSymbol`. This produces a single-level list of every assignment in the file (functions and variables alike), with no structural grouping, no sections, and no nesting. The `uri` field is set to a placeholder `file:///` that is never replaced.

By contrast:

- **R Language Server** returns flat `SymbolInformation[]` but with accurate ranges that span the full construct (including function bodies). VS Code infers hierarchy from range containment. It also emits R code sections (`# Foo ----`) as `SymbolKind::String` entries whose ranges span until the next section, causing children to nest under them.
- **TypeScript LS** and **Pyright/Pylance** return hierarchical `DocumentSymbol[]` with explicit `children`, `selectionRange` (identifier only), and `range` (full construct). They distinguish `Function`, `Variable`, `Constant`, `Class`, `Method`, `Enum`, etc.

### Problems with Current Implementation

| # | Problem | Impact |
|---|---------|--------|
| 1 | Flat list — no hierarchy | Breadcrumb bar shows a single-level dropdown; no structural navigation |
| 2 | No `selectionRange` | Cannot distinguish "click to highlight name" from "full extent of construct" |
| 3 | No R code sections | Users who organize with `# Section ----` get no outline benefit |
| 4 | Only two SymbolKinds | Variables and functions are the only distinction; no constants, classes, or methods |
| 5 | No `detail` on functions | Breadcrumb/outline shows `my_func` without parameter hint |
| 6 | Placeholder URI bug | `SymbolInformation.location.uri` is `file:///` — wrong if any consumer reads it |
| 7 | No `containerName` on workspace symbols | `Ctrl+T` shows duplicate names with no context to distinguish them |
| 8 | Local variables at top level | Inner assignments inside functions appear alongside top-level symbols |

---

## Scope

This spec covers two LSP methods:

- `textDocument/documentSymbol` — per-file outline and breadcrumb
- `workspace/symbol` — cross-file symbol search (`Ctrl+T`)

Changes to folding ranges, diagnostics, or completions are out of scope.

---

## Priority 1: Align with Best Practices

### 1.1 Switch to hierarchical `DocumentSymbol` response

**Change:** Return `DocumentSymbolResponse::Nested(Vec<DocumentSymbol>)` instead of `DocumentSymbolResponse::Flat(Vec<SymbolInformation>)`.

The `DocumentSymbol` type (from `lsp_types`) has this shape:

```rust
pub struct DocumentSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: SymbolKind,
    pub tags: Option<Vec<SymbolTag>>,
    pub deprecated: Option<bool>,
    pub range: Range,           // full extent of the construct
    pub selection_range: Range, // just the identifier
    pub children: Option<Vec<DocumentSymbol>>,
}
```

**Capability check:** The client reports `hierarchicalDocumentSymbolSupport` in `textDocument.documentSymbol` during `initialize`. If absent or `false`, fall back to the current flat format. VS Code always sends `true`.

**Implementation notes:**
- Remove the `#[allow(deprecated)]` on `SymbolInformation` usage in the `DocumentSymbol` path (flat fallback still needs it).
- `collect_symbols` should be replaced by a new function `collect_document_symbols` that returns `Vec<DocumentSymbol>`.

### 1.2 Set correct `range` and `selectionRange`

For each symbol:

| Field | Value |
|-------|-------|
| `range` | Full span of the assignment node (`binary_operator`). For `f <- function(x) { ... }`, this spans from `f` through the closing `}`. |
| `selectionRange` | Span of the LHS identifier only. For `f <- function(x) { ... }`, this is just the `f` token. |

This is what makes breadcrumbs work: when the cursor is inside a function body, VS Code finds the `DocumentSymbol` whose `range` contains the cursor position.

**Implementation:** Use `lhs.start_position()..lhs.end_position()` for `selectionRange` and `node.start_position()..node.end_position()` for `range` (where `node` is the `binary_operator`).

### 1.3 Nest children inside functions

**Change:** When recursing into the RHS of an assignment whose RHS is a `function_definition`, collect symbols from the function body as `children` of the function's `DocumentSymbol`, rather than appending them to the top-level list.

**Algorithm sketch:**

```text
collect_document_symbols(node) -> Vec<DocumentSymbol>:
    for each child of node:
        if child is assignment (binary_operator with <- / = / <<-):
            lhs = identifier
            rhs = value
            kind = if rhs is function_definition then FUNCTION else VARIABLE
            children = if rhs is function_definition then
                           collect_document_symbols(rhs.body)
                       else
                           None
            emit DocumentSymbol { name, kind, range, selectionRange, children }
        else:
            recurse into child, collecting into current level
```

This means a file like:

```r
outer <- function(x) {
    helper <- function(y) { y + 1 }
    result <- helper(x)
    result
}
top_var <- 42
```

Produces:

```text
outer (Function)
  ├── helper (Function)
  └── result (Variable)
top_var (Variable)
```

**Decision: which children to include inside functions.** Only collect assignments (named definitions). Do not include loop variables (`for (i in ...)`), conditional branches, or other non-assignment constructs. This matches what users expect in an outline and avoids noise.

### 1.4 Remove placeholder URI

The flat fallback path (for clients without `hierarchicalDocumentSymbolSupport`) should receive the actual document URI as a parameter to `collect_symbols` and use it in `SymbolInformation.location.uri`. The hierarchical path (`DocumentSymbol`) has no `uri` field, so this is only relevant for the fallback.

---

## Priority 2: Enhance UX

### 2.1 R code section support

R users organize scripts with comment-based sections:

```r
# Data Loading ----
data <- read.csv("input.csv")

# Analysis ====
model <- lm(y ~ x, data)

## Subsection ####
residuals <- resid(model)
```

**Detection regex** (matches RStudio and R Language Server conventions):

```text
^\s*#(#*)\s*(%%)?\s*(\S.+?)\s*(#{4,}|\-{4,}|={4,}|\*{4,}|\+{4,})\s*$
```

Captures:
1. Leading `#` count → nesting level (1 `#` = level 0, 2 `##` = level 1, etc.)
2. Optional `%%` (RMarkdown chunk marker — ignore for plain `.R` files)
3. Section name text
4. Trailing marker (4+ of `-`, `=`, `#`, `*`, `+`)

**SymbolKind:** Use `SymbolKind::MODULE` (2). This renders with a clear structural icon in VS Code and is semantically reasonable ("a section is a module of related code"). The R Language Server uses `SymbolKind::STRING` (15), which produces a confusing `"ab"` icon.

**Range computation:** Each section's range extends from its comment line to the line before the next section at the same or higher level, or to the end of the file. This is identical to how folding regions would work.

**Nesting:** Multi-level sections nest naturally:

```r
# Top Section ----        → level 0, range: lines 0-8
x <- 1
## Sub A ====             → level 1, range: lines 2-5
a <- 2
## Sub B ====             → level 1, range: lines 5-8
b <- 3
# Next Section ----       → level 0, range: lines 9-...
```

Produces:

```text
Top Section (Module)
  ├── x (Variable)
  ├── Sub A (Module)
  │   └── a (Variable)
  └── Sub B (Module)
      └── b (Variable)
Next Section (Module)
```

**Integration with symbol nesting:** Sections and function nesting interact. A function defined inside a section is a child of the section. A variable defined inside a function that's inside a section is a grandchild of the section:

```text
Section
  └── my_func (Function)
      └── local_var (Variable)
```

**Implementation approach:**

1. First pass: scan all comment nodes at the top level to identify section markers (line, level, name).
2. Compute section ranges from the section list.
3. Second pass: collect assignment symbols with their tree-sitter ranges.
4. Build the hierarchy: sections at their respective nesting levels, then place each assignment symbol inside the deepest section whose range contains it.
5. Within functions, recurse to find nested definitions as before.

### 2.2 Richer SymbolKind mapping

Expand the RHS detection to distinguish more R constructs:

| R Pattern | SymbolKind | Detection |
|-----------|-----------|-----------|
| `f <- function(x) { }` | `Function` (12) | RHS node kind is `function_definition` |
| `x <- 42` | `Variable` (13) | Default for non-function RHS |
| `MY_CONST <- "value"` | `Constant` (14) | Identifier matches `^[A-Z][A-Z0-9_.]+$` (all uppercase with dots/underscores) |
| `MyClass <- R6Class(...)` | `Class` (5) | RHS is a `call` node where the function name is `R6Class` or `R6::R6Class` |
| `MyClass <- setRefClass(...)` | `Class` (5) | RHS is a `call` node where the function name is `setRefClass` |
| `setClass("MyClass", ...)` | `Class` (5) | Top-level call to `setClass` (not an assignment — first arg is the name) |
| `setGeneric("foo", ...)` | `Function` (12) | Top-level call to `setGeneric` |
| `setMethod("foo", ...)` | `Method` (6) | Top-level call to `setMethod` |

**ALL_CAPS heuristic for constants:** R convention uses `ALL_CAPS` for constants (e.g., `MAX_ITER`, `DEFAULT_ALPHA`, `PI`). The regex `^[A-Z][A-Z0-9_.]+$` matches identifiers that are entirely uppercase letters, digits, dots, and underscores, starting with an uppercase letter. Single-character identifiers like `N` or `X` should NOT match (they're often loop counters or matrix dimensions). Note: the built-in constants `TRUE`, `FALSE`, `NULL`, `Inf`, `NaN`, `NA`, and `NA_*` are already filtered by the reserved words check and won't reach this point.

### 2.3 Function parameter signature in `detail`

Set `DocumentSymbol.detail` on function symbols to show the parameter list:

```
name: "fit_model"
detail: "(data, formula, family = gaussian)"
```

**Extraction:** Walk the `parameters` node of `function_definition`. For each `parameter` child:
- Simple parameter: extract name (`x`)
- Default parameter: extract `name = default` from the `default_parameter` node, but only show the parameter name and the `=` marker, not the full default expression: `x = ...` would be too long. Actually, for short defaults, include them: `family = gaussian`. For long defaults (> 20 chars), truncate: `opts = ...`.

**Truncation:** If the full parameter list exceeds 60 characters, truncate with `...`:
```
(x, y, z, very_long_param_name, another_one, ...)
```

### 2.4 Top-level call detection (setClass, setGeneric, setMethod)

Some R constructs create named symbols via top-level function calls rather than assignments:

```r
setClass("MyClass", representation(x = "numeric"))
setGeneric("myMethod", function(x, ...) standardGeneric("myMethod"))
setMethod("myMethod", "MyClass", function(x, ...) { x@x })
```

**Detection:** When the current node is a `call` node (not inside an assignment) and the function name matches `setClass`, `setGeneric`, or `setMethod`, extract the first string argument as the symbol name.

| Call | Symbol Name | SymbolKind |
|------|-------------|------------|
| `setClass("Foo", ...)` | `Foo` | `Class` (5) |
| `setGeneric("bar", ...)` | `bar` | `Function` (12) |
| `setMethod("bar", "Foo", ...)` | `bar.Foo` | `Method` (6) |

For `setMethod`, concatenate the method name and class name with `.` to disambiguate multiple method implementations.

### 2.5 Workspace symbol `containerName`

For workspace symbols (which remain flat `SymbolInformation[]` per the LSP spec for `workspace/symbol`), populate `container_name` with the filename (without extension):

```rust
container_name: Some("analysis".to_string())  // from analysis.R
```

This helps users distinguish identically-named symbols across files in the `Ctrl+T` picker.

---

## Out of Scope (Future Work)

These items are noted but not part of this spec:

- **Folding range integration with sections.** The folding range provider (`collect_folding_ranges`) currently only folds braced constructs. Extending it to fold sections would be complementary but is a separate change.
- **R Markdown / Quarto support.** Chunk headers (```` ```{r name} ````) could become symbols. Deferred.
- **S4 formal class hierarchy.** Detecting `setClass` inheritance and `contains` slots. Deferred.
- **List member symbols.** Treating named list elements (`list(a = 1, b = 2)`) as children of the list variable. Low value, high complexity.
- **Workspace symbol scoring/ranking.** Fuzzy matching, relevance scoring, recently-opened-file boosting. Deferred.

---

## Test Plan

### Unit Tests

1. **Hierarchical output:** Parse a file with top-level functions, nested functions, and variables. Assert the returned `Vec<DocumentSymbol>` has correct nesting, `range`, `selectionRange`, and `kind`.

2. **Section detection:** Parse a file with `# Sec1 ----`, `## Sub ====`, `# Sec2 ----`. Assert three section symbols with correct nesting and ranges.

3. **Section + symbol interaction:** Symbols defined between two sections are children of the first section. Symbols inside a function inside a section are grandchildren.

4. **SymbolKind mapping:** Test each pattern from section 2.2 (R6Class, setRefClass, ALL_CAPS constant, regular variable, function).

5. **Function detail extraction:** Test parameter signature extraction with defaults, truncation, and edge cases (no parameters, `...` only).

6. **setClass/setGeneric/setMethod detection:** Test top-level S4 calls produce correct symbol names and kinds.

7. **Reserved words:** Verify that `TRUE <- 1` and similar do not produce symbols (existing behavior preserved).

8. **Flat fallback:** When `hierarchicalDocumentSymbolSupport` is `false`, verify the response is `DocumentSymbolResponse::Flat` with correct URIs.

9. **Workspace symbol containerName:** Verify `container_name` is populated with the filename.

### Integration Tests

1. **Breadcrumb navigation:** Open a file with nested functions. Place cursor inside inner function body. Verify breadcrumb shows `outer > inner`.

2. **Outline view sections:** Open a file with sections. Verify Outline panel shows collapsible section hierarchy.

3. **Ctrl+T search:** Search for a function name. Verify results include the container filename.

---

## Implementation Order

| Phase | Items | Rationale |
|-------|-------|-----------|
| 1 | 1.1, 1.2, 1.3, 1.4 | Core structural fix — switch to `DocumentSymbol`, correct ranges, nesting, URI fix. One cohesive change. |
| 2 | 2.1 | Section support — high UX value for R users, moderate complexity. |
| 3 | 2.3 | Function `detail` — visible breadcrumb improvement, low complexity. |
| 4 | 2.2, 2.4 | Richer SymbolKind + S4 calls — incremental improvements. |
| 5 | 2.5 | Workspace symbol `containerName` — small, independent. |
