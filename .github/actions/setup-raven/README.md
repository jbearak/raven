# Setup Raven

Installs the Raven CLI from prebuilt release binaries. This action verifies the
published SHA-256 checksum and adds `raven` to `PATH`. It installs the binary and
nothing else: every `raven` command — `packages update`/`fetch`/`freeze`,
`check`, `lint` — is a `run:` line your workflow owns.

```yaml
- uses: jbearak/setup-raven@v1
  with:
    version: latest
- run: raven packages update   # broad R-free CRAN/Bioconductor coverage
- run: raven check
```

Inputs:

- `version`: `latest` or a release tag. Defaults to `latest`.

Supported runners are Linux and macOS on x64 or arm64, matching the
release assets tested by this action. Windows binaries are still published,
but Windows GitHub Actions runners are not a v1 target.

Provisioning package metadata is left to your workflow: `raven packages update`
downloads Raven's broad package-symbol database, `raven packages fetch` creates
an ephemeral project-scoped `.raven/packages.json` from CRAN/Bioconductor
r-universe, and a committed `.raven/packages.json` from `raven packages freeze`
is the reproducible project-specific option.
