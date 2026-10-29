# Raven user documentation redesign

Date: 2026-10-29. Status: design, revision 4.

Inputs: `2026-10-29-docs-prior-art.md` (how Ruff, uv, ty, Air, Jarl, Biome, rust-analyzer, lintr, Deno, Typst, and others document themselves) and an audit of Raven's current docs (summarized in §1). Revisions 2–4 address the round-1 to round-3 reviews (Terra, Sonnet); §11 lists each change.

## Goal

The README (also the GitHub landing page), the VS Code Marketplace README, and every user-facing page under `docs/` should beat the best comparable developer-tool docs on four tests:

1. **Time to first value.** A new user, starting from the Marketplace with nothing else installed, sees Raven catch a real bug within two minutes.
2. **Findability.** Every task in the fixed acceptance set (§6) is answerable within two clicks from the README, or with one search on the docs site followed by opening one result.
3. **Trust.** Every block that shows Raven CLI output is either asserted against the real binary, or explicitly exempted with a stated reason that the docs test enforces (§5.1). The landing demo, the tutorial output, and every diagnostic-code example that the CLI can produce are always asserted; the rest carry exempt reasons. The tutorial's editor steps are covered by a VS Code integration test. Other editor-only claims have a named verification method (§5.2).
4. **Depth without noise.** Power-user semantics stay complete but never sit in a beginner's path.

Prior art wins on (1) and (2): Ruff and uv do it with landing pages, Diátaxis navigation, and search. On (3), Ruff, ty, Jarl, and Biome generate their rule pages from source, but every surveyed project hand-writes its landing demo, tutorial output, and feature prose. On (4), they either omit the depth (Air) or drown readers in it (Raven today). Raven can match (1) and (2), and do (3) and (4) better than anyone.

Non-goals: translations, versioned docs, a playground, GIFs, and changes to Raven's behavior.

## 1. What is wrong today (audit summary)

- **No getting-started path.** The README spends ~650 words (lines 3–17) before the feature list. Its "Quick Start" is just install links.
- **Walls of text.**
  - 75 paragraphs exceed 150 words, the worst at 780.
  - The README has a 276-word paragraph.
  - diagnostics.md has 154-word table cells.
- **Implementation detail in user pages.**
  - Issue numbers (`issue #638`) and source paths (`crates/raven/src/handlers.rs::hover`).
  - "AST" 129×, "Tier 1/2/3" 40×.
  - A manual QA plan in help-viewer.md and iframe internals in knit.md.
- **Duplication.**
  - "How Raven differs / coexists" appears five times.
  - `raven.rConsole.activation` is explained in 15+ pages.
  - configuration.md re-tabulates the generated settings-reference.md.
  - CI templates appear in both ci.md and cli.md.
  - Suppression is documented in four pages, twice within diagnostics.md.
- **First-person editorializing**: "## Why we built this" opens help-viewer.md and data-viewer.md.
- **Inconsistent page shapes**: heading case, line wrapping, and the Settings/Limitations sections all vary.
- **Drift.** The VS Code README omits the debugger, Quarto, modules, NSE, and CI, and describes the console wrongly.
- **Thin editor guidance.** editor-integrations.md is bare snippets, with no way to confirm the server is working.
- **No visuals, no search, no runnable examples.**

What must survive is the precise semantics and the legal text:

- path resolution
- directive grammar
- NSE policy
- diagnostic codes
- the lintr compatibility matrix
- the `raven.toml` schema
- CLI exit codes and streams
- package-database tiers
- package-mode visibility
- the coexistence matrix
- debugger capabilities
- keybinding tables
- provenance and license text

§6 makes this enforceable.

## 2. Principles

1. **Show, then tell.** Every page opens with one sentence saying what the feature does for you. Next comes a concrete example: code with Raven's output, a before/after with the reason the fix works (Air style), or a "you do X → Raven does Y" table. The explanation follows.
2. **One home per fact.** Each fact lives on one page, and the others link to it.
   - `raven.rConsole.activation`: coexistence.md.
   - Suppression: diagnostics.md.
   - Settings tables: the generated settings-reference.md.
   - CI templates: ci.md.
3. **Layered depth.** Each feature page has three layers.
   - **Use it**: the common case, readable in two minutes.
   - **Settings**: a short table linking into settings-reference.md.
   - **Details**: exact semantics for power users, at the end. Long items go in GitHub-rendered `<details>` blocks with a descriptive summary.

   Nothing is deleted for being too deep. It moves down.
4. **User facts only.** No issue numbers, source paths, internal type names, or test plans in user docs. Those go to `docs/development.md` or code comments.
5. **Plain, second-person voice.** Short sentences, no "we", no marketing adjectives. Paragraphs target ≤100 words (hard ceiling 150), and table cells ≤40.
6. **GitHub Markdown is the source and a canonical target.** Runtime links point at `github.com/jbearak/raven/blob/main/docs/*.md`: the `raven check` footer, a VS Code notification, a setting description, and the Marketplace README. Pages use only GitHub-flavored Markdown: GitHub alerts, `<details>`, and tables. The docs site (§7) renders the same files unchanged.
7. **Claims are verifiable.** Diagnostic and CLI examples are executable and asserted (§5.1). Editor-only claims are listed with their verification method (§5.2).

## 3. Information architecture

Filenames stay flat and **stable**. Old binaries, old extension versions, and external sites link to `blob/main/docs/<name>.md` and to anchors. No existing user-facing file is renamed or deleted. A page whose content moves leaves a one-paragraph pointer to its new home. Navigation comes from the hub and the site's sidebar, not from directories.

### 3.1 User-page manifest

`docs/user-pages.json` lists every user-facing page with its hub group and a one-line description. The hub, the site navigation, `llms.txt`, and the docs lints all read this one manifest.

- **Root READMEs**: `README.md` and `editors/vscode/README.md`. They are not hub entries, but they are linted.
- **Start here**:
  - `getting-started` (new)
  - `coming-from` (new)
  - `editor-integrations`
  - `ci`
- **Analysis**:
  - `diagnostics`
  - `cross-file`
  - `non-standard-evaluation`
  - `r-package-dev`
  - `modules`
  - `rprofile`
  - `linting`
  - `indentation`
- **Navigation and editing**:
  - `completion`
  - `hover`
  - `go-to-definition`
  - `find-references`
  - `document-outline`
  - `syntax-highlighting`
  - `snippets`
- **R session (VS Code)**:
  - `r-console`
  - `debugger`
  - `plot-viewer`
  - `data-viewer`
  - `help-viewer`
- **Documents**: `chunks`, `knit`, `quarto`.
- **Reference**:
  - `directives`
  - `configuration`
  - `settings-reference` (generated)
  - `cli`
  - `keybinding-comparison`
- **Understanding Raven**:
  - `comparison`
  - `coexistence`
  - `limitations`
  - `package-database`
  - `cross-file-analysis-performance` (under the label "Performance on large projects")
- **Help**: `troubleshooting` (new), `faq` (new).

Diagnostic codes are not a separate page. They are the reference half of `diagnostics` (§3.4).

**Internal, excluded from the hub and lints:**

- `development`
- `shared-config-schema`
- `diagnostic-corpora`
- `package-corpus-checkpoint`
- `release-notes-*`
- `superpowers/**`
- `examples/**`

The template (§3.5) and the lints (§5.3) apply to **every** user page above, without exception.

### 3.2 The hub: `docs/README.md` (new)

GitHub renders `docs/README.md` when someone opens `docs/`, and the site uses it as its home page. It is generated from the manifest, with one line per page: the link and what you'd go there for. Each user page carries a one-line breadcrumb under its title (`[Docs](README.md) › <Group>`), because GitHub has no sidebar.

### 3.3 New pages

**`getting-started.md`** is a tutorial that needs nothing but the editor. Steps:

1. Install the VS Code extension. It bundles the server, so there is nothing else to install. Non-VS Code users go to editor-integrations.md, which links back into step 2.
2. Make a folder with two files by copy-paste: `main.R`, which `source()`s `helpers.R` and contains one typo, and `helpers.R`. They are three to eight lines each and depend on no packages, so they work with or without R installed.
3. See the undefined-variable warning on the typo, fix it, and watch it clear. A before/after says why the fix works.
4. Cmd/Ctrl-click a function from `helpers.R` to jump across the `source()` boundary. Hover it to see where it came from.
5. **Optional: the command line.** The extension's bundled binary is not on your PATH. Install the CLI (Homebrew, apt, or a release binary; link to cli.md) and verify with `raven --version`. Then run `raven check .` in the folder. The reader's files are fixed at this point, so the tutorial shows the clean-run output (corpus `getting-started-after`). Next to it is the output for the original files (corpus `getting-started-before`), labeled "what CI would have reported before your fix".
6. Next steps: CI, linting, the R console and debugger, and the "coming from" guides. "Try more" links the repo's `demo/` workspaces.

The two files are corpus examples (§5.1) in two states, `getting-started-before` and `getting-started-after`, and each state's `raven check` output is asserted.

**`coming-from.md`** has a short section each for RStudio, vscode-R, Positron, and lintr users. Each says:

- what stays the same
- what changes
- which settings to flip (linking coexistence.md)
- keybinding differences (linking keybinding-comparison.md)

**`troubleshooting.md`** is an ordered procedure, in rust-analyzer's style.

1. Check the version.
2. Open the output channel and raise the log level.
3. Reproduce on the command line with `raven check`, where results are deterministic and shareable.
4. Work through the symptom table:
   - a false undefined-variable
   - a `source()` that isn't followed
   - duplicate completions from two servers
   - the console not starting
   - diagnostics missing in a background tab
   - the server not starting in Neovim or Zed
5. File an issue, using the template of what to include.

**`faq.md`** answers in ≤80 words each, linking onward:

- Does Raven run my code?
- Does it need R installed?
- How is it different from languageserver, Ark, lintr, Jarl, or Air?
- Can I use it behind an AI agent?
- What does it cost?

### 3.4 Restructured existing pages

**README.md (landing page)** has a target of ≤120 lines, in this order:

1. **Tagline.** One sentence, e.g. "Raven finds undefined variables and broken `source()` chains in R code — across files, as you type, without running anything."
2. **Demo.** A 6–10 line R snippet and its real `raven check` output (a corpus example). Then one screenshot of the same diagnostic inline in VS Code (§8).
3. **Install.** Three lines: VS Code / Open VSX / CLI (Homebrew, apt, binaries), then "→ Getting started".
4. **What you get.** Four groups: analysis, navigation, R session, documents & CI. Each bullet is ≤15 words plus a link. JAGS/Stan support is one bullet that keeps its existing anchor links.
5. **Why static analysis.** Four consequences in one sentence each, then a link to comparison.md.
6. **Works with your setup.** Two sentences and a link to coexistence.md.
7. **Documentation** (link to the site and the hub), status, Sight, provenance (verbatim), and license.

The current headings `## Installation`, `### Command line`, and `## How Raven Differs` keep their slugs: as headings where they fit, otherwise as `<a id>` anchors at the matching content.

**editors/vscode/README.md (Marketplace)** has the same skeleton with VS Code wording. Its feature-list links equal the root README's, and a test enforces it. It uses absolute `blob/main` URLs and keeps every existing anchor. Its images use absolute `raw.githubusercontent.com` URLs, which the Marketplace requires. Prose and example fences may differ in wording. Only the link set is compared.

**editor-integrations.md** has one fixed section per editor: VS Code-family (VS Code, Cursor, Positron, VSCodium), Neovim (nvim-lspconfig and native `vim.lsp.config`), Zed, Helix, Emacs (eglot), and generic LSP clients. Each section contains:

- install
- the config snippet
- **verify it's working**: a concrete check, e.g. `:checkhealth vim.lsp` / `:LspInfo`, or Zed's language-server log, plus "open a file with a typo and see the warning"
- what you get

After the sections comes a **feature-availability matrix**:

- **Rows**: completion, hover, definition, references, diagnostics, outline, semantic tokens, formatting-on-type, code actions, console, debugger, viewers, knit, Quarto.
- **Columns**: "any LSP editor" and "VS Code extension".

Config snippets are checked for syntax in CI: JSON and TOML parse, and Lua passes `luac -p` when available, skipping cleanly otherwise. Editor behavior itself is hand-verified (§5.2).

**diagnostics.md** has two parts. It is the target of the `raven check` footer link.

- **Use it**: what you see. The existing Quick Reference list becomes one recipes table:
  - silence one line
  - declare a symbol
  - declare NSE
  - turn a category off

  It is also the single home of suppression, including `# nolint` and the `@lsp-` aliases.
- **Diagnostic codes reference**: an index table (code, default severity, suppressible, setting), then one `### \`code\`` section per code in a fixed template:
  - one-sentence meaning
  - **Example**, with R code and Raven's message (a corpus example wherever the CLI can produce it)
  - **Fix**, a before/after with the reason
  - **Suppressible**
  - **Setting**
  - optional `<details>` with exact semantics

The long semantic lists now in diagnostics.md go into the `<details>` of the code they belong to, or to the page that owns the concept:

- what binds a name → `undefined-variable` details
- the NSE catalogue → non-standard-evaluation.md
- targets → cross-file.md
- Stan rules → the Stan code's details

Every legacy anchor is preserved (§4).

**configuration.md** explains *how* configuration works:

- VS Code settings vs `raven.toml` vs `.lintr`
- discovery
- precedence
- per-file overrides
- exclusions
- live reload

It stops re-tabulating settings and links settings-reference.md, which stays generated.

**cli.md** is the reference for `raven check`, `lint`, `packages`, `console`, and `--stdio`: flags, exit codes, and output streams. The CI templates move to ci.md, and the maintainer appendix moves to development.md. cli.md keeps the legacy anchors `#ci-examples`, `#github-actions-example`, `#bitbucket-pipelines-example`, and `#ubuntu-installation`, each with a short pointer. The headings test in `tests/bun/apt-packaging.test.ts` moves its assertions to ci.md.

**ci.md** is the single home for CI. It is a tutorial: what CI is, then the GitHub Actions template, the Bitbucket template, and choosing flags.

**comparison.md, coexistence.md, and the README** split by question:

- **README**: why static, in four sentences.
- **comparison.md**: "How does Raven compare to X?" It uses factual tables, with no line-range links into other projects' source, and keeps a short "Why Raven exists" section with its anchor.
- **coexistence.md**: "How do I run Raven next to X?" It holds the recipes and the activation matrix, and is the single home of `raven.rConsole.activation`. r-console.md and the viewer pages link to it rather than restate it.

**help-viewer.md and data-viewer.md**: "Why we built this" becomes a one-sentence lead. The smoke-test plan moves to development.md, and the comment in `editors/vscode/src/test/help-viewer.test.ts` points there.

**All other user pages** keep their content and get the template:

- r-console, debugger, completion, hover, go-to-definition, find-references, document-outline, syntax-highlighting, snippets
- plot-viewer, cross-file, directives, non-standard-evaluation, r-package-dev, modules, rprofile, linting, indentation, knit, quarto, chunks
- package-database, limitations, keybinding-comparison, cross-file-analysis-performance

On each, "Use it" comes first and exhaustive rules move into "Details". Issue numbers and internals become user-facing statements, and restated activation/suppression text becomes a link.

### 3.5 The page template

```markdown
# <Feature>

[Docs](README.md) › <Group>

<One sentence: what this does for you.>

<Example: code + result, before/after, or a "you do → Raven does" table. Screenshot here if any.>

## <Task-oriented "Use it" sections>

## Settings            (only if the feature has settings; links into settings-reference.md)

## Limitations         (only if any)

## Details             (exact semantics; long items in <details>)

## See also            (2–5 links)
```

Headings use sentence case, and each paragraph is one source line (no hard wrapping).

## 4. Link and anchor safety

1. **Frozen legacy-anchor baseline.** Before any page is edited, a script records `tests/bun/fixtures/docs-anchor-baseline.json`. It holds every heading slug (all levels, including GitHub's `-1`/`-2` duplicate suffixes), every explicit `<a id>`/`name` in README.md, editors/vscode/README.md, and every current user page, plus every anchor the current READMEs and code link to. A Bun test fails if any baseline `file#slug` no longer resolves to a heading or an `<a id="…">` in that file. When content moves to another page, the old slug stays as an `<a id>` on a one-line pointer. Without this, an old link would land on unrelated text.
2. **Link checker.** `tests/bun/docs-links.test.ts` resolves every relative link and `#anchor` in the manifest pages, both READMEs, and `llms.txt`. It handles code fences and computes GitHub slugs, and it counts `<a id>`/`<a name>` as targets. It also checks the `blob/main/docs/…#anchor` URLs found in `crates/` and `editors/`. The slugger is tested against fixture headings whose GitHub slugs are known (punctuation, backticks, duplicates, Unicode).
3. **Existing guards stay**: the runtime footer tests in `check.rs` and `check_footer_stream.rs`, the settings-reference drift test, and the apt-packaging test (retargeted, §3.4).

## 5. Verification contract

### 5.1 Executable examples (CLI output)

**Corpus.** `docs/examples/snippets/<name>/` holds one self-contained mini-workspace per example:

- `.R` files (and optionally `.Rmd` / `.qmd`)
- an optional `raven.toml`
- `cmd`: one line, the arguments after `raven`, e.g. `check .` or `check --format json .` or `check --help`
- `stdout.txt`: exact expected stdout
- `stderr.txt`: exact expected stderr (often empty, but always present and asserted)
- `exit`: the expected exit code, a single integer

**Displayed form.** In a page, an example is a ```` ```console ```` block preceded by `<!-- example: <name> -->`. Its content is `$ raven <cmd>` followed by the exact contents of `stdout.txt`. To show stderr instead (errors, notes), write `<!-- example: <name> stream=stderr -->`: the block is `$ raven <cmd>` followed by `stderr.txt`. For both streams, use `stream=both`: stdout, then stderr. The two streams are never shown interleaved. When the exit code matters to the reader, the prose states it, and `exit` asserts it. A source-file block is preceded by `<!-- example: <name> file=<relative path> -->` and equals that file byte-for-byte. The Bun docs test checks both bindings.

**Harness** (`crates/raven/tests/docs_examples.rs`, run by `cargo test` in the existing CI). The harness never adds flags: it runs exactly `raven <cmd>`, the command the page displays. Isolation comes from the environment and the filesystem, which the docs' readers share for any subcommand (`check`, `lint`, `--version`, `--help`, usage errors). For each example the harness:

1. Copies the directory to a fresh temp directory outside the repo. It asserts that no ancestor of that directory contains a `raven.toml` or `.lintr`, so upward config discovery from the cwd finds only the example's own config.
2. Writes `<tmp>/raven.toml`: the example's own `raven.toml` (if any) with `packages.enabled = false` forced. The harness fails if an example sets `packages.enabled` itself. Default discovery (`--workspace` defaults to the cwd and config is searched upward from it) picks this file up for `check` and `lint` without extra flags. Commands that read no config are unaffected.
3. Runs the built `raven` binary with cwd `<tmp>`, stdout and stderr as pipes (not a TTY, so `auto` color is off), and a cleared environment. It sets only these variables:
   - `NO_COLOR=1`
   - `PATH` (system dirs, no R)
   - `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, pointing into `<tmp>`

   So `RAVEN_NAMES_DB`, a user `~/.lintr`, the user-data `names.db`, and installed packages cannot leak in.
4. Compares stdout and stderr byte-for-byte, and the exit code exactly. Version strings are the one exception: a `stdout.txt` may contain the token `{{version}}`, which the harness substitutes with the crate version, so a release bump doesn't churn the corpus. The page shows the substituted current version, and the Bun binding check applies the same substitution from `Cargo.toml`.

A pre-flight check confirms that base-R symbols (e.g. `paste`, `mean`, `data.frame`) resolve with `packages.enabled = false`. The tutorial's "works without R" claim depends on the embedded base coverage.

`UPDATE_DOCS_EXAMPLES=1` rewrites `stdout.txt` and `exit`. Examples use only base-R symbols and their own files. The corpus must include at least one example with its own `raven.toml` (a lint rule enabled), one JSON-format example, the `check --help` text, one `raven lint` example, one `--version`, and one usage error asserted on stderr with exit 1. That proves config merging, non-text output, stderr, and non-`check` commands work.

**Platforms.** CI runs this on Linux (the integration jobs are `ubuntu-latest`), and contributors run it on macOS. Example paths are relative POSIX paths. The docs do not claim Windows-identical output.

**No silent escapes.** In user pages and both READMEs, a fenced block must carry `<!-- example: … -->` or `<!-- example-exempt: <reason> -->` if it contains any of:

- a line starting `$ raven` or `> raven`
- a standalone CLI message line starting, case-insensitively, with `error:`, `warning:`, `note:`, or `raven:` (path-less errors and notes such as `Error: raven check: unknown flag: --bogus`)
- a diagnostic-shaped line (`<path>:<line>:<col> <severity>: <text>`, where the path may contain spaces, the severity is `error|warning|info|hint|note`, and any or no trailing `[...]` is allowed)
- the `N issue(s) (…)` summary
- `Usage: raven`
- a `raven <semver>` version string
- JSON with both `"severity"` and `"code"` keys
- a SARIF `$schema`/`"runs"` document

Exempt reasons are free text, e.g. "absolute paths vary per machine". The checker's detection has its own unit tests with positive and negative fixtures for each pattern: spaces in paths, `note`, non-kebab codes, stderr-style notes, JSON settings snippets that must *not* trigger, and so on.

### 5.2 Editor-only claims

**Tutorial in the editor.** A new VS Code integration test, `editors/vscode/src/test/getting-started.test.ts`, runs in the existing `vscode-test` CI job. It opens the tutorial's corpus files (`getting-started-before`) as a workspace, with R not required and no CLI on PATH (it uses the bundled server). It then asserts each tutorial step:

- the undefined-variable diagnostic appears on the typo
- applying the documented fix clears it
- go-to-definition on the helper call lands in `helpers.R`
- hover names `helpers.R`

**Fresh install.** The install path is verified independently of screenshots by `scripts/fresh-install-check.sh`, which is documented in development.md and run once for this change, with its output in the PR. The script:

1. Packages the VSIX.
2. Installs it into an empty `--extensions-dir`, with an empty `--user-data-dir` and no `raven` or R on PATH.
3. Runs the same `getting-started.test.ts` against that installed extension. The test runner is loaded through a stub `extensionDevelopmentPath` that contributes nothing, so the installed VSIX is the only Raven.

The screenshot session (§8) reuses this profile, but nothing in §5 depends on it.

**Other editor-only claims.** Hover, completion, go-to-definition, debugger, viewers, knit, and Quarto examples are hand-written. Each such page lists, in development.md's new "Docs verification" table, how its claims are verified:

- by an existing VS Code integration test (named),
- by an LSP-level Rust test (named), or
- by the manual `demo/` procedure.

The docs claim automated verification only for §5.1 and the tutorial test. The table is reviewed whenever its page changes (enforced in the PR template checklist).

### 5.3 Docs lints (Bun)

The lints apply by page class:

- **Feature and guide pages**: every rule below, plus the template's lead, breadcrumb, and section order.
- **Reference pages**: directives, configuration, cli, keybinding-comparison, and `settings-reference`. These use a reference template: title, breadcrumb, lead sentence, body, See also. `settings-reference.md` is generated, so its generator (`generate-settings-reference.mjs`) emits the breadcrumb, lead, and See also. Its existing drift test keeps passing because the committed file is regenerated in the same change.
- **The hub `docs/README.md`**: generated from the manifest by `scripts/generate-docs-hub.mjs` with a `--check` drift mode, wired into the Bun test like settings-reference.
- **Both READMEs**: no breadcrumb or template, but all content lints apply. The exception is the `## Provenance` and `## License` sections, which are legal text kept verbatim and exempt from the voice and source-path lints. Today they contain no first person and no source paths.

The rules:

- No `issue #\d+`.
- No `crates/`, `editors/vscode/src/`, or `.rs`/`.ts` source paths.
- No first person (`\bwe\b`, `\bour\b`, `\bus\b`, case-insensitive, excluding `US`) outside quotes and code.
- No duplicate heading text within a page. Python-Markdown and GitHub disagree on duplicate-slug suffixes; legacy duplicate slugs survive as `<a id>`.
- Starts with `# `, the breadcrumb, and a lead sentence.
- Every manifest page is linked from the hub.
- No hub section is empty, and no hub link points outside the manifest.
- No paragraph over 150 words outside `<details>`, tables, and code.
- Every image has non-empty alt text and an existing file.
- `llms.txt` lists exactly the manifest pages.
- README feature-link parity.

### 5.4 Content-preservation ledger

Before rewriting, `docs/superpowers/specs/2026-10-29-docs-content-ledger.md` inventories every H2/H3 section of every user page. For each section it records: kept here / moved to `page#anchor` / moved to development.md / dropped as duplicate of `page#anchor`. Rewrites must satisfy the ledger, and the reviewers check it. Nothing is dropped unless it is a duplicate or internal.

## 6. Acceptance review (task-based)

**Who runs it.** Fresh LLM agents, one per persona, with no repo access. Each gets only the start URL (the GitHub README, or the docs site) and a browser/fetch tool. Each records its path (every page and search used), its answer, and a confidence rating. The implementer then spot-checks every failed task and at least a quarter of the passes against the actual docs. Results, transcripts, and spot-check notes go in the PR description for the owner.

**Fixed task set (20 tasks).** The *(cmp: …)* note on each task names the surveyed tools with a counterpart task. Tasks marked *Raven-only* have no counterpart.

- **Onboarding**
  1. Install and see a first diagnostic, without R (cmp: Ruff, Biome, Jarl).
  2. Find what Raven does that lintr/Jarl don't (cmp: Jarl "Related work", Ruff FAQ).
  3. Find whether Raven runs your code (cmp: ty).
- **Editor setup**
  4. Configure Neovim (cmp: Ruff, ty, Air).
  5. Configure Zed (cmp: Ruff, Air).
  6. Confirm the server is attached in a non-VS Code editor (cmp: Ruff, rust-analyzer).
  7. Stop duplicate completions when also running vscode-R (cmp: none; *Raven-only*).
- **Diagnostics**
  8. Silence one diagnostic on one line (cmp: Ruff, Biome, Jarl, lintr).
  9. Turn one category off project-wide (cmp: Ruff, Biome, Jarl).
  10. Learn what one diagnostic code means and how to fix it (cmp: Ruff, Biome, ty).
  11. Fix a false undefined-variable from an NSE helper (*Raven-only*).
- **Reference depth**
  12. Make a `source()` built with `file.path()` resolve (*Raven-only*).
  13. Find the meaning of exit code 2 from `raven check` (cmp: Ruff, uv, Biome).
  14. Find where project config lives and how it's discovered (cmp: Ruff, uv, Biome).
  15. Find which `.lintr` options are honored (cmp: Jarl).
- **Troubleshooting**
  16. Diagnostics missing in one file (cmp: rust-analyzer, ty).
  17. Gather logs for a bug report (cmp: rust-analyzer, Ruff).
- **CI**
  18. Set up GitHub Actions (cmp: Ruff, uv, Biome, Jarl).
  19. Fail CI only on errors, not warnings (cmp: Ruff, Biome).
- **Session**
  20. Use Raven's console instead of vscode-R's (*Raven-only*).

**Measures.** The review records **clicks** (page loads after the start page) and **searches** (queries submitted) separately for each task. **Effort**, for comparisons only, is clicks + searches.

**Pass criteria**, which must all hold:

- **(a) Own findability.** 20/20 tasks are answered correctly via one of two routes, matching Goal 2:
  - searches = 0 and clicks ≤ 2
  - searches = 1 and clicks ≤ 1, where the one click opens a search result

  If the site fallback (§7) applies, only the first route counts.
- **(b) Versus each comparator.** For every task with a counterpart, Raven's correctness is ≥ each comparator's, and Raven's effort is ≤ each comparator's. Comparators run under the same rules from their own landing page.
- **(c) Baseline.** The pre-redesign docs are run on the same set and recorded. This is not a gate, but it shows the improvement.

Failures are fixed in the docs and the affected tasks re-run until (a) and (b) hold. LLM runs are noisy, so a tied or marginal comparator result is re-run at least twice before it counts as a failure.

## 7. Docs site with search

The same Markdown files are published as a static site with full-text search on GitHub Pages.

**Generator: Zensical, pinned.** A spike on 2026-10-29 built representative pages with Zensical 0.0.73 and confirmed:

- **GitHub alerts** render as admonitions via `markdown-callouts`' `github-callouts` extension.
- **`<details markdown="1">`** renders inner Markdown. GitHub ignores the attribute, so pages write that form.
- **Relative `.md` links and `#anchors`**, including `<a id>` targets, are rewritten correctly.
- **Strict mode** aborts on a broken link.
- **Search**: `search.json` is emitted, with per-heading entries.
- **Slugs**: `pymdownx.slugs.slugify(case="lower")` matches GitHub's, except for duplicate-heading suffixes. §5.3 bans duplicate headings in a page.

Out-of-`docs/` links (README, `demo/`) are written as absolute GitHub URLs so they work in both renderers. Tooling is pinned in `docs/site/requirements.txt` with hashes and installed with `uv`. A header comment records the spike date and the versions verified. Navigation is generated from `docs/user-pages.json`. Internal pages are excluded.

**Workflows.** These run in a new `.github/workflows/docs.yml`, separate from the required integration checks:

- **Pull requests touching `docs/**`, the READMEs, or the site config**: a build-only job runs `zensical build --strict` and a search-index check. The check asserts that `nolint`, `rConsole.activation`, `sourced-by`, and `exit code` each hit their expected page. There is no deploy and no write permission. It is not a required check, so a tool or network outage cannot block unrelated PRs. The required gate for links stays the Bun link checker in the existing CI.
- **Push to `main`**: build and deploy with `actions/deploy-pages`. Permissions are `contents: read`, `pages: write`, and `id-token: write` only.

**Canonical links unchanged.** GitHub `blob/main` URLs remain the runtime targets, and nothing in code is repointed. The README, hub, and `llms.txt` link the site for search.

**Enabling Pages** is a one-time repo setting (build type: GitHub Actions).

**Fallback.** If the site cannot be deployed (e.g. Pages is not enabled), the site build stays as a non-required PR check and the deploy job is gated off by a repo variable, so nothing deploys and nothing goes red. If the site cannot be *built*, its files and workflow are dropped. The Markdown sources never depend on the site, so GitHub rendering does not regress. In that case:

- The manifest's `site_url` is empty, so the generated hub, README docs line, and `llms.txt` emit no site links. The generators are written that way from the start, so the fallback is a one-field change.
- §6(a) must pass by the two-click route alone, and the search-index check is removed with the workflow.
- The missing search is recorded in the PR as an open gap.

## 8. Visuals

Three screenshots in `docs/images/` (light theme, 2× scale, cropped tight):

1. An undefined-variable squiggle with the hover message, for the README, Marketplace, and getting-started pages.
2. Cross-file go-to-definition peek, for go-to-definition.md and the Marketplace.
3. The debugger stopped at a breakpoint with variables, for debugger.md and the Marketplace.

Each image:

- has descriptive alt text
- has a caption naming the Raven version it shows
- is captured from a real VS Code session running this build: VS Code in a browser (`code serve-web`) with a fresh profile and the built VSIX, captured by browser automation. **Fallback:** if serve-web capture fails, screenshots are captured manually by the owner with the same recorded steps. The PR then ships without images, with the reproduction steps in development.md and a tracking issue.
- is listed in development.md with its reproduction steps (workspace and actions)

The lint checks the alt text and that the files exist. Screenshots are refreshed when their UI changes.

## 9. Agent-readable docs

A root `llms.txt` is generated from the manifest (with a drift check). It lists each page with an absolute `https://github.com/jbearak/raven/blob/main/docs/<page>.md` URL and its one-line description, and links the site.

## 10. Why this beats the prior art

- **Time to first value.** The landing demo and a two-minute, copy-paste tutorial need nothing but the extension. This matches uv and Biome and beats Air, lintr, and vscode-R, whose first steps assume R tooling.
- **Findability.** The hub, sidebar, search, FAQ, troubleshooting, "coming from" guides, and a per-editor feature matrix aim at parity with Ruff and uv and a lead over every R tool surveyed. §6 gates this per task against each comparator, rather than asserting it.
- **Trust.** The landing demo, the tutorial output, and every diagnostic-code example the CLI can produce are asserted against the real binary. Every other CLI-output block is asserted or carries an enforced exemption reason. The tutorial's editor steps are an integration test. Ruff, ty, Jarl, and Biome assert rule examples, but none we found asserts its landing demo or tutorial. Raven also guards legacy anchors, which none we found documents doing.
- **Depth without noise.** The three-layer template, the content ledger, and the paragraph and leakage lints keep Raven's unusually deep semantics complete and out of the beginner's path. Raven's depth is greater than any surveyed tool's, which makes this more demanding.

## 11. Changes from revision 1

| Review item | Resolution |
|---|---|
| Terra 1: no search | §7: site with search, a CI strict build, and a search-index test |
| Terra 2 / Sonnet 1: tutorial assumes repo/PATH | §3.3: copy-paste files; CLI step is optional with install and verify |
| Terra 3 / Sonnet 3: legacy anchors | §4.1: frozen baseline of all slugs and `<a id>` preservation |
| Terra 4 / Sonnet 5, 6: verification contract | §5: deterministic harness, marker enforcement, editor-claim table, narrowed claims |
| Terra 5: task-based acceptance and content inventory | §5.4 ledger, §6 persona review with baseline and comparator |
| Sonnet 2: editor-integrations | §3.4: per-editor template, verification steps, feature matrix |
| Sonnet 4: manifest | §3.1 manifest, with every page placed and exclusions named |
| Sonnet 7: visuals | §8: three real screenshots |
| Non-blocking (both) | Before/after fixes (§2.1); absolute URLs in llms.txt (§9); breadcrumbs (§3.2); a single recipes table (§3.4); hub sanity lints (§5.3); parity compares links only (§3.4) |
| Terra r2-1 / Sonnet r2-4: example scope and markers | §5.1: separate `cmd`/`stdout.txt`/`exit`; marker-or-exempt rule over all output shapes, with checker unit tests; Goal 3 reworded |
| Terra r2-2 / Sonnet r2-1: harness isolation | §5.1: temp copy outside repo, forced `packages.enabled = false` merged into the example config, cleared env, HOME/XDG in temp; config, JSON, and `--help` examples required |
| Terra r2-3 / Sonnet r2-3: comparator rigor | §6: fixed 20-task set mapped to comparators, effort metric, pass criteria (a) 20/20 and (b) ≤ each comparator, LLM personas plus implementer spot-checks |
| Terra r2-4: generated pages and README lints | §5.3: lint rules by page class; generator emits breadcrumb and lead; hub generated with a drift check; provenance and license exempt |
| Terra r2-5: tutorial as editor workflow | §5.2: `getting-started.test.ts` integration test; fresh-profile run in the §8 session |
| Sonnet r2-2: site and screenshot fallbacks, CI safety | §7: Zensical chosen by a completed spike; separate non-required PR build; least-privilege deploy on `main`; explicit fallbacks; §8 screenshot fallback |
| Terra r3-1: stderr and errors | §5.1: asserted `stderr.txt`, `stream=` binding, path-less error and note markers, required usage-error example |
| Terra r3-2: command-specific args | §5.1: harness runs the displayed command verbatim; isolation via cwd, ancestor check, forced config, and env only; `lint`, `--version`, and usage-error examples required |
| Terra r3-3: fallbacks vs gates | §7: `site_url`-driven link emission, two-click-only gate under fallback; §5.2: fresh-install script independent of screenshots |
| Terra r3-4: findability metric | §6: clicks and searches recorded separately; two explicit routes |
| Sonnet r3 non-blocking | Goal 3 and §10 scoped to CLI-producible examples; base-symbol pre-flight; softened prior-art claims; marginal re-runs; spike date in requirements |
