# Notes for cli.md (batch D)

## Corpus examples created by batch B

- `usage-error` (`check --bogus`): stdout empty, stderr `Error: raven check: unknown flag: --bogus`, exit 1. Show with `stream=stderr`.
- `version` (`--version`): `raven {{version}}`, exit 0.
- `check-help` (`check --help`): full help text, exit 0.
- `check-json` (`check --format json .`): workspace `analysis.R` with a `scroes` typo; one JSON diagnostic, exit 1.
- `exit-on-errors-only` (`check --max-severity warning .`): same workspace; one warning, exit 0.

Bind them with `<!-- example: <name> -->` and copy `stdout.txt` exactly (the Bun test currently reports cli.md blocks at lines ~79/151/495 differing from these).
