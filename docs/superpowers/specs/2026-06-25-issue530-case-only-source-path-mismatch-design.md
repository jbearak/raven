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
- Backward-directive (`# raven: sourced-by` / `run-by` / `included-by`)
  diagnostics. Resolution leniency (component 1 below) applies uniformly because
  it lives at the shared chokepoint, so a backward directive with a case typo
  will *resolve* on a case-sensitive FS instead of erroring — a benign,
  consistent side effect — but **no** case-mismatch diagnostic is emitted for
  backward directives. This matches the issue's scope (`source()`/include).
- Auto-fix / code action to correct the casing (possible follow-up).

## Design

### Component 1 — resolution leniency at the chokepoint (`cross_file/path_resolve.rs`)

`resolve_path_impl` currently runs `canonicalize_case_below` only inside the
`if canonical.exists()` branch. Add a fallback branch for when the lexical path
does **not** exist:

- Attempt case-insensitive resolution of the path components **below `base`**
  (reusing the `canonicalize_case_below` mechanism), then re-check existence.
- Only accept the corrected path when it exists **and every otherwise-missing
  component resolved to exactly one case-insensitive directory entry**. If a
  component has 2+ case-insensitive matches (only possible on a case-sensitive
  FS), the result is ambiguous → return the lexical path unchanged (stays
  `unresolved-source-path`, current behavior).

This requires a **uniqueness-aware** variant of the existing `real_entry_name`
(which today returns the *first* case-insensitive match without counting). The
new helper distinguishes "exactly one ci match" from "multiple ci matches".

Properties:
- On a **case-insensitive FS** this new branch is a guaranteed no-op: if a
  case-variant entry exists, `canonical.exists()` already returned true (the FS
  folds the lookup), so the existing branch fired first. Two entries differing
  only by case cannot coexist on such a filesystem. **No regression risk for the
  already-working macOS path.**
- On a **case-sensitive FS** this is what makes the file enter the dependency
  graph, fixing the cascade **uniformly across all five resolution consumers**
  (dependency-graph build, scope resolution, missing-file diagnostics,
  go-to-definition path resolution, path completion) — the standing invariant
  that resolution behavior must be identical across these five.

Applies to both `resolve_path` and `resolve_path_with_workspace_fallback`, and
to all three resolution shapes (file-relative, workspace-root `/`-prefixed, and
workspace-root fallback), since all route through `resolve_path_impl` /
`canonicalize_case_below`.

### Component 2 — mismatch detection helper (`cross_file/path_resolve.rs`)

A pure, public helper the diagnostic collectors call:

```rust
pub enum CaseMismatchRegime { CaseInsensitiveFs, CaseSensitiveFs }

/// Returns the case-mismatch regime for a forward source path, or None when the
/// path resolves with an exact-case match (or doesn't resolve at all).
pub fn source_path_case_mismatch(path: &str, ctx: &PathContext)
    -> Option<(CaseMismatchRegime, PathBuf /* resolved real path */)>;
```

Logic:
1. Resolve via `resolve_path_with_workspace_fallback`. If `None`, return `None`.
2. If the resolved real path does not exist, return `None` (that is a
   missing-file case, handled by `unresolved-source-path`).
3. Compare the resolved real spelling against the typed spelling, component by
   component **below `base`**. If all are byte-equal → exact match → `None`. If
   any differ but are case-insensitively equal → **mismatch**.
4. Regime: derive **per-directory** from whether the typed absolute path
   (`base.join(typed)`) exists as-typed. Exists → `CaseInsensitiveFs` (the FS
   folded the lookup; R runs fine; INFO). Does not exist → `CaseSensitiveFs`
   (R would error; WARNING). No global FS-sensitivity probe — this is accurate
   even on mixed-sensitivity volumes (a case-sensitive APFS volume on macOS, a
   case-insensitive mount on Linux).

The regime decision is factored into a pure `fn regime(typed_exists: bool) ->
CaseMismatchRegime` so the INFO/WARNING mapping is unit-testable without a real
case-sensitive filesystem.

### Component 3 — diagnostic emission (`handlers.rs`)

Both collectors — `collect_missing_file_diagnostics_standalone` (async, live +
standalone) and `collect_missing_file_diagnostics_from_snapshot` (snapshot
path) — gain, for each **forward source that resolves to an existing file**, a
call to `source_path_case_mismatch`. On a mismatch, push a diagnostic:

- `code`: `source-path-case-mismatch`.
- `range`: the `source()`/directive path span (same span the existing
  unresolved-source-path / file-not-found diagnostics use).
- `severity`: resolved from `caseMismatchSeverity` (see Component 4); for
  `"auto"`, INFO for `CaseInsensitiveFs`, WARNING for `CaseSensitiveFs`.
- `message`: names the typed path and the real on-disk file and the hazard, e.g.
  - case-insensitive regime: `Case mismatch: 'scripts/templates.r' resolves to
    'templates.R' on this filesystem, but will not be found on a case-sensitive
    filesystem (e.g. Linux CI).`
  - case-sensitive regime: `Case mismatch: 'scripts/templates.r' not found;
    using the case-insensitive match 'templates.R'. R errors here on this
    case-sensitive filesystem — fix the path casing.`

Mutual exclusivity is structural: a path either resolves to an existing file
(→ possible case-mismatch diagnostic) or it does not (→ `unresolved-source-path`
/ file-not-found). The two never fire for the same source.

The standalone collector currently batches an existence check; the snapshot
collector keys off `resolved.is_none()`. The case-mismatch call slots into the
"resolved + exists" path of each so the resulting behavior matches.

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
  `recompute_parsed_configs` writer), the `cross_file_config` carried in
  `DiagnosticsSnapshot`, and the standalone collector's parameters.
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

- **`path_resolve.rs` unit tests** (tempdir, FS-agnostic):
  - uniqueness-aware resolution: single ci match resolves to the real entry; 2+
    ci matches → unresolved; exact-case query is returned verbatim (extends the
    existing `canonicalize_case_below_*` tests).
  - `source_path_case_mismatch`: detects a below-base directory-component
    mismatch as well as a filename mismatch; returns `None` for exact matches and
    for genuinely-missing files.
  - pure `regime(typed_exists)` mapping → INFO/WARNING.
- **`handlers.rs` collector tests:** a forward `source()` with a case-only
  mismatch produces exactly one `source-path-case-mismatch` at the path span,
  the correct severity, **no** `unresolved-source-path`, and **no**
  `undefined-variable` cascade for the sourced file's symbols. Cover both
  collectors.
- **Config tests:** `"auto"` / pinned / `"off"` each map to the expected
  emission; VS Code `settings.test.ts` named-value cases; settings-reference
  drift test stays green.
- **Case-sensitive-regime integration:** the WARNING regime requires
  `typed.exists() == false` alongside a ci match, which cannot be constructed on
  a case-insensitive host. Gate the full end-to-end WARNING assertion on a
  genuinely case-sensitive host (runs in Linux CI); the regime *logic* is covered
  host-independently via the pure `regime` function and via direct
  `canonicalize_case_below`-style tests.

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

## Risks / open questions for adversarial review

- **Uniqueness vs. the existing first-match `real_entry_name`.** The existing
  `canonicalize_case_below` deliberately takes the first ci match (correct for
  the post-`exists()` correction). The new branch must *not* resolve ambiguous
  multi-match cases. Ensure the two code paths don't conflate.
- **Per-directory regime accuracy.** Deriving the regime from `typed.exists()`
  assumes the directory holding the file has consistent case behavior. This is
  true per-directory in practice; document the assumption.
- **Determinism across machines.** The same file yields INFO on a dev's Mac and
  WARNING in Linux CI under `"auto"`. This is *intended* (the issue explicitly
  wants the CI signal), but it means a snapshot/golden test of severity must not
  assume a fixed level under `"auto"`.
- **Interaction with `missingFileSeverity = "off"`.** The chosen design gives
  case-mismatch its own knob, so turning off missing-file diagnostics does not
  silence case-mismatch. Confirm this is desired (it is, per the dedicated-knob
  decision).
- **Backward-directive resolution leniency** is a deliberate, diagnostic-free
  side effect. Confirm no test asserts that a case-typo'd backward directive
  stays unresolved.
