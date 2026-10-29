# Automated checks in CI

[Docs](README.md) › Start here

Run `raven check` on every push and pull request, so a typo, a missing `source()` target, or an undefined object fails the build during review instead of when someone reruns the analysis.

| You do | CI does |
|---|---|
| Commit `.github/workflows/raven.yml` or `bitbucket-pipelines.yml` once | Starts a fresh Linux machine for every push and pull request |
| Push a commit or open a pull request | Installs Raven, runs `raven packages update` and `raven check` |
| Open the pull request | Shows a green check or a red ✗, with each finding's file and line in the log |

## What CI is

CI means **Continuous Integration**: a service such as GitHub Actions or Bitbucket Pipelines runs commands automatically every time you push code or open a pull request. You describe the commands once, in a small configuration file committed to the repository, and the service runs them on a fresh machine for every change. No one has to remember to run the checks, and everyone reviewing the change sees the result.

This is standard practice in most software ecosystems. Python projects run `pytest` and `ruff` on every pull request, TypeScript projects run `eslint` and the compiler, and Rust projects run `cargo clippy` and their test suite. The tools differ, but the pattern is the same: an automated gate that catches problems before a change is merged, instead of after it has broken something. Raven brings that pattern to R analysis code.

The mechanics:

1. You commit a configuration file to the repository: `.github/workflows/raven.yml` for GitHub Actions, or `bitbucket-pipelines.yml` at the repository root for Bitbucket. The examples below are complete files, so you don't need to write YAML from scratch.
2. When you push a commit or open a pull request, the service starts a fresh Linux machine, checks out your code, and runs the listed commands.
3. The result appears on the pull request as a green check mark or a red ✗. Clicking through shows the log: the same output you would see running `raven check` in a terminal, including file names and line numbers for each finding.

Raven's CI command is [`raven check`](cli.md#raven-check). It runs the same static diagnostics the editor publishes, in a batch suited to CI logs and pass/fail gating. It reads `.R`, `.Rmd`, and `.qmd` files, follows `source()` chains, and reports syntax errors, missing source paths, undefined variables, package-scope issues, and enabled style lints. It does **not** run your scripts.

## Why `raven check` belongs in CI

Most language ecosystems have a CI checker that reads code without running it: `cargo check`, `tsc`, `pyright`, `ruff`. R's tooling grew up around a different need. `R CMD check` and the CI ecosystem around it verify *packages*, which means installing every dependency and running code. There's little equivalent for *analysis repositories*, the scripts that make up most scientific and statistical work, and that gap is what `raven check` fills.

Raven's core is static analysis with **position-aware scope**: it tracks what's defined at each point in a script, line by line and inside each function, so it can flag an undefined variable, including one used before it's defined. It follows `source()` chains and static `targets::tar_source()` batches, builds a map of how your scripts depend on one another, and resolves scope across them. No other R tool does this, and it makes `raven check` useful for analysis repositories as well as for package development.

If you aren't building a package, you usually don't want CI to *run* your scripts, or to install every package they depend on just to check them. Raven finishes in about a second; compiling a dependency tree can take hours, which makes the check slow and expensive, and at scale pushes avoidable load onto CRAN mirrors. So Raven runs **without R, and without your repo's packages installed**.

It still needs each package's **export names** to tell a real function from a typo. [Choose where package names come from](#choose-where-package-names-come-from) lists the options; the templates below use the simplest, `raven packages update`.

## Recommended setup

For most analysis repositories, start with this pattern:

1. Install the Raven CLI in the CI job: `jbearak/setup-raven` on GitHub Actions, or the signed apt repository on Bitbucket Pipelines.
2. Run `raven packages update`, so Raven recognizes CRAN and Bioconductor package exports without installing the packages.
3. Run `raven check`.

That setup needs no R installation and does not run your analysis. Base R symbols are embedded in the binary; broad CRAN/Bioconductor coverage comes from `raven packages update`.

## GitHub Actions

Use [`jbearak/setup-raven`](https://github.com/jbearak/setup-raven) to install the prebuilt Raven CLI. Copy [`docs/examples/ci/github-actions-raven.yml`](examples/ci/github-actions-raven.yml) to `.github/workflows/raven.yml`:

```yaml
name: Raven

# Runs on pull requests and on pushes to the default branch (main).
# Scoping push to main avoids a duplicate run when you push to a branch
# that already has an open pull request (pull_request already covers that).
"on":
  push:
    branches: [main]
  pull_request:

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

Pin `version` to a release tag when you want a fully reproducible CLI version; the example tracks the latest release.

## Bitbucket Pipelines

Bitbucket Pipelines runs the commands in `bitbucket-pipelines.yml`. Raven publishes a signed apt repository, so a normal Ubuntu build image can install the CLI directly. Copy [`docs/examples/ci/bitbucket-pipelines.yml`](examples/ci/bitbucket-pipelines.yml) to `bitbucket-pipelines.yml`:

```yaml
# Runs on pull requests and on pushes to the default branch (main).
# repository-push is scoped to main so pushing to a branch with an open
# pull request runs only once (via pullrequest-push), not twice.
# lfs: false skips downloading Git LFS content (e.g. large datasets);
# raven check reads only code. In a repository that does not use LFS,
# the setting simply has no effect.
clone:
  lfs: false

image: ubuntu:24.04

pipelines:
  custom:
    Raven:
      - step:
          name: Raven
          script:
            - apt-get update
            - apt-get install -y ca-certificates curl
            - install -d -m 0755 /etc/apt/keyrings
            - curl -fsSL https://jbearak.github.io/apt-raven/raven-archive-keyring.gpg -o /tmp/raven-archive-keyring.gpg
            - echo "aaaee9d0c6d944091d1a78d8aeb4f93f59dc713ee1f218052add12b0d7c743cd  /tmp/raven-archive-keyring.gpg" | sha256sum -c -
            - install -m 0644 /tmp/raven-archive-keyring.gpg /etc/apt/keyrings/raven-archive-keyring.gpg
            - echo "deb [signed-by=/etc/apt/keyrings/raven-archive-keyring.gpg] https://jbearak.github.io/apt-raven stable main" > /etc/apt/sources.list.d/raven.list
            - apt-get update
            - apt-get install -y raven
            - raven packages update
            - raven check

triggers:
  repository-push:
    - condition: BITBUCKET_BRANCH == "main"
      pipelines:
        - Raven
  pullrequest-push:
    - condition: glob(BITBUCKET_BRANCH, "**")
      pipelines:
        - Raven
```

To pin a specific Raven package version for reproducible runs, replace the `apt-get install -y raven` line:

```yaml
            - apt-cache madison raven
            - apt-get install -y "raven=${RAVEN_DEB_VERSION}"
```

Set `RAVEN_DEB_VERSION` in your pipeline variables to one of the versions listed by `apt-cache madison raven`, or omit the pin to track the latest package in the apt repository.

If VS Code's YAML extension reports an unresolved Bitbucket schema reference such as `pipelines_configuration`, the pipeline file can still be valid. That is an editor schema issue, not a Raven or Bitbucket runtime error.

## Choose where package names come from

<a id="package-metadata-strategies"></a>

`raven check` needs package export names, not installed packages. Installing R itself is not the expensive part; restoring and compiling the package dependency tree is. There are four ways to supply the names, each with different trade-offs:

1. **R and packages installed.** Install R and the project's packages in CI (for example with `renv::restore()`). Exact, full coverage that matches the installed versions, with no external database.
2. **`raven packages update`** before `raven check`. Downloads broad CRAN/Bioconductor metadata from Raven's `names-db` GitHub Release. No R needed and broad coverage, but it depends on a Release the Raven maintainer publishes and tracks the latest versions, not pinned ones.
3. **`raven packages fetch [--missing-only]`** before `raven check`. Fetches only the project's used packages from r-universe. No R needed and no dependency on the `names-db` Release; exports are the latest versions (installed packages stay version-exact under `--missing-only`). Without R in CI, `--missing-only` does nothing extra and this equals plain `raven packages fetch`.
4. **`raven packages freeze`** locally, then commit `.raven/packages.json`. Run it on a machine with R and the packages installed and commit the result. CI needs no R and no network, and the names match the versions you installed.

| Strategy | Needs R in CI | Network in CI | Coverage | Version fidelity | Committed | Depends on `names-db` Release |
|---|---|---|---|---|---|---|
| 1. R + packages installed | yes | (install) | exact, full | version-exact | no | no |
| 2. `packages update` | no | yes (1 file) | whole ecosystem | latest snapshot | no | **yes** |
| 3. `packages fetch [--missing-only]` | no | yes (per package) | project's used set | latest (installed rows exact under `--missing-only`) | no (temporary) | no |
| 4. `freeze` + commit | no (in CI) | no | project's used set | version-exact | yes | no |

Strategies 3 and 4 combine: commit a `freeze` file for version-exact coverage of installed packages, then run `fetch` in CI to top up whatever `freeze` missed. `fetch` never changes a record `freeze` wrote.

To use a committed snapshot, generate it locally on a machine with R and the project's packages installed:

```bash
raven packages freeze
git add .raven/packages.json
```

Then CI can run `raven check` without `raven packages update`. See [Package database](package-database.md) for how Raven combines these sources, and [`raven packages`](cli.md#raven-packages) for every flag.

If your pipeline also installs packages and runs the R scripts, add `--report-uninstalled` so `library(pkg)` calls fail when the package is missing from the CI library:

```bash
raven check --report-uninstalled
```

For a static gate that doesn't run the scripts, keep the default. It suppresses missing-package warnings because CI often checks code without restoring the R library. See [Missing-package reporting in CI](cli.md#missing-package-reporting-in-ci).

## What fails the build

"Fails the build" does not mean Raven itself failed. It means `raven check` ran and found at least one diagnostic above your severity threshold, and it reports that through its exit code, the standard way a checker tells GitHub Actions or Bitbucket Pipelines there is something to look at:

- **`0`**: nothing exceeded the threshold; the step passes.
- **`1`**: a diagnostic exceeded the threshold; the step fails. Raven found an issue in your code; Raven itself did not break.
- **`2`**: Raven could not run (an unreadable path, a malformed `raven.toml`). This is a setup error, separate from findings in your code.

`--max-severity LEVEL` sets the highest severity still allowed to pass; anything more severe fails the build. From most to least severe the scale is `error`, `warning`, `info`, `hint`. The default is `info`, so `warning` and `error` findings fail and `info` and `hint` findings pass. See [Exit codes](cli.md#exit-codes) for every case.

A failing `raven check` fails the pipeline, but a red build does not block a merge by itself. To prevent merging when the check fails, mark it as a required status check (GitHub branch protection) or a merge check (Bitbucket).

Use a committed [`raven.toml`](configuration.md) to keep editor diagnostics and CI aligned. Common CI-specific settings include `[workspace].exclude` for generated outputs and `diagnostics.reportUnusedSuppressions = true` to flag stale `# raven: ignore` comments.

## Gate on style

Raven's style lints (line length, naming, infix spacing, and similar) are `information`-level, so they never fail CI by default. To gate on them, first enable linting with `raven.toml` or a `.lintr` (see [Linting](linting.md)), then lower the threshold to `hint` so info-level findings fail:

```bash
raven check --max-severity hint
```

That fails the build on style findings as well as warnings and errors. `--max-severity off` is stricter still and fails on every diagnostic. See [Diagnostics](diagnostics.md) for the full diagnostic set.

To run only the style linter, use `raven lint` in place of `raven check`. It needs no package metadata. On GitHub Actions:

```yaml
- uses: actions/checkout@v4
- uses: jbearak/setup-raven@v1
  with:
    version: latest
- run: raven lint .
```

## Running Raven and Sight together

Some social-science repositories mix R and Stata. [Sight](https://github.com/jbearak/sight) is Raven's sibling project, the same kind of static checker for Stata `.do` files, and its CI command, `sight check`, works like `raven check`. If your repository contains both languages, run both checkers.

The examples below run them **one after the other in a single job**. Each additional job starts its own fresh machine and checks out the repository again, so two jobs cost roughly twice the startup time and compute minutes for two commands that each take seconds. If you prefer a separate green or red mark per checker on the pull request, both providers also support parallel jobs; that alternative is described after each example.

<a id="github-actions-1"></a>

### Both checkers on GitHub Actions

Copy [`docs/examples/ci/github-actions-raven-and-sight.yml`](examples/ci/github-actions-raven-and-sight.yml) to `.github/workflows/checks.yml`:

```yaml
name: Checks

# Runs on pull requests and on pushes to the default branch (main).
# Scoping push to main avoids a duplicate run when you push to a branch
# that already has an open pull request (pull_request already covers that).
"on":
  push:
    branches: [main]
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jbearak/setup-raven@v1
        with:
          version: latest
      - uses: jbearak/setup-sight@v1
        with:
          version: latest
      - run: raven packages update
      - run: raven check
      # if: always() means Sight still runs (and reports its findings)
      # even when raven check has already failed the job.
      - run: sight check
        if: always()
```

Both checkers install onto the same runner and share one checkout. The `if: always()` on the Sight step matters: without it, a Raven finding would skip the Sight step, so you would fix the R issues, push, and only then discover the Stata issues. With it, one run reports both.

To run them as **parallel jobs** instead, put two entries under `jobs:`, one with the Raven steps and one with the Sight steps, each starting with its own `actions/checkout@v4`. Each job gets its own runner and its own status on the pull request.

<a id="bitbucket-pipelines-1"></a>

### Both checkers on Bitbucket Pipelines

Sight is distributed on npm, so the combined pipeline uses the `node:24` image (Debian-based; Raven's signed apt repository installs on it exactly as on Ubuntu) and adds Sight with one `npm install`. Copy [`docs/examples/ci/bitbucket-pipelines-raven-and-sight.yml`](examples/ci/bitbucket-pipelines-raven-and-sight.yml) to `bitbucket-pipelines.yml`:

```yaml
# Runs on pull requests and on pushes to the default branch (main).
# repository-push is scoped to main so pushing to a branch with an open
# pull request runs only once (via pullrequest-push), not twice.
# lfs: false skips downloading Git LFS content (e.g. large datasets);
# raven check reads only code. In a repository that does not use LFS,
# the setting simply has no effect.
clone:
  lfs: false

image: node:24

pipelines:
  custom:
    Checks:
      - step:
          name: Raven and Sight
          script:
            - apt-get update
            - apt-get install -y ca-certificates curl
            - install -d -m 0755 /etc/apt/keyrings
            - curl -fsSL https://jbearak.github.io/apt-raven/raven-archive-keyring.gpg -o /tmp/raven-archive-keyring.gpg
            - echo "aaaee9d0c6d944091d1a78d8aeb4f93f59dc713ee1f218052add12b0d7c743cd  /tmp/raven-archive-keyring.gpg" | sha256sum -c -
            - install -m 0644 /tmp/raven-archive-keyring.gpg /etc/apt/keyrings/raven-archive-keyring.gpg
            - echo "deb [signed-by=/etc/apt/keyrings/raven-archive-keyring.gpg] https://jbearak.github.io/apt-raven stable main" > /etc/apt/sources.list.d/raven.list
            - apt-get update
            - apt-get install -y raven
            - npm install -g @jbearak/sight
            - raven packages update
            # Bitbucket fails the step at the first nonzero exit, which would
            # let a Raven finding skip Sight entirely. The "|| touch" swallows
            # raven check's exit code but records it in a marker file, sight
            # check then runs either way, and the final test fails the step
            # when the marker exists — so both checkers always report, and
            # either one failing turns the step red.
            - raven check || touch /tmp/raven-failed
            - sight check
            - test ! -f /tmp/raven-failed

triggers:
  repository-push:
    - condition: BITBUCKET_BRANCH == "main"
      pipelines:
        - Checks
  pullrequest-push:
    - condition: glob(BITBUCKET_BRANCH, "**")
      pipelines:
        - Checks
```

Bitbucket stops a step at the first failing command, so the last three lines use a marker file. `|| touch /tmp/raven-failed` swallows `raven check`'s exit code and records it as a file, so the script continues. `sight check` runs and can fail the step directly. The final `test ! -f /tmp/raven-failed` exits nonzero, failing the step, whenever the marker exists. A Raven finding still turns the step red, on the last line, after Sight has also reported. Pin versions the same way as in the Raven-only example: `apt-get install -y "raven=${RAVEN_DEB_VERSION}"` for Raven, and `npm install -g @jbearak/sight@X.Y.Z` for Sight.

To run them as **parallel steps** instead, wrap two `- step:` entries in a `- parallel:` block, one installing and running Raven and one installing and running Sight. Each step gets its own container and its own checkout, and each reports separately in the pipeline view.

## Details

<details markdown="1">
<summary>What <code>jbearak/setup-raven</code> does, and other ways to install</summary>

The [`jbearak/setup-raven`](https://github.com/jbearak/setup-raven) action installs Raven from the prebuilt GitHub Release binary for the runner platform, verifies the published SHA-256 checksum, and adds `raven` to `PATH`. It only installs: every `raven` command (`packages update` or `fetch`, `check`, `lint`) is an explicit `run:` step your workflow controls. You need neither Rust nor Cargo. It supports Linux, macOS, and Windows runners on x64 and arm64. Set `version` to a specific release tag for reproducible CLI versions.

`cargo install --git https://github.com/jbearak/raven raven` is a source build, not a binary install; keep it for Raven development or custom local builds. GitHub Actions should use `jbearak/setup-raven@v1`, and Bitbucket Pipelines and other Ubuntu CI should use the signed apt repository (see [Ubuntu installation](cli.md#ubuntu-installation)).

The apt repository is static HTTPS hosting for Debian repository metadata and `.deb` files. It is not a Docker image and does not run a remote installer script. The SHA-256 check pins the bootstrap keyring before apt trusts it, and the `signed-by=` keyring then makes apt verify Raven's repository metadata before it installs the package.

</details>

<details markdown="1">
<summary>Installing R in CI, and keeping checks offline</summary>

To get installed and local package awareness and exact local package metadata in CI, install R (for example with `r-lib/actions/setup-r`) before running `raven check`. Base R symbols are embedded in the binary even without R. Broad CRAN/Bioconductor coverage requires Raven's `names.db` database, downloaded with `raven packages update`.

Run that update step right after installing Raven. After it, `raven check`, language server startup, completion, hover, and package lookup make no network requests. `raven packages update` follows Raven's moving `names-db` Release; commit `.raven/packages.json` from `raven packages freeze` when package metadata should be pinned by the project.

</details>

<details markdown="1">
<summary>Why the Bitbucket examples set <code>clone: lfs: false</code></summary>

If the repository stores large data files in [Git LFS](https://git-lfs.com), there is no reason to download them: `raven check` reads only code, and analysis datasets can be far larger. In a repository that does not use LFS, the setting has no effect, so it is safe to keep either way. GitHub Actions needs no equivalent, because `actions/checkout` skips LFS content by default.

</details>

## See also

- [CLI](cli.md): every `raven check` and `raven lint` flag, exit code, and output format.
- [Package database](package-database.md): how Raven knows package exports without R.
- [Linting](linting.md): turn on style rules.
- [Configuration](configuration.md): share one `raven.toml` between the editor and CI.
