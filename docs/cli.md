# CLI

Raven ships a single binary that serves the LSP via stdio *and* exposes a `lint` subcommand for use outside an editor. This page documents `lint`. The binary also has an `analysis-stats <path> [--csv] [--only <phase>]` subcommand for profiling workspace analysis phases (`scan`, `parse`, `metadata`, `scope`, `packages`); see `raven --help` for the current invocation.

## `raven lint`

Run the native style linter against one or more paths and exit with a code suitable for CI gating.

```text
raven lint [OPTIONS] [PATHS...]
```

### Options

- `--config PATH` — explicit path to a `raven.toml` (default: walk upward from CWD, discovering a `raven.toml` or `.lintr`).
- `--no-config` — ignore `raven.toml` and `.lintr`; use Raven's built-in defaults.
- `--format text|json|sarif` — default `text`.
- `--max-severity off|hint|info|warning|error` — highest severity that does **not** fail the build (default `info`). Linting is opt-in: with no `raven.toml` / `.lintr` discovered (or under `--no-config`) the linter is disabled and emits no diagnostics, so `raven lint .` exits 0. A discovered config enables rules; raising any to `warning` or `error` is what then gates CI.
- `--quiet` — suppress the trailing summary line.
- `--no-color` — accepted for forward compatibility. `text` output is currently uncolored regardless, so this flag has no visible effect yet.

### Exit codes

- `0` — no diagnostic exceeded `--max-severity`.
- `1` — at least one diagnostic exceeded `--max-severity`.
- `2` — operator error detected while running (config parse failure, unreadable or missing path). An unknown flag is a usage error and exits `1`.

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

Only plain R files (`.R` / `.r`) are linted. R Markdown / Quarto files (`.Rmd` / `.qmd`) are skipped with a one-line note on stderr — chunk extraction isn't supported on the command line — and other file types are ignored silently. Passing a directory walks it recursively for R files.
