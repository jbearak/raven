# De-jargon package-metadata CLI messages

**Date:** 2026-06-04
**Status:** Design approved, pending spec review

## Problem

`raven check` and several `raven packages` surfaces leak internal terminology
to end users — "Tier 3", "names.db", "sidecar". A user has no way to know what
these mean. The most acute case is the missing-export-metadata warning printed
by `raven check`, which leads with internal mechanics and omits the most obvious
remedy (just install the package). Secondary cases are `raven --help` text, a
package-database load error shown both on the CLI and as a VS Code warning
toast, and install-error guidance.

This change rewrites the user-facing strings around **impact → primary fix → CI
fallback**, in plain language. Internal code identifiers, type names, module
docs, and the developer docs under `docs/` keep their existing tier/`names.db`
vocabulary — only text a user reads at runtime changes.

Guiding rule for which jargon to remove:
- **"Tier N"** — pure internal jargon. Remove from every user-facing string.
- **"sidecar"** — internal term. Replace with plain language.
- **`names.db`** — a real installed filename / path / the `RAVEN_NAMES_DB` env
  value. Keep it where it names a literal file the user can act on; it aids
  debugging. The plain-language alias "Raven's package symbol database" is used
  only in descriptive prose (help text, the `check` warning), never to replace a
  literal path.

## Scope

Six string changes plus one help-text reordering. No control-flow, signature,
or data-structure changes. The `check` warning keeps its existing
`tier3_present: bool` branch — only the two message bodies change.

---

## Change 1 — `raven check` missing-export-metadata warning

**File:** `crates/raven/src/cli/check.rs`, `format_missing_export_metadata_warning` (~line 668).

Signature unchanged: `(packages: &[String], tier3_present: bool) -> String`. The
package list is still sorted, deduped, and truncated to 8, as today. Only the
two message bodies change.

### Variant A — symbol database **not** installed (`tier3_present == false`)

```
raven check: couldn't load exported symbols for bar, foo.
Some "Undefined variable" warnings above may be inaccurate as a result.
To fix: install these packages in your R library.
In CI without R: run `raven packages update` before `raven check` to download Raven's package symbol database, or commit a `raven packages freeze` snapshot made on a machine where they're installed.
```

### Variant B — symbol database installed but package not found (`tier3_present == true`)

```
raven check: couldn't load exported symbols for foo.
Some "Undefined variable" warnings above may be inaccurate as a result.
To fix: install these packages in your R library.
Raven's package symbol database is installed but doesn't list these packages — they may not be on CRAN/Bioconductor. Capture them with `raven packages freeze` on a machine where they're installed, and commit the result.
```

Rationale: impact first (warnings may be unreliable), then the obvious fix
(install the package), then the CI-specific fallbacks. Variant B uses the
"database present but package missing" state as a signal that the package is
likely private / not on CRAN/Bioconductor, so it steers toward `freeze` rather
than repeating the `update` suggestion that has already failed.

### Tests

Update the two existing unit tests that pin the old copy:
- `formats_missing_metadata_warning_for_absent_tier3` (~line 794)
- `formats_missing_metadata_warning_for_present_tier3_miss` (~line 807)

Keep assertions for the package-name list (sorted/deduped). Re-assert on the new
strings: both must contain "couldn't load exported symbols" and "install these
packages"; variant A must contain the `raven packages update` CI-fallback
sentence; variant B must contain the "doesn't list these packages" hint and
`raven packages freeze`. Neither may contain "Tier".

---

## Change 2 — `raven --help` text

**File:** `crates/raven/src/main.rs`, the `packages` subcommand block (~lines 46–53).

Reorder so `freeze` is listed **before** `fetch` (so `fetch`'s "Like `freeze`"
description does not forward-reference a line below it), and reword:

| Command | Before | After |
|---|---|---|
| `freeze` | `Write a repo's Tier 2 .raven/packages.json` | `Write symbols exported by packages used in this repo to .raven/packages.json` |
| `fetch` | `Fetch a repo's Tier 2 .raven/packages.json from r-universe (R-free)` | `Like freeze, but fetches package exports from r-universe (use when packages aren't installed locally)` |
| `update` | `Download the names.db sidecar` | `Download Raven's package symbol database (for use in CI when packages aren't installed in the runner)` |
| `build-shipped-db` | `Maintainer-only Tier 3 names.db builder` | `Maintainer-only package symbol database builder` |

Unchanged: `validate-shipped-db` ("Maintainer-only names.db compatibility/
integrity validator") and the `freeze, fetch` top-level aliases line keep their
current text — `validate-shipped-db` is maintainer-only and `names.db` there
names the literal artifact being validated.

Behavioral facts confirming the wording (module doc, `crates/raven/src/cli/packages.rs:4-5`):
`freeze` captures from a **local R install**; `fetch` from CRAN/Bioc
**r-universe** (R-free). `fetch` resolves symbols package-by-package and writes
them into `.raven/packages.json` — it does not download a prebuilt
`packages.json`.

---

## Change 3 — package-database load error ("Tier 3" leak)

**File:** `crates/raven/src/package_db/binary_db.rs`, `ShippedDbError` `Display`, `UnsupportedFormat` arm (~lines 51–56).

This error reaches normal users two ways: printed by `raven check` as
`raven check: <note>` (`crates/raven/src/cli/check.rs:551`) and shown as a VS
Code warning toast via `surface_load_notes` (`crates/raven/src/backend.rs:1204`).
Drop "Tier 3":

- **Before:** `…The bundled database is incompatible with this build — Tier 3 export resolution is unavailable. Upgrade Raven to match the bundled database.`
- **After:** `…The bundled database is incompatible with this build — package export resolution is unavailable. Upgrade Raven to match the bundled database.`

The `Absent` arm ("no names.db present") and `Corrupt` arm ("names.db is
unreadable: …") are unchanged — they carry no tier jargon, and `names.db` is the
literal file. Note: `Absent` never reaches normal users — the load path maps a
missing file to `None` silently (`binary_db.rs:305`, `package_library.rs:1850`);
its text renders only via the maintainer-only `validate-shipped-db <path>`
command. Only `Corrupt` and `UnsupportedFormat` propagate into load notes, which
is why the `UnsupportedFormat` arm is the one that matters here.

---

## Change 4 — install/error guidance ("sidecar" leak)

**File:** `crates/raven/src/cli/packages.rs`.

Replace the phrase "override sidecar lookup" with "override the database
location" at every occurrence (the dest-dir error ~line 886,
`sidecar_write_error`, and `write_unique_temp`). The surrounding text and the
`RAVEN_NAMES_DB` env-var name are unchanged.

- **Before:** `…rerun with --dest-dir …, or set RAVEN_NAMES_DB to override sidecar lookup`
- **After:** `…rerun with --dest-dir …, or set RAVEN_NAMES_DB to override the database location`

Unchanged in this file (all keep `names.db` as a literal file/path/env):
- `manual_sidecar_guidance` — "Alternatively, set RAVEN_NAMES_DB to a manually installed names.db"
- `update` success output — "Installed names.db to {path}" / "names.db source: …"
- "downloaded names.db failed validation: {e}. …"
- `validate-shipped-db needs a names.db path`

Internal identifiers (`install_downloaded_sidecars`, `sidecar_write_error`,
`unique_sidecar_path`, the `ShippedDb` / `package_db` types) are not user-facing
and are left as-is.

---

## What is explicitly NOT changed

- Internal code identifiers, type names, function names, struct fields.
- Module-level doc comments and the developer docs under `docs/` (e.g.
  `docs/package-database.md`, `docs/cli.md`) — these are reference material where
  the tier model and `names.db` are the correct vocabulary.
- The `RAVEN_NAMES_DB` environment variable name.
- Literal `names.db` filenames/paths in error and success output where the user
  acts on the actual file.
- The VS Code extension TS strings — already plain ("package database").

## Testing & verification

- Update the two `check.rs` unit tests (Change 1).
- No other test pins any changed string (verified: help text, the `binary_db`
  `UnsupportedFormat` text, and "override sidecar lookup" are not asserted
  anywhere).
- Gates: `cargo fmt --all`, then
  `cargo clippy --workspace --all-targets --features test-support -- -D warnings`,
  then `cargo test`.
- Manual spot check: a final `grep -rn "Tier" crates/raven/src` should show only
  internal/doc/test occurrences, no user-facing print/format/Display strings.
```
