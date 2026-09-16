# Static box search paths

Implement as a separate PR after #765 merges. No synchronization with a running
R session, R evaluation, or R subprocess for path discovery.

## User-visible contract

- Add project-only `[box] searchPaths = ["modules", "../shared-r"]` in
  `raven.toml`. Resolve relative entries against the directory containing that
  configuration file. An explicit list overrides inferred inputs, including an
  empty list; it is a Raven analysis override and does not change R's options.
- Capture the `R_BOX_PATH` inherited by Raven at startup. Use the platform path
  separator and anchor relative entries to Raven's startup working directory.
  An empty environment value behaves as absent, matching box.
- Recognize unconditional top-level `options(box.path = "modules")` and
  `options(box.path = c("modules", "../shared-r"))`, including `base::options`,
  in the workspace-root `.Rprofile`. Resolve relative entries against the
  workspace root. Process declarations in source order; a later unsupported
  assignment to `box.path` invalidates an earlier known value. Function bodies
  do not contribute. Do not evaluate conditions, variables, arbitrary calls,
  sourced startup scripts, home profiles, or `.Renviron`.
- A conditional write invalidates a prior known value, rather than silently
  preserving it. Respect masking of unqualified `options`, `c`, and `character`;
  explicit `base::` forms remain analyzable. A later unconditional known write
  may restore a known value. Test both transitions.
- Treat path declarations as project analysis configuration, independently of
  `packages.enabled` and `packages.rprofilePrelude`; they apply to qualified
  module imports in all project file contexts, including package tests. This
  does not assert that a clean R test process executes `.Rprofile`. Honor
  workspace exclusion/gitignore rules when discovering a profile and document
  that excluded profiles do not contribute. Explicit configuration and startup
  environment paths remain available in those cases.
- Distinguish absent/reset (`NULL`), known empty (`character(0)`), known ordered
  paths, and unknown dynamic declarations. Document the supported static subset
  and recommend explicit configuration for other forms.
- Precedence: explicit Raven config, then nonempty startup `R_BOX_PATH`, then
  statically known project `box.path`, then Rhino's existing inferred root.
  An unknown higher-priority input must not silently select a lower-priority
  module. Preserve existing behavior where no search-path context is known.
- For known search paths, search each root in order, with the importing file's
  directory last. Within each root preserve `.r`, `.R`, `__init__.r`,
  `__init__.R` ordering. An exact match in any root beats a case-mismatch report.
  Explicit relative imports bypass this list; bare names remain packages.

## Implementation

1. Introduce a small shared box search-path input/resolution module. Keep input
   collection separate from pure precedence selection and filesystem lookup.
   Persist the ordered candidate roots in qualified imports so diagnostics,
   graph construction, and editor requests consume the same result without I/O.
2. Parse the project-only setting through the existing configuration authority.
   Snapshot startup environment once. Capture configuration and `.Rprofile`
   inputs for detached enrichment; avoid re-reading/parsing startup files per
   import or cloning full project state.
3. Thread that snapshot through existing editor, workspace scan, on-demand,
   excluded-file, and CLI enrichment paths. Keep `{import}` and ordinary
   `source()` resolution semantics unchanged.
4. Refresh affected imports on configuration reload and project `.Rprofile`
   open/edit/close/save/delete. Reuse guarded commits and existing on-demand
   loading for newly selected targets and their reexports. Track all candidate
   roots so higher-priority creation and selected-module deletion switch the
   target correctly. State the client file-watching boundary for external roots.
5. Update modules, configuration, Rprofile, limitations, and maintainer docs.
   Include examples and explicitly describe relative anchors, precedence,
   static parsing limits, and startup-only environment behavior.

## Verification and delivery

- Focused tests for ordered roots, shadowing, empty/reset/unknown inputs,
  namespace and renamed attachments, `__init__` reexports, case mismatch,
  missing modules, non-Rhino projects, and explicit-relative/package regressions.
- Tests for conditional writes, masked built-ins versus base-qualified calls,
  excluded profiles, package scopes, and both package/prelude switches disabled.
- Environment-list tests for wholly empty values, leading/interior/trailing
  empty entries, repeated separators, Windows drive paths and semicolons, and
  Unix colons. Match R's splitting behavior rather than assuming Rust's generic
  path splitting is identical. Set environment variables on CLI child processes
  or inject captured inputs; never mutate shared test-process environment.
- CLI and editor integration tests for equivalent resolution, external module
  loading, configuration/profile changes, removal, candidate creation/deletion,
  and stale asynchronous refresh rejection. Reuse existing editor feature
  tests to cover completion, hover, signatures, and definition provenance.
- Run the pinned-toolchain full Rust suite, `cargo fmt --all` and its check,
  workspace/all-target clippy with `test-support` and warnings denied, and
  private-item rustdoc with warnings denied in default and `test-support`
  configurations. Run relevant Bun/extension checks if touched.
- Run independent subagent reviews for correctness/regressions, lifecycle and
  performance/memory, and coverage/simplicity. Fix findings and repeat until all
  return clean, then open the PR.
- Inspect CodeRabbit and every CI gate, including performance. Resolve agreed
  comments or failures, repeat the review loop after fixes, and merge only when
  everything is clean. Do not waive gates or change thresholds to force green.

Primary semantics: <https://klmr.me/box/reference/use.html#search-path> and
<https://github.com/klmr/box/blob/main/R/paths.r>.
