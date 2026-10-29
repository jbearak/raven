# Limitations

[Docs](README.md) › Understanding Raven

This page lists what Raven doesn't do yet, or does differently from comparable tools, grouped by area, with a link to where each gap is discussed in context.

Most gaps share one cause: Raven reads code without running it, so it can't see what R decides only at runtime. If a gap affects you and another tool covers it, see [Using Raven with other R tools](coexistence.md) to run both.

## Language server

- **Session-aware completions.** Raven's completions are purely static. vscode-R can complete symbols from the live session's `globalenv()`, including column names of data frames that exist only at runtime. See [How Raven compares](comparison.md#language-intelligence).
- **Full lintr coverage.** Raven's opt-in style linter re-implements 18 of lintr's rules, most of its default set. vscode-R's [languageserver](https://github.com/REditorSupport/languageserver) runs lintr itself, including rules Raven doesn't have, such as `object_usage_linter`; you can run both. See [Linting](linting.md) and [Using Raven with other R tools](coexistence.md#language-servers-raven-alone-vs-both).
- **Stan is checked by name resolution, not compilation.** Raven reports syntax errors and undeclared variables in complete `.stan` programs, but doesn't type-check, compile, or expand `#include`. See [Diagnostics: Stan undeclared variables](diagnostics.md#stan-undeclared-variables).
- **Registered native routines look undefined.** When a package uses `useDynLib(pkg, .registration = TRUE)`, R creates bindings such as rlang's `ffi_enquo` at load time from C code, so Raven flags them as undefined. This mostly affects packages that call their own routines, such as rlang; silence them with `# raven: ignore-next` or a [directive](directives.md).
- **`data()` objects don't reach files that declare their parent.** When a parent calls `data(api, package = "survey")`, a child that inherits scope through `# raven: sourced-by` (or an inferred backward link) sees `api` but not the objects it loads, such as `apiclus1`. Children reached through `source()` see them all. See [Cross-file analysis](cross-file.md#base-packages) for workarounds.
- **Symlinked paths to closed files.** If you reach the same closed file through two different symlinked paths, Raven may treat them as two files. Open files are matched to their on-disk file. See [Cross-file analysis](cross-file.md#open-buffers-disk-state-and-closing-files).
- **Member navigation only for static names.** Go to definition, hover, and find references follow `foo$bar`, `foo@bar`, and `foo[["bar"]]`, but not subscripts R resolves only at runtime, such as `x[[i]]`, `x[[1]]`, or `x["bar"]`. See [Go to definition](go-to-definition.md#-and--member-resolution) and [Find references](find-references.md#scope-and-pooling).

<details markdown="1">
<summary>Exact rules for Stan, symlinks, and member navigation</summary>

**Stan.** Complete `.stan` programs get native syntax and undeclared-variable diagnostics. Raven does not type-check expressions, validate shapes or overloads, diagnose whether a called function or sampling distribution exists, preprocess `#include`, or assemble project-specific source fragments. A file with no real top-level Stan block is treated as a fragment and gets no undeclared-variable findings. Any `#include` turns off that check for the whole file, because the included file may supply declarations.

**Native routines.** The bindings live in the package's C source (for example `src/init.c`) and can't be derived from R code or the NAMESPACE file alone.

**Symlinks and path spelling.** Raven keeps each file under the path spelling it was reached by rather than resolving every path to one canonical form, because full canonicalization follows symlinks and could disagree with the paths in the workspace index. So closed files reached through different symlinked spellings can stay separate. An open file whose path differs from the on-disk file only by case or by a symlink stands in for that file while it is open, including for package-internal scope and for the workspace `.Rprofile`. Diagnostics still appear on the path the editor opened. When resolving `source()` paths, Raven may correct a case-only mismatch so it matches the on-disk spelling.

**Member navigation.** A member access is navigable only when it is statically a name: an identifier after `$` or `@` (`foo$bar`), or a single, positional, literal string inside `[[` (`foo[["bar"]]`, which extracts the same element as `$`). Raven does not follow computed indices (`x[[i]]`, `x[[paste0("a", "b")]]`), numeric indices (`x[[1]]`), named or multi-argument subscripts (`x[[name = "a"]]`, `x[["a", exact = FALSE]]`), strings with escapes, or single brackets (`x["bar"]`, which returns a sub-container, not the element).

</details>

## box module system (`box::use`)

Raven understands the statically analyzable subset of [box](https://klmr.me/box/) modules in diagnostics, completion, hover, navigation, and `raven check`. See [box and import modules](modules.md#box-modules-boxuse).

- **Only literal `box::use()` calls.** Raven recognizes `box::use(...)` and `box:::use(...)` written out in the code, but not `do.call(box::use, ...)`, an alias for `box::use`, or arguments built at runtime.
- **Module search paths must be static.** Raven reads the nearest `rhino.yml`, the project's `box.searchPaths`, `R_BOX_PATH` at startup, and simple top-level assignments in the project `.Rprofile`. It ignores dynamic or conditional values, startup helpers, your home `.Rprofile`, `.Renviron`, and changes made while R runs. See [box and import modules](modules.md).
- **Relative module paths work differently from `source()`.** They resolve from the importing file's own directory, are case-sensitive, and ignore `# raven: cd`, the testthat working directory, and the workspace-root fallback.

<details markdown="1">
<summary>More on box path resolution</summary>

Raven does not synchronize with a running R session. A module path that exists only under a different letter case is reported as a mismatch, not silently corrected. Paths that match more than one file case-insensitively, which can only happen on a case-sensitive filesystem, stay unresolved. See [box and import modules](modules.md) for precedence, relative-path anchors, and file-watching limits.

</details>

## import package

- **Only the static part of `import::from()`, `import::here()`, and `import::into()`.** Raven follows literal package names, literal `.R` / `.r` script paths, literal `.directory` and named destinations, explicit and renamed selections, `.all`, and static `.except`. Calls it can't follow are ignored rather than partly guessed.
- **No runtime module execution.** Raven doesn't run module code, load or unload hooks, or other side effects, and doesn't see exports created at runtime.
- **Static member access only.** Completion, hover, navigation, and references on module members cover `$`, `@`, and a single literal-string `[[...]]`. Installed-package members complete and are checked, but don't navigate to package source.

<details markdown="1">
<summary>What Raven doesn't model in import calls</summary>

Raven does not model detach or S3 side effects, does not follow URL or pins modules, and does not evaluate dynamic `.character_only`, `.library`, `.directory`, `.into`, source, or member expressions. Environment-valued destinations and `import:::` internal imports are not modeled.

Modules with no explicit export list are treated as incomplete: known members are available, but Raven doesn't report a missing member unless the module declares its exports explicitly. Installed-package imports follow the same rule, using Raven's installed, frozen, or downloaded package export data. Computed subscripts and nested runtime values are not evaluated.

</details>

## targets and tarchetypes

- **Only statically written target calls.** Raven recognizes namespace-qualified calls, and bare calls when the package is attached at top level and the name isn't shadowed. Aliases, `do.call()`, partial argument names, calls inside functions or quoted code, and metaprogramming are ignored.
- **A limited `tar_map()` subset, all or nothing.** Raven expands `tar_map()` only for a literal table of values; if any generated name is unsupported, it expands none of them.
- **Report documents need a literal path.** `tar_render()`, `tar_knit()`, and `tar_quarto()` are linked only for a static target name and a literal `.Rmd`, `.Rmarkdown`, or single `.qmd` path. Raven doesn't render reports.

See [Cross-file analysis: tarchetypes target factories and report documents](cross-file.md#tarchetypes-target-factories-and-report-documents).

<details markdown="1">
<summary>Exact <code>tar_map()</code>, report, and <code>tar_load()</code> rules</summary>

**`tar_map()`.** The supported subset requires a literal `list()`, `data.frame()`, or `tibble()` table with named scalar or literal-vector columns; target-definition objects statically bound to `...`; a static, unshadowed column-name selection; compatible lengths; no collision between target names and value columns; and a literal delimiter. Raven does not keep partial targets or report links when one generated name is unsupported. It does not predict the runtime hash fallback, non-ASCII or locale-dependent `make.names()` results, dynamic values, selections, or delimiters, replication factories, or other dynamic branching. Raw and string-expression variants, `tar_eval()`, `tar_sub()`, syntax-tree walkers, and internal `_run` helpers are not modeled.

**Reports.** `tar_render()` and `tar_knit()` need a literal `.Rmd` or `.Rmarkdown` path; `tar_quarto()` needs a single `.qmd`, `.Rmd`, or `.Rmarkdown` file. Computed paths and Quarto project directories are not followed. Helpers sourced only by the report don't contribute target declarations back to the pipeline.

**`tar_load()`.** References are found only from a direct name or a literal, unshadowed `c(name, ...)`. Dynamic tidyselect expressions are not expanded.

</details>

## R6 classes

- **Bare instance members need `portable = FALSE` and inline member lists.** Computed lists, class aliases, runtime `$set()` changes, and methods supplied as separate function variables are not resolved.
- **Inheritance follows static class bindings only.** Raven follows superclasses bound at top level in the same file, in package source files, or through `source()` relationships. When an ancestor can't be resolved, the class's own members still work.
- **No live objects.** Raven doesn't inspect live R6 instances or synchronize with a running R session.

<details markdown="1">
<summary>When inherited R6 members are left out</summary>

Nested class factories, computed superclass expressions, an explicit `parent_env`, and ambiguous package class names contribute no inherited members. If a sibling class changes its creator environment through `source()`, imports, or removals, Raven needs that context in the current analysis; when it is unavailable or cut short, Raven adds no guessed inherited members. Conflicting writes in a sourcing file and the file it sources can leave superclass order uncertain, and those names contribute no inherited members. Inheritance is safe against cycles and is limited to 32 classes and 4,096 member entries.

</details>

## R Markdown / Quarto

R chunks in `.Rmd`, `.Rmarkdown`, and `.qmd` documents are fully analyzed as R code, with these gaps:

- **Inline R isn't analyzed.** Only fenced chunks (```` ```{r} ```` blocks) are treated as R, not `` `r expr` `` in prose.
- **An unclosed delimiter can spill into the next chunk.** Raven analyzes all chunks as one R program, so an unclosed `"`, `(`, or `{` can break parsing of the next chunk. The unclosed delimiter is itself flagged.
- **Non-R chunks aren't analyzed.** `{python}`, `{bash}`, `{julia}`, and other chunks are never analyzed or linted.
- **knitr chunk reuse isn't resolved.** `<<label>>` lines are treated as blank.
- **Quarto Preview has limits.** It isn't a Shiny lifecycle, can't preview formats such as DOCX and PPTX (use Render), needs a trusted workspace, and isn't guaranteed in Codespaces. See [Quarto: limitations](quarto.md#limitations).

<details markdown="1">
<summary>More on chunk analysis and Quarto Preview</summary>

The unclosed-delimiter behavior comes from analyzing chunks in one pass. knitr itself evaluates chunks one at a time and would stop at the chunk with the error.

Quarto Preview leaves refresh-on-save to Quarto's own file watcher. Raven rejects a document-level `server: shiny` on a best-effort basis and doesn't detect project-level Shiny configuration before launch. Formats a browser can't show, such as DOCX and PPTX, fail Preview with a 404 message. Preview belongs to the VS Code window that started it.

</details>

## R-session features

- **Debugger.** Breakpoints in code that's already loaded take effect when the code runs again. There are no data breakpoints, Restart Frame, or step back. See [Debugger: limitations](debugger.md#limitations).
- **No workspace viewer.** vscode-R has a sidebar panel showing the objects in the live session's `globalenv()` with their types and dimensions, plus attached and loaded namespaces. Raven has no equivalent. See [How Raven compares](comparison.md#what-reditorsupports-vs-code-extension-offers-that-raven-doesnt).
- **No htmlwidget or Shiny viewer.** vscode-R shows interactive HTML output (plotly, DT, profvis) and Shiny apps in webview panels. Raven has no equivalent.
- **Knit Preview doesn't refresh automatically.** Raven's [Knit Preview](knit.md) for `.Rmd` / `.Rmarkdown` re-knits when you click **Knit again** or press `Shift+Cmd+Enter` / `Shift+Ctrl+Enter`. vscode-R's preview has an opt-in auto-refresh mode. [Quarto Preview](quarto.md) does refresh `.qmd` output on save.
- **No list or environment viewer.** vscode-R's `View()` on a list or environment opens a collapsible tree. Raven's `View()` handles only data frames and matrices. See [Data viewer](data-viewer.md).

If you need the workspace viewer, the htmlwidget or Shiny viewer, or the list viewer, keep vscode-R installed next to Raven; see [Using Raven with other R tools](coexistence.md).

## See also

- [How Raven compares](comparison.md): where Raven overlaps with RStudio, Positron, vscode-R, lintr, Jarl, and Air.
- [Using Raven with other R tools](coexistence.md): run Raven next to tools that fill these gaps.
- [Diagnostics](diagnostics.md): silence a finding Raven gets wrong.
- [Directives](directives.md): declare what Raven can't see.
