# Demo Workspaces

Each subfolder can be opened as a VS Code workspace to manually smoke-test Raven features.

## Subfolders

### `completions/`
Demonstrates intelligent autocomplete: variable, function, package, accessor (`$`), and parameter completions.

### `diagnostics/`
Demonstrates Raven's diagnostic capabilities:

- `01_undefined_variable.R` — Undefined variable detection (typos caught before running)
- `02_forward_reference.R` — Out-of-scope / forward reference warning
- `03_syntax_error.R` — Syntax error detection (missing paren, unmatched brace)
- `04_orchestrator.R` → `05_analysis.R`, `06_output.R` — Cross-file scope-aware diagnostics: child files use parent-defined symbols without false positives, but truly undefined variables are still flagged

### `navigation/`
Demonstrates cross-file go-to-definition and find-references:

- `01_main.R` — Defines `normalize` and `compute_score`, sources children
- `02_prepare.R` — Uses `normalize`; Cmd-click jumps to definition in 01_main.R
- `03_model.R` — Uses `compute_score` and `scaled`; find-references shows all usages

### `package-mode/`
Demonstrates R package mode. Contains a `DESCRIPTION` file that triggers mutual visibility between `R/` files and one-way visibility from `tests/testthat/` into `R/`.

- `R/utils.R` — defines `validate_input`
- `R/analysis.R` — uses `validate_input` (no diagnostic expected)
- `R/boundary.R` — references `test_only_helper` (diagnostic expected — tests/ symbols aren't visible from R/)
- `tests/testthat/test-analysis.R` — uses `run_analysis` from R/ (no diagnostic expected)

### `linting-raven-toml/`
Demonstrates linting configured via `raven.toml`. Open this folder and check that `lint_violations.R` shows lint diagnostics.

### `linting-lintr/`
Demonstrates linting configured via `.lintr`. Same violations file, different config mechanism.

### `linting-vscode-settings/`
Demonstrates linting configured via `.vscode/settings.json`. Same violations file, VS Code settings approach.

### `rmarkdown-quarto/`
Demonstrates chunk detection in R Markdown and Quarto files.

- `analysis.Rmd` — R Markdown with multiple R chunks
- `report.qmd` — Quarto document with R chunks using `#|` options

### `data-viewer-smoke.R`
Manual smoke tests for the data viewer (large frames, labels, copy, scrolling). Run sections interactively in the R console.

## Automated Coverage

The mocha integration tests in `editors/vscode/src/test/` exercise the same scenarios programmatically:

- `package-mode.test.ts` — package mode visibility and boundary
- `linting-config.test.ts` — lint diagnostics with `raven.toml` in the workspace
- `rmarkdown-quarto.test.ts` — chunk detection on .Rmd and .qmd files
- `data-viewer.test.ts` — data viewer panel lifecycle and scrolling
