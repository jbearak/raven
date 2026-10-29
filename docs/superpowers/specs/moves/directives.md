# Moves into directives.md

## From docs/diagnostics.md (suppression is now single-homed there)

diagnostics.md `#suppressing-diagnostics` now carries the full ignore syntax (line/next-line, `[code]` selector, file and block forms, `expect` flavor, chunk pointer, `@lsp-` aliases). directives.md `## Ignore Directives` can become a short table of the forms with a link to `diagnostics.md#suppressing-diagnostics` (keep its anchor `#ignore-directives`). The Stan-specific note (ignore directives suppress only Stan `undefined-variable`; a trailing `# raven: ignore` keeps the Stan code before it parsed) is in diagnostics.md `#stan-undeclared-variables` and `#jags-and-stan-parse-errors`.
