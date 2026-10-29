# Moves into linting.md

## From docs/diagnostics.md (suppression is now single-homed there)

diagnostics.md `#suppressing-diagnostics` now holds the full suppression story, including `# nolint`, `# nolint: rules`, `# nolint start/end`, and the "which marker silences which diagnostics" matrix plus its notes (string-literal markers, typos not recognized, unterminated start, nested commented-code markers). linting.md `## Suppression matrix` can shrink to a one-line pointer (keep its heading/anchor `#suppression-matrix`).

Links from diagnostics.md into linting.md that must keep resolving: `#behavior-matrix`, `#line-length`, `#trailing-whitespace`, `#tab-characters`, `#trailing-blank-lines`, `#assignment-operator`, `#object-names`, `#object-length`, `#infix-spaces`, `#commented-code`, `#quotes`, `#commas`, `#t--f-symbol`, `#semicolon`, `#equals-na`, `#vector-logic`, `#function-left-parentheses`, `#spaces-inside`, `#indentation`.

The old diagnostics.md Style Lints prose (infix-spaces operator set, commented-code skip list, object-name NOTE) was dropped there as duplicate of linting.md's per-rule sections; make sure linting.md keeps them.
