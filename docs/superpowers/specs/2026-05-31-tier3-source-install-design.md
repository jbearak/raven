# Tier 3 package database delivery for source installs

## Problem

Raven's broad package-export floor (`names.db`) is a sidecar file. Release zips
and the VS Code extension place it next to the `raven` executable, where
`locate_shipped_db()` can find it. A source install through:

```sh
cargo install --git https://github.com/jbearak/raven raven
```

installs only the executable. It does not install `names.db` or
`base-exports.json`, because Cargo has no post-install sidecar hook and the DB is
intentionally not committed or embedded. That leaves raw Cargo installs without
the zero-adoption CI behavior the docs currently imply.

The fix must keep normal Raven startup network-free, avoid committing or
embedding the full ecosystem DB, keep explicit environment overrides, and
preserve typed degradation for absent, incompatible, and corrupt DB files.

## Decision summary

1. `raven check` must not auto-install or auto-fetch `names.db`.
2. `raven packages update` becomes the explicit consent boundary for downloading
   mutable package DB sidecars.
3. Runtime lookup becomes:
   `RAVEN_NAMES_DB` override -> user data DB -> executable-relative sidecar ->
   absent.
4. A compact base/recommended export floor belongs in the binary, so raw Cargo
   installs still understand the R platform even without the ecosystem DB.
5. Missing-package-export warnings are targeted: Raven reports the missing DB or
   missing package metadata only when it can affect undefined-variable
   diagnostics.
6. CI docs must show `raven packages update` as part of setup for source/Cargo
   installs.
7. Release archives, VSIX, and package-manager installs still ship sidecars next
   to the executable. Homebrew packaging should do the same.

## Non-goals

- No automatic network access from `raven check`, LSP initialization, or normal
  package lookup.
- No `build.rs` network fetch.
- No full `names.db` checked into git.
- No full `names.db` embedded into the binary.
- No attempt to make Cargo install arbitrary sidecar files by itself.

## Lookup model

`locate_shipped_db()` should evolve from "env var else exe-relative" into a
small ordered locator. The override remains first and exact:

1. `RAVEN_NAMES_DB`, when set and non-empty.
2. The user data DB installed by `raven packages update`.
3. `names.db` next to `std::env::current_exe()`.

`locate_base_exports()` should follow the same shape for `RAVEN_BASE_EXPORTS`,
the user data file, and the executable-relative file. Once base/recommended
exports are embedded, the sidecar remains useful as a packaging/debug artifact
but is no longer the only R-free base source.

The user data path should be platform-appropriate mutable application data:

- macOS/Linux: prefer an XDG data location such as
  `$XDG_DATA_HOME/raven/names.db`, falling back to
  `~/.local/share/raven/names.db`.
- Windows: `%LOCALAPPDATA%\Raven\names.db`.

`~/.raven/names.db` may be accepted as a legacy/simple fallback, but it should
not be the primary documented install target if a standard data directory is
available.

If a higher-priority DB is present but corrupt or incompatible, Raven should
explain it and try the next lower-priority DB. A bad user-updated file should not
permanently shadow a good shipped sidecar.

## `raven packages update`

Add a user-invoked command:

```sh
raven packages update
```

The command downloads `names.db` and `base-exports.json` from Raven's moving
`names-db` GitHub Release. It writes to the user data location by default, not
beside the executable. This avoids installing mutable data into `~/bin`,
`~/.cargo/bin`, or `/usr/local/bin`.

Recommended behavior:

- Download both DB assets plus the published checksum file when available.
- Verify transport-level success and verify `names.db` by opening it through
  `ShippedDb::open`.
- Verify `base-exports.json` through the existing Tier 2 JSON reader path.
- Write to temporary files in the destination directory.
- Atomically rename into place after verification.
- Print the installed paths and the snapshot/provenance when available.
- If the data directory cannot be created or written, fail with a clear message
  and suggest `RAVEN_NAMES_DB` / `RAVEN_BASE_EXPORTS` for a manually chosen path.

The command is allowed to use the network because the user requested it
explicitly. Normal Raven commands remain network-free.

In CI, users who install from source should run:

```sh
cargo install --git https://github.com/jbearak/raven raven
raven packages update
raven check --format sarif > raven.sarif
```

For reproducible adopter CI, `.raven/packages.json` remains the pinned Tier 2
path. `packages update` restores broad ecosystem coverage for zero-adoption
scans, but it is not deterministic across time because the moving `names-db`
Release can gain newer package versions.

## Base/recommended floor

Raven should not require a sidecar to understand the R platform itself. Raw
Cargo installs should still have base and recommended package coverage.

The binary should carry a compact built-in base/recommended export and dataset
floor. It may be generated from the same reference-R capture used to build
`base-exports.json`, but the result should be compiled into Raven as ordinary
Rust data or a compact embedded payload.

Runtime precedence should be:

1. Installed base/recommended packages on disk, when available.
2. `RAVEN_BASE_EXPORTS`, user data, or executable-relative `base-exports.json`,
   using the same location precedence as `names.db`.
3. Embedded base/recommended floor.

This separates the R platform from the CRAN/Bioconductor ecosystem. The full
ecosystem database remains external; the platform floor travels with the binary
as the last R-free fallback. A refreshed sidecar can still improve or update the
embedded floor, but a raw Cargo install is not left empty.

## Targeted warnings

Raven should not print a generic startup warning merely because Tier 3 is absent.
The warning should be tied to evidence that missing package metadata can create
false-positive undefined-variable diagnostics.

For `raven check`, collect package metadata misses during diagnostic production:

- A package is referenced by the workspace.
- It is not available through Tier 1.
- It is not covered by Tier 2.
- Either Tier 3 is absent, or Tier 3 is present but does not cover the package.
- The missing package metadata can affect emitted undefined-variable diagnostics.

Emit one stderr note per run, with package names capped to avoid noisy output.

When Tier 3 is absent:

```text
raven check: package export metadata is missing for foo, bar.
Tier 3 names.db is not installed, so undefined-variable diagnostics from these packages may be false positives.

To cover base/recommended, CRAN, and Bioconductor packages, run:
  raven packages update

For GitHub-only, internal, or version-exact packages, run:
  raven packages freeze
and commit .raven/packages.json, or install R and the relevant packages in the CI image.
```

When Tier 3 is present but still misses the package:

```text
raven check: package export metadata is missing for foo, bar.
Raven checked installed packages, .raven/packages.json, and names.db, but these packages were not found.

`raven packages update` can refresh coverage for base/recommended, CRAN, and Bioconductor packages.
For GitHub-only, internal, or version-exact packages, run `raven packages freeze` locally and commit .raven/packages.json, or install R and the relevant packages in the CI image.
```

The LSP already has package-not-installed diagnostics. It should not add a
second popup-style warning path for the same `library(pkg)` call. Instead, the
missing-export-metadata signal should be available to enrich or explain existing
package-related diagnostics and logs. In particular, if a package is not
installed and no Tier 2/3 export metadata covers it, the existing diagnostic (or
its related information/log entry) can explain that undefined-variable
diagnostics from that package may be false positives and point to
`raven packages freeze` / `raven packages update`. The editor must not produce
one notification per file, package, symbol, or diagnostic.

## Packaging

Release archives and VSIX packages continue to place `names.db` and
`base-exports.json` next to the executable. That keeps packaged installs fully
offline at runtime.

Homebrew should be supported with a Raven tap or formula that installs the
binary and sidecars in a layout where Raven can find them. If Homebrew symlinks
the executable into a bin directory, the formula must ensure the actual
`current_exe()` path sees the sidecars or set/wrap the environment consistently.

Other package managers should follow the same rule: install sidecars with the
tool, or rely on `raven packages update` to populate the user data DB.

## Documentation changes

Update `README.md`, `docs/cli.md`, `docs/package-database.md`,
`docs/r-package-dev.md`, and `docs/development.md` to distinguish install paths:

- Release archives, VSIX, and package-manager installs ship the Tier 3 sidecar.
- Cargo/source installs need `raven packages update` for broad Tier 3 coverage.
- Tier 2 (`raven packages freeze`) is the reproducible, project-specific path.
- `raven packages update` is an explicit network step and should be part of CI
  image setup/cache warmup when source installs are used.

Docs should stop saying the bundled Tier 3 DB is "always there" without
qualifying the install path.

## Testing

Unit tests should cover:

- Locator precedence: env override, user data DB, exe-relative DB.
- Fallback from corrupt/incompatible higher-priority DB to a valid lower-priority
  DB while preserving load notes.
- `raven packages update` atomic install behavior using a local test server or
  injectable downloader.
- `raven check` targeted warning behavior for:
  - Tier 3 absent and package metadata missing.
  - Tier 3 present but package not covered.
  - Tier 2 covering all referenced packages, producing no warning.
- Embedded base/recommended fallback with no R, no sidecars, and no Tier 3 DB.

CI should keep the existing release packaging checks and add a source-install
style test that verifies base/recommended coverage works without sidecars while
non-base CRAN coverage requires the explicit update or an injected test DB.

## Open implementation choices

- Exact user data directory helper: use a small dependency such as `directories`
  or implement the few needed platform paths directly.
- Command name: `raven packages update` is preferred; `install-db` is more
  explicit but less natural for future refreshes.
- Whether `base-exports.json` remains part of the release sidecars after the
  embedded base/recommended floor lands. Keeping it initially lowers migration
  risk.
