# Design: `setup-raven` GitHub Action

**Date:** 2026-06-23
**Status:** Implemented. Action extracted to `jbearak/setup-raven` and tagged
`v1`; this repo's dogfood workflow now consumes `jbearak/setup-raven@v1` as a
drift smoke test (section 7 step 4 complete).

---

## 1. Goal & motivation

Provide an official GitHub Action that installs the Raven CLI from prebuilt
GitHub Release binaries so CI users do not need:

```sh
cargo install --git https://github.com/jbearak/raven raven
```

That command builds Raven from source. It requires Rust/Cargo, costs CI time,
and is not how normal users expect to install a released CLI binary. Cargo also
cannot install arbitrary GitHub Release zip assets, so Raven needs a thin
installer action for CI.

The desired public workflow shape is:

```yaml
name: Raven

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  raven:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jbearak/setup-raven@v1
        with:
          version: latest
      - run: raven packages update
      - run: raven check
```

The action installs the `raven` binary and nothing else. Every `raven`
invocation — `packages update`/`fetch`/`freeze`, `check`, `lint` — is an
ordinary `run:` line the workflow owns, so the workflow keeps full, visible
control over paths, output format, severity thresholds, `--report-uninstalled`,
and any future CLI flags. This is the `setup-node` pattern: the action does the
non-trivial part (OS/arch detection, download, checksum, `PATH`), and running
the tool is a one-line `run:` step that needs no action of its own.

---

## 2. Naming decision

The public action should be named:

```yaml
uses: jbearak/setup-raven@v1
```

This matches the established convention for setup-only actions:

- `actions/setup-node`, `actions/setup-python`, and similar platform actions
  install a toolchain and leave commands to later steps.
- `astral-sh/setup-uv` installs `uv` and adds it to `PATH`; workflows then run
  their own `uv` commands.
- `biomejs/setup-biome` installs the Biome CLI; workflows then run `biome ci`
  or another command explicitly.

By contrast, `*-action` names usually imply a runner action that executes the
tool, such as `astral-sh/ruff-action` or `jakebailey/pyright-action`.

The action is install-only, so `setup-raven` is the accurate, least-surprising
name. The justification is concrete, not just convention: running `raven` is a
trivial `run:` line, so it needs no action of its own — the only non-trivial work
is installation. A `*-action` that ran `raven check` would earn its existence
only by doing something a `run:` line can't, such as rendering findings as inline
annotations on the PR diff (GitHub `::error file=,line=::` workflow commands).
There is no plan to build one; the `setup-` name simply leaves that door open
without promising it.

---

## 3. Boundary & non-goals

The action is responsible for:

1. Detecting runner OS and architecture.
2. Mapping them to the correct Raven Release asset.
3. Resolving `version: latest` to GitHub's latest Release download URL, or using
   a specific tag.
4. Downloading the zip and matching `.sha256`.
5. Verifying the SHA-256 checksum.
6. Extracting the `raven` binary.
7. Adding it to `PATH`.
8. Running `raven --version` as a smoke test.

It is not responsible for:

- Running **any** `raven` subcommand — including `packages update`/`fetch`/
  `freeze`, `check`, and `lint`. Those are `run:` lines the workflow owns.
- Choosing `raven check` defaults, paths, severities, or output formats.
- Defaulting to SARIF or documenting GitHub code scanning as a primary path.
- Uploading SARIF.
- Installing R.
- Restoring project R packages.
- Caching Raven downloads or the package-symbol database.
- Managing action-level annotations.
- Mirroring any Raven CLI flag as an action input.

The action runs no `raven` subcommand: `packages update`/`fetch` provision the
environment and `check`/`lint` analyze the repo, but both are things you *run*,
and running `raven` is a one-line `run:` step. Keeping them out of the action
means every `raven` invocation is visible in the workflow and the action's input
surface stays minimal (just `version`). If the action grows beyond release
resolution, download, checksum verification, and `PATH` setup, it is overbuilt.

---

## 4. Public API

A single input:

```yaml
version:
  default: latest
  accepted: latest or a Raven release tag
```

Semantics:

- `version: latest` (default) resolves to GitHub's latest Release. This is the
  main documentation example.
- `version: <tag>` pins a specific Raven release tag for teams that need a fully
  reproducible CLI version.

There is no `packages` input. Provisioning the package-symbol database and
analyzing the repo are both things you *run*, so they are ordinary `run:` lines:

```yaml
- uses: jbearak/setup-raven@v1
  with:
    version: latest
- run: raven packages update   # broad R-free CRAN/Bioconductor coverage
- run: raven check
```

Pinning `version` pins the Raven executable only. Package-metadata
reproducibility is separate: commit `.raven/packages.json` generated by
`raven packages freeze` when the package export database should be
project-pinned.

---

## 5. Support matrix

V1 support target:

| Runner | Status |
|---|---|
| `ubuntu-latest` x64 | Required, dogfooded |
| `ubuntu-24.04-arm` (Linux arm64) | Supported and dogfooded |
| `macos-latest` arm64 | Supported and dogfooded |
| macOS x64 | Supported by mapping/release asset |
| `windows-latest` x64 | Supported and dogfooded |
| Windows arm64 | Supported by mapping/release asset |

All three OSes Raven publishes binaries for are supported. Windows works through
the same Bash installer (GitHub's Windows runners run `shell: bash` via Git Bash)
with three small accommodations: the OS maps to the `windows` asset, the binary
is `raven.exe`, extraction falls back from `unzip` to `7z` (Windows runners ship
`7z`, not `unzip`), and `RUNNER_TEMP` backslashes are normalized so `sha256sum`
does not escape its checksum output. The action fails clearly on any genuinely
unsupported OS.

Raven's analysis is platform-independent — the same R source yields the same
results on any OS — and Linux runners bill at the lowest rate, so Linux is
usually the most economical CI choice even though all three platforms work.

---

## 6. Implementation plan in this repository

Start with an internal composite action:

```text
.github/actions/setup-raven/
  action.yml
  setup-raven.sh
  README.md
```

Use a Bash installer. It runs on all three OSes — GitHub's Windows runners
execute `shell: bash` via Git Bash — so one script covers the matrix. The script
should rely only on standard GitHub-hosted runner tools:

- `bash`
- `curl`
- `unzip` (Linux/macOS) or `7z` (Windows) — the script falls back between them
- `sha256sum` or `shasum`

The composite action passes inputs through environment variables and executes
the script. The script should keep its control flow simple:

```text
validate version input
map RUNNER_OS/RUNNER_ARCH to asset name
build Release download URLs
download zip and .sha256
verify checksum
extract archive
copy raven into a per-run bin directory
chmod +x
append bin directory to GITHUB_PATH
run raven --version
```

Dogfood the internal action with a focused workflow:

```text
.github/workflows/setup-raven-action.yml
```

The workflow should run on changes to the internal action and on manual
dispatch. It should test `ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`,
and `windows-latest`, and run `raven --version` after setup. It does not run any
`raven` subcommand beyond the smoke test; `check` and package commands are
covered by Raven's normal integration gates.

---

## 7. Extraction plan

This repository is the staging area only. The public action should live in its
own repository:

```text
jbearak/setup-raven
```

Reasons:

- The desired public syntax requires a repository named `setup-raven`.
- The action needs a stable major tag (`v1`) independent of Raven CLI release
  tags.
- Action bugfixes can ship without implying a Raven CLI release.
- Raven CLI releases can ship without moving the action's `v1` tag.
- Users download a small action repository instead of the full Raven source
  repository.

The sequence:

1. Add the internal composite action, the dogfood workflow, and the user-facing
   docs (section 8) on a Raven branch.
2. Validate the internal action on GitHub-hosted Linux (x64 and arm64) and
   macOS via the dogfood workflow.
3. Create `jbearak/setup-raven`: copy `action.yml`, `setup-raven.sh`, and the
   README into it, add a minimal CI workflow that exercises the action against
   live Raven release assets, and tag `v1`.
4. Repoint the dogfood workflow from `./.github/actions/setup-raven` to
   `jbearak/setup-raven@v1` and **delete the internal
   `.github/actions/setup-raven/` implementation**. Once the public repo exists,
   the action lives there and nowhere else; the repointed workflow keeps no
   duplicated implementation and becomes an integration smoke test that verifies
   the public action can still install Raven's own latest releases, catching
   asset-naming/mapping drift between the two repos.

There is exactly one source of truth for the action — `jbearak/setup-raven`. The
Raven repo never keeps a second copy of `action.yml`/`setup-raven.sh`; it keeps
only a workflow that *consumes* the published action. The docs reference
`jbearak/setup-raven@v1`, so steps 1–3 land together (or the public repo and its
`v1` tag are created first) to avoid a window where the documented action 404s.

---

## 8. Documentation changes

Update Raven docs so the primary GitHub Actions example uses:

```yaml
- uses: jbearak/setup-raven@v1
  with:
    version: latest
- run: raven packages update
- run: raven check
```

Keep `cargo install --git https://github.com/jbearak/raven raven` documented as
a source-build/development option, not the recommended CI path.

Docs should explain:

- Normal CI users do not need Rust or Cargo.
- `version: latest` is the main example.
- A specific tag can be used to pin the Raven CLI version.
- The action installs only; `raven packages update`/`fetch`, `check`, and `lint`
  are explicit `run:` lines the workflow controls.
- `raven packages update` is broad and convenient but follows Raven's moving
  `names-db` Release.
- Committing `.raven/packages.json` from `raven packages freeze` is the
  reproducible project-specific package metadata path.
- `raven packages fetch` is an ephemeral project-scoped CI producer from
  r-universe.
- V1 supports Linux, macOS, and Windows runners; Linux is usually the most
  economical CI choice since the analysis is platform-independent.

Do not lead with SARIF or GitHub code scanning. `--format sarif` can remain in
the CLI output-format reference because Raven supports it, but code scanning is
not a primary workflow for a Raven/Stata-style static analyzer.

---

## 9. Testing strategy

Local/offline checks:

- `bash -n .github/actions/setup-raven/setup-raven.sh`
- Parse `action.yml` and the dogfood workflow as YAML.
- Verify invalid inputs fail before network access:
  - bad `version`
  - unsupported OS (e.g. a non-Linux/macOS/Windows `RUNNER_OS`)
  - unsupported architecture
- Simulate a release download with a fake `curl`, fake Raven zip, and matching
  `.sha256` so the install path (download, checksum verify, extract, `PATH`,
  smoke test) is exercised without network.
- `git diff --check`

GitHub-hosted checks:

- Dogfood workflow installs `version: latest`, then runs `raven --version` on
  `ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, and `windows-latest`.
- The public `setup-raven` repo should repeat the live-install matrix before
  tagging `v1`.

Acceptance criteria:

- A workflow can install Raven from Release binaries on `ubuntu-latest`.
- Linux arm64, macOS, and Windows installs work, or failures are caught by
  dogfood before public release.
- Normal users do not need Rust or Cargo.
- Downloads are checksum verified.
- `raven` is available on `PATH` in later steps.
- `version: latest` and a pinned tag both work.
- Raven docs include a PR workflow example triggered by `opened`, `synchronize`,
  `reopened`, and `ready_for_review`.
