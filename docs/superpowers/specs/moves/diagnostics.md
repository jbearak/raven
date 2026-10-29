# Moves into docs/diagnostics.md

## From docs/chunks.md (batch F)

Chunk-level suppression stays documented on chunks.md, because it is a chunk option. Suggestion for diagnostics.md's suppression recipes table: add a row "Silence a whole R Markdown / Quarto chunk" linking `chunks.md#suppressing-diagnostics-in-a-chunk`. The two forms are the knitr option `raven.ignore=TRUE` (or `raven.ignore="code1, code2"`) in the chunk header and the `# raven: ignore-chunk` / `# raven: ignore-chunk[code]` directive in the chunk body.
