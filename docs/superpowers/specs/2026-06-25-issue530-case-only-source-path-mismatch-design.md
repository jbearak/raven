# Resolve case-only `source()` path mismatches into the graph (issue #530)

**Status:** design approved (direction); pending implementation
**Issue:** #530

## Problem

When a `source()` / forward-directive path differs from the real on-disk
filename **only by case**, raven's behavior splits by host filesystem:

- **Case-insensitive FS (macOS, typical Windows):** the path already resolves
  silently. Issue #476 added case-correction (`canonicalize_case_below`) at the
  resolution chokepoint, so `source("scripts/templates.r")` resolves to the
  on-disk `templates.R`, the edge target URI matches the workspace index key,
  and the symbols are visible. **Verified:** `raven check` reports `0 issues`
  for this case today. What is *missing* is any signal that the same code will
  break on a case-sensitive filesystem.

- **Case-sensitive FS (Linux/CI):** the lexical path `…/templates.r` fails
  `Path::exists()`, so the `canonicalize_case_below` correction (which is gated
  behind `canonical.exists()`) never runs. The path is reported as
  `unresolved-source-path` ("File not found"), the target is **dropped from the
  source graph**, and every symbol that file would have defined cascades into
  false `undefined-variable` diagnostics. A single one-character case typo
  produced ~140 bogus warnings in the motivating real-world report.

The fix, in both regimes: **resolve the file into the graph, report the case
mismatch once at the `source()` site, and never let it cascade.**

## Goals

1. On a **case-insensitive FS**, when a `source()`/forward-directive path
   resolves only via a case-only difference, emit an **information**-level
   diagnostic at the `source()` line flagging the portability hazard. Resolution
   is unchanged (already works).
2. On a **case-sensitive FS**, when the typed path has no exact match but
   **exactly one** case-insensitive match, **resolve it into the graph anyway**
   and emit a **warning**-level diagnostic at the `source()` line. This both
   kills the cascade and surfaces the one real, actionable warning.
3. The diagnostic's severity is host-derived by default but configurable via a
   new `raven.crossFile.caseMismatchSeverity` setting.

## Non-goals

- `system.file()` source diagnostics (package-internal; resolution
  case-correction from #476 already applies there, but no case-mismatch
  diagnostic is emitted for them).
- **Backward-directive (`# raven: sourced-by` / `run-by` / `included-by`)
  behavior is unchanged.** The new resolution leniency (Component 1) is
  **forward-only** — gated on the same flag that enables the workspace-root
  fallback (`try_workspace_fallback`, true only for `source()` calls and forward
  directives). Backward directives continue to resolve via the exact-match path
  only, so a case-typo'd `# raven: sourced-by` stays `unresolved-source-path` on
  a case-sensitive FS exactly as today. This avoids silently altering the
  dependency graph for backward edges with no diagnostic signal (a backward edge
  is created the moment `resolve_path` returns a URI), and keeps the change
  inside the issue's scope (`source()`/include). The five-consumer
  uniform-resolution invariant is preserved *per direction*: all forward
  consumers route through `resolve_path_with_workspace_fallback` and get the
  leniency; all backward consumers route through `resolve_path` and do not.
- **Non-ASCII case folding.** Case-insensitive matching reuses the existing
  `eq_ignore_ascii_case` comparison (ASCII-only), matching #476's behavior. A
  filename differing only by the case of a non-ASCII letter is **not** detected
  as a case mismatch. Locale/Unicode-aware folding is out of scope.
- Auto-fix / code action to correct the casing (possible follow-up).

## Design

### Component 1 — resolution leniency + mismatch signal at the chokepoint (`cross_file/path_resolve.rs`)

The mismatch must be detected **inside resolution**, where the base that
actually won (file-relative `base`, the workspace-root fallback base, or the
`/`-prefixed `workspace_root`) is known. A separate after-the-fact helper cannot
know which base produced the resolved path (finding #2), so resolution returns
the signal directly.

Refactor `resolve_path_impl` to return a richer outcome, with thin wrappers
preserving the five consumers' existing `Option<PathBuf>` signatures:

```rust
pub enum CaseMismatchRegime { CaseInsensitiveFs, CaseSensitiveFs }

pub struct ResolveOutcome {
    pub path: Option<PathBuf>,            // case-corrected real path, as today
    pub case_mismatch: Option<CaseMismatchRegime>, // Some iff resolved via case-only diff
}

// New rich entry point; forward-only fallback flag as today.
fn resolve_path_rich(path: &str, ctx: &PathContext, try_workspace_fallback: bool) -> ResolveOutcome;

// Existing public fns become wrappers returning `.path` — UNCHANGED signatures,
// so dependency-graph build, scope, go-to-definition, and completion are
// untouched:
pub fn resolve_path(path, ctx) -> Option<PathBuf>            { resolve_path_rich(path, ctx, false).path }
pub fn resolve_path_with_workspace_fallback(path, ctx) -> Option<PathBuf> { resolve_path_rich(path, ctx, true).path }

// New public wrapper the case-mismatch collector calls:
pub fn resolve_source_path_rich(path: &str, ctx: &PathContext) -> ResolveOutcome { resolve_path_rich(path, ctx, true) }
```

**Resolution ordering (pins finding #1).** For each base attempted, an
exact-case match always wins before any case-insensitive match is considered.
The full order for a forward (`try_workspace_fallback = true`) relative path:

1. file-relative **exact** (`base.join(path)` exists byte-for-byte on a
   case-sensitive FS, or via FS folding on a case-insensitive FS) — today's
   `canonical.exists()` branch, with `canonicalize_case_below` applied. On a
   case-insensitive FS a case-variant resolves here and is flagged
   `CaseInsensitiveFs`.
2. workspace-root fallback **exact** (only when `!cd_in_effect()` and a
   workspace root exists) — today's fallback branch.
3. file-relative **case-insensitive single match** (new) — accept only if the
   case-corrected path exists **and every otherwise-missing component below
   `base` resolved to exactly one case-insensitive directory entry**; flag
   `CaseSensitiveFs`.
4. workspace-root fallback **case-insensitive single match** (new, same gate as
   step 2 plus the single-match requirement) — flag `CaseSensitiveFs`.
5. otherwise → `path: Some(lexical)`, `case_mismatch: None` (→
   `unresolved-source-path`, today's behavior).

Steps 3–4 are **forward-only** (guarded by `try_workspace_fallback`), so
backward directives never gain leniency (finding #5). The `/`-prefixed branch
resolves below `workspace_root`; it gets the same exact-then-single-ci-match
treatment, also forward-only.

The single-match gate needs a **uniqueness-aware** variant of `real_entry_name`
(which today returns the *first* ci match without counting): it must
distinguish "exactly one ci match" from "2+ ci matches", returning no match in
the ambiguous case. ASCII-only comparison, as today (see Non-goals).

**Regime derivation.** `CaseInsensitiveFs` when the path resolved at an
exact-`exists()` step (1/2) but `canonicalize_case_below` changed a component's
spelling (the FS folded the lookup — only possible on a case-insensitive FS).
`CaseSensitiveFs` when it resolved only at a single-ci-match step (3/4) — the
typed spelling did not exist, so this is a case-sensitive FS where R would
error. This is determined per-directory from the actual resolution path, needs
no global FS probe, and is correct on mixed-sensitivity volumes.

Properties:
- On a **case-insensitive FS** steps 3–4 are a guaranteed no-op: a case-variant
  entry always satisfies step 1's `exists()` (the FS folds the lookup), and two
  entries differing only by case cannot coexist. **No regression risk for the
  already-working macOS path** — its only change is gaining the
  `CaseInsensitiveFs` mismatch signal.
- On a **case-sensitive FS** steps 3–4 are what make the file enter the
  dependency graph, fixing the cascade **uniformly across all five forward
  resolution consumers** (graph build, scope, missing-file diagnostics,
  go-to-definition, completion), since all route through
  `resolve_path_with_workspace_fallback` → `resolve_path_rich(.., true)`.

### Component 2 — (folded into Component 1)

The mismatch detection is part of resolution (Component 1); there is no separate
post-hoc helper. The collector consumes `ResolveOutcome.case_mismatch`.

### Component 3 — diagnostic emission: a separate, separately-gated collector (`handlers.rs`)

**Factual correction (finding #3):** the two existing collectors are **not**
symmetric. `collect_missing_file_diagnostics_standalone` (async) batches
`exists()` checks and emits "File not found" for resolved-but-missing files.
`collect_missing_file_diagnostics_from_snapshot` (sync) performs **no** existence
check — it emits only when `resolve_path*` returns `None`
(`handlers.rs:5154`). Both are gated by `missing_file_severity` (standalone runs
only when it is `Some`, `handlers.rs:4794`; snapshot early-returns when `None`,
`handlers.rs:5138`).

**Single owning phase (fixes finding #1 — no duplicates).** Both production
entry points — the LSP debounced path (`backend.rs:2522`/`2539`) and `raven
check` (`cli/check.rs:1102`/`1116`) — run `diagnostics_from_snapshot` first, then
feed its output into `diagnostics_async_standalone`, which **strips** the
snapshot's missing-file messages by string match (`handlers.rs:4783`) and
re-emits them authoritatively via `collect_missing_file_diagnostics_standalone`
(`handlers.rs:4796`). Missing-file is therefore *owned by the standalone phase*.
The case-mismatch diagnostic must be emitted in **exactly that one phase**: add
its collection inside `diagnostics_async_standalone`. The snapshot collector
(`collect_missing_file_diagnostics_from_snapshot`) does **not** emit it, so there
are no duplicates and the async strip step needs no new string to match.

**The case-mismatch diagnostic must NOT be gated by `missing_file_severity`
(finding #4).** In `diagnostics_async_standalone`, the existing
`collect_missing_file_diagnostics_standalone` call sits inside
`if let Some(severity) = missing_file_severity`. The new case-mismatch
collection goes **outside** that block, gated by its own resolved
`caseMismatchSeverity`, so `missingFileSeverity = "off"` does not silence it.
`diagnostics_async_standalone` gains a new parameter carrying the
case-mismatch severity config. **All** production callers must pass it from the
snapshot's `cross_file_config`: the debounced LSP path (`backend.rs:2539`), the
`publish_diagnostics_inner` LSP path (`backend.rs:8363`), and `raven check`
(`cli/check.rs:1116`). Test call sites (e.g. `backend.rs:15744`) are updated
too. A search for every `diagnostics_async_standalone(` call must come up
fully-threaded — missing one would silently drop the diagnostic on that path.

Dedicated collector, e.g.
`collect_case_mismatch_diagnostics_standalone(uri, meta, workspace_folders, cfg) -> Vec<Diagnostic>`:

- Iterate `meta.sources` (**forward only**). Skip any source where
  `source.system_file.is_some()` — `system.file()` sources are a non-goal, and
  branch-1 self-package entries (path `/inst/...`) are **not**
  `exempt_from_missing_file_diagnostics` (`types.rs:370`), so they must be
  excluded explicitly here or they would wrongly draw a case-mismatch
  diagnostic. Also skip `exempt_from_missing_file_diagnostics` (inert/resolved
  system.file entries). Backward directives are not considered.
- For each, build the forward `PathContext` and call `resolve_source_path_rich`.
  When `case_mismatch` is `Some`, push a diagnostic. Because the regime comes
  from resolution, no separate existence check is needed.
- Resolve `caseMismatchSeverity`: `Off` → emit nothing; `Fixed(s)` → severity
  `s`; `Auto` → INFO for `CaseInsensitiveFs`, WARNING for `CaseSensitiveFs`.

Diagnostic fields:
- `code`: `source-path-case-mismatch`.
- `range`: the **forward-source** construction the sibling missing-file
  diagnostic in this same standalone phase uses (finding #2/#3): `start =
  (source.line, source.column)`, `end = (source.line, source.column +
  path.len() + 10)` using the standalone phase's byte-length `path.len()` (as at
  `handlers.rs:5002`). Forward directives also live in `meta.sources` and use
  this same `source.line/source.column` form — the `0..LSP_EOL_CHARACTER`
  full-line form is for *backward* directives only and is not used here. (No
  stored true literal-path range exists today; this matches existing behavior.)
- `severity`: as resolved above.
- `message`: names the typed path and the real on-disk file and the hazard:
  - `CaseInsensitiveFs`: `Case mismatch: 'scripts/templates.r' resolves to
    'templates.R' on this filesystem, but will not be found on a case-sensitive
    filesystem (e.g. Linux CI).`
  - `CaseSensitiveFs`: `Case mismatch: 'scripts/templates.r' not found; using
    the case-insensitive match 'templates.R'. R errors here on this
    case-sensitive filesystem — fix the path casing.`

Mutual exclusivity with `unresolved-source-path` is structural: a path with
`case_mismatch = Some` resolved to an existing file, so the missing-file branch
does not fire for it.

### Component 4 — `raven.crossFile.caseMismatchSeverity` setting

A new configuration value, parallel to `missingFileSeverity`:

- **Values:** `"auto"` (default), `"error"`, `"warning"`, `"information"`,
  `"hint"`, `"off"`.
- **`"auto"`** → host-derived: INFO on case-insensitive FS, WARNING on
  case-sensitive FS (Component 2 regime).
- A pinned level overrides both regimes; `"off"` suppresses the diagnostic
  entirely.

Representation in `cross_file_config`: a small enum, e.g.

```rust
enum CaseMismatchSeverity { Auto, Fixed(DiagnosticSeverity), Off }
```

so `"auto"` is distinct from a pinned level and from `off`.

Wiring (the standard three-place + reference-regen dance for a new LSP setting):
- Rust config layering: `config_file/mod.rs` (the raw layer + the
  `recompute_parsed_configs` writer) and the `cross_file_config`
  (`cross_file/config.rs`) carried in `DiagnosticsSnapshot`. The resolved value
  is threaded as a new parameter into `diagnostics_async_standalone` by both
  callers (`backend.rs`, `cli/check.rs`) and on into the dedicated collector.
- Backend init-options parsing: `backend.rs` string→value mapping (add the
  `"auto"` sentinel handling).
- VS Code: `editors/vscode/package.json` schema, the shared
  `editors/vscode/src/initializationOptions.ts` factory, `SETTINGS_MAPPING` +
  named-value cases in `editors/vscode/src/test/settings.test.ts`, then
  regenerate the settings index with
  `bun editors/vscode/scripts/generate-settings-reference.mjs` (drift-gated by
  `tests/bun/settings-reference.test.ts`).
- `raven check` (CLI): honor the configured value; `"auto"` resolves at emission
  time per the per-directory regime, so CI on Linux naturally gets the WARNING.

### Component 5 — diagnostic code registration (`diagnostic_code.rs`)

- Add `pub const SOURCE_PATH_CASE_MISMATCH: &str = "source-path-case-mismatch";`
- Add to `ANALYZER_CODES`.
- **Not** added to `SUPPRESSIBLE_ANALYZER_CODES` — like `unresolved-source-path`,
  it is governed only by its severity setting, not by `# raven: ignore`.

## Behavior matrix

| Host FS | Typed vs on-disk | Exact match? | ci matches | Resolution | Diagnostic |
|---|---|---|---|---|---|
| insensitive | `templates.r` vs `templates.R` | no | n/a (folds) | resolves (today) | **INFO** case-mismatch (new) |
| insensitive | exact | yes | — | resolves | none |
| sensitive | `templates.r` vs `templates.R` | no | exactly 1 | **resolves (new)** | **WARNING** case-mismatch (new) |
| sensitive | `tempaltes.R` (typo) | no | 0 | unresolved | `unresolved-source-path` (today) |
| sensitive | both `templates.R` & `templates.r` exist, typed `Templates.R` | no | 2+ | unresolved (ambiguous) | `unresolved-source-path` (today) |
| sensitive | exact | yes | — | resolves | none |

With `caseMismatchSeverity` pinned, the "INFO/WARNING" cells take the pinned
level; with `"off"`, no case-mismatch diagnostic is emitted (resolution still
happens, so no cascade either).

## Testing

- **`path_resolve.rs` unit tests** (tempdir):
  - uniqueness-aware `real_entry_name` variant: single ci match → the real
    entry; 2+ ci matches → no match (ambiguous); exact-case query returned
    verbatim (extends the existing `canonicalize_case_below_*` tests).
  - `resolve_path_rich` ordering: an exact match beats a case-insensitive match
    at the same and at a later base (file-relative exact vs workspace-fallback
    ci; workspace-fallback exact vs file-relative ci). On a case-sensitive host
    a single-ci-match forward path resolves with
    `case_mismatch = Some(CaseSensitiveFs)`; an ambiguous 2+-match path resolves
    to `path: Some(lexical)`, `case_mismatch: None`. Backward
    (`try_workspace_fallback = false`) never yields `case_mismatch`.
  - regime correctness: when run on a case-insensitive host, a case-variant
    forward path yields `Some(CaseInsensitiveFs)`; the `CaseSensitiveFs` arm is
    asserted on a case-sensitive host (see below).
- **`handlers.rs` collector tests:** a forward `source()` with a case-only
  mismatch produces exactly one `source-path-case-mismatch` at the expected
  range/severity, **no** `unresolved-source-path`, and (via an integration-level
  check) **no** `undefined-variable` cascade for the sourced file's symbols.
  Assert the dedicated collector is **independent of `missingFileSeverity`** —
  with `missingFileSeverity = "off"` and `caseMismatchSeverity` non-off, the
  case-mismatch diagnostic still emits. Assert **single emission** (no
  duplicate) through the full `diagnostics_from_snapshot` →
  `diagnostics_async_standalone` pipeline.
- **Config tests:** `"auto"` / pinned level / `"off"` each map to the expected
  emission and severity; VS Code `settings.test.ts` named-value cases;
  settings-reference drift test stays green.
- **Host-FS dependence.** The `CaseSensitiveFs` regime requires the typed
  spelling to not exist while a ci match does — impossible to construct on a
  case-insensitive host. Tests that need it are gated with a runtime
  case-sensitivity probe (create `aA`-style temp entries and check) and run for
  real in Linux CI; on a case-insensitive dev host they assert the
  `CaseInsensitiveFs` arm instead. The ordering/uniqueness tests are
  host-agnostic.

## Docs to update

- `docs/diagnostics.md`: add `source-path-case-mismatch` to the codes table
  (not suppressible) and a row/paragraph under **Cross-File Diagnostics**
  describing the host-derived severity.
- `docs/cross-file.md`: explain case-only mismatch resolution and the
  portability diagnostic.
- `docs/configuration.md` + `docs/settings-reference.md` (regenerated): the new
  `caseMismatchSeverity` setting.
- `docs/cli.md`: note that `raven check` on case-sensitive CI surfaces the
  WARNING.

## Risks / notes (post-review)

- **Uniqueness vs. the existing first-match `real_entry_name`.** The existing
  `canonicalize_case_below` deliberately takes the first ci match (correct for
  the post-`exists()` correction in steps 1–2). The new single-match gate
  (steps 3–4) uses a *separate* uniqueness-aware lookup and must not resolve
  ambiguous multi-match cases. The two paths stay distinct.
- **Determinism across machines.** Under `"auto"` the same file yields INFO on a
  dev's Mac and WARNING in Linux CI. This is *intended* (the issue wants the CI
  signal). Golden/snapshot severity tests must not assume a fixed level under
  `"auto"` — see Host-FS dependence in Testing.
- **`ResolveOutcome` refactor blast radius.** The five consumers keep their
  `Option<PathBuf>` signatures via thin wrappers, so the refactor is internal to
  `path_resolve.rs`; verify no consumer relied on a behavior other than "return
  the resolved path or None".
- **Single-phase emission parity.** The case-mismatch collector lives only in
  `diagnostics_async_standalone`, which both the LSP and `raven check` run as the
  final phase — so the two agree by construction and no duplicate can arise from
  the snapshot phase. Do not also add it to `diagnostics_from_snapshot`.
