# Development moves: batch B

## From docs/diagnostics.md

- Issue references removed from user text (state as maintainer notes if wanted): issue #503 (namespace-member diagnostic republishes across other open documents after background package warming); issue #505 (a `::`-accurate data-member authority is a tracked follow-up; user text now says "a precise check for data members is planned").
- Internal detail dropped from user text: the namespace-member authority is "synchronous and never spawns R" (user text now: "Raven never starts R to check a member").
- Code facts the reworded page now states that came from source, not the old page (reviewers: keep in sync with `handlers.rs` collectors): `box-module-not-found` / `import-module-not-found` use `crossFile.missingFileSeverity`; `box-module-case-mismatch` always resolves `caseMismatchSeverity` with the case-sensitive regime (warning under `auto`), `import-module-case-mismatch` uses the host regime; `box-export-not-found` / `import-export-not-found` use `packages.namespaceMemberSeverity`; circular-dependency and redundant-directive diagnostics carry no code (CLI prints `[]`).
