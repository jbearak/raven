# Docs redesign: implementation plan

Date: 2026-10-29. Status: plan, revision 2 (addresses round-1 reviews by Terra and Sonnet; see the table at the end).

This plan implements `docs/superpowers/specs/2026-10-29-docs-redesign-design.md` (revision 4, approved by Terra and Sonnet; referred to as "the design" and cited by §). Everything ships as one PR from branch `t3/documentation-redesign`, reviewed with sol-loop and merged by squash, the repo's only allowed method. Steps are ordered so that guards exist before content changes. Phases 1–3 build the tooling, Phase 4 rewrites content, and Phases 5–8 verify and ship.

## Phase 0: Setup

1. Commit the design, the prior-art notes, and this plan.
2. Record the base commit (`git merge-base HEAD origin/main`) as `BASE`. Every "pre-redesign" artifact is computed from `BASE`, never from the working tree.
3. Confirm the toolchains:
   - rustup 1.96.0 is first on PATH (Homebrew cargo shadows it).
   - bun works.
   - `uv` is available with `UV_CACHE_DIR=$TMPDIR/uvcache`.
   - Use a separate `CARGO_TARGET_DIR` for this worktree. Only the orchestrator and Batch B run cargo. Corpus updates (`UPDATE_DOCS_EXAMPLES=1`) are serialized through them, so concurrent batches never contend on the cargo lock.

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

All tests live under `tests/bun/docs/`, with shared helpers in `tests/bun/docs/_lib/`.

**Gating from the first commit:** the anchor-baseline test, the link test, the slug and escape-detector unit tests, settings-reference, and apt-packaging. Every commit on the branch keeps these green.

**Report mode during Phase 4:** the content lints that the rewrite is meant to satisfy (`docs-lints`, `docs-examples` binding/escape, hub drift, README parity) run in report mode via `DOCS_LINT_REPORT=1`, which prints violations and does not fail. **No report-mode switch exists in CI.** The image-existence lint can't pass until images exist, so it becomes gating in Phase 6 (§Phase 6.3). The final commit has every test gating.

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
   - **site-compatibility rules (design §7)**:
     - every `<details>` is written `<details markdown="1">`
     - links that leave `docs/` (to the README, `demo/`, LICENSE, `editors/`) are absolute `https://github.com/jbearak/raven/blob/main/...` URLs
     - the exceptions are the root README and editors/vscode/README.md, whose links into `docs/` stay relative in the root README (so branch-pinned review works) and absolute in the Marketplace README (required by the Marketplace)
7. **`scripts/generate-docs-hub.mjs`** reads the manifest and writes three things:
   - `docs/README.md`, the hub, with a site link only if `site_url` is non-empty
   - root `llms.txt`, with absolute `blob/main` URLs
   - the nav block of `docs/site/zensical.toml`

   It also has a `--check` mode, and `docs-hub-drift.test.ts` runs that mode.
8. **`docs-snippet-syntax.test.ts`**: every ```` ```json ```` and ```` ```toml ```` block in manifest pages parses (JSONC comments allowed for VS Code `settings.json` snippets). Every ```` ```lua ```` block passes `luac -p` when `luac` is on PATH and is skipped otherwise.
9. **`docs-readme-parity.test.ts`**: the set of `docs/*.md` targets linked from the "What you get" section of README.md equals the set linked from the matching section of editors/vscode/README.md, normalized to repo-relative paths.
10. **settings-reference generator.** `generate-settings-reference.mjs` emits the breadcrumb, a lead sentence, and a See also section. Regenerate the file and update `tests/bun/settings-reference.test.ts` for the new header lines, keeping every existing assertion, including the `workspace.respectGitignore` row.
11. **apt-packaging test.** `tests/bun/apt-packaging.test.ts:133–138` retargets the CI-heading assertions from `docs/cli.md` to `docs/ci.md`. The test also asserts that `docs/cli.md` still contains the legacy anchors `ci-examples`, `github-actions-example`, and `bitbucket-pipelines-example` (as headings or `<a id>`).

## Phase 3: Executable examples (Rust harness)

1. **`crates/raven/tests/docs_examples.rs`**, per design §5.1:
   - It uses `env!("CARGO_BIN_EXE_raven")`, `tempfile`, and `toml` (already dependencies).
   - It iterates `docs/examples/snippets/*/`.
   - For each example: copy it to a tempdir, run the ancestor-config assertion, write the forced-config `raven.toml` (failing if the example sets `packages.enabled`), and run with a cleared env plus `NO_COLOR`, `PATH=<tmp>/bin` (an empty directory, since the binary is invoked by absolute path and needs no tools), and `HOME`/`XDG_*` set to the tempdir. No R is reachable even on CI images that install it.
   - Compare stdout, stderr, and exit, with `{{version}}` substitution.
   - With `UPDATE_DOCS_EXAMPLES=1`, rewrite the expected files, restoring the `{{version}}` token.
   - It reports all mismatches with a diff, not just the first.
   - A `base_symbols_resolve_without_r` test checks `paste`, `mean`, `data.frame`, and `lapply` in an example with `packages.enabled = false`.
2. **Seed corpus** (each a directory with `cmd`, files, `stdout.txt`, `stderr.txt`, and `exit`):
   - `readme-demo`
   - `getting-started-before` and `getting-started-after`
   - `lint-config` (`raven.toml` enabling a lint rule, run with `lint .`)
   - `check-json` (`check --format json .`; verified on 2026-10-29 that JSON paths are workspace-relative, so the output is deterministic and asserted)
   - `check-help`
   - `version`
   - `usage-error` (`check --bogus`, stderr, exit 1)
   - `exit-on-errors-only` (`check --max-severity warning .`)
   - one `diag-<code>` per diagnostic code the CLI can produce from a self-contained workspace

   Batch B decides which codes are CLI-producible. Each code it can't produce gets an `example-exempt` reason in diagnostics.md and a ledger row naming the reason (e.g. "needs an installed package", "editor-only tab scoping").
3. The harness runs under the normal `cargo test` CI job. Run fmt, clippy (`--all-targets --features test-support -D warnings`), and rustdoc locally on the pinned toolchain.

## Phase 4: Content rewrite

**Shared brief.** Every writer, whether me or a subagent, gets the same brief:

- design §2, §3.4, §3.5, §4, §5.1, and §5.3
- the ledger
- the site-authoring rules (design §7): write `<details markdown="1">`; links that leave `docs/` are absolute GitHub URLs; no duplicate headings in a page
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
- Update `AGENTS.md` (`CLAUDE.md` is a symlink to it) "What to read" with the new pages (getting-started, coming-from, troubleshooting, faq) and the hub. Check `CONTEXT.md` for docs references and update any that moved.
- Add to `docs/development.md`:
  - a **"Docs verification" table** (design §5.2) with one row per editor-only page: the claim area, then how it is verified (a named VS Code integration test, a named Rust LSP test, or the manual `demo/` procedure)
  - a **"Docs tooling" section**: the corpus and harness, `UPDATE_DOCS_EXAMPLES`, the lints, the hub generator, the site build, `scripts/fresh-install-check.sh`, and the screenshot reproduction steps
- Create `.github/pull_request_template.md` (none exists). It holds a short checklist, including: "If you changed a user-facing doc page, re-check its row in the Docs verification table in docs/development.md" and "If you changed CLI output, run `UPDATE_DOCS_EXAMPLES=1 cargo test --test docs_examples` and review the diff".
- Delete the staging directories.
- Flip all lints except image existence to gating, and make them green. Image existence flips in Phase 6.3.

## Phase 5: Docs site

1. Add these under `docs/site/`:
   - `zensical.toml`, configured as in the 2026-10-29 spike: `github-callouts`, `md_in_html`, `admonition`, `attr_list`, `tables`, `toc` with `pymdownx.slugs.slugify(case="lower")`, and `docs_dir = "../"` with `exclude_docs` for internal pages, or the Zensical equivalent
   - `requirements.txt`, with hashes generated by `uv pip compile --generate-hashes` and a header recording the spike date and versions
   - `search-check.mjs`, which asserts the four search terms hit their pages in the built `search.json`
2. **Pages that link outside `docs/`** (README, `demo/`, LICENSE) use absolute GitHub URLs, as design §7 requires. The link test already resolves those to local files.
3. **`.github/workflows/docs.yml`**:
   - The `build` job runs on `pull_request` for the paths `docs/**`, `README.md`, `editors/vscode/README.md`, and `.github/workflows/docs.yml`, and on `push: main`. It uses `uv` to install the pinned requirements, then runs `zensical build --strict` and the search check. Then, on `push: main` only, it uploads the site with `actions/upload-pages-artifact`. Permissions: `contents: read`.
   - The `deploy` job runs on `push: main` only, `needs: build`, and has `if: vars.DOCS_PAGES_ENABLED == 'true'`, so it is skipped (not red) while Pages is off. It runs `actions/deploy-pages` on the artifact the build job uploaded. Permissions: `pages: write`, `id-token: write`. It runs in the `github-pages` environment.
   - Actions use major-version tags, matching `integration.yml`.
4. **Pages enablement is not done by the agent.** Changing repo settings is outside the authority this task was given. The PR therefore ships the design §7 fallback configuration:
   - `site_url` is empty, so the hub, README, and `llms.txt` emit no site links.
   - Acceptance gates on the two-click route.
   - The strict site build still runs on PRs as an extra link and render check.

   The final report gives the owner the two steps to switch the site on:
   - `gh api -X POST repos/jbearak/raven/pages -f build_type=workflow` plus `gh variable set DOCS_PAGES_ENABLED --body true`
   - a one-line `site_url` edit, followed by a regenerate

   This updates the design §7 fallback: the site build and workflow are kept (deploy gated off) rather than dropped. That is strictly safer, since nothing deploys and nothing goes red.
5. Verify locally:
   - The strict build passes.
   - The search check passes.
   - Load the built site through a local static server in the T3 preview browser, and check the hub, a long page with `<details>`, an alert, and a legacy `<a id>` anchor.

## Phase 6: Editor verification and visuals

1. **`editors/vscode/src/test/getting-started.test.ts` (§5.2).**
   - **Isolated fixture.** It does not use the shared `src/test/fixtures` root, because that root contains a `raven.toml` that upward discovery would apply. A pretest step copies `docs/examples/snippets/getting-started-before/` into `editors/vscode/.vscode-test/getting-started-ws/`, so the corpus stays the single source of truth. The test then asserts no `raven.toml` or `.lintr` exists in that directory or its ancestors up to the repo root, and the repo root has none.
   - **Separate test config.** `.vscode-test.mjs` gains a second labeled config, `getting-started`:
     - `files: out/test/getting-started.test.js`, with that file excluded from the default config's glob
     - `workspaceFolder` set to the copied workspace
     - `env.PATH` set to the system PATH with every directory containing `R`/`Rscript` or `raven` removed (computed in the config)

     The extension uses its bundled server, so this proves "no R, no CLI on PATH" even though the CI job installs `r-base-core`. CI's `bun run test` runs both configs (`vscode-test` runs all labeled configs by default; verified in Phase 6 by checking the CI log lists both).
   - It asserts each step:
     - the warning appears
     - applying the documented edit clears it
     - go-to-definition lands in `helpers.R`
     - hover mentions `helpers.R`
   - Use `awaitActive(editor)` per AGENTS.md.
   - Locally, this suite doesn't complete over SSH (memory note), so it is proven in CI. Failure messages name the tutorial step.
2. **`scripts/fresh-install-check.sh` (§5.2)**, documented in development.md's "Docs tooling" section. It does three things:
   - `bun run package`: builds the VSIX with the bundled binary
   - installs it into empty `--extensions-dir` and `--user-data-dir` with the same R/raven-free PATH
   - runs `getting-started.test.ts` through `@vscode/test-electron` with a stub `extensionDevelopmentPath` (`scripts/fresh-install-stub/package.json`) and launch args that **omit `--disable-extensions`**, so the installed VSIX loads

   **Where it runs:** a `workflow_dispatch` workflow can't be dispatched before it exists on `main`. So a **temporary** `.github/workflows/fresh-install.yml` (ubuntu + xvfb) triggers on `pull_request` with `paths: [.github/workflows/fresh-install.yml, scripts/fresh-install-check.sh]`, which runs it on this PR. The run's link and log excerpt are recorded in the PR description, and the workflow file is **deleted in the last commit before merge**. The script itself stays.
3. **Screenshots (§8).**
   - **Session.** Run `code serve-web --without-connection-token --port <free>` with a fresh `--server-data-dir`, and install the same VSIX built by the fresh-install script into it (a fresh profile, the same build as §5.2). Open it with the T3 preview browser, then open the tutorial workspace.
   - **Captures:** three screenshots:
     - the squiggle with its hover
     - the go-to-definition peek
     - the debugger at a breakpoint
   - **Fallback (design §8): all three or none.** If any of the three can't be captured, ship no images. Record the reproduction steps in development.md, and open a tracking issue asking the owner to capture them. The README, Marketplace README, and pages then carry no image references, and their layout already works without them.
   - **On success:** save them as PNGs in `docs/images/`, with alt text, a version caption, and reproduction steps in development.md. Marketplace README images use `raw.githubusercontent.com/.../main/docs/images/...`, which the link test maps to local files.
   - **Either way,** the image-existence lint flips to gating here.

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
3. **Rebase, unslop, and push.** Rebase on `origin/main`. Then run the unslop pass on the README, Marketplace README, and the four new pages. Push the branch. The acceptance run below tests this pushed revision.
4. **Acceptance review (§6).** It runs against the pushed head SHA.
   - **Isolation is enforced.** Each persona is a `delegate_task` child with no repo checkout access. Its brief allows only web fetch/search tools, and it must return a transcript listing every tool call (tool, URL or query). Any transcript containing a non-web tool call (shell, file read, grep) is rejected and the task is re-run. I audit every transcript.
   - **Inputs.** Each persona gets only the start URL (`https://github.com/jbearak/raven/blob/<head-sha>/README.md`). Root README and hub links are relative, so they stay on the pinned SHA. It records clicks, searches, path, answer, and confidence.
   - **Gate.** Raven is gated on the **two-click route only** (the site isn't deployed, design §7 fallback). Comparator runs use each tool's live docs under the same rules.
   - **Spot checks.** I spot-check every failure and ≥25% of passes against the docs, and re-run marginal results twice.
   - **Failures** go back to Phase 4 for the affected pages, followed by a re-run of the affected tasks.
   - **Evidence.** `docs/superpowers/specs/2026-10-29-docs-acceptance.md` holds the per-task table, every transcript (or a link to it), and the spot-check notes. The PR description summarizes them.
5. **Binding to the shipped revision.** Any later commit that changes a user page (bot fixes, rebases with doc conflicts) triggers a re-run of the tasks whose recorded path touches that page, against the new head. The acceptance file records the final SHA each task passed on.

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
   - Docs CI (`docs.yml`) and the temporary fresh-install workflow are not required, but both must be green before merge. The fresh-install workflow is then deleted (Phase 6.2).
3. **Merge gate (full-send):**
   - required checks green
   - bots done and every finding handled
   - the branch up to date and mergeable
   - squash merge
4. **After merge:**
   - Confirm `docs.yml`'s build job is green on `main`, and that `deploy` is skipped (Pages not enabled).
   - The site/search spot-check is deferred until the owner enables Pages (see the report).
5. **Report**: the PR link, merge commit, proof, decisions, and the two owner steps to enable the site.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A writer drops a behavioral fact | Ledger review after each wave; "keep and move to Details" rule; reviewers see the ledger |
| Anchor breakage in old binaries or Marketplace | Frozen baseline test; runtime URL tests unchanged |
| Example flakiness | Isolated harness; base-only symbols; Linux CI + macOS local |
| The PR is huge to review | One concern per commit, in this order: guards, harness, then each content batch, then site, then visuals. The PR description gives the ledger and acceptance results as review aids |
| Zensical (0.0.x) churn | Pinned with hashes; the site is non-required CI; the sources don't depend on it |
| Pages not enabled (agent lacks authority) | Fallback config ships; deploy gated by a repo variable; owner steps in the report |
| vscode-test can't run locally | CI proves `getting-started.test.ts`; fresh-install runs in a temporary PR-triggered workflow |

## Changes from revision 1

| Review item | Resolution |
|---|---|
| Terra 1: Pages artifact across jobs | Phase 5.3: build job uploads the artifact; deploy consumes it; deploy gated by a repo variable |
| Terra 2 / Sonnet 5: dispatch infeasible, `--disable-extensions` | Phase 6.2: temporary PR-triggered workflow deleted before merge; stub config omits the flag; documented in development.md |
| Terra 3 / Sonnet 4: §5.2 table, PR template, script docs | Phase 4 last steps: Docs verification table, Docs tooling section, new PR template |
| Terra 4: JSON example must be asserted | Phase 3.2: JSON paths verified relative; asserted |
| Terra 5: screenshot fallback | Phase 6.3: all three or none; same VSIX and fresh profile |
| Terra 6 / Sonnet 3: acceptance isolation and binding | Phase 7.3–7.5: delegate children with web-only tools and audited transcripts; run after rebase and unslop on the pushed head; re-run on later page changes |
| Sonnet 1: image lint vs screenshots; early gating | Phase 2 preamble: link and baseline tests gate from the first commit; image lint flips in Phase 6.3 |
| Sonnet 2: Pages enablement authority | Phase 5.4: the agent does not change repo settings; fallback ships with gated deploy; owner steps in the report |
| Sonnet 6: fixture isolation and no-R proof | Phase 6.1: fixture outside the shared root with an ancestor check; separate test config with R/raven stripped from PATH |
| Sonnet 7: authoring rules for the site | Brief and `docs-lints` enforce `<details markdown="1">` and absolute out-of-docs links |
| Sonnet 8: branch name | Fixed to `t3/documentation-redesign` |
| Sonnet non-blocking | Empty-PATH harness; relative root and hub links; snippet-syntax test in Phase 2; cargo serialized; AGENTS.md / CONTEXT.md; exempt reasons in the ledger |
