# box and import modules

[Docs](README.md) › Analysis

Raven understands [`box::use()`](https://klmr.me/box/) and [`import::from()`](https://rticulate.github.io/import/) imports, binding only the names each import requests, so it can check module members and flag a name a module doesn't export. <a id="module--import-systems"></a>

<!-- example: diag-box-export-not-found file=main.R -->
```r
box::use(./modules/summaries[trimmed_mean, winsorize])

trimmed_mean(c(1, 2, 3, 100))
```

<!-- example: diag-box-export-not-found file=modules/summaries.R -->
```r
#' @export
trimmed_mean <- function(x) mean(x, trim = 0.1)
```

<!-- example: diag-box-export-not-found -->
```console
$ raven check .
main.R:1:44 warning: 'winsorize' is not exported by this box import source [box-export-not-found]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

Both systems are **selective imports**. Raven never merges a whole file's definitions the way `source()` does, and never adds a package's entire export set as bare names the way `library()` does. Everything is static: Raven doesn't run your code to find what a module exports or where it lives. Forms it can't read statically are left inert, so they neither bind names nor produce misleading diagnostics.

## box modules (`box::use()`)

A box import binds a **namespace object**, used as `alias$member`, and/or a chosen subset of a module's exports:

```r
box::use(
  dplyr,                 # namespace object:        dplyr$filter(...)
  dr = dplyr,            # ... under an alias:       dr$filter(...)
  dplyr[filter, select], # attach members directly (no namespace object)
  dplyr[f = filter],     # attach under a local name: f()
  dplyr[...],            # attach every export
  ./helpers,             # local module: helpers.r or helpers/__init__.r
  ../lib/util[foo],      # attach `foo` from a module one directory up
  app/logic/math,       # Rhino module, relative to the application root
)
```

- A **bare name** is an installed package. Relative modules start with `./` or `../`. Qualified paths such as `app/logic/math` resolve in Rhino applications and through custom search paths.
- Raven recognizes top-level and function-scoped calls, and the `box:::use()` spelling.
- The default namespace name is the last path or package component (`../lib/util` binds `util`). Write `alias = spec` to change it.
- An **attach-only** spec (`pkg[a, b]`, `pkg[...]`) binds no namespace object unless you also alias it (`alias = pkg[...]`).

**Relative modules** resolve from the importing file's own directory. box doesn't use Raven's `source()` working-directory or workspace-root fallback rules. The spec omits the extension, and Raven tries `path.r`, `path.R`, `path/__init__.r`, then `path/__init__.R`, so a file module wins over a package module (`path/__init__.r`). Resolution is case-sensitive.

### Exports

`box::export()` calls and `#' @export` tags define a module's exports. When either is present, the export list is authoritative, so a missing member (`module$typo`) is reported. A module with no export markers falls back to "every top-level name that doesn't start with a dot", which isn't authoritative: Raven doesn't conclude a name is missing, since a dynamic binding might supply it. Private names, and names the module only imports itself, never cross the boundary.

Imported namespaces and attached members work wherever Raven's analysis does: diagnostics, completion, hover, signatures, go-to-definition, and find references, in open and indexed files, in the editor and in `raven check`. Editing a local module's exports rechecks the files that import it. A box import never lends ordinary `source()` scope or `# raven: nse` / `# raven: func` declarations. The `/` inside a box spec is exempt from the `infix_spaces` lint; ordinary `/` expressions are unaffected.

### Rhino applications

Rhino applications can use paths that aren't relative:

```r
box::use(app/view/hello)
box::use(
  app/logic/say_hello[say_hello],
)
```

Raven uses the nearest ancestor directory containing `rhino.yml` as the application root, following [Rhino's default `box.path` convention](https://github.com/Appsilon/rhino/blob/main/R/app.R). So `app/logic/say_hello` finds `<root>/app/logic/say_hello.R` from any file below the root, including nested view modules. The same candidate order and case checks apply, including `__init__.R` modules. Aliases, renamed attachments, wildcard imports, reexports, and editor features work as for relative modules. A bare `app` still means an installed package.

The marker identifies the root even when you open a parent repository or a subdirectory. A nested `rhino.yml` starts a separate application, and Raven doesn't fall back to an outer application when a module is missing there. Without a marker or a known custom search path, qualified imports stay unresolved, with no module-not-found diagnostic.

### Custom search paths

Custom search paths work in Rhino applications and other projects. Raven uses the first of these that supplies a value:

1. `box.searchPaths` in the project's `raven.toml`.
2. A non-empty `R_BOX_PATH` environment variable when Raven starts.
3. A statically readable `options(box.path = ...)` in the workspace-root `.Rprofile`.
4. The nearest Rhino application root.

```toml
[box]
searchPaths = ["modules", "../shared-r"]
```

Entries in `raven.toml` are relative to the directory containing it. The setting affects only Raven's analysis, not R's options. You can instead reuse an existing startup declaration:

```r
options(box.path = c("modules", "../shared-r"))
```

Entries in `.Rprofile` are relative to the workspace root. See [Search path rules](#search-path-rules) for which `.Rprofile` forms count, how roots are searched, and how changes are picked up.

## import package (`import::from()`)

The import package selects names from an installed package or a local `.R`/`.r` script:

```r
import::from(dplyr, filter, select)     # selected names
import::from(dplyr, keep = filter)       # renamed
import::from(dplyr, .except = "lag")     # every export except some
import::here(clean, .from = "utils.R")   # into the current environment
```

- A source is a package name or a **literal** `.R`/`.r` path. The extension is part of the path; there is no box-style candidate search. A literal `.directory` is honored.
- `.all = TRUE` attaches the known export set, and a non-empty static `.except` implies `.all`. When several `.all` imports bind the same local name, R's last-write-wins order applies.
- `here()` binds into the current environment at the call. Inside a function, its effect stays in that function.
- `from()` and `into()` bind into a lower-priority search-path environment. These are fallback bindings *below* your own names, not namespace objects, so they don't enable `$` access.

A local script module's candidate exports are its private top-level environment, including dotted names and top-level `import::here()` bindings. box export markers don't apply to import modules. Editing a local script module rechecks the files that import it, without lending ordinary scope.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `box.searchPaths` (`raven.toml` only) | unset | Directories box searches for qualified module paths, relative to `raven.toml` |

There is no VS Code setting for this; it is a project setting. See [Configuration](configuration.md) for how `raven.toml` is found.

<a id="what-is-not-covered"></a>
## Limitations

Both systems stop at what is statically knowable. Programmatic calls, computed or dynamic sources and paths, remote and pins modules, runtime `options(box.path = ...)`, `.character_only` package vectors, and side-effecting load or unload hooks are left inert rather than guessed. For the exact lists, see [Limitations: box module system](limitations.md#box-module-system-boxuse) and [Limitations: import package](limitations.md#import-package). For the `box-*` and `import-*` diagnostic codes, see [Diagnostics](diagnostics.md#diagnostic-codes).

## Details

### Search path rules

<details markdown="1">
<summary>Which <code>.Rprofile</code> forms count, and how roots are searched</summary>

Raven reads `options(box.path = ...)` from the workspace-root `.Rprofile` when it is an unconditional top-level call whose value is a literal string, a `c()` of literal strings, `NULL`, or `character(0)`. `base::`-qualified calls and R raw strings are accepted.

- Strings that need escape processing, and computed expressions, leave the value unknown.
- Declarations apply in order, and a later dynamic or conditional write makes an earlier known value unknown.
- Function bodies and quoted expressions don't set paths.
- Masking `options`, `c`, or `character` stops inference from the unqualified call.
- Raven reads only the root `.Rprofile` for this, not files it sources, home profiles, or `.Renviron`.

`R_BOX_PATH` uses `:` on Unix and `;` on Windows, and relative entries are resolved from Raven's startup working directory. An empty value is ignored. Restart Raven to pick up a changed environment. Raven never runs startup code or syncs with a running R session.

For an explicit path list, Raven searches the roots in order, then the importing file's directory, with the file and `__init__` candidate order in each. An exact match in a later root wins over a case mismatch in an earlier one. An empty configured list or `character(0)` uses only the importing directory. `NULL` removes the option, which allows Rhino's default. An unknown `.Rprofile` value stays unresolved rather than falling back to a possibly wrong Rhino module; explicit configuration or the startup environment can override it. Paths are literal: shell substitutions and `~` expansion aren't supported.

Reading paths from `.Rprofile` is independent of `packages.enabled` and `packages.rprofilePrelude`, and applies to qualified imports in every file, including package tests. It is a project analysis convention; it doesn't imply that a clean R test process runs `.Rprofile`. Excluded or gitignored profiles don't contribute paths.

</details>

<details markdown="1">
<summary>How changes to roots and modules are picked up</summary>

Reloading the config, and opening, editing, closing, or changing `.Rprofile` on disk, refreshes imports. Raven loads referenced files outside the workspace without scanning entire search roots.

In editors that support dynamic file watches, including VS Code, Raven watches external roots for R files being created, changed, or deleted. Other editors must forward those events for live updates. Creating a module in a higher-priority root, or deleting the selected module, retargets the import.

VS Code watches `rhino.yml` creation and deletion inside open workspace folders, along with module file changes. If you open only a subdirectory, a change to a marker above it needs you to reopen or edit the importing file, or open the application root as a workspace folder. Other editors must forward `rhino.yml` file events for live root changes.

</details>

## See also

- [Cross-file analysis](cross-file.md): how `source()` and `library()` differ from imports
- [Diagnostics](diagnostics.md#box-module-not-found): the `box-*` and `import-*` codes
- [.Rprofile startup files](rprofile.md#static-box-search-paths): box search paths from `.Rprofile`
- [Limitations](limitations.md#box-module-system-boxuse): exact box and import boundaries
