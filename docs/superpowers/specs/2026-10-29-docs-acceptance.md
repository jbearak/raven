# Docs redesign acceptance

Date: 2026-10-29. This file records the persona findability review from §6 of `2026-10-29-docs-redesign-design.md`, following Phase 7 of the plan.

- **Baseline docs SHA:** `6c7871aac52a75305cb9996412e905e7524618a0` (the docs before the redesign).
- **Tested docs SHA:** `572f6612a7aa7553a091d3b02b0d140049d0972b`. The runs were made at `55d86e47`, `c1317332`, and `76d99864`, and carry forward as described under Carry-forward.
- **Evidence commits:** the commits that add and update this file. It touches only `docs/superpowers/`.

## Protocol

- Five personas ran as delegated Claude Sonnet 5.5 agents at medium effort: analyst, package developer, Neovim user, CI maintainer, and vscode-R user. Each got four of the 20 tasks.
- The agents had web tools only. Each run started from `https://github.com/jbearak/raven/blob/<sha>/README.md` and was not allowed to search Raven's docs. Every run's transcript lists its tool calls, and none touched local files.
- A click is one page fetched after the start page. Effort, used only for comparisons, is clicks plus searches.
- Comparators ran under the same rules from their own landing pages. Search was allowed there, and every search counted toward effort:
  - Ruff, uv, and ty (`docs.astral.sh`)
  - Biome (`biomejs.dev`)
  - Jarl (`jarl.etiennebacher.com`)
  - Air (`posit-dev.github.io/air`)
  - rust-analyzer (`rust-analyzer.github.io/book`)
  - lintr (`lintr.r-lib.org`)
- Pass criteria:
  - (a) Every task is answered with no searches and at most 2 clicks.
  - (b) For every task with a counterpart, Raven's effort is no more than each comparator's.

## Results

Each Raven cell shows the effort, or "nf" for not found. "Comparator best" is the lowest effort any comparator needed to find the answer. "—" means the task has no counterpart.

| # | Task | Baseline | Final | Comparators (effort) | Comparator best | (a) | (b) |
|---|---|---|---|---|---|---|---|
| 1 | Install and see a first warning without R | 1 | 0 | Ruff 1, Jarl 0, Biome 1 | 0 | ✓ | ✓ |
| 2 | What Raven checks that lintr/Jarl don't | 1 | 0 | Ruff 1, Jarl 0 | 0 | ✓ | ✓ |
| 3 | Does Raven run your code | 0 | 0 | ty nf (3) | nf | ✓ | ✓ |
| 4 | Configure in Neovim | 1 | 1 | Ruff 1, Air 1, ty 1 | 1 | ✓ | ✓ |
| 5 | Configure in Zed | 1 | 1 | Ruff 1, Air 1 | 1 | ✓ | ✓ |
| 6 | Confirm the server is attached in Neovim | nf | 1 | Ruff nf, rust-analyzer 2 | 2 | ✓ | ✓ |
| 7 | Duplicate completions with vscode-R | 1 | 1 | — | — | ✓ | — |
| 8 | Silence one diagnostic on a line | 1 | 1 | Ruff 1, Jarl 1, Biome 2, lintr 1 | 1 | ✓ | ✓ |
| 9 | Turn off a category project-wide | 2 | 1 | Ruff 1, Jarl 1, Biome 1 | 1 | ✓ | ✓ |
| 10 | What a diagnostic code means and how to fix it | 1 | 1 | Ruff 2, Biome 1, ty 2 | 1 | ✓ | ✓ |
| 11 | False undefined-variable from an NSE helper | 1 | 1 | — | — | ✓ | — |
| 12 | `source(file.path(...))` | 1 | 1 | — | — | ✓ | — |
| 13 | Exit code 2 | 1 | 1 | Ruff 1, Biome nf, uv nf | 1 | ✓ | ✓ |
| 14 | Where project config lives | 1 | 0 | Ruff 1, Biome 2, uv 1 | 1 | ✓ | ✓ |
| 15 | Which `.lintr` options are honored | 2 | 1 | Jarl nf | nf | ✓ | ✓ |
| 16 | No diagnostics in one file | 1 | 1 | rust-analyzer 2, ty 2 | 2 | ✓ | ✓ |
| 17 | Gather logs for a bug report | nf | 1 | Ruff 1, rust-analyzer 2 | 1 | ✓ | ✓ |
| 18 | Set up GitHub Actions | 1 | 1 | Ruff 1, Jarl 1, Biome 2, uv 1 | 1 | ✓ | ✓ |
| 19 | Fail CI only on errors | 1 | 1 | Ruff 1, Biome 3 | 1 | ✓ | ✓ |
| 20 | Use Raven's console instead of vscode-R's | 1 | 1 | — | — | ✓ | — |

Baseline: 18/20 found; tasks 6 and 17 were not found. Final: 20/20 found, and every task with a counterpart meets (b).

## Rounds and fixes

1. **final** at `49b2a733`. All 20 were found at 1 click each. Task 1 (1 click) and task 2 (1 click) lost to Jarl (0). Fix: the README says how to see a first warning and how Raven differs from lintr and Jarl.
2. **final2** at `4732b0d4`. Tasks 1–3 were found at 0 clicks. Task 14 took 2 clicks against 1 for Ruff and uv. Fix: the README says where `raven.toml` lives and how it's found (`55d86e47`).
3. **final3** at `55d86e47`. A full re-run, because the README changed. Task 14 was found at 0 clicks. Tasks 9 and 16 took 2 clicks: the tester opened a second page to confirm an answer that `diagnostics.md` already gave. That page answered task 9 at 1 click in rounds 1 and 2. The `raven.toml` form for task 9 was a link away, though, so `diagnostics.md` now shows it inline (`c1317332`).
4. **final4** at `c1317332`. Tasks 9, 10, and 16 visit `diagnostics.md`, so two independent testers re-ran them. Both found all three at 1 click with high confidence. Tester A answered 16 from `diagnostics.md` and tester B from `troubleshooting.md`.
5. **final5** at `76d99864`. Merging `main`, which added Raven's console on Windows, changed one feature-table row in `editor-integrations.md`. Tasks 4, 5, and 6 visit that page, so they were re-run, and all three were found at 1 click with high confidence.

## Carry-forward

Between `55d86e47` and `c1317332`, only `docs/diagnostics.md` changed (`git diff --stat 55d86e47 c1317332`). final3's runs for every task except 9, 10, and 16 visited only pages that are byte-identical at the two SHAs, so they carry forward:

- README
- `ci.md`
- `coexistence.md`
- `cross-file.md`
- `directives.md`
- `editor-integrations.md`
- `linting.md`
- `non-standard-evaluation.md`
- `troubleshooting.md`

After acceptance, a reader found the R console page's opening confusing because it treated "the R terminal" and "the console" as two separate things. Commits `50fd5ab2` through `a8d78880`, `2018668d`, and `572f6612` restructured the top of `docs/r-console.md` around one console with a choice of program, and updated one link label in `docs/configuration.md`.

The merge from `main` at `76d99864` changed `cli.md`, `debugger.md`, `limitations.md`, `r-console.md`, and `editor-integrations.md`. Of these, only `editor-integrations.md` was visited by an acceptance run (tasks 4, 5, and 6), and those tasks were re-run as final5. `git diff --stat 76d99864 572f6612 -- README.md editors/vscode/README.md docs ':!docs/superpowers'` shows only `docs/r-console.md`. Every result in the table is therefore valid at `572f6612`.

## Spot checks

The implementer checked each final answer against the page it cites:

- Task 9: `raven check` reports `undefined-variable` and `unresolved-source-path`, exiting 1. After adding the `raven.toml` block shown in `diagnostics.md` ("Turn a category off"), it reports 0 issues and exits 0.
- Task 13: `ci.md` gives exit 2 as "could not run". `raven check .` with a malformed `raven.toml` prints `failed to load …/raven.toml` and exits 2.
- Task 19: `--max-severity warning` matches the bound `exit-on-errors-only` example.
- Task 4: the Neovim snippet in `editor-integrations.md` uses `cmd = { "raven", "--stdio" }`, which matches `raven --help`.
- Tasks 6 and 17: both answers come from text that appears on the pages.

## Transcripts

The delegated runs' full transcripts are in the T3 Code threads titled "Acceptance baseline: …", "Acceptance comparator: …", and "Acceptance final…: …". Each one ends with a numbered list of its tool calls.
