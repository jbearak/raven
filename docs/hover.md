# Hover

Hovering over an identifier shows what the symbol is, where it's defined, and — for package exports — the R help text. Hover uses the same position-aware, cross-file scope model as [completions](completion.md), [diagnostics](diagnostics.md), and [go-to-definition](go-to-definition.md), so the package attributed at the cursor matches what's in scope under Raven's static model — namely, packages brought in via `library()` / `require()` (or via `loadNamespace()`, which Raven treats as an attach signal even though R itself only loads the namespace), plus namespace qualifiers and declared symbols.

## What You See

| At the cursor | Hover shows |
|---|---|
| `pkg::name` / `pkg:::name` | Bold `pkg::name` help-panel link + R help text for that topic |
| Local or cross-file definition | A code block with the definition statement and a file-location line |
| Symbol declared via `@lsp-var` / `@lsp-func` | `name (declared function\|variable)` + the directive and line where it's declared |
| Package export in scope (via `library()` / `require()` / `loadNamespace()` / directives) | Bold `pkg::name` help-panel link + R help text |
| Built-in or otherwise unresolved symbol | R help text, if R has a topic for it |

Hover returns nothing for symbols R doesn't recognize and that aren't in scope.

## Resolution Order

Hover tries sources in this order and stops at the first match. This matches the logic in `crates/raven/src/handlers.rs::hover`:

1. **Namespace qualifier.** If the cursor is inside a `pkg::name` or `pkg:::name` expression, the qualifier wins — even if the file-local scope would resolve `name` to something else. Without this rule, hovering `filter` inside `dplyr::filter(...)` could show `stats::filter` whenever the workspace happened to surface that one first.
2. **Cross-file scope.** Raven resolves the identifier through the dependency graph at the cursor's position. If it finds a local definition, a sourced definition, a declared symbol, or a package export that's in scope, it builds the hover from that symbol.
3. **Package exports from loaded packages.** If the identifier isn't in the cross-file scope but it matches a symbol exported by any package loaded at the cursor (including packages inherited from parent files), hover shows that package's help topic.
4. **R help fallback.** For anything left over — base/recommended built-ins, or symbols whose origin Raven can't infer — hover asks R for a help topic and returns it verbatim in a code block.

Each step takes the first hit and stops; steps 2–4 never run once a match is found.

## File Location Lines

When the hover is built from a cross-file symbol, Raven adds one line underneath the code block so you can jump to the definition:

- Defined in the same file: `this file, line N`.
- Defined in another file: `[rel/path.R](file:///…), line N` — click the link to open that file at the definition.
- Definition statement couldn't be extracted (e.g. the defining file has since moved or changed): Raven falls back to a `*Defined in rel/path.R*` italic attribution.

The relative path is computed against the workspace root when one is available, so hovering a symbol defined in `R/utils.R` shows exactly that — not an absolute URI. This is the same path the go-to-definition navigation uses; see [Go-to-Definition](go-to-definition.md#cross-file-navigation).

## Declared Symbols

Symbols declared via [`@lsp-var` or `@lsp-func`](directives.md#declaration-directives) hover as:

```text
name (declared function)

Declared via @lsp-func directive at line 12

*Defined in analysis/helpers.R*
```

The "Defined in" line is omitted when the declaration lives in the current file. If the same name is declared more than once in the providing file, Raven uses the **first declaration by line number** — the same rule [diagnostics](diagnostics.md), [completions](completion.md), and [go-to-definition](go-to-definition.md#declared-symbols) follow.

## Package Exports and the Help-Panel Link

When hover resolves to a package export and R has a help topic for it, the first line of the hover is a bold Markdown link of the form `pkg::name`. In VS Code, clicking that link opens the [help viewer](help-viewer.md) beside the editor with the rendered Rd documentation — the same topic the hover is showing, but in a resizable panel with back/forward navigation.

If R hasn't rendered help text for that topic yet (cold cache, large package, or a symbol R doesn't have a topic for), hover falls back to a shorter form that omits the bold heading and just shows the name or Raven's parsed signature followed by a `from {pkg}` attribution. Subsequent hovers on the same topic hit Raven's help cache and render the full help text with the clickable heading.

Namespace-qualified calls (`dplyr::filter`) always get the bold heading whether or not help text is available — Raven honors the qualifier even when R can't render a topic for it.

## Scope-Aware Package Attribution

Because hover goes through the cross-file scope engine, the package attributed at each cursor depends on what's in scope at that position:

```r
library(stats)
filter(x, filt, method = "convolution")  # → stats::filter

library(dplyr)
filter(df, x > 0)                        # → dplyr::filter (dplyr loaded after stats)
```

Explicit qualifiers short-circuit this — `dplyr::filter` and `stats::filter` always hover as their qualified packages regardless of what else is loaded. For how this differs from other R hover implementations, see [Comparison: Hover help](comparison.md#hover-help).

## With REditorSupport Also Installed

VS Code runs hover providers from every enabled extension and stacks their output, separated by horizontal rules. If you have both Raven and the [REditorSupport (R) extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) active, you'll see REditorSupport's bold help link at the top of the hover and Raven's result below it — and sometimes REditorSupport contributes several bold links instead of one.

REditorSupport's hover doesn't resolve scope at the cursor. When its `guess_namespace` heuristic can't narrow a name down to a single package, it falls through to an unqualified `utils::help((topic))` lookup, which returns matches across every installed package. Hovering `filter` after `library(dplyr)`, for example, may show **both** `dplyr::filter` and `stats::filter` as bold links at the top — see [Comparison: Hover help](comparison.md#hover-help) for the mechanism. Raven's single scope-aware result (`dplyr::filter`, in this case) appears underneath.

This isn't a Raven bug. Both extensions are answering the hover request independently, and VS Code is concatenating their output. If you'd rather see only Raven's hover, disable REditorSupport's language server with `"r.lsp.enabled": false` — see [Coexistence](coexistence.md#language-servers-raven-alone-vs-both).

## Limits

- **No navigation to installed package sources.** Hover attributes a symbol to its package and links to the help viewer, but cmd-click on a package export does not jump into the package's source. See [Go-to-Definition: Package Exports](go-to-definition.md#package-exports).
- **R-help fallback is async.** The first hover for a topic spawns an R subprocess to render help; re-hovering the same topic uses the cached result.

## Related

- [Cross-File & Package Awareness](cross-file.md) — the scope and dependency model hover uses
- [Go-to-Definition](go-to-definition.md) — follows the same file-location link hover displays
- [Help Viewer](help-viewer.md) — the panel opened by the bold `pkg::name` link at the top of a hover
- [Directives](directives.md) — `@lsp-var` / `@lsp-func` declaration format
- [Completions](completion.md) — shares the position-aware scope model with hover
- [Diagnostics](diagnostics.md) — if hover resolves a symbol, the diagnostics pass won't flag it as undefined
- [Comparison: Hover help](comparison.md#hover-help) — how Raven's scope-aware attribution differs from REditorSupport's
