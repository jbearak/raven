<!-- What problem does this solve, and how? Lead with the user-visible effect. -->

## Checklist

- [ ] CI gates pass locally: `cargo fmt --all --check`, clippy with `-D warnings`, rustdoc, `bun test` (see AGENTS.md).
- [ ] User-visible behavior changed? The matching page under `docs/` is updated (`docs/README.md` lists them all).
- [ ] Changed a user doc page? Re-checked its row in the "Docs verification" table in `docs/development.md`.
- [ ] Changed CLI output? Ran `UPDATE_DOCS_EXAMPLES=1 cargo test -p raven --test docs_examples` and reviewed the diff and the pages that show it.
- [ ] Added or renamed a setting? Followed the VS Code settings-sync steps in AGENTS.md and regenerated `docs/settings-reference.md`.
