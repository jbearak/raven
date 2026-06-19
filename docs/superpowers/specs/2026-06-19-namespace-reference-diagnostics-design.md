# Namespace reference warming and diagnostics

**Date:** 2026-06-19
**Status:** Design - approved, pending spec review

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

Add a full-document scanner near the existing loader-call scanner in
`crates/raven/src/cross_file/source_detect.rs`.

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
  a namespace operator without an RHS.
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

Extend the existing backend warm-set builders:

- `did_open`: include namespace-reference packages in the synchronous
  `prefetch_packages()` before diagnostics.
- `did_change`: include namespace-reference packages in the background prefetch
  that force-republishes diagnostics after warming.
- Open-document warmup: include namespace-reference packages from every open
  document's metadata in `prefetch_packages_for_open_documents`.
- Config and libpath rebuild paths: rely on the open-document warmup plus the
  existing force-republish behavior.

The diagnostic collectors stay pure. They may inspect the package cache and
metadata snapshot, but they must not call `prefetch_packages()`, spawn work, or
mark documents for force republish.

Validate package names before prefetching so quoted or recovered syntax cannot
send invalid names to the R subprocess. The `load_all()` sentinel and other
synthetic names must not be prefetch candidates.

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

- Code: `namespace-member-not-found`
- Setting: `raven.packages.namespaceMemberSeverity`
- Default: `warning`
- Suppressible: yes
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

The direct-member set is `exports union lazy_data` for the package named on the
left of `::`. Do not use `combined_entries`, `Depends`, or meta-package attached
exports: `tidyverse::mutate` should be judged against what `tidyverse` itself
exposes through `::`, not what `library(tidyverse)` attaches.

When member metadata is partial or unknown, emit no member diagnostic. Absence
from partial metadata is not evidence of absence.

### 5. Package-library member authority

Do not use `get_exports_sync()` as the authority for member diagnostics. Its
contract is completion-oriented: it returns the first non-empty result from cache,
installed static NAMESPACE parsing, or providers, and it intentionally favors
instant partial results over absence certainty.

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

The minimum provenance model can be lean:

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

This can live on `PackageInfo` or on a derived query result, as long as production
load paths can distinguish complete, partial, and unknown member sets. Existing
`PackageInfo::new` and `PackageInfo::with_details` should remain available for
tests and legacy construction; production chokepoints should assign explicit
member completeness.

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
  only from complete member sets.
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
