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

- Add a package-library API that can say whether the direct `pkg::member` member
  set is complete enough for absence diagnostics.
- Add a suppressible `namespace-member-not-found` diagnostic for `pkg::member`
  when complete metadata says the member is absent.
- Continue to skip member validation for `pkg:::member`.

Package install status and export/member metadata stay independent. If `pkg` is
not installed but Tier 2 or Tier 3 metadata is complete and says `member` is
absent, Raven should emit both diagnostics when both severities are enabled:
`package-not-installed` on the package token and `namespace-member-not-found` on
the member token.

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

```rust
pub struct SourceRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
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

`CrossFileMetadata` gains:

```rust
#[serde(default)]
pub namespace_references: Vec<NamespaceReference>;
```

Extraction rules:

- Use tree-sitter `namespace_operator` nodes and field names, not child indexes.
- Accept identifier, string, and backtick package qualifiers where R accepts them.
- Strip string/backtick delimiters from package and member names before storage.
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

Warm-set source (decided): store namespace-reference package names on the
`Document` in a new `namespace_packages` field, populated when metadata is
extracted, alongside the existing `loaded_packages` and `data_packages`. This
keeps the open-document warmup (`prefetch_packages_for_open_documents` →
`collect_open_document_packages`) reading from one consistent place — `Document`
fields — rather than mixing in a `metadata_map` lookup. The `did_open` /
`did_change` paths, which build their warm set from freshly extracted metadata,
add namespace-reference packages from that same metadata directly.

Extend the existing backend warm-set builders:

- `did_open`: include namespace-reference packages in the synchronous
  `prefetch_packages()` before diagnostics (extend the `library_calls`-derived
  set built via `extract_loaded_packages_from_library_calls`).
- `did_change`: include namespace-reference packages in the background prefetch
  that force-republishes diagnostics after warming (extend
  `edited_document_warm_packages`).
- Open-document warmup: include `doc.namespace_packages` from every open document
  in `collect_open_document_packages`.
- Config and libpath rebuild paths: rely on the open-document warmup plus the
  existing force-republish behavior.

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

For namespace references, anchor the diagnostic to `package_range`, not the whole
`pkg::member` expression. `pkg::member` and `pkg:::member` both qualify for this
diagnostic when the package is missing.

### 4. Namespace member diagnostics

Add a new diagnostic:

- Code: `namespace-member-not-found` — add a constant in the `diagnostic_code`
  module next to `PACKAGE_NOT_INSTALLED`.
- Setting: `raven.packages.namespaceMemberSeverity`
- Default: `warning`
- Suppressible: yes. Wire through the same machinery as `package-not-installed`:
  `# nolint` / `# raven: ignore` code matching, unused-suppression accounting via
  the `suppressed_out` channel, and the code table in `docs/diagnostics.md`.
- Applies to: `pkg::member` only, never `pkg:::member`

The message should avoid implying that only functions are valid:

```text
Package 'pkg' has no known exported member or data object named 'member'
```

The collector emits this diagnostic only when all of the following are true:

- Package awareness is enabled.
- The package library is ready enough to answer package metadata questions.
- The reference is `::`, not `:::`.
- A member token is present.
- The configured severity is not `off`.
- The package-library member query returns a complete direct-member set.
- The member is absent from that set.

The direct-member set is `PackageInfo.exports ∪ PackageInfo.lazy_data` for the
package named on the left of `::`. Use only that package's own `exports` and
`lazy_data` — never the separate combined/attached cache (`combined_entries`),
`Depends`, or meta-package attached exports: `tidyverse::mutate` should be judged
against what `tidyverse` itself exposes through `::`, not what
`library(tidyverse)` attaches.

When member metadata is partial or unknown, emit no member diagnostic. Absence
from partial metadata is not evidence of absence.

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

`Absent` must be returned only from complete direct-member metadata. `Partial` is
positive-only: it may prove that a member is present, but it cannot prove that a
member is missing.

**Two independent completeness axes (decided).** A package's `exports` and its
`lazy_data` are sourced separately and can have different completeness at the same
time. The clearest example: a non-pattern package with a clean NAMESPACE
(`exports` complete) plus a `data/` directory that R never enumerated (`lazy_data`
partial). For `pkg::foo` where `foo` is neither a known export nor a known data
object, exports say "absent" but data says "partial" — so the only sound answer is
`Partial`, **not** `Absent`. A single whole-package completeness value cannot
express this and would produce the very false positives this design exists to
prevent. Therefore track completeness per axis:

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

Carry `MemberCompleteness` (and, for debugging/provenance, `MemberSource`)
**separately for exports and for lazy_data**. `namespace_member_status_sync`
reconciles the two axes conservatively:

- If the member is present in `exports` **or** `lazy_data` → `Present`.
- Else if **both** the `exports` axis and the `lazy_data` axis are `Complete` →
  `Absent`.
- Else if either relevant axis is `Partial` (and the member was not found) →
  `Partial`.
- Else → `Unknown`.

In short: `Absent` requires the member to be missing from *both* a complete
exports set and a complete data set. Any incompleteness on either axis degrades
the answer away from `Absent`.

This can live on `PackageInfo` (two completeness fields) or on a derived query
result, as long as production load paths can distinguish complete, partial, and
unknown member sets per axis. Existing `PackageInfo::new` and
`PackageInfo::with_details` should remain available for tests and legacy
construction (defaulting both axes to `Unknown` so they are never
absence-authoritative); production chokepoints should assign explicit per-axis
completeness.

Source mapping:

- Static NAMESPACE parse with no `exportPattern()` / `exportClassPattern()`:
  complete exports.
- R subprocess namespace expansion: complete exports.
- INDEX fallback for pattern packages: partial exports.
- Provider records from `.raven/packages.json`, `names.db`, or embedded base:
  complete for the captured package version, with the existing Tier 2/Tier 3
  version-skew caveat.
- Static data-file discovery without R enumeration: partial data metadata when a
  data directory exists; complete empty data metadata when no data directory
  exists.
- R `data(package=)` enumeration or provider `lazy_data`: complete known data
  metadata for diagnostic purposes.
- Empty failed-load placeholders: unknown, never absence-authoritative.

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

- Complete metadata plus absent member emits `namespace-member-not-found`.
- Complete metadata plus present export emits no diagnostic.
- Complete metadata plus present `lazy_data` object emits no diagnostic.
- Partial or unknown metadata emits no member diagnostic.
- Two-axis reconciliation: exports `Complete` but `lazy_data` `Partial`, member
  absent from both → no diagnostic (the data axis is not absence-authoritative).
- Two-axis reconciliation: exports `Complete` and `lazy_data` `Complete`, member
  absent from both → diagnostic emitted.
- `namespace_member_status_sync` returns `Present` when the member is a known
  export even if the data axis is `Partial`/`Unknown` (and vice versa for a known
  data object).
- `pkg:::x` never emits the member diagnostic.
- Direct package membership is used; combined `Depends` or meta-package attached
  exports do not suppress the diagnostic.
- If package is uninstalled but complete provider metadata says the member is
  absent, both diagnostics are emitted when enabled.

Configuration and docs:

- Add Rust config parsing for `packages.namespaceMemberSeverity`.
- Add VS Code schema, initialization options, and settings tests.
- Regenerate `docs/settings-reference.md`.
- Update `docs/diagnostics.md`, `docs/completion.md`, `docs/package-database.md`,
  and `docs/development.md`.

## Risks

- **False positives from partial metadata.** Mitigated by emitting member absence
  only when *both* the exports axis and the data axis are complete. The two-axis
  reconciliation in `namespace_member_status_sync` is the single chokepoint for
  this; a single whole-package completeness value would mask the
  complete-exports / partial-data case and reintroduce false positives.
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
- A file containing `dplyr::mutatee` reports `namespace-member-not-found` when
  complete `dplyr` metadata is available.
- A file containing `dplyr::mutatee` does not report the member diagnostic while
  metadata is partial or unknown.
- `datasets::mtcars` is accepted when known lazy-data metadata is available.
- `dplyr:::internal_name` may report a missing package, but never reports the
  member diagnostic.
- No package referenced only through `pkg::` becomes visible as a bare-name
  package scope contribution.
