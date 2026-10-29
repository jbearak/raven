# Writer brief for the docs redesign

Date: 2026-10-29. Every writer rewriting a user page follows this brief: the orchestrator and each batch subagent alike. It condenses `2026-10-29-docs-redesign-design.md` (§2, §3.4, §3.5, §4, §5.1, §5.3, §7) and the plan's Phase 4 rules. When the two disagree, the design wins.

## What you're doing

You are rewriting existing pages so a new user can act on them in two minutes and a power user still finds every exact rule. **You are not changing what Raven does or claims.** Cut duplication and internals. Never change a behavioral claim. If you are unsure whether something is a duplicate, keep it and move it into `## Details`.

## Page shape

```markdown
# <Title>

[Docs](README.md) › <Group from docs/user-pages.json>

<One sentence lead: what this does for you.>

<Example: R code + Raven's result, a before/after with why the fix works, or a "you do → Raven does" table.>

## <Task-oriented sections, the "use it" layer>

## Settings          (only if there are settings: a short table linking into settings-reference.md)

## Limitations       (only if any)

## Details           (exact semantics; long items inside <details markdown="1">)

## See also          (2–5 links)
```

- Guide pages must keep the tail sections in exactly that order: Settings, Limitations, Details, See also. All four are optional.
- Reference pages (directives, configuration, settings-reference, cli, keybinding-comparison) need only the title, breadcrumb, lead, body, and an optional final See also.
- Long exact rules go in a block like this. The `markdown="1"` is required. The summary line names what's inside.

```html
<details markdown="1">
<summary>Exactly which <code>source()</code> paths Raven folds</summary>

...Markdown content...

</details>
```

## Style rules (enforced by `bun test tests/bun/docs`)

- Second person, plain words. No "we", "our", or "us". No marketing adjectives.
- Prose paragraphs are ≤100 words as a target; 150 is a hard fail. Table cells are ≤40 words.
- **No em dashes in prose.** Use a period or a comma. Tables may use `—` to mean "none".
- Use sentence-case headings, with no duplicate heading text within a page.
- No issue or PR numbers, no source paths (`crates/…`, `*.rs`, `editors/vscode/src/…`), and no internal type or function names. If a fact matters to users, state it as user behavior. If it only matters to maintainers, move it to your staging file for development.md.
- Each paragraph is one line in the source (no hard wrapping).
- Links to files outside `docs/` (the README, `demo/`, LICENSE, `editors/`) must be absolute: `https://github.com/jbearak/raven/blob/main/<path>`. Links between docs pages stay relative.
- Apply the unslop rules as well:
  - no puffery or AI vocabulary ("crucial", "seamless", "robust", "leverage")
  - no "serves as"
  - no inline bold-label lists that restate the line
  - prefer active voice and say what Raven does concretely

## Anchors (enforced by `tests/bun/docs/anchor-baseline.test.ts`)

**Never** remove an anchor listed for your page in `tests/bun/fixtures/docs-anchor-baseline.json`. Old releases link to them.

- If you rename a heading, put `<a id="old-slug"></a>` on its own line just above the new heading.
- If you move a section to another page, leave `<a id="old-slug"></a>` and a one-line pointer ("Moved to [X](x.md#y).") at the old spot, or at the most relevant remaining content.
- Explicit anchors are invisible on GitHub and on the site.

## Examples (enforced by `tests/bun/docs/examples.test.ts`)

Any code block that shows Raven CLI output must be one of two things:

- **Bound to the corpus.** Write the example in `docs/examples/snippets/<name>/`, with `cmd`, the files, and `stdout.txt`/`stderr.txt`/`exit`. The orchestrator or batch B regenerates those with `UPDATE_DOCS_EXAMPLES=1 cargo test -p raven --test docs_examples`, so ask rather than running cargo yourself unless you are batch B. Then show it as follows.

  ````markdown
  <!-- example: <name> -->
  ```console
  $ raven check .
  <exact stdout.txt content>
  ```
  ````

  A source file is shown as `<!-- example: <name> file=analysis.R -->` above an ```` ```r ```` block whose content equals that file.
- **Exempt with a reason**, given as `<!-- example-exempt: needs an installed package -->` directly above the block.

## Ledger and staging

- Fill in your pages' rows in `docs/superpowers/specs/ledger/<batch>.md`. Copy the rows for your pages from `docs/superpowers/specs/2026-10-29-docs-content-ledger.md`, and fill in Disposition and Destination for every H2/H3.
- Write anything moving to `docs/development.md` into `docs/superpowers/specs/dev-moves/<batch>.md`, with a heading per source page. Don't edit `development.md` directly.
- Write anything destined for another batch's page into `docs/superpowers/specs/moves/<target-page>.md`, with a heading naming the source.
- Don't edit files outside your batch's page list, except your staging files.
- Don't commit. The orchestrator reviews and commits.

## Checking your work

```sh
DOCS_LINT_REPORT=1 bun test tests/bun/docs 2>&1 | grep -E "docs/(your-page)\.md"
bun test tests/bun/docs/anchor-baseline.test.ts tests/bun/docs/links.test.ts
```

Both must be clean for your pages before you report back. In your final message, list:

- the pages changed
- anything you were unsure about and kept
- every claim you moved or reworded in a way a reviewer should double-check
