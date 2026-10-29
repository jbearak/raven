# Batch D: content moving to docs/development.md

## From docs/cli.md

### Maintainer `raven packages` commands (was "Appendix: maintainer and advanced topics")

cli.md keeps `<a id>` anchors `raven-packages-build-shipped-db`, `raven-packages-validate-shipped-db`, `raven-packages-build-embedded-base` on a one-line pointer to `development.md#tier-3-build-pipeline`. The user-facing `--base-url` self-hosting section stayed in cli.md (under `raven packages update`), with the `appendix-maintainer-and-advanced-topics` anchor on it.

#### `raven packages build-shipped-db`

**Maintainer / CI-only.** Builds Raven's Tier 3 `names.db` database. All base-priority packages are excluded from `names.db` (they are embedded in the binary). The shipped binary is **network-free**: this command transforms r-universe JSON that the build workflow has already downloaded with `curl`, merging it **append-only** over an authoritative reference-R capture of the build machine's installed library. The reference capture **auto-discovers every R `.libPaths()` entry**. The result is published to the `names-db` GitHub Release, where `raven packages update` downloads it on demand. It is **not** bundled with the binary, and the VSIX omits it too (VS Code users resolve their locally installed packages via Tier 1). Its Tier 3 reference-R capture (always on) picks up authoritative dataset lists for LazyData packages when R is available at build time (this sentence was in package-database.md "Base packages and datasets").

#### `raven packages validate-shipped-db`

**Maintainer / CI-only.** Opens a `names.db` database with the current Raven binary, verifies the container header, format version, payload checksum, index bounds, and decodes every package record. The command fails if the file is corrupt, uses a newer unsupported format, or if the fully decoded record count does not match the database provenance.

```text
raven packages validate-shipped-db names.db
```

Raven's release workflow runs this against the current `names-db` Release asset before building the release binaries: a **compatibility gate** confirming the version of Raven being shipped can open and validate the database users will download. It is not a bundling step: `names.db` is not shipped with the binary.

#### `raven packages build-embedded-base`

**Maintainer-only.** Regenerates the embedded base export/dataset table (`crates/raven/src/package_db/embedded_base_generated.rs`) from a reference R installation, covering all 14 base-priority packages. The generated file is compiled into the binary so base symbols are available without any database file or R installation.

```text
raven packages build-embedded-base --reference-lib DIR [--output PATH]
```

- `--reference-lib DIR`: path to the R library containing the base packages (e.g. the output of `Rscript -e 'cat(.Library)'`).
- `--output PATH`: where to write the generated file (default: `crates/raven/src/package_db/embedded_base_generated.rs`).

After running, verify with `cargo test -p raven embedded_base` and commit the result.

### `targets::tar_source()` in `raven check` (internal mechanics)

User page now says this in user terms. The original internal wording:

> `raven check` supplements the ordinary URI-based dependency neighborhood with a bounded, context-sensitive provider traversal; providers outside the initial workspace scan are parsed and finalized into the same workspace index before diagnostics run. This affects scope only: navigation, missing-file checks, and dependency revalidation continue to use one URI-global graph edge per source entry.

### Package warming

The user page calls it "loads export lists"; the original term was "warms the export cache" (before reporting, `raven check` warms the export cache for packages each reported file attaches). Keep the term in development.md if useful.

### NSE footer design rationale

> The footer is framed carefully so it never reads as Raven asserting the call *is* NSE ... The snippet is enough to apply without understanding the syntax; the links explain it, mirroring how ShellCheck and Clippy attach a docs URL rather than explaining suppression inline. The footer carries no header or per-line prefix (it is `raven check`'s own output, so labeling it as such mid-stream would be redundant).

## From docs/package-database.md

### Exports completeness internals

- Each cached `PackageInfo` records how complete its export set is; the `namespace-member-not-found` diagnostic uses it.
- The member authority (`namespace_member_status_sync`) is synchronous, never spawns R, and never touches disk: it consults the warmed cache, then the providers, and concludes `Absent` only from a `Complete` set. It deliberately does not parse the on-disk `NAMESPACE` synchronously, which would block the keystroke path and could not see datasets.
- Data objects (`lazy_data`, the per-file `data_aliases` object names, and base-package datasets via `base_exports`) are positive-only.
- The cache write path (`insert_package`) is monotonically authoritative: once a package is cached `Complete`, a later weaker (`Partial`/`Unknown`) load can never downgrade its exports or completeness; it only folds in additional positive-only data.

### Provider architecture and rationale

- Tier 2 and Tier 3 share one in-memory model, one reader, and one writer.
- The embedded base table is a `// @generated` per-package record; the other 7 non-attached base packages sit in the per-package cache.
- `names.db`'s post-merge filter strips all 14 base-priority packages.
- "Bundling third-party data carries supply-chain responsibility, so provenance and a tamper check are part of the pipeline." (rationale for the blake3 checksum and header provenance)
- Non-base package datasets are captured as a `lazy_data` list in every tier's records and folded into the resolvable set when the package's exports are collected.

## From docs/linting.md

- The `commented_code` rule re-parses each candidate comment body via a thread-local parser pool; every other rule walks only the already-parsed tree. (User page keeps "re-parses each candidate comment".)
- Lint rules run against the tree-sitter AST; `commented_code` classification differs from `lintr` because Raven parses with tree-sitter and `lintr` with R. (User page says "Raven's own R parser".)

## From docs/configuration.md

- Package-affecting `raven.toml` changes reuse the same reconciliation path as `workspace/didChangeConfiguration`: the package library is rebuilt via R if needed, the libpath watcher is restarted, and any updated completion-trigger registration is re-applied, all asynchronously, off the LSP write lock.
- `[workspace].exclude`: Raven prunes directories during the serial workspace walk only when a positive directory glob proves every descendant is excluded; directory globs prune before the parallel parse/index phase (wording from cli.md).
- `raven.crossFile.maxChainDepth` also bounds the bidirectional neighborhood-walk depth.
- `maxTransitiveDependentsVisited` budget is consumed by dependent revalidation, package-scope snapshots, and open-neighborhood pinning (settings-reference wording).
