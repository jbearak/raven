# CLI

Raven ships a single binary that serves the LSP via stdio *and* exposes a `lint` subcommand for use outside an editor.

## `raven lint`

Run the native style linter against one or more paths and exit with a code suitable for CI gating.

```text
raven lint [OPTIONS] [PATHS...]
```

### Options

- `--config PATH` — explicit path to a `raven.toml` (default: walk upward from CWD).
- `--no-config` — ignore `raven.toml` and `.lintr`; use Raven's built-in defaults.
- `--format text|json|sarif` — default `text`.
- `--max-severity off|hint|info|warning|error` — highest severity that does **not** fail the build (default `info`). With Raven's all-`hint` default severities, a vanilla `raven lint .` exits 0; raise rules to `warning` in `raven.toml` to gate CI.
- `--quiet` — suppress the trailing summary line.
- `--no-color` — disable ANSI colors (auto-detected on TTY).

### Exit codes

- `0` — no diagnostic exceeded `--max-severity`.
- `1` — at least one diagnostic exceeded `--max-severity`.
- `2` — operator error (config parse failure, unreadable path, invalid flag).

### Output formats

- `text` — `path:line:col level: message [rule]`, one per line.
- `json` — array of `{ path, diagnostic }` objects (`diagnostic` is a verbatim LSP `Diagnostic`).
- `sarif` — SARIF 2.1.0 envelope. Tool name `raven`; `ruleId` from `Diagnostic.code`.

### GitHub Actions example

```yaml
- name: Lint R sources
  run: |
    cargo install --git https://github.com/jbearak/raven raven
    raven lint --format sarif R/ tests/ > raven.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: raven.sarif
```

### Scope

`raven lint` runs the native style linter only. Cross-file, undefined-variable, and package diagnostics need a workspace scan and are LSP-only.
