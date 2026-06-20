# Namespace reference warming and diagnostics

**Date:** 2026-06-19
**Status:** Design - approved, revised after adversarial review

## Problem

Raven now completes exported package symbols after `pkg::`, but namespace
references are still treated as a completion-only syntax case. They are not
recorded in cross-file metadata, so they do not participate in package cache
warming and they cannot drive diagnostics.

That leaves two user-visible gaps:

1. A file that uses `pkg::member` but never calls `library(pkg)` does not warm
   the package cache. Cold completion can show only the synchronous static subset,
   even though the docs already say a prior `pkg::` use can warm richer results.
2. Raven can report missing packages for `library(pkg)` / `require(pkg)` /
   `loadNamespace(pkg)`, but not for `pkg::member`. It also cannot report an
   obviously misspelled namespace member such as `dplyr::mutatee`.

The feature must preserve R semantics:

- `pkg::member` is a qualified namespace lookup, not a package attachment.
- `pkg:::member` is an internal lookup. It may justify package cache warming and
  missing-package diagnostics, but not exported-member validation.
- The left side of `::` is a package name, not an evaluated variable.
- Valid `pkg::` targets include exported namespace objects and known package data
  objects such as `datasets::mtcars`, so the member diagnostic should not speak
  only in terms of exported functions.

## Decision

Add namespace references as first-class cross-file metadata and use that metadata
for package warming and diagnostics. Implement the work in two phases, but design
the metadata shape once so Phase 2 does not need to reparse the document.

Phase 1:

- Detect `pkg::member`, `pkg:::member`, and incomplete `pkg::` / `pkg:::` forms
  during metadata extraction.
- Store them in `CrossFileMetadata.namespace_references`.
- Add namespace-reference packages to existing package warm sets.
- Extend `package-not-installed` to namespace references, using the same
  install-state policy and severity setting as loader calls.

Phase 2:

- Add a synchronous package-library API (`namespace_member_status_sync`) that says
  whether a `pkg::member` is `Present` / `Absent` / `Partial` / `Unknown`, with
  `Absent` returned only from a *complete exports set*.
- Add a suppressible `namespace-member-not-found` diagnostic for `pkg::member` when
  that API returns `Absent`. Member validation is **exports-authoritative**; data
  objects are positive-only (they can confirm-present but never prove absent). The
  fully `::`-accurate data-member authority is deferred to issue #505.
- Continue to skip member validation for `pkg:::member`.

Package install status and export/member metadata stay independent. If `pkg` is
not installed but Tier 2 or Tier 3 metadata is complete and says `member` is
absent, Raven should emit both diagnostics when both severities are enabled:
`package-not-installed` on the package token and `namespace-member-not-found` on
the member token. This is gated by the *existing* missing-package precondition:
`collect_missing_package_diagnostics_from_snapshot` early-returns when install
status is unknowable (no libpaths and no R subprocess — `handlers.rs:5089`), so in
that environment `package-not-installed` does not fire and "both" reduces to
whichever diagnostics the install-status-known gate permits. The member diagnostic
is independent of install status and may still fire from complete provider
metadata.

## Components

### 1. Namespace metadata

Add namespace-reference detection alongside the existing loader-call scanner
(`detect_library_calls`) in `crates/raven/src/cross_file/source_detect.rs`. The
two concerns are orthogonal (`detect_library_calls` answers "what packages does
this file load?"; this answers "what namespace members does it reference?"), but
they both walk the whole tree. Prefer folding namespace detection into the
existing single traversal over adding a second independent whole-tree walk per
`did_change`; if a separate pass is clearer, the extra walk cost is accepted but
should be a deliberate choice, not incidental.

Recommended model:

`SourceRange` columns are **LSP UTF-16 code units**, not tree-sitter byte
offsets (`Point.column` is bytes). Convert at extraction time, mirroring the
existing loader-call conversion (`source_detect.rs:1099`); add a regression test
with multibyte text before `pkg::member` so squiggles land correctly.

```rust
pub struct SourceRange {
    pub start_line: u32,
    pub start_column: u32, // UTF-16 code units
    pub end_line: u32,
    pub end_column: u32,   // UTF-16 code units
}

pub struct NamespaceReference {
    pub package: String,
    pub package_range: SourceRange,
    pub member: Option<NamespaceMember>,
    pub internal: bool,
    pub range: SourceRange,
}

pub struct NamespaceMember {
    pub name: String,
    pub range: SourceRange,
}
```

The flat `internal: bool` + `member: Option<…>` shape makes invalid combinations
representable (e.g. `internal: true` with a member is a valid `pkg:::x`, but a
collector that forgets the `internal` check will mis-handle it). Either model it as
an enum (`Exported { member }`, `Internal { member }`, `Incomplete { internal }`)
or treat "every member-diagnostic site MUST check `!internal`" as a hard invariant
with a test. The member diagnostic applies to `Exported` only.

`CrossFileMetadata` gains:

```rust
#[serde(default)]
pub namespace_references: Vec<NamespaceReference>;
```

Extraction rules:

- Use tree-sitter `namespace_operator` nodes and field names, not child indexes.
- Accept identifier, string, and backtick package qualifiers where R accepts them.
- Unquoting is **delimiter-stripping only**, not full R literal unescaping (matching
  the existing completion-side `unquote_package`). Document this limit: a quoted
  name containing R escape sequences (e.g. `` `a\`b` ``) is stored verbatim minus
  the outer delimiters and may not round-trip to the true object name. This is an
  accepted edge case; if it ever drives a false member diagnostic, restrict the
  member diagnostic to simple (escape-free) quoted forms rather than guessing.
- Preserve source ranges for the whole expression, package token, and member token.
- Store `member: None` for incomplete `pkg::` / `pkg:::` when the parser exposes
  a `namespace_operator` node with a present LHS and a missing RHS. Incomplete
  forms that tree-sitter recovers as an `ERROR` node (rather than a clean
  `namespace_operator`) are **not** captured. This is acceptable: the completion
  path uses a cursor-based fallback to find such forms, but a cursorless metadata
  scanner cannot replicate that cheaply, and the only thing lost is transient
  warming during mid-token typing — never a diagnostic.
- Ignore comments, strings that are not namespace operators, invalid LHS forms
  such as `a$b::x`, and empty package names.
- Keep `internal: true` for `:::`. Do not collapse it into `::`.

This scanner becomes the canonical source for live LSP metadata. The existing
completion cursor classifier can remain specialized for cursor positions, but
shared helper code for unquoting and node extraction should be used where it
keeps semantics aligned. The CLI `raven packages freeze/fetch` path already
collects namespace LHS package names; migrating it to the shared extractor is
allowed but not required for this feature.

### 2. Package warming

Namespace references should warm package metadata, but they must not attach the
package to scope.

Warm-set source (decided): a **single shared "warmable namespace-ref packages"
extractor**, derived from the same artifact every lifecycle path already uses, to
avoid the drift hazard both reviewers flagged. Note that today's warm sets come
from two *different* extraction systems: `Document.loaded_packages` /
`data_packages` are computed in `Document::new_with_kind` / `update` from
`(tree, text)` (`state.rs:257`, `:316`) — **not** from `CrossFileMetadata`, which
is produced separately by `extract_metadata_with_tree`. Namespace references are
defined to live in `CrossFileMetadata.namespace_references`, so the warm-set must
read from there, not from a new `Document` field populated "alongside
loaded_packages" (which would be a false premise — those fields do not come from
metadata).

Provide one helper, e.g. `namespace_warm_packages(meta: &CrossFileMetadata) ->
Vec<String>` (validated, sentinel-filtered names, deduped), and call it from every
warm path so they cannot diverge:

- `did_open`: union it with the `library_calls`-derived set
  (`extract_loaded_packages_from_library_calls`) before the synchronous
  `prefetch_packages()`.
- `did_change`: union it into `edited_document_warm_packages` so the background
  prefetch (which force-republishes after warming) includes namespace-ref packages.
- Open-document warmup (`prefetch_packages_for_open_documents` →
  `collect_open_document_packages`): pull namespace-ref packages from each open
  document's metadata (`metadata_map`) via the same helper.
- Config and libpath rebuild paths: rely on the open-document warmup plus
  force-republish.

Add **parity tests** across `did_open`, `did_change`, and the open-document rebuild
warmup asserting all three warm the same namespace-ref packages for the same
document — this is the regression guard against the drift the reviewers identified.

**Cross-document force-republish (fix).** Today `did_change`'s background prefetch
marks only the *edited* URI for force-republish. But warming `dplyr` can change the
`namespace-member-not-found` / `package-not-installed` verdict in *any other* open
document that references `dplyr::`. After a namespace-driven prefetch completes,
mark for force-republish every open document whose namespace-reference packages
intersect the just-warmed set — not only the edited file — so stale "unknown
metadata → no diagnostic" results in sibling files refresh. This stays within the
existing version-monotonic force-republish model (same-version republish allowed,
never older).

The diagnostic collectors stay pure. They may inspect the package cache and
metadata snapshot, but they must not call `prefetch_packages()`, spawn work, or
mark documents for force republish.

Validate package names before prefetching so quoted or recovered syntax cannot
send invalid names to the R subprocess. Reuse the existing boundary guard
`is_valid_package_name(p) && !is_load_all_sentinel(p)` (the `load_all()` sentinel
is `__raven_load_all__`); `prefetch_packages()` itself does no filtering and
trusts its callers, so the namespace-reference packages must be filtered at the
same boundary the loader-call packages already are.

### 3. Missing package diagnostics

Extend `collect_missing_package_diagnostics_from_snapshot` so it checks both:

- existing `library_calls`
- `namespace_references`

The diagnostic keeps the existing code and setting:

- Code: `package-not-installed`
- Setting: `raven.packages.missingPackageSeverity`
- Install-state policy: Tier 1 only, via `PackageLibrary::package_exists()`
- Suppression: existing line/code suppression behavior

For namespace references, anchor the squiggle to `package_range`, not the whole
`pkg::member` expression. `pkg::member` and `pkg:::member` both qualify for this
diagnostic when the package is missing.

Suppression keying with sub-line anchors (the existing loader-call diagnostic
anchors at column 0 and suppression is line-keyed via `is_line_ignored_for_code`):
key `package-not-installed` suppression and `suppressed_out` on
`package_range.start_line`, and `namespace-member-not-found` on
`member.range.start_line`. When both diagnostics land on the same line they are two
distinct codes and must be independently suppressible; when multiple namespace refs
share a line, each (line, code) pair is accounted once (the `suppressed_out` channel
dedups by pair). Specify and test these so an implementer does not key off the
wrong range field.

### 4. Namespace member diagnostics

Add a new diagnostic:

- Code: `namespace-member-not-found` — add a constant in the `diagnostic_code`
  module next to `PACKAGE_NOT_INSTALLED`.
- Setting: `raven.packages.namespaceMemberSeverity`
- Default: `warning`
- Suppressible: yes. Inline `# nolint` / `# raven: ignore` matching alone is not
  enough — register the code in the analyzer/suppressible code lists so block,
  file, and chunk suppression and `expect` accounting all work. Concretely: add to
  `SUPPRESSIBLE_ANALYZER_CODES` (`diagnostic_code.rs:66`), ensure the final
  suppression filter in `handlers.rs` (~`:718`) covers it, and key
  unused-suppression accounting through the `suppressed_out` channel on
  `member.range.start_line`. Add tests for inline, ignore-next, block, file, chunk,
  and `expect`. Update the code table in `docs/diagnostics.md`.
- Applies to: `pkg::member` only, never `pkg:::member`

The message should avoid implying that only functions are valid:

```text
Package 'pkg' has no known exported member or data object named 'member'
```

The collector emits this diagnostic only when all of the following are true:

- Package awareness is enabled.
- The package library is ready enough to answer package metadata questions.
- The reference is `::`, not `:::` (every member-diagnostic site MUST check
  `!reference.internal`).
- A member token is present (`member: Some`).
- The configured severity is not `off`.
- `namespace_member_status_sync(package, member)` returns `Absent`.

**Authority model — exports-authoritative, data positive-only (v1, decided).**
Absence is judged against the package's own *complete* exports set. Data objects
are consulted **positive-only**: they can confirm a member is present (and suppress
the diagnostic), but the diagnostic is never gated on data-set completeness. This
ships the headline value (`dplyr::mutatee`-style typos) without the false positives
that a strict "data must be complete too" rule would create for the many real
packages whose `data/` directory is never enumerated. It is conservative in the
safe direction: it accepts the false *negative* of never flagging a misspelled
data reference (e.g. `datasets::mtcarss`). The fully `::`-accurate data-member
authority is tracked separately as a follow-up (GitHub issue #505) and is a strict
tightening of this rule — no rework of the exports path.

The present-check (suppression) set is the named package's own `PackageInfo.exports`
∪ `PackageInfo.lazy_data`, **plus `base_exports` when the package is a
base/recommended package** — base-package datasets such as `datasets::mtcars` are
merged into `base_exports` (`package_library.rs:170`), not the per-package
`lazy_data`, so omitting `base_exports` would falsely flag them. Never use the
separate combined/attached cache (`combined_entries`), `Depends`, or meta-package
attached exports: `tidyverse::mutate` is judged against what `tidyverse` itself
exposes through `::`, not what `library(tidyverse)` attaches.

When the exports set is partial or unknown, emit no member diagnostic. Absence
from a non-complete exports set is not evidence of absence.

### 5. Package-library member authority

Do not use `get_exports_sync()` as the authority for member diagnostics. It
returns the first **non-empty** member set across cache → installed static
NAMESPACE parse → providers and stops — but it returns that set **without any
signal of whether it is complete**. An INDEX-fallback partial export set is
indistinguishable from a complete NAMESPACE parse at its return type
(`Option<Vec<String>>`). Treating "member not in the returned set" as "member
absent" would therefore fire false positives whenever the returned set is merely
partial. Member diagnostics need a completeness signal that `get_exports_sync()`
deliberately discards.

Add a synchronous package-library API with explicit status:

```rust
pub enum NamespaceMemberStatus {
    Present,
    Absent,
    Partial,
    Unknown,
}

pub fn namespace_member_status_sync(
    &self,
    package: &str,
    member: &str,
) -> NamespaceMemberStatus;
```

`Absent` must be returned only from a **complete exports set**. `Partial` is
positive-only: it may prove that a member is present, but it can never prove a
member missing.

**Completeness lives on the exports set (v1).** Carry a `MemberCompleteness` (and,
for provenance/debugging, a `MemberSource`) describing the *exports* set:

```rust
pub enum MemberCompleteness {
    Complete,
    Partial,
    Unknown,
}

pub enum MemberSource {
    InstalledStaticNamespace,
    InstalledRNamespace,
    InstalledIndexFallback,
    Provider,
    EmbeddedBase,
    FailedOrEmpty,
}
```

`namespace_member_status_sync(package, member)` resolves as:

1. If `member` is present in the present-check set (the named package's `exports`
   ∪ `lazy_data`, plus `base_exports` for base/recommended packages) → `Present`.
   The data sources here are positive-only; their completeness is irrelevant.
2. Else if the exports set is `Complete` → `Absent`.
3. Else if the exports set is `Partial` → `Partial`.
4. Else → `Unknown`.

(Data completeness intentionally does not enter the `Absent` decision in v1; issue
#505 tightens this by adding a `::`-accurate, completable data-member set.)

**Synchronous contract (no R, no mutation).** `namespace_member_status_sync` is a
hot-path diagnostic call and MUST be cache/provider/static-only — it must not spawn
the R subprocess and must not mutate the cache. Two consequences the implementer
must honor:

- Completeness can only be as good as what warming has already produced. For
  `exportPattern()` packages, a `Complete` exports set requires the async R
  namespace expansion to have *already run* (via prefetch); until then the sync
  query returns `Partial`/`Unknown` and no member diagnostic fires. This is the
  expected cold→warm transition, resolved by the force-republish path.
- It may do a bounded synchronous static NAMESPACE parse (as `get_exports_sync`'s
  Tier-2 branch already does) but should memoize rather than re-parse on every
  diagnostic pass.

**Cache authority must be monotonic.** `prefetch_packages()` skips any package
already in the cache (`package_library.rs:1123`), and existing paths can cache
failed/empty or INDEX-fallback (`Partial`) `PackageInfo`s. A weaker cached entry
must never shadow stronger metadata for member purposes: never overwrite a
`Complete` exports set with a `Partial`/`Unknown` one, allow upgrade from
`Unknown`/`Partial` to `Complete`, and ensure a failed-load placeholder is treated
as `Unknown` (never absence-authoritative), not as an empty `Complete` set.

This completeness can live on `PackageInfo` (one completeness field for the exports
set) or on a derived query result. `PackageInfo::new` / `PackageInfo::with_details`
remain for tests and legacy construction and **default exports completeness to
`Unknown`** — so any production path that does not explicitly stamp completeness is
silently non-authoritative (safe direction, but the feature does nothing until the
stamping paths below are updated). The provider boundary needs explicit support:
`PackageMetadataProvider::lookup()` / `PackageRecord::into_info()`
(`package_db/model.rs:90`) currently build via `with_details`, so add an explicit
constructor or query-result type that lets providers assign `Complete`, otherwise
all Tier 2/Tier 3 member diagnostics silently never fire.

Exports-completeness stamping (every construction site that feeds the cache must be
audited; defaulting to `Unknown` is safe but inert):

- Static NAMESPACE parse with no `exportPattern()` / `exportClassPattern()` and no
  re-export indirection: `Complete`. **Caveat (M3):** the static parser is not a
  full `getNamespaceExports()` — re-export idioms and S3-method emission can
  diverge. If the parse cannot be shown equivalent for the package's directives,
  stamp `Partial`. Only the R-subprocess expansion is unconditionally `Complete`.
- R subprocess namespace expansion: `Complete`.
- INDEX fallback for pattern packages: `Partial`.
- Provider records from `.raven/packages.json`, `names.db`, or embedded base:
  `Complete` for the captured package version, with the existing Tier 2/Tier 3
  version-skew caveat — *provided the provider record actually carries a full
  export list* (verify the record shape; a name-only index is `Partial`).
- Empty failed-load placeholders: `Unknown`, never absence-authoritative.

`get_exports_sync()` may continue to serve completion by discarding completeness
and returning whatever member names are useful for suggestions.

## Data flow

1. Metadata extraction scans the document and stores namespace references.
2. Backend lifecycle code builds warm sets from loader calls, `data(package=)`,
   inherited package scope, and namespace references.
3. Package prefetch runs through existing synchronous or background paths.
4. Diagnostics run from an immutable `DiagnosticsSnapshot`.
5. Missing-package diagnostics read install state from `package_exists()`.
6. Namespace-member diagnostics read member authority from
   `namespace_member_status_sync()`.
7. If a background prefetch changed package metadata, the existing force-republish
   path republishes diagnostics at the same document version.

## Out of scope

- Completing or validating `pkg:::` internals.
- Treating `pkg::member` as `library(pkg)` for bare-name scope.
- Adding internal namespace metadata to the package database.
- Blocking every `did_change` diagnostic pass on package prefetch. The existing
  "publish now, force-republish after warmup" model stays.
- Replacing all existing namespace helper code in one refactor. Reuse and
  centralize where it directly serves this feature.

## Testing

Parser and metadata:

- Detect `pkg::x`, `pkg:::x`, `"pkg"::x`, `` `pkg`::x ``, `pkg::"x"`, and
  `` pkg::`non syntactic` ``.
- Store ranges for the whole expression, package token, and member token.
- Record incomplete `pkg::` for warming with `member: None`.
- Ignore comments, strings, invalid LHS expressions, and empty package names.
- Preserve existing namespace-operator behavior as structural non-references for
  undefined-variable and out-of-scope diagnostics.

Package warming:

- `did_open` warm sets include namespace-reference packages.
- `did_change` background prefetch includes namespace-reference packages and
  force-republishes after warming.
- Open-document warmup includes namespace-reference packages.
- Namespace warming does not make package exports visible as bare symbols.
- `pkg:::` warms package metadata but still produces no completion items.

Missing packages:

- `pkg::x` and `pkg:::x` report `package-not-installed` when install state is
  known and the package is absent.
- Installed packages do not report.
- Existing suppression and unused-suppression accounting work for namespace refs.
- The existing loader-call missing-package behavior is unchanged.

Namespace members:

- Complete exports + absent member emits `namespace-member-not-found`.
- Complete exports + present export emits no diagnostic.
- Present `lazy_data` object suppresses the diagnostic regardless of data
  completeness (data is positive-only).
- Present `base_exports` member of a base/recommended package suppresses the
  diagnostic (`datasets::mtcars` — the C1 fix; the per-package `lazy_data` is empty
  for base packages).
- Partial or unknown *exports* emits no member diagnostic.
- `namespace_member_status_sync` returns `Present` for a known export even when the
  exports set is otherwise `Partial`/`Unknown` (present short-circuit wins).
- Monotonic authority: a `Partial`/failed cached entry does not shadow a later
  `Complete` exports set; `Complete` is never downgraded by a weaker entry; a
  failed-load placeholder yields `Unknown`, never `Absent`.
- Sync contract: an `exportPattern()` package returns `Partial`/`Unknown` (no
  member diagnostic) until R namespace expansion has warmed it; after warm +
  force-republish, the diagnostic appears.
- `pkg:::x` never emits the member diagnostic.
- Direct package membership is used; combined `Depends` or meta-package attached
  exports do not suppress the diagnostic.
- If package is uninstalled but complete provider metadata (with a full export
  list) says the member is absent, both diagnostics are emitted when enabled and
  install status is knowable.

Configuration and docs:

- Add Rust config parsing for `packages.namespaceMemberSeverity`, reusing
  `parse_severity` and the `Option<DiagnosticSeverity>` convention where `None`
  means `off` (mirroring `packages_missing_package_severity`).
- Add VS Code schema, initialization options, and settings tests.
- Regenerate `docs/settings-reference.md`.
- Update `docs/diagnostics.md`, `docs/completion.md`, `docs/package-database.md`,
  and `docs/development.md`.

## Risks

- **False positives from partial metadata.** Mitigated by emitting member absence
  only from a `Complete` exports set, judged in the single chokepoint
  `namespace_member_status_sync`. Residual risk under the v1 exports-authoritative
  model: a LazyData package whose `lazy_data` we captured only partially, where the
  user references a genuine LazyData object that is not in the export set — it could
  be flagged. Bounded and tracked by issue #505 (dedicated data-member authority).
- **Cache shadowing.** A weaker cached `PackageInfo` (failed/empty/INDEX-partial)
  could otherwise shadow stronger metadata and either suppress a real diagnostic or
  fire from non-authoritative data. Mitigated by the monotonic-authority rule.
- **Tier 3 version skew.** Existing package-database caveat applies: complete
  metadata is complete for the captured version, not necessarily the user's exact
  intended version when the package is uninstalled.
- **Diagnostic churn while typing.** `did_change` may first publish no member
  diagnostic and then publish one after background warming. This matches existing
  package prefetch behavior and avoids blocking edit feedback.
- **Parser drift.** Multiple private namespace helpers already exist. New code
  should use field-name extraction and shared unquoting helpers where possible to
  avoid one more divergent interpretation of `namespace_operator`.
- **Settings wiring drift.** A new LSP setting must be wired through the Rust
  parser, VS Code schema, initialization-options factory, settings tests, and
  generated settings reference.

## Acceptance

- A file containing only `dplyr::mutate` warms `dplyr` package metadata without
  requiring `library(dplyr)`.
- A file containing `missingpkg::foo` reports `package-not-installed` under the
  same conditions and setting as `library(missingpkg)`.
- A file containing `dplyr::mutatee` reports `namespace-member-not-found` when a
  complete `dplyr` exports set is available.
- A file containing `dplyr::mutatee` does not report the member diagnostic while
  the exports set is partial or unknown.
- `datasets::mtcars` is accepted: `mtcars` resolves via `base_exports` for the
  base/recommended `datasets` package (not the per-package `lazy_data`).
- `dplyr:::internal_name` may report a missing package, but never reports the
  member diagnostic.
- No package referenced only through `pkg::` becomes visible as a bare-name
  package scope contribution.
