# Docs redesign: implementation plan

Date: 2026-10-29. Status: plan, revision 1.

This plan implements `docs/superpowers/specs/2026-10-29-docs-redesign-design.md` (revision 4, approved by Terra and Sonnet; referred to as "the design" and cited by §). Everything ships as one PR from branch `t3/62f5ff83`, reviewed with sol-loop and merged by squash, the repo's only allowed method. Steps are ordered so that guards exist before content changes. Phases 1–3 build the tooling, Phase 4 rewrites content, and Phases 5–8 verify and ship.

## Phase 0: Setup

1. Commit the design, the prior-art notes, and this plan.
2. Record the base commit (`git merge-base HEAD origin/main`) as `BASE`. Every "pre-redesign" artifact is computed from `BASE`, never from the working tree.
3. Confirm the toolchains:
   - rustup 1.96.0 is first on PATH (Homebrew cargo shadows it).
   - bun works.
   - `uv` is available with `UV_CACHE_DIR=$TMPDIR/uvcache`.
   - Use a separate `CARGO_TARGET_DIR` for this worktree.

## Phase 1: Baselines (before any content edit)

1. **Anchor baseline (design §4.1).** Write `scripts/docs/anchor-baseline.mjs`.
   - It reads the `BASE` versions via `git show BASE:<path>` of:
     - README.md
     - editors/vscode/README.md
     - every user page in the design §3.1 manifest that exists at `BASE`
   - It emits `tests/bun/fixtures/docs-anchor-baseline.json`, a map of `file → [slugs]`. That covers all heading slugs with GitHub duplicate suffixes, plus any explicit `<a id|name>`.
   - It also adds every `docs/*.md#anchor` referenced from `crates/`, `editors/`, `scripts/`, `tests/`, and `.github/` at `BASE`.
   - The fixture is committed and never regenerated, so it is frozen. The script exists only for provenance.
2. **Manifest.** Create `docs/user-pages.json` exactly as in design §3.1. Fields:
   - `site_url`
   - `groups[]`, each `{title, pages:[{file, title, description, kind: "guide"|"reference"|"hub"}]}`
   - `internal[]` globs
   - `readmes[]`
3. **Content ledger skeleton (§5.4).** A script lists every H2/H3 of every user page at `BASE` into `docs/superpowers/specs/2026-10-29-docs-content-ledger.md`. It has one table per page, with the columns `section | disposition | destination`, left blank. Known violations go in up front: issue numbers, source paths, first person, `comparison.md` line-range links, and the `cli.md` maintainer appendix.
4. **Findability baseline (§6c).** Run the 20-task persona set against `BASE` docs, using GitHub URLs pinned to the `BASE` SHA, and record the results in `docs/superpowers/specs/2026-10-29-docs-acceptance.md`. This runs as background agents (see Phase 7 for the agent protocol) while Phases 2–4 proceed.

## Phase 2: Guards and generators (Bun + scripts)

All tests live under `tests/bun/docs/`, with shared helpers in `tests/bun/docs/_lib/`. During Phase 4, the lints that the rewrite is meant to satisfy run in report mode via `DOCS_LINT_REPORT=1`, which prints violations and does not fail. **No report-mode switch exists in CI.** The final commit has every test gating.

1. **`_lib/markdown.ts`**: a fence-aware line scanner that returns:
   - headings, links, `<a id|name>` anchors
   - fenced blocks with their info string and the preceding HTML comment
   - paragraphs, excluding tables, code, `<details>` bodies, and blockquotes that are GitHub alerts (which still count as paragraphs)
2. **`_lib/slug.ts`**: GitHub slugger. It lowercases, strips punctuation except `-` and `_`, maps spaces to `-`, and adds `-1`/`-2` duplicate suffixes. Unit test `slug.test.ts` uses fixture headings with known GitHub slugs: backticks, `&`, `/`, `.`, emoji/Unicode, and duplicates.
3. **`docs-links.test.ts` (§4.2)** resolves:
   - relative links and anchors in manifest pages, both READMEs, `llms.txt`, and `docs/README.md`
   - `https://github.com/jbearak/raven/blob/main/<path>#anchor` and `raw.githubusercontent.com/jbearak/raven/main/<path>` URLs in those files, plus `crates/`, `editors/`, and `scripts/`, mapped to local files
   - `<a id>` as valid targets
4. **`docs-anchor-baseline.test.ts` (§4.1)**: every baseline `file#slug` still resolves in the current file.
5. **`docs-examples.test.ts` (§5.1 binding)**:
   - `<!-- example: name [file=…] [stream=stdout|stderr|both] -->` blocks equal the corpus files, with `{{version}}` substituted from `crates/raven/Cargo.toml`.
   - The no-silent-escape detector (all §5.1 patterns, case-insensitive message prefixes) fails on unmarked, unexempted blocks.
   - The detector is exported, and `docs-escape-detector.test.ts` unit-tests it with positive and negative fixtures:
     - spaces in paths, `note`, non-kebab codes, `Error: raven check: unknown flag`
     - the `1 issues (…)` summary, `Usage: raven`, `raven 0.21.1`
     - diagnostics JSON and SARIF
     - negatives: settings JSON, `raven.toml`, R code containing `error:`
6. **`docs-lints.test.ts` (§5.3)** checks rules by page class from the manifest `kind`, with README provenance and license exempt:
   - no issue numbers, source paths, or first person
   - breadcrumb, H1, and lead sentence
   - guide-template section order: Settings, Limitations, Details, See also, each optional but in order
   - no duplicate headings
   - paragraphs ≤150 words
   - table cells ≤40 words, as a warning list printed but not failing (the design says target)
   - image alt text and file existence
   - hub coverage
7. **`scripts/generate-docs-hub.mjs`** reads the manifest and writes three things:
   - `docs/README.md`, the hub, with a site link only if `site_url` is non-empty
   - root `llms.txt`, with absolute `blob/main` URLs
   - the nav block of `docs/site/zensical.toml`

   It also has a `--check` mode, and `docs-hub-drift.test.ts` runs that mode.
8. **`docs-readme-parity.test.ts`**: the set of `docs/*.md` targets linked from the "What you get" section of README.md equals the set linked from the matching section of editors/vscode/README.md, normalized to repo-relative paths.
9. **settings-reference generator.** `generate-settings-reference.mjs` emits the breadcrumb, a lead sentence, and a See also section. Regenerate the file and update `tests/bun/settings-reference.test.ts` for the new header lines, keeping every existing assertion, including the `workspace.respectGitignore` row.
10. **apt-packaging test.** `tests/bun/apt-packaging.test.ts:133–138` retargets the CI-heading assertions from `docs/cli.md` to `docs/ci.md`. The test also asserts that `docs/cli.md` still contains the legacy anchors `ci-examples`, `github-actions-example`, and `bitbucket-pipelines-example` (as headings or `<a id>`).

## Phase 3: Executable examples (Rust harness)

1. **`crates/raven/tests/docs_examples.rs`**, per design §5.1:
   - It uses `env!("CARGO_BIN_EXE_raven")`, `tempfile`, and `toml` (already dependencies).
   - It iterates `docs/examples/snippets/*/`.
   - For each example: copy it to a tempdir, run the ancestor-config assertion, write the forced-config `raven.toml` (failing if the example sets `packages.enabled`), and run with a cleared env plus `NO_COLOR`, `PATH=/usr/bin:/bin`, and `HOME`/`XDG_*` set to the tempdir.
   - Compare stdout, stderr, and exit, with `{{version}}` substitution.
   - With `UPDATE_DOCS_EXAMPLES=1`, rewrite the expected files, restoring the `{{version}}` token.
   - It reports all mismatches with a diff, not just the first.
   - A `base_symbols_resolve_without_r` test checks `paste`, `mean`, `data.frame`, and `lapply` in an example with `packages.enabled = false`.
2. **Seed corpus** (each a directory with `cmd`, files, `stdout.txt`, `stderr.txt`, and `exit`):
   - `readme-demo`
   - `getting-started-before` and `getting-started-after`
   - `lint-config` (`raven.toml` enabling a lint rule, run with `lint .`)
   - `check-json` (`check --format json .`; if absolute paths appear, the example is replaced by an exempted block, and the plan records that)
   - `check-help`
   - `version`
   - `usage-error` (`check --bogus`, stderr, exit 1)
   - `exit-on-errors-only` (`check --max-severity warning .`)
   - one `diag-<code>` per diagnostic code the CLI can produce from a self-contained workspace

   The design §3.4 / diagnostics phase decides which codes are CLI-producible. The rest get exempt reasons.
3. The harness runs under the normal `cargo test` CI job. Run fmt, clippy (`--all-targets --features test-support -D warnings`), and rustdoc locally on the pinned toolchain.

## Phase 4: Content rewrite

**Shared brief.** Every writer, whether me or a subagent, gets the same brief:

- design §2, §3.4, §3.5, §4, §5.1, and §5.3
- the ledger
- the anchor rules: never remove a baseline slug. When a heading changes or content moves, leave `<a id="old-slug"></a>` at the relevant content, or on a one-line pointer to its new home.
- the unslop writing rules: plain, specific, no AI tells
- run `DOCS_LINT_REPORT=1 bun test tests/bun/docs` on your pages until clean

**Facts must be preserved.** Writers may cut duplication and internals. They must not change claims about behavior. When unsure, keep the claim and move it to Details.

**Conflict avoidance.** Agents run concurrently in the shared checkout on **disjoint file sets**. The two shared files are handled through staging:

- The ledger: each batch writes `docs/superpowers/specs/ledger/<batch>.md`, and I merge them into the ledger.
- development.md: each batch writes `docs/superpowers/specs/dev-moves/<batch>.md`, and I merge them into a new "Internals moved from user docs" section, or the matching existing section.

Agents don't commit. I review each batch's diff before the next phase.

**Batches.** Each batch is one subagent (Claude Opus via the Agent tool) unless noted.

| Batch | Pages | Notes |
|---|---|---|
| A (me) | README.md, editors/vscode/README.md, getting-started (new), faq (new), coming-from (new), troubleshooting (new) | Landing pages are the highest-stakes surface; I write them after B–G land so the links and claims are final |
| B | diagnostics.md | Codes reference with the fixed template, one recipes table, single home of suppression. Also builds the `diag-<code>` corpus and decides which codes are CLI-producible. Moves long semantic lists per design §3.4 to cross-file.md / non-standard-evaluation.md *by writing staged insert files* `docs/superpowers/specs/moves/<target>.md`, which batch C integrates |
| C | cross-file, directives, non-standard-evaluation, modules, rprofile, r-package-dev, cross-file-analysis-performance | Starts after B finishes, to integrate B's staged moves |
| D | cli, ci, configuration, package-database, linting | Moves CI templates to ci.md and the maintainer appendix to dev-moves; configuration stops re-tabulating settings |
| E | editor-integrations, completion, hover, go-to-definition, find-references, document-outline, syntax-highlighting, snippets, indentation | editor-integrations per design §3.4: per-editor template, verify steps, feature matrix; snippets are checked for syntax (Phase 2 adds `docs-snippet-syntax.test.ts`: JSON/TOML parse; Lua via `luac -p` if present, else skip) |
| F | r-console, debugger, plot-viewer, data-viewer, help-viewer, chunks, knit, quarto, keybinding-comparison | Activation explained only by a link to coexistence; help-viewer smoke plan goes to dev-moves; update the comment in `editors/vscode/src/test/help-viewer.test.ts` |
| G | comparison, coexistence, limitations | Single home of `raven.rConsole.activation`; no source-line links into other projects |

**Wave order.** B, D, E, F, and G run in parallel, then C, then A.

**After each wave, I:**

- review diffs against the ledger, looking for dropped facts
- merge the staging files
- run the full docs suite in report mode

**Last steps of Phase 4:**

- Update the code comments that cite moved docs sections, e.g. the `knit/post-knit-renderer.ts:227` "Fonts" section and `help-viewer.test.ts:9`. Runtime URLs stay unchanged.
- Update CLAUDE.md "What to read" with the new pages (getting-started, coming-from, troubleshooting, faq) and the hub.
- Delete the staging directories.
- Flip all lints to gating and make them green.

## Phase 5: Docs site

1. Add these under `docs/site/`:
   - `zensical.toml`, configured as in the 2026-10-29 spike: `github-callouts`, `md_in_html`, `admonition`, `attr_list`, `tables`, `toc` with `pymdownx.slugs.slugify(case="lower")`, and `docs_dir = "../"` with `exclude_docs` for internal pages, or the Zensical equivalent
   - `requirements.txt`, with hashes generated by `uv pip compile --generate-hashes` and a header recording the spike date and versions
   - `search-check.mjs`, which asserts the four search terms hit their pages in the built `search.json`
2. **Pages that link outside `docs/`** (README, `demo/`, LICENSE) use absolute GitHub URLs, as design §7 requires. The link test already resolves those to local files.
3. **`.github/workflows/docs.yml`**:
   - The `build` job runs on `pull_request` for the paths `docs/**`, `README.md`, and `editors/vscode/README.md`, and on `push: main`. It uses `uv` to install the pinned requirements, then runs `zensical build --strict` and the search check. Permissions: `contents: read`.
   - The `deploy` job runs on `push: main` only and needs `build`. It runs `actions/upload-pages-artifact` and `actions/deploy-pages`. Permissions: `pages: write`, `id-token: write`, `contents: read`. It runs in the `github-pages` environment.
   - Action versions are pinned by SHA, matching the repo's convention if one exists. Otherwise major tags are used, as in `integration.yml`.
4. **Pages enablement.** This is a decision recorded for the owner: before merge, run `gh api -X POST repos/jbearak/raven/pages -f build_type=workflow`.
   - It is reversible and publishes already-public content.
   - If the API refuses (permissions), apply the design §7 fallback: an empty `site_url`, the workflow dropped, the gap recorded.
   - `site_url` is set to the Pages URL only after enablement succeeds.
5. Verify locally:
   - The strict build passes.
   - The search check passes.
   - Load the built site in a browser (preview tools) and check the hub, a long page with `<details>`, an alert, and a legacy `<a id>` anchor.

## Phase 6: Editor verification and visuals

1. **`editors/vscode/src/test/getting-started.test.ts` (§5.2).**
   - Fixture: copy `getting-started-before` into `editors/vscode/src/test/fixtures/getting-started/` via a pretest copy step, so there is a single source of truth; or point the test at the corpus path directly if the vscode-test workspace config allows it.
   - It asserts each step:
     - the warning appears
     - applying the documented edit clears it
     - go-to-definition lands in `helpers.R`
     - hover mentions `helpers.R`
   - Use `awaitActive(editor)` per CLAUDE.md.
   - Locally, this suite doesn't complete over SSH (memory note), so it is proven in CI. The test is written so a failure message names the tutorial step.
2. **`scripts/fresh-install-check.sh` (§5.2).** It does three things:
   - `bun run package`: builds the VSIX with the bundled binary
   - installs it into empty `--extensions-dir` and `--user-data-dir` with a PATH that has no `raven` or R
   - runs `getting-started.test.ts` through `@vscode/test-electron` with a stub `extensionDevelopmentPath` (`scripts/fresh-install-stub/package.json`)

   Run it once on macOS. If the Electron run can't complete locally (the SSH display limitation), run it in a one-off `workflow_dispatch` job on the PR branch (`.github/workflows/fresh-install.yml`, manual trigger, ubuntu + xvfb). Record its output in the PR.
3. **Screenshots (§8).**
   - Run `code serve-web --without-connection-token --port <free>` with a fresh server data dir and the VSIX installed (`--install-extension` through the server CLI).
   - Open it with the T3 preview browser, open the tutorial workspace, and capture three screenshots:
     - the squiggle with its hover
     - the go-to-definition peek
     - the debugger at a breakpoint (needs R; if R or the debugger can't run in serve-web, ship two screenshots and record why)
   - Save them as PNGs in `docs/images/`, with alt text, a version caption, and reproduction steps in development.md.
   - Marketplace README images use `raw.githubusercontent.com/.../main/docs/images/...`, which the link test maps to local files.
   - Fallback per §8: if serve-web capture fails, ship no images, keep the steps in development.md, and open a tracking issue.

## Phase 7: Review and acceptance

1. **Local gates:**
   - `cargo fmt --all --check`
   - clippy, with the CI command
   - rustdoc in both feature configs
   - `cargo test -p raven --test docs_examples`
   - `bun test` (root)
   - `node editors/vscode/scripts/generate-settings-reference.mjs --check`
   - `vsce package` once, to be sure the Marketplace README with HTML comments packages cleanly
   - the zensical strict build
2. **sol-loop** (required by full-send): up to 3 rounds with the latest GPT Sol on the full diff against `origin/main`. Brief scope: the docs rewrite, guards, harness, site, and tests. Fix blockers and shoulds; decline nits with reasons.
3. **Push the branch** so the personas can browse branch-pinned GitHub URLs.
4. **Acceptance review (§6).** Fresh general-purpose subagents, five personas with four tasks each, given only the start URL (`https://github.com/jbearak/raven/blob/<head-sha>/README.md`) and WebFetch. Each records clicks, searches, path, answer, and confidence.
   - The site isn't deployed before merge, so Raven is gated on the **two-click route only**, which is the stricter route. It does not rely on search.
   - Comparator runs use each tool's live docs under the same rules.
   - I spot-check every failure and ≥25% of passes against the docs, and re-run marginal results twice.
   - Failures are fixed (back to Phase 4 for the affected pages), followed by a re-run of affected tasks, until criteria (a) and (b) hold.
   - Results are written to `docs/superpowers/specs/2026-10-29-docs-acceptance.md` and summarized in the PR.
5. **Unslop pass** on the README, Marketplace README, and the four new pages.

## Phase 8: PR, CI, merge

1. Rebase on `origin/main` and rerun the gates after any conflict. Run the file-pr skill. The title follows repo conventions, e.g. `docs: rebuild the user docs around a getting-started path, a hub, and tested examples`. The description includes:
   - the problem and the approach
   - the acceptance table
   - the fresh-install result
   - one line on how it was proven
   - the decisions list (Pages enablement)
   - the `Reviewed with sol-loop` line
   - the model attribution
2. Link the PR to this thread, watch it, and babysit:
   - Fix CI failures and real bot findings, with proof for each, and push with `--force-with-lease` after a rebase.
   - Docs CI (`docs.yml`) is not required, but it must be green before merge.
3. **Merge gate (full-send):**
   - required checks green
   - bots done and every finding handled
   - the branch up to date and mergeable
   - squash merge
4. **After merge:**
   - Confirm the `docs.yml` deploy succeeded and the site loads.
   - Run the search route spot-check (three tasks, one search each).
   - If the deploy fails, fix it in a follow-up PR the same session.
5. **Report**: the PR link, merge commit, proof, and decisions.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A writer drops a behavioral fact | Ledger review after each wave; "keep and move to Details" rule; reviewers see the ledger |
| Anchor breakage in old binaries or Marketplace | Frozen baseline test; runtime URL tests unchanged |
| Example flakiness | Isolated harness; base-only symbols; Linux CI + macOS local |
| The PR is huge to review | One concern per commit, in this order: guards, harness, then each content batch, then site, then visuals. The PR description gives the ledger and acceptance results as review aids |
| Zensical (0.0.x) churn | Pinned with hashes; the site is non-required CI; the sources don't depend on it |
| Pages can't be enabled | Design §7 fallback, decided at Phase 5.4 |
| vscode-test can't run locally | CI proves `getting-started.test.ts`; fresh-install runs via workflow_dispatch |
