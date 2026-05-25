# Knit Preview — Suppress YAML Frontmatter Table — Design

**Status**: Design (post-brainstorming).
**Author**: jbearak.
**Scope**: Knit Preview only (md→html rendering). Does not affect knitr's Rmd→md step or the Pandoc export pipeline.

## Summary

The Knit Preview currently renders the document's YAML frontmatter as an HTML table at the top of the preview. The table is unwanted: YAML in an `.Rmd` is knit plumbing, not authorial content. This change strips the YAML frontmatter from the markdown source in memory before handing it to VS Code's `markdown.api.render`, so the rendered preview HTML never contains the frontmatter table. The on-disk `.md` is unchanged; Pandoc HTML export and the webview "Export ▾" path continue to read full YAML from disk and render the document's title/author/etc. exactly as before.

## Motivation

VS Code's built-in markdown extension (`vscode.markdown-language-features`) registers a `front_matter` block rule that, by default, emits:

```html
<table class="frontmatter" title="Frontmatter" data-vscode-context='{"webviewSection":"frontMatter"}'>
  <tbody>
    <tr><th>title</th><td>…</td></tr>
    …
  </tbody>
</table>
```

Raven's Knit Preview calls `vscode.commands.executeCommand('markdown.api.render', src)` (see [post-knit-renderer.ts:185](editors/vscode/src/knit/post-knit-renderer.ts:185)) to turn the post-knit `.md` into HTML, then writes the resulting HTML to disk and displays it in our own webview iframe. That command goes through the same rendering pipeline as VS Code's markdown preview pane, so the frontmatter table comes along for the ride.

VS Code exposes a global setting `markdown.preview.frontMatter` with values `"table"` / `"codeBlock"` / `"hide"`, but it's a *VS Code-wide* knob for all markdown previewing. We don't want to depend on the user reconfiguring it, and we don't want to override it (which could surprise users who set it to `"codeBlock"` for their regular markdown previewing). The right policy for Raven specifically is to *always* suppress the frontmatter rendering in the Knit Preview, regardless of that setting.

## Non-goals

- **No change to the Rmd→md step.** The R subprocess (`knitr::knit` driven from `editors/vscode/src/knit/r-expression.ts`) is untouched.
- **No change to Pandoc export.** Both the editor-toolbar `Knit: Export to …` commands and the webview "Export ▾" button read the `.md` directly from disk; the YAML frontmatter is preserved there and Pandoc's metadata handling (title heading, author, output options, `pandoc_args`) keeps working.
- **No new user-facing setting** (e.g. `raven.knit.preview.frontMatter`). The user asked for the table to be removed, not for a knob. If a future request comes in, the policy is centralized enough that adding the setting later is trivial.
- **No title-block synthesis.** We do not render an `<h1>` (or author/date block) from `title:` / `author:` / `date:` for the preview. Pandoc export already renders the full title block; the preview is a fast iteration surface, not a full reproduction of the export.
- **No webview / iframe trust-boundary changes.** The fix is entirely inside the md→html step that runs in the extension host. No new postMessage types, no changes to `MESSAGE_SCHEMAS`, no changes to the webview JS bundle.

## Architecture

One small pure helper, one call-site wiring.

### New helper

In [editors/vscode/src/knit/yaml-frontmatter.ts](editors/vscode/src/knit/yaml-frontmatter.ts), export a new function alongside the existing `extractFrontmatter`:

```ts
/**
 * Return `text` with the leading `---\n...\n---(\n|$)` frontmatter block
 * removed, or `text` unchanged when no terminated frontmatter block is
 * present at the start of the document.
 *
 * Matches `extractFrontmatter`'s detection rules verbatim: the strip
 * fires iff `extractFrontmatter(text) !== null`. CRLF inputs are
 * normalized to LF before matching, and the returned string carries LF
 * line endings.
 *
 * Used by the Knit Preview's md→html step (`renderKnitHtml`) so VS
 * Code's `markdown.api.render` never sees the frontmatter and therefore
 * never emits its `<table class="frontmatter">`. The on-disk `.md` is
 * unaffected — Pandoc HTML export still reads the full YAML.
 */
export function stripFrontmatter(text: string): string;
```

To keep the two helpers from drifting apart, factor the shared "find frontmatter end index" logic into a private helper:

```ts
/**
 * Returns the absolute index in `normalizedText` (post-BOM-strip,
 * post-CRLF→LF) one past the closing fence's trailing newline (or one
 * past the closing fence itself if the document ends without a newline
 * after it). Returns `null` when no terminated frontmatter exists.
 */
function findFrontmatterEnd(normalizedText: string): number | null;
```

Both `extractFrontmatter` and `stripFrontmatter` consume `findFrontmatterEnd`'s result and project to their respective return shapes (body vs. remainder).

### Strip semantics

- **BOM**: leading U+FEFF is stripped before matching (same as `extractFrontmatter`).
- **Line endings**: CRLF→LF normalization happens before matching (same as `extractFrontmatter`). The returned remainder carries LF line endings. `markdown.api.render` is line-ending agnostic so this is safe; the on-disk `.md` is untouched either way.
- **Match condition**: document must start with `---\n` (after BOM strip + CRLF normalization) AND have a closing `\n---` followed by `\n` or end-of-string later in the document. Anything less → no strip.
- **What's removed**: the opening `---\n`, the body, the closing `---`, and one optional newline immediately after the closing fence.
- **No-frontmatter docs**: returned with BOM strip + CRLF→LF normalization applied (matching `extractFrontmatter`'s precondition), but otherwise unchanged.

### Call-site

In [editors/vscode/src/knit/render-html.ts](editors/vscode/src/knit/render-html.ts), inside `renderKnitHtml`, change:

```ts
const html = await args.renderMarkdown(args.markdownSource);
```

to:

```ts
const html = await args.renderMarkdown(stripFrontmatter(args.markdownSource));
```

and import `stripFrontmatter` from `./yaml-frontmatter`. That's the only behavior change.

### Why `renderKnitHtml` and not `post-knit-renderer.ts`

`renderKnitHtml` is the pure, dependency-injected module that owns the md→html policy. Pre-stripping there:

- Keeps the policy in a single module that's exercised by the existing pure render-html test surface (no VS Code host needed for the regression test).
- Means anyone who later wires a different `renderMarkdown` (e.g. for testing, or a future replacement of `markdown.api.render`) inherits the strip automatically.
- Keeps `post-knit-renderer.ts` doing only what its name suggests (wiring live VS Code surfaces).

## What stays untouched (invariants this design preserves)

| Surface | What it does | Why it's unaffected |
|---|---|---|
| `knitr::knit` in R subprocess | Reads `.Rmd`, writes `.md` with full YAML | Strip happens entirely in TypeScript, post-knit. |
| Webview "Export ▾" → Pandoc | Reads on-disk `.md`, spawns Pandoc | Strip happens on the in-memory string passed to `markdown.api.render`, not on disk. |
| Editor-toolbar "Export to …" → Pandoc | Reads on-disk `.md`, spawns Pandoc | Same reason — disk untouched. |
| `parseOutputOptions` / `detectFormat` / `detectBlockers` | Parse YAML frontmatter | `stripFrontmatter` is a separate helper; the parser path doesn't change. |

## Test coverage

### Pure unit tests (bun, no VS Code host)

**`tests/bun/yaml-frontmatter.test.ts`** — add a `stripFrontmatter` describe block covering:

- No frontmatter → returns input unchanged (modulo normalization).
- Well-formed frontmatter with trailing newline (`---\n...\n---\n\nbody\n`) → strips opening fence, body, closing fence, and the one newline after it; returns `\nbody\n`.
- Frontmatter closing at end-of-string with no trailing newline (`---\n...\n---`) → strips cleanly; returns empty string.
- Unterminated frontmatter (`---\nbody\nno closing`) → returns input unchanged.
- Empty body (`---\n---\n`) → strips to empty remainder.
- Mid-body `---` only (no opener at byte 0) → returns input unchanged; not mistaken for a frontmatter close.
- BOM and CRLF inputs normalize the same way `extractFrontmatter` does.
- **Lockstep test**: for a curated set of inputs, assert `stripFrontmatter(x)` produces empty-or-not-empty consistent with `extractFrontmatter(x)` returning a body-or-`null`. Catches drift if the shared predicate is later refactored apart.

**`tests/bun/render-html.test.ts`** — add one case:

- Feed `renderKnitHtml` a fixture with `---\ntitle: Hi\nauthor: Me\n---\n\nBody.\n` and a fake `renderMarkdown` that records its input and returns a placeholder. Assert (a) the fake received exactly `\nBody.\n` (or the post-normalization equivalent), (b) the final assembled document does not contain the substrings `title:`, `author:`, or `frontmatter` anywhere in its body. This is the regression test for the user's complaint.

### Integration test (Mocha / `vscode-test`)

**`editors/vscode/src/test/knit-preview-yaml-stripped.test.ts`** — modeled on `knit-yaml-output-ignored.test.ts`:

- Write a temp `.Rmd` containing a `title:` frontmatter and a single-line body.
- Run the `raven.knit` (Knit Preview) command end-to-end.
- Read the resulting on-disk `<basename>.html` from the per-session temp dir.
- Assert the body markup is present AND the rendered HTML does NOT contain `<table class="frontmatter"` or the literal string `title`.

This catches the case where someone changes the wiring in `post-knit-renderer.ts` and forgets to keep the strip.

### Tests that do not change

- Pandoc export tests continue to assert that YAML-driven metadata (title, output options) flows through to the exported file. The strip happens in `renderKnitHtml`, not on a code path Pandoc export traverses.
- The webview trust-boundary tests (`tests/bun/knit-output-trust-boundary.test.ts`) are unaffected; no new message types.

## Risks and tradeoffs

1. **Users who want to see their YAML in the preview**: now can't (in the preview). The YAML is still present in the on-disk `.md` and is still rendered by Pandoc export (title block, author, date). If a real user request surfaces, add a `raven.knit.preview.frontMatter` setting with `"hide"` (new default) / `"codeBlock"` / `"table"` values mirroring VS Code's; the policy is centralized enough to make that a one-spot change. Not adding now (YAGNI).
2. **Drift between `stripFrontmatter` and `extractFrontmatter`**: mitigated by extracting the shared `findFrontmatterEnd` predicate and the lockstep test.
3. **VS Code changes the emitted frontmatter shape**: irrelevant under Approach A — we strip before invoking `markdown.api.render`, so whatever shape it would have emitted never enters the pipeline.

## Docs and AGENTS.md updates

**`AGENTS.md`** — add one bullet under the existing "Knit pipeline (Knit Preview + Pandoc Export)" key-invariants block:

> The Knit Preview's md→html step strips YAML frontmatter from the markdown source in memory **before** calling `markdown.api.render`, so the YAML never appears as a `<table class="frontmatter">` in the rendered HTML. The on-disk `.md` keeps its frontmatter — both Pandoc HTML export and the webview "Export ▾" path re-read it from disk and depend on the YAML (title, output options, `pandoc_args`, …). The strip is implemented in `renderKnitHtml` (`render-html.ts`), not in `post-knit-renderer.ts`, so the pure render-html test surface can exercise it. `stripFrontmatter` and `extractFrontmatter` in `yaml-frontmatter.ts` share a private `findFrontmatterEnd` predicate; the lockstep test in `tests/bun/yaml-frontmatter.test.ts` guards against drift.

**`docs/knit.md`** — add a one-line note where the rendering pipeline is described:

> YAML frontmatter is omitted from the preview rendering; it remains in the intermediate `.md` and drives Pandoc export (title, author, output options, `pandoc_args`).

## Out of scope (deliberate non-goals)

- No `r-expression.ts` changes.
- No Pandoc-invocation changes.
- No new user-facing setting.
- No title/author/date block synthesis for the preview.
- No webview / iframe / trust-boundary changes.
- No fixes to other ways the YAML might surface (e.g. a hypothetical future "show source" toggle); that's a separate feature with its own design.
