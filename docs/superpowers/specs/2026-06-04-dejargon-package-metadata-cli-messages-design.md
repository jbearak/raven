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

Four areas of user-facing copy (the `check` warning, `--help` text, the
package-database load error, and `packages update` error guidance), plus one
help-text reordering. No control-flow, signature, or data-structure changes. The
`check` warning keeps its existing `tier3_present: bool` branch — only the two
message bodies change.

---

## Change 1 — `raven check` missing-export-metadata warning

**File:** `crates/raven/src/cli/check.rs`, `format_missing_export_metadata_warning` (~line 668).

Signature unchanged: `(packages: &[String], tier3_present: bool) -> String`. The
package list is still sorted, deduped, and truncated to 8, as today. Only the
two message bodies change.

**Count-aware wording.** The message branches on the deduped package count `n`
so a single package reads naturally:
- `noun` = `this package` (n == 1) / `these packages` (n > 1)
- `obj`  = `it` (n == 1) / `them` (n > 1)
- `inst` = `it's` (n == 1) / `they're` (n > 1)

**Line length.** Output is plain `eprintln!` with no wrapping helper, so the body
is split into short lines at natural breaks rather than one ~200-char line that
wraps arbitrarily in narrow terminals.

### Variant A — symbol database **not** installed (`tier3_present == false`)

Template:
```
raven check: couldn't load exported symbols for {names}.
Some "Undefined variable" warnings above may be inaccurate as a result.
To fix: install {noun} in your R library.
In CI without R, run `raven packages update` before `raven check` to download Raven's package symbol database,
or commit a `raven packages freeze` snapshot made on a machine where {inst} installed.
```

Rendered, n == 2:
```
raven check: couldn't load exported symbols for bar, foo.
Some "Undefined variable" warnings above may be inaccurate as a result.
To fix: install these packages in your R library.
In CI without R, run `raven packages update` before `raven check` to download Raven's package symbol database,
or commit a `raven packages freeze` snapshot made on a machine where they're installed.
```

### Variant B — symbol database file present but package unresolved (`tier3_present == true`)

`tier3_present` is computed from `p.exists()` over the candidate paths
(`check.rs:374`) — it means *a database file is on disk*, **not** that it loaded
and was searched successfully. A present-but-corrupt/unsupported `names.db` also
takes this branch (and separately produces its own load note, Change 3). The
wording therefore must **not** claim the database was searched and the package
was absent from it. It states the actionable conclusion instead — the package
isn't available from the database, so `freeze` is the path:

Template:
```
raven check: couldn't load exported symbols for {names}.
Some "Undefined variable" warnings above may be inaccurate as a result.
To fix: install {noun} in your R library.
Raven's package symbol database doesn't provide {obj} — {inst} likely private or not on CRAN/Bioconductor.
Capture {obj} with `raven packages freeze` on a machine where {inst} installed, and commit the result.
```

Rendered, n == 1:
```
raven check: couldn't load exported symbols for foo.
Some "Undefined variable" warnings above may be inaccurate as a result.
To fix: install this package in your R library.
Raven's package symbol database doesn't provide it — it's likely private or not on CRAN/Bioconductor.
Capture it with `raven packages freeze` on a machine where it's installed, and commit the result.
```

Rationale: impact first (warnings may be unreliable), then the obvious fix
(install the package), then the CI-specific fallbacks. Variant B uses the
"database file present" state to steer toward `freeze` (the `update` path either
already ran or failed to load), without asserting a successful lookup that may
not have happened.

### Tests

Update the two existing unit tests that pin the old copy:
- `formats_missing_metadata_warning_for_absent_tier3` (~line 794)
- `formats_missing_metadata_warning_for_present_tier3_miss` (~line 807)

Keep assertions for the package-name list (sorted/deduped). Re-assert on the new
strings: both must contain "couldn't load exported symbols" and "install"; variant
A must contain the `raven packages update` CI-fallback sentence; variant B must
contain "doesn't provide" and `raven packages freeze`. Neither may contain "Tier".
Add coverage exercising `n == 1` to lock the singular wording ("this package",
"it"): the present-database test already calls with a single package, so extend
it; add a single-package case for the absent variant too.

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
Drop "Tier 3", but keep the failure **scoped to the bundled database** — only
that one provider fails to load; installed packages and `.raven/packages.json`
still resolve (`package_library.rs:1846`). The earlier draft's "package export
resolution is unavailable" wrongly implied *all* resolution dies, which is
broader than the original "Tier 3 export resolution is unavailable". Corrected:

- **Before:** `…The bundled database is incompatible with this build — Tier 3 export resolution is unavailable. Upgrade Raven to match the bundled database.`
- **After:** `…The bundled database is incompatible with this build, so its package metadata is unavailable. Upgrade Raven to match the bundled database.`

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

Three groups of "sidecar" text reach users on `raven packages update` failures:

1. **"override sidecar lookup"** — replace with "override the database location"
   at every occurrence (the dest-dir error ~line 886, `sidecar_write_error`, and
   the `write_unique_temp` fallback). The surrounding text and the
   `RAVEN_NAMES_DB` env-var name are unchanged.
   - **Before:** `…rerun with --dest-dir …, or set RAVEN_NAMES_DB to override sidecar lookup`
   - **After:** `…rerun with --dest-dir …, or set RAVEN_NAMES_DB to override the database location`

2. **"could not create unique temporary sidecar in {}…"** (`packages.rs:1155`) —
   surfaces on a filesystem error while writing the download. Replace "temporary
   sidecar" with "temporary database file".

3. **"could not create unique backup sidecar for {}…"** (`packages.rs:1182`) —
   surfaces when backing up an existing database before replacement. Replace
   "backup sidecar" with "backup database file".

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

## Terminology note (deferred)

User-facing prose adopts **"package symbol database"** for `names.db`. The
existing user doc `docs/cli.md` uses "package-export database". This spec leaves
that doc as-is to keep the change focused; aligning the doc to one term is a
separate, optional follow-up.

## Testing & verification

- Update the two `check.rs` unit tests (Change 1), including the `n == 1`
  singular-wording coverage.
- No other test pins any changed string (verified: help text, the `binary_db`
  `UnsupportedFormat` text, and the "sidecar" strings are not asserted anywhere;
  the package tests that mention `names.db` / `RAVEN_NAMES_DB` assert only
  strings this spec keeps).
- External consumers parsing this stderr text can't be verified from the repo;
  no in-repo CI/script/extension code parses these strings. Treat the wording as
  human-facing, not a stable API.
- Gates: `cargo fmt --all`, then
  `cargo clippy --workspace --all-targets --features test-support -- -D warnings`,
  then `cargo test`.
- Manual spot check: a final `grep -rn "Tier\|sidecar" crates/raven/src` should
  show only internal/doc/test occurrences, no user-facing
  print/format/Display strings.
