# Names DB Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Tier 3 `names.db` refresh build from a protected Raven source branch, and make every Raven release validate the exact `names.db` it bundles before packaging binaries.

**Architecture:** The scheduled workflow remains present on `main` because GitHub Actions cron workflows run from the default branch, but its checkout is pinned to a protected branch named `names-db-builder`. Raven gains a maintainer CLI command, `raven packages validate-shipped-db PATH`, which opens a `names.db`, verifies its container integrity, decodes every package record, and fails if the decoded record count does not match provenance. `release-build.yml` downloads the mutable `names-db` Release asset once, validates it with the just-tagged Raven source, uploads the validated file as a run artifact, and all platform build jobs bundle that validated artifact instead of re-downloading the mutable Release asset.

**Tech Stack:** GitHub Actions, Rust, Raven package DB CLI, existing `ShippedDb::open` / `all_records` integrity checks, existing pinned Actions artifact upload/download actions.

---

## File Structure

- Modify `.github/workflows/build-names-db.yml`: keep the scheduled workflow on `main`, but checkout protected ref `names-db-builder` before building Raven and running `scripts/build-names-db.sh`.
- Modify `.github/workflows/release-build.yml`: add a `validate-names-db` preflight job and make `build-lsp` consume the validated artifact.
- Modify `crates/raven/src/main.rs`: add the validator subcommand to top-level usage text.
- Modify `crates/raven/src/cli/packages.rs`: add parse/run support and tests for `validate-shipped-db`.
- Modify `docs/cli.md`: document the maintainer validator command.
- Modify `docs/development.md`: document the protected-branch refresh model and release-time validation invariant.

## Task 1: Pin the names.db Refresh Job to the Protected Builder Branch

**Files:**
- Modify: `.github/workflows/build-names-db.yml`

- [ ] **Step 1: Patch workflow env + checkout ref**

Change the top of `.github/workflows/build-names-db.yml` to define the protected source branch and use it in `actions/checkout`.

```yaml
name: Build names.db (Tier 3 package-export DB)

on:
  workflow_dispatch:
  schedule:
    - cron: "0 6 * * 1"   # Mondays 06:00 UTC

permissions:
  contents: write   # to update the names-db Release

env:
  NAMES_DB_BUILDER_REF: names-db-builder

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1
        with:
          ref: ${{ env.NAMES_DB_BUILDER_REF }}
      - uses: r-lib/actions/setup-r@a51a8012b0aab7c32ef9d19bf54da93f3254335e # v2 — reference R; build-shipped-db auto-discovers its .libPaths()
```

- [ ] **Step 2: Run a YAML parse check**

Run:

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/build-names-db.yml"); puts "ok"'
```

Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-names-db.yml
git commit -m "ci: build names db from protected builder branch"
```

## Task 2: Add a Maintainer DB Validator Command

**Files:**
- Modify: `crates/raven/src/cli/packages.rs`
- Modify: `crates/raven/src/main.rs`

- [ ] **Step 1: Add parser and args type**

In `crates/raven/src/cli/packages.rs`, after `BuildShippedDbArgs`, add:

```rust
pub struct ValidateShippedDbArgs {
    pub path: PathBuf,
}

pub fn parse_validate_shipped_db_args(
    mut argv: impl Iterator<Item = String>,
) -> Result<ValidateShippedDbArgs, String> {
    let Some(path) = argv.next() else {
        return Err("validate-shipped-db needs a names.db path".into());
    };
    if path == "--help" {
        return Err("HELP".into());
    }
    if let Some(extra) = argv.next() {
        return Err(format!("unexpected extra argument: {extra}"));
    }
    Ok(ValidateShippedDbArgs {
        path: PathBuf::from(path),
    })
}
```

- [ ] **Step 2: Add validator runner**

In `crates/raven/src/cli/packages.rs`, after `run_build_shipped_db`, add:

```rust
pub fn run_validate_shipped_db(args: ValidateShippedDbArgs) -> Result<(), String> {
    let db = ShippedDb::open(&args.path)
        .map_err(|e| format!("{}: {e}", args.path.display()))?;
    let records = db.all_records();
    let provenance = db.provenance();
    let expected = provenance.package_count as usize;
    if records.len() != expected {
        return Err(format!(
            "{}: decoded {} package records, but provenance says {}",
            args.path.display(),
            records.len(),
            expected
        ));
    }
    eprintln!(
        "Validated {}: {} packages; source: {}; snapshot: {}; built by Raven {}",
        args.path.display(),
        records.len(),
        provenance.source,
        provenance.snapshot_date,
        provenance.raven_version
    );
    Ok(())
}
```

- [ ] **Step 3: Wire the packages dispatcher and help**

In `crates/raven/src/cli/packages.rs`, update `run`:

```rust
        Some("validate-shipped-db") => {
            let args = parse_validate_shipped_db_args(argv)?;
            run_validate_shipped_db(args)
        }
```

Update the `None` usage string:

```rust
Err("usage: raven packages <fetch|freeze|update|build-shipped-db|build-embedded-base|validate-shipped-db> [OPTIONS]".into())
```

Update `print_help()` usage to include:

```text
         raven packages validate-shipped-db names.db
```

- [ ] **Step 4: Update top-level usage**

In `crates/raven/src/main.rs`, change the packages usage line to:

```text
       raven packages <fetch|freeze|update|build-shipped-db|build-embedded-base|validate-shipped-db> [OPTIONS]
```

Add this subcommand description under `packages <subcommand>`:

```text
  validate-shipped-db       Maintainer-only names.db compatibility/integrity validator
```

- [ ] **Step 5: Add parser tests**

In `crates/raven/src/cli/packages.rs` tests module, add:

```rust
    #[test]
    fn parse_validate_shipped_db_requires_one_path() {
        let err = super::parse_validate_shipped_db_args(std::iter::empty()).unwrap_err();
        assert!(err.contains("needs a names.db path"));

        let args = super::parse_validate_shipped_db_args(
            ["dist/names.db"].into_iter().map(String::from),
        )
        .unwrap();
        assert_eq!(args.path, std::path::PathBuf::from("dist/names.db"));

        let err = super::parse_validate_shipped_db_args(
            ["a.db", "b.db"].into_iter().map(String::from),
        )
        .unwrap_err();
        assert!(err.contains("unexpected extra argument"));
    }
```

- [ ] **Step 6: Add validator success/failure tests**

In `crates/raven/src/cli/packages.rs` tests module, add:

```rust
    #[test]
    fn validate_shipped_db_accepts_valid_db() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("names.db");
        write_shipped_db(&path, &records(), provenance()).unwrap();

        super::run_validate_shipped_db(super::ValidateShippedDbArgs { path }).unwrap();
    }

    #[test]
    fn validate_shipped_db_rejects_corrupt_db() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("names.db");
        std::fs::write(&path, b"NOT A RAVEN DB").unwrap();

        let err = super::run_validate_shipped_db(super::ValidateShippedDbArgs { path }).unwrap_err();
        assert!(err.contains("bad magic"), "got {err}");
    }
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
cargo test -p raven validate_shipped_db
```

Expected: all `validate_shipped_db` tests pass.

- [ ] **Step 8: Commit**

```bash
git add crates/raven/src/cli/packages.rs crates/raven/src/main.rs
git commit -m "feat: add names.db validator command"
```

## Task 3: Validate the Exact names.db Bundled by Releases

**Files:**
- Modify: `.github/workflows/release-build.yml`

- [ ] **Step 1: Add a preflight validation job**

In `.github/workflows/release-build.yml`, add this job before `build-lsp`:

```yaml
  validate-names-db:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1

      - name: Download package DB from the names-db Release
        run: |
          mkdir -p dist
          gh release download names-db --repo "$GITHUB_REPOSITORY" \
            --pattern 'names.db' --dir dist
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Build Raven validator
        run: cargo build --release -p raven

      - name: Validate package DB
        run: ./target/release/raven packages validate-shipped-db dist/names.db

      - name: Upload validated package DB
        uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f # v6.0.0
        with:
          name: names-db
          path: dist/names.db
          retention-days: 30
```

- [ ] **Step 2: Make `build-lsp` depend on the preflight job**

Change the start of `build-lsp`:

```yaml
  build-lsp:
    needs: validate-names-db
    runs-on: ${{ matrix.os }}
```

- [ ] **Step 3: Replace mutable Release download with validated artifact download**

Replace the `Download package DB from the names-db Release` step in `build-lsp` with:

```yaml
      - name: Download validated package DB
        uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7.0.0
        with:
          name: names-db
          path: dist
```

- [ ] **Step 4: Run a YAML parse check**

Run:

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/release-build.yml"); puts "ok"'
```

Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release-build.yml
git commit -m "ci: validate names db before release packaging"
```

## Task 4: Document the Maintainer Contract

**Files:**
- Modify: `docs/cli.md`
- Modify: `docs/development.md`

- [ ] **Step 1: Update CLI docs**

In `docs/cli.md`, after `### raven packages build-shipped-db`, add:

````markdown
### `raven packages validate-shipped-db`

**Maintainer / CI-only — most users never run this.** Opens a `names.db` sidecar with the current Raven binary, verifies the container header, format version, payload checksum, index bounds, and decodes every package record. The command fails if the file is corrupt, uses a newer unsupported format, or if the fully decoded record count does not match the database provenance.

```text
raven packages validate-shipped-db names.db
```

Raven's release workflow runs this command against the exact `names.db` artifact it will bundle beside release binaries.
````

- [ ] **Step 2: Update development docs**

In `docs/development.md`, in the Tier 3 build pipeline section, update the workflow description to say:

```markdown
- The scheduled `build-names-db.yml` workflow stays on the default branch so GitHub Actions can run its cron, but its `actions/checkout` step is pinned to the protected `names-db-builder` branch. That branch is the production source line for the DB builder; merge only reviewed, release-compatible DB-builder changes into it.
- `release-build.yml` downloads the current `names-db` Release asset once, validates it with the just-tagged Raven source via `raven packages validate-shipped-db`, uploads that validated file as a workflow artifact, and every platform package bundles that artifact. This prevents a mutable Release asset from changing between validation and packaging.
```

- [ ] **Step 3: Run docs grep checks**

Run:

```bash
rg -n "validate-shipped-db|names-db-builder" docs/cli.md docs/development.md .github/workflows
```

Expected: shows entries in `docs/cli.md`, `docs/development.md`, `.github/workflows/build-names-db.yml`, and `.github/workflows/release-build.yml`.

- [ ] **Step 4: Commit**

```bash
git add docs/cli.md docs/development.md
git commit -m "docs: describe names db release hardening"
```

## Task 5: End-to-End Verification

**Files:**
- Read: `.github/workflows/build-names-db.yml`
- Read: `.github/workflows/release-build.yml`
- Read: `crates/raven/src/cli/packages.rs`
- Read: `docs/cli.md`
- Read: `docs/development.md`

- [ ] **Step 1: Run package CLI tests**

Run:

```bash
cargo test -p raven packages
```

Expected: package CLI/package DB tests pass.

- [ ] **Step 2: Build Raven release binary locally**

Run:

```bash
cargo build --release -p raven
```

Expected: build succeeds and `target/release/raven` exists.

- [ ] **Step 3: Validate the committed seed DB if available**

Run:

```bash
./target/release/raven packages validate-shipped-db crates/raven/data/names-db-seed.db
```

Expected: either prints `Validated ...` for a local LFS checkout with the seed present, or fails with an LFS-pointer/format error if the file is not materialized. If it fails because the LFS object is not present locally, do not treat that as a code failure; the release workflow validates the downloaded Release asset.

- [ ] **Step 4: Verify workflow intent in git diff**

Run:

```bash
git diff -- .github/workflows/build-names-db.yml .github/workflows/release-build.yml
```

Expected: `build-names-db.yml` checks out `${{ env.NAMES_DB_BUILDER_REF }}` and `release-build.yml` validates then uploads a `names-db` artifact consumed by `build-lsp`.

- [ ] **Step 5: Final commit if Task 5 changed files**

If Task 5 reveals a small correction and a file changes, commit it:

```bash
git add .github/workflows/build-names-db.yml .github/workflows/release-build.yml crates/raven/src/cli/packages.rs crates/raven/src/main.rs docs/cli.md docs/development.md
git commit -m "fix: complete names db release hardening verification"
```

Expected: no commit is needed if Task 5 only runs verification.

## Self-Review

- Spec coverage: The plan covers protected-branch source for DB refresh, release-time validation, exact-artifact bundling, CLI support, tests, and docs.
- Placeholder scan: No task relies on an unspecified implementation. The protected branch name is fixed as `names-db-builder`.
- Type consistency: The new Rust type is `ValidateShippedDbArgs`; parser, runner, dispatcher, and tests all use that name. The CLI subcommand spelling is consistently `validate-shipped-db`.
- Risk note: GitHub branch protection itself is repository configuration, not a file change. After Task 1 lands, create/protect the `names-db-builder` branch in GitHub and only merge reviewed release-compatible DB-builder changes into it.
