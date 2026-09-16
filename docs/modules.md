# Module & import systems

Raven understands two R module/import systems whose semantics ordinary
`library()` and `source()` cannot express: the [`box`](https://klmr.me/box/)
package and the [`import`](https://rticulate.github.io/import/) package. Both are
modelled as **selective imports** — Raven brings in only the names an import
actually requests, under the names it requests. It never merges a whole file's
definitions the way `source()` does, and never dumps a package's entire export
set in as bare names the way `library()` does.

Everything here is **static**: Raven does not run your code to discover what a
module exports or where it lives. Forms it cannot read statically are left inert
— they neither bind names nor produce misleading diagnostics. For the exact
boundaries see [Limitations](limitations.md); for the diagnostic codes see
[Diagnostics](diagnostics.md).

## box modules (`box::use()`)

A box import binds a **namespace object** (used as `alias$member`) and/or an
explicitly chosen subset of a module's exports:

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

- A **bare name** is an installed package. Explicit relative modules begin with
  `./` or `../`; qualified paths such as `app/logic/math` resolve in Rhino
  applications. Both top-level and function-scoped calls are recognised, as is
  the `box:::use()` spelling.
- The default namespace name is the final path/package component (`../lib/util`
  binds `util`); write `alias = spec` to override it.
- An **attach-only** spec (`pkg[a, b]`, `pkg[...]`) binds no namespace object
  unless you also alias it (`alias = pkg[...]`).

**Explicit relative modules** resolve relative to the importing file's own directory — box
does not use Raven's `source()` working-directory or workspace-root fallback
rules. The extension is omitted in the spec; Raven tries `path.r`, `path.R`,
`path/__init__.r`, then `path/__init__.R` (so a file module wins over a package
module), and resolution is case-sensitive.

**Rhino applications** can use non-relative module paths:

```r
box::use(app/view/hello)
box::use(
  app/logic/say_hello[say_hello],
)
```

Raven uses the nearest ancestor directory containing a `rhino.yml` file as the
application root. This follows [Rhino's default `box.path` convention](https://github.com/Appsilon/rhino/blob/main/R/app.R).
For example, `app/logic/say_hello` finds `<root>/app/logic/say_hello.R` from
any file beneath that root, including nested view modules. The same candidate
order and case checks apply, including `__init__.R` modules. Aliases, renamed
attachments, wildcard imports, reexports, and editor features work as they do
for explicit relative modules. A bare `app` still means an installed package.

The marker identifies the root even when you open a parent repository or a
subdirectory in the editor. A nested `rhino.yml` starts a separate application;
Raven does not fall back to an outer application if a module is missing there.
VS Code watches marker creation and deletion within opened workspace folders,
along with module file changes. If you open only a subdirectory, changes to an
ancestor marker require reopening or editing the importing file, or opening
the application root as a workspace folder. Other LSP clients must forward
`rhino.yml` file events for live root changes.
Without a marker or a known custom search path, qualified imports stay unresolved
without module-not-found diagnostics.

**Custom search paths** work in Rhino applications and other projects. Raven
selects one input, in this order:

1. Project-only `box.searchPaths` in `raven.toml`.
2. A nonempty `R_BOX_PATH` inherited when Raven starts.
3. Statically readable `options(box.path = ...)` in the workspace-root `.Rprofile`.
4. The nearest Rhino application root, when none of the above supplies a value.

For example:

```toml
[box]
searchPaths = ["modules", "../shared-r"]
```

Config entries are relative to the directory containing `raven.toml`. The setting
controls Raven's analysis; it does not change R's options. Alternatively, reuse
an existing project startup declaration:

```r
options(box.path = c("modules", "../shared-r"))
```

Profile entries are relative to the workspace root. Raven accepts unconditional
top-level calls with a literal string, `c()` of literal strings, `NULL`, or
`character(0)`, including `base::`-qualified calls and R raw strings. Strings
requiring escape evaluation and computed expressions remain unknown. Declarations
apply in order; a later dynamic or conditional write invalidates an earlier
known value. Function bodies and quoted expressions do not set paths. Masking
`options`, `c`, or `character` prevents inference from the unqualified call.
Raven reads only the root profile for this purpose, not sourced helpers, home
profiles, or `.Renviron`.

`R_BOX_PATH` uses `:` on Unix and `;` on Windows. Relative entries use Raven's
startup working directory. An empty environment value is ignored. Restart Raven
to pick up a changed environment. Raven never executes startup code or
synchronizes with a running R session.

For an explicit path list, roots are searched in order, followed by the importing
file's directory. Each root uses the file/`__init__` candidate order above. An
exact match in a later root wins over a case mismatch in an earlier root.
An empty configured list or `character(0)` uses only the importing directory;
`NULL` removes the option, allowing Rhino's default. An unknown profile value
stays unresolved rather than falling back to a potentially wrong Rhino module;
explicit configuration or the startup environment can override it. Paths are
literal: shell substitutions and `~` expansion are not supported.

Profile path inference is independent of `packages.enabled` and
`packages.rprofilePrelude`, and applies to qualified imports in all file
contexts, including package tests. This is a project analysis convention; it
does not imply that a clean R test process executes `.Rprofile`. Excluded or
gitignored profiles do not contribute paths.

Config reloads and `.Rprofile` open/edit/close or watched changes refresh imports.
Raven loads referenced files outside the workspace without scanning entire
search roots. For clients supporting dynamic relative file watches (including
VS Code), it registers external roots for R-file creation, changes, and deletion.
Other clients must forward those events for live updates. Module creation in a
higher-priority root and deletion of a selected module retarget the import.

**Exports** come from `box::export()` and `#' @export` tags. When either is
present the interface is authoritative, so a missing member (`module$typo`) is
diagnosable. A module with no export markers falls back to "every top-level name
that does not begin with a dot," treated as *non-authoritative* — absence is not
concluded, because a dynamic binding might supply it. Private names, and names
only transitively imported, never cross the boundary.

Imported namespace aliases and attached members work everywhere Raven's
intelligence does — diagnostics, completion, hover, signatures, go-to-definition,
and find-references — in open and workspace-indexed files, in the language server
and `raven check`. Editing a local module's exports revalidates its importers,
but a box edge never lends ordinary `source()` scope or `# raven: nse` /
`# raven: func` declarations. The `/` inside a box spec stays exempt from the
`infix_spaces` lint; ordinary `/` expressions are unaffected.

## import package (`import::from()`)

The import package selects names from an installed package or a local `.R`/`.r`
script module:

```r
import::from(dplyr, filter, select)     # selected names
import::from(dplyr, keep = filter)       # renamed
import::from(dplyr, .except = "lag")     # every export except some
import::here(clean, .from = "utils.R")   # into the current environment
```

- A source is a package name or a **literal** `.R`/`.r` path (the extension is
  part of the path — no box-style candidate guessing). A literal `.directory`
  is honoured.
- `.all = TRUE` attaches the known export set; a non-empty static `.except`
  implies `.all`. When several `.all` bindings target the same local name, R's
  sequential last-write-wins order applies.
- `here()` binds into the current (lexical) environment at the call position —
  inside a function, its effect stays in that function. `from()` and `into()`
  bind into a lower-priority search-path destination: these are fallback bindings
  *below* your lexical names, not namespace objects, so they enable no `$` access.

A local script module's candidate exports are its private top-level environment
(including dotted names and top-level `import::here()` bindings). box export
markers do not govern import modules. Editing a local module revalidates its
importers without lending ordinary scope.

## What is not covered

Both systems deliberately stop at what is statically knowable. Programmatic
invocation, computed or dynamic sources and paths, remote/pins modules, runtime
`options(box.path = ...)`, `.character_only` package vectors, and side-effecting
load/unload hooks are left inert rather than guessed. For the exact per-system
lists, see [Limitations — box module system](limitations.md#box-module-system-boxuse)
and [Limitations — import package](limitations.md#import-package); for the
`box-*` and `import-*` diagnostic codes, see [Diagnostics](diagnostics.md).
