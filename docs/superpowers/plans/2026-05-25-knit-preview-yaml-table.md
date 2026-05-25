# Knit Preview — Suppress YAML Frontmatter Table — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suppress the `<table class="frontmatter">` that VS Code's `markdown.api.render` emits at the top of the Knit Preview HTML, without affecting the on-disk `.md` or the Pandoc export path.

**Architecture:** Add a `stripFrontmatter(text)` helper to `editors/vscode/src/knit/yaml-frontmatter.ts`, share the frontmatter-end-finding logic with the existing `extractFrontmatter` via a private `findFrontmatterEnd` predicate, and call `stripFrontmatter` once in `renderKnitHtml` (`editors/vscode/src/knit/render-html.ts`) immediately before invoking `args.renderMarkdown`. The on-disk `.md` (which Pandoc export reads) is never touched.

**Tech Stack:** TypeScript (VS Code extension); bun for pure unit tests; Mocha + `vscode-test` for integration tests. Test file conventions and `pretest`/`test` scripts are defined in `editors/vscode/package.json`.

**Spec:** [docs/superpowers/specs/2026-05-25-knit-preview-yaml-table-design.md](../specs/2026-05-25-knit-preview-yaml-table-design.md)

---

## File Structure

**Files to modify:**
- `editors/vscode/src/knit/yaml-frontmatter.ts` — add `stripFrontmatter` and the private `findFrontmatterEnd` helper; refactor `extractFrontmatter` to use the new predicate.
- `editors/vscode/src/knit/render-html.ts` — import `stripFrontmatter` and call it once inside `renderKnitHtml`.
- `tests/bun/yaml-frontmatter.test.ts` — add `describe('stripFrontmatter', ...)` block including a lockstep test against `extractFrontmatter`.
- `tests/bun/render-html.test.ts` — add one regression test that confirms `renderKnitHtml` strips frontmatter before invoking the injected `renderMarkdown`.
- `CLAUDE.md` — append one bullet under the "Knit pipeline" key-invariants block.
- `docs/knit.md` — add a one-line note in step 10 of the "What it does, step by step" pipeline description.

**Files to create:**
- `editors/vscode/src/test/knit-preview-yaml-stripped.test.ts` — integration test exercising `runPostKnitRender` end-to-end against a markdown source that contains YAML frontmatter.

**Files that intentionally do NOT change:**
- `editors/vscode/src/knit/r-expression.ts` — the R subprocess command is unaffected.
- `editors/vscode/src/knit/post-knit-renderer.ts` — strip happens inside `renderKnitHtml`, not in the VS Code wiring layer.
- `editors/vscode/src/knit/pandoc-engine.ts`, `pandoc-args.ts`, `output-options.ts` — export paths are unaffected.

---

## Task 1: Add `stripFrontmatter` helper with lockstep semantics

**Files:**
- Test: `tests/bun/yaml-frontmatter.test.ts`
- Modify: `editors/vscode/src/knit/yaml-frontmatter.ts`

### - [ ] Step 1: Write failing unit tests for `stripFrontmatter`

Open `tests/bun/yaml-frontmatter.test.ts`. The existing imports look like:

```ts
import {
    extractFrontmatter,
    parseFrontmatter,
    detectFormat,
    detectBlockers,
    isSupportedHtmlFormat,
} from '../../editors/vscode/src/knit/yaml-frontmatter';
```

Replace that import block with:

```ts
import {
    extractFrontmatter,
    parseFrontmatter,
    detectFormat,
    detectBlockers,
    isSupportedHtmlFormat,
    stripFrontmatter,
} from '../../editors/vscode/src/knit/yaml-frontmatter';
```

Then append the following describe block at the end of the file (after the existing `describe('detectBlockers', ...)` block — confirm by reading the bottom of the file):

```ts
describe('stripFrontmatter', () => {
    test('strips a well-formed frontmatter block with trailing newline', () => {
        const text = '---\ntitle: example\noutput: html_document\n---\n\nbody\n';
        // The opening `---\n`, the body, the closing `---`, and the
        // one newline immediately after the closing fence are removed.
        // The blank line that originally separated the closing fence
        // from `body` becomes the leading `\n` of the remainder.
        expect(stripFrontmatter(text)).toBe('\nbody\n');
    });

    test('strips frontmatter that ends at EOF without a trailing newline', () => {
        const text = '---\ntitle: x\n---';
        expect(stripFrontmatter(text)).toBe('');
    });

    test('strips a minimal-body frontmatter (one blank line between fences)', () => {
        // The closing-fence regex requires `\n---` (a newline BEFORE
        // the closing `---`), so a minimal frontmatter must have at
        // least one line — even an empty one — between the fences.
        const text = '---\n\n---\nbody\n';
        expect(stripFrontmatter(text)).toBe('body\n');
    });

    test('returns input unchanged when there is no opening fence', () => {
        const text = '# heading\n\nbody\n';
        expect(stripFrontmatter(text)).toBe(text);
    });

    test('returns input unchanged when the opening fence is not at byte 0', () => {
        const text = '\n---\ntitle: x\n---\nbody\n';
        expect(stripFrontmatter(text)).toBe(text);
    });

    test('returns input unchanged when the frontmatter is unterminated', () => {
        // No closing `---` after the opener — must NOT mistake a
        // later `---` mid-body for a closer either (there is none here).
        const text = '---\ntitle: x\nno close\n';
        expect(stripFrontmatter(text)).toBe(text);
    });

    test('does not mistake a body-side `---` for a frontmatter close', () => {
        // No frontmatter at all; the `---` appears as a horizontal
        // rule between paragraphs. Must come back unchanged.
        const text = 'intro\n\n---\n\nrest\n';
        expect(stripFrontmatter(text)).toBe(text);
    });

    test('strips a leading UTF-8 BOM before matching', () => {
        const text = '﻿---\ntitle: ok\n---\nbody\n';
        // BOM-stripped, frontmatter-stripped. Result is just the body
        // with no separating blank line, since the original had none.
        expect(stripFrontmatter(text)).toBe('body\n');
    });

    test('accepts CRLF line endings, returning LF in the remainder', () => {
        const text = '---\r\ntitle: x\r\n---\r\nbody\r\n';
        // CRLF→LF normalized before matching; remainder carries LF.
        expect(stripFrontmatter(text)).toBe('body\n');
    });

    test('lockstep with extractFrontmatter: same decision predicate', () => {
        // For every fixture, `stripFrontmatter` must change the input
        // iff `extractFrontmatter` returns a non-null body. This is
        // the contract that guards the shared `findFrontmatterEnd`
        // predicate.
        const fixtures: string[] = [
            '---\ntitle: x\n---\nbody\n',
            '---\ntitle: x\n---',
            '---\n\n---\nbody\n',
            '# heading\nbody\n',
            '---\nunterminated\n',
            '\n---\ntitle: x\n---\nbody\n',
            'intro\n\n---\n\nrest\n',
            '﻿---\ntitle: ok\n---\nbody\n',
            '---\r\ntitle: x\r\n---\r\nbody\r\n',
            '',
        ];
        for (const f of fixtures) {
            const stripped = stripFrontmatter(f);
            const extracted = extractFrontmatter(f);
            if (extracted === null) {
                expect(stripped).toBe(f);
            } else {
                expect(stripped).not.toBe(f);
            }
        }
    });
});
```

### - [ ] Step 2: Run tests to verify they fail

Run from the repo root:

```bash
bun test tests/bun/yaml-frontmatter.test.ts
```

Expected: all `stripFrontmatter` tests fail with a TypeScript / runtime error along the lines of `stripFrontmatter is not a function` or `does not exist on module`. Existing `extractFrontmatter`, `parseFrontmatter`, `detectFormat`, `detectBlockers`, `isSupportedHtmlFormat` tests still pass.

### - [ ] Step 3: Implement `findFrontmatterEnd` and `stripFrontmatter`; refactor `extractFrontmatter` to share the predicate

Open `editors/vscode/src/knit/yaml-frontmatter.ts`. The current shape is:

```ts
const BOM = '﻿';

/**
 * Strip the YAML front-matter block from the document text. Returns the
 * inner body of the fence with a normalized trailing newline, or `null`
 * when no terminated front-matter block is present. CRLF line endings are
 * normalized to LF so downstream parsing is line-ending-agnostic.
 */
export function extractFrontmatter(text: string): string | null {
    let body = text;
    if (body.startsWith(BOM)) body = body.slice(BOM.length);
    body = body.replace(/\r\n/g, '\n');

    if (!body.startsWith('---\n')) return null;

    const rest = body.slice(4);
    const closeMatch = rest.match(/\n---(?:\n|$)/);
    if (!closeMatch || closeMatch.index === undefined) return null;
    const inner = rest.slice(0, closeMatch.index);
    return inner.endsWith('\n') ? inner : inner + '\n';
}
```

Replace the entire `extractFrontmatter` function (and `BOM` constant — keep) with the following block:

```ts
const BOM = '﻿';

/**
 * Internal result describing where a well-formed frontmatter block sits
 * inside a *normalized* document (post-BOM-strip, post-CRLF→LF). Used by
 * both `extractFrontmatter` (which returns the inner body) and
 * `stripFrontmatter` (which returns the remainder of the document after
 * the closing fence).
 *
 * Sharing this predicate is the lockstep contract: the two callers must
 * always agree about whether a frontmatter block exists.
 */
interface FrontmatterBounds {
    /** Normalized document text (post-BOM-strip, post-CRLF→LF). */
    normalized: string;
    /** Inner body of the fence (between opening `---\n` and closing `---`), always ending with `\n`. */
    inner: string;
    /**
     * Index in `normalized` one past the closing fence's trailing
     * newline (or one past the closing fence itself if the document
     * ends without a newline after it). Used by `stripFrontmatter` as
     * the start of the remainder.
     */
    endIndex: number;
}

/**
 * Normalize the document (BOM strip + CRLF→LF) and locate the
 * frontmatter block, if any. Returns `null` when no terminated block is
 * present at byte 0 of the normalized document — same condition the old
 * `extractFrontmatter` used.
 */
function findFrontmatterEnd(text: string): FrontmatterBounds | null {
    let normalized = text;
    if (normalized.startsWith(BOM)) normalized = normalized.slice(BOM.length);
    normalized = normalized.replace(/\r\n/g, '\n');

    if (!normalized.startsWith('---\n')) return null;

    const rest = normalized.slice(4);
    const closeMatch = rest.match(/\n---(?:\n|$)/);
    if (!closeMatch || closeMatch.index === undefined) return null;

    const innerRaw = rest.slice(0, closeMatch.index);
    const inner = innerRaw.endsWith('\n') ? innerRaw : innerRaw + '\n';

    // Compute the absolute index in `normalized` immediately after the
    // matched close. `4` is the opening `---\n`; `closeMatch.index` is
    // where `\n---…` begins inside `rest`; `closeMatch[0].length` is the
    // length of `\n---` plus the optional trailing `\n` (or 0 at EOF).
    const endIndex = 4 + closeMatch.index + closeMatch[0].length;

    return { normalized, inner, endIndex };
}

/**
 * Strip the YAML front-matter block from the document text. Returns the
 * inner body of the fence with a normalized trailing newline, or `null`
 * when no terminated front-matter block is present. CRLF line endings are
 * normalized to LF so downstream parsing is line-ending-agnostic.
 */
export function extractFrontmatter(text: string): string | null {
    const bounds = findFrontmatterEnd(text);
    return bounds ? bounds.inner : null;
}

/**
 * Return `text` with the leading `---\n...\n---(\n|$)` frontmatter block
 * removed, or `text` unchanged when no terminated frontmatter block is
 * present at the start of the document.
 *
 * Matches `extractFrontmatter`'s detection rules verbatim: the strip
 * fires iff `extractFrontmatter(text) !== null`. CRLF inputs are
 * normalized to LF before matching, and the returned remainder carries
 * LF line endings.
 *
 * Used by the Knit Preview's md→html step (`renderKnitHtml`) so VS
 * Code's `markdown.api.render` never sees the frontmatter and therefore
 * never emits its `<table class="frontmatter">`. The on-disk `.md` is
 * unaffected — Pandoc HTML export still reads the full YAML.
 */
export function stripFrontmatter(text: string): string {
    const bounds = findFrontmatterEnd(text);
    if (!bounds) return text;
    return bounds.normalized.slice(bounds.endIndex);
}
```

### - [ ] Step 4: Run unit tests to verify they pass

```bash
bun test tests/bun/yaml-frontmatter.test.ts
```

Expected: all tests pass, including the new `stripFrontmatter` block and the unchanged `extractFrontmatter` tests.

### - [ ] Step 5: Commit

```bash
git add editors/vscode/src/knit/yaml-frontmatter.ts tests/bun/yaml-frontmatter.test.ts
git commit -m "$(cat <<'EOF'
feat(knit): add stripFrontmatter helper sharing extractFrontmatter's predicate

Pulls the BOM/CRLF normalization and `---\n...\n---(\n|$)` detection out
of `extractFrontmatter` into a private `findFrontmatterEnd` helper.
`extractFrontmatter` and the new `stripFrontmatter` both consume that
predicate, so they cannot disagree about whether a document has a
frontmatter block. Wired into renderKnitHtml in the next commit.
EOF
)"
```

---

## Task 2: Wire `stripFrontmatter` into `renderKnitHtml`

**Files:**
- Test: `tests/bun/render-html.test.ts`
- Modify: `editors/vscode/src/knit/render-html.ts`

### - [ ] Step 1: Write the failing regression test

Open `tests/bun/render-html.test.ts`. Inside the existing `describe('renderKnitHtml', ...)` block (starts around line 443), append the following test as a new sibling test inside that block (you can place it after the last existing test in the block — check the bottom of the file for the closing `});` of `renderKnitHtml` and insert just before it):

```ts
    test('strips YAML frontmatter from the markdown before calling renderMarkdown', async () => {
        // Regression test for the user-reported "Knit Preview prints
        // YAML as a table" behavior. The strip lives in renderKnitHtml
        // so VS Code's markdown.api.render never sees the frontmatter
        // and therefore never emits its `<table class="frontmatter">`
        // shape. The on-disk .md is untouched (Pandoc export depends on
        // the full YAML); this test only exercises the in-memory
        // strip handed to the injected renderMarkdown.
        const seenByRenderer: string[] = [];
        const markdownSource =
            '---\ntitle: Hi\nauthor: Me\n---\n\nBody text.\n';
        const out = await renderKnitHtml({
            markdownSource,
            renderMarkdown: async (src) => {
                seenByRenderer.push(src);
                return '<p>Body text.</p>';
            },
            registry: fakeRegistry({}),
        });

        // renderMarkdown received the post-strip source — no YAML
        // delimiters, no `title:` line.
        expect(seenByRenderer).toHaveLength(1);
        expect(seenByRenderer[0]).not.toContain('---');
        expect(seenByRenderer[0]).not.toContain('title:');
        expect(seenByRenderer[0]).not.toContain('author:');
        expect(seenByRenderer[0]).toContain('Body text.');

        // The assembled document body must not contain YAML fragments
        // either. We deliberately do not assert on the `<table
        // class="frontmatter">` shape here — that's VS Code's
        // markdown extension's emission, which we're not exercising
        // with the fake renderer. The end-to-end integration test in
        // editors/vscode/src/test/knit-preview-yaml-stripped.test.ts
        // covers that shape against the real renderer.
        expect(out).toContain('<p>Body text.</p>');
        expect(out).not.toContain('title:');
        expect(out).not.toContain('author:');
    });
```

Confirm the test file already imports `renderKnitHtml` and `fakeRegistry`. The existing imports at the top of the file include:

```ts
import {
    composeStylesheet,
    decodeCodeBlock,
    extractLanguageId,
    renderKnitHtml,
    resolveFontFamilies,
    sanitizeFontFamily,
} from '../../editors/vscode/src/knit/render-html';
```

and `fakeRegistry` is defined locally in the same file (search for `function fakeRegistry`). If those are not present (file was refactored), add the missing import and re-locate `fakeRegistry`.

### - [ ] Step 2: Run tests to verify the new test fails

```bash
bun test tests/bun/render-html.test.ts
```

Expected: the new test fails because the fake renderer's `seenByRenderer[0]` still contains `---` and `title:` (current code passes the raw `markdownSource` straight through). Existing `renderKnitHtml` tests pass — they don't use a frontmatter-containing source.

### - [ ] Step 3: Wire `stripFrontmatter` into `renderKnitHtml`

Open `editors/vscode/src/knit/render-html.ts`. The current imports at the top of the file include:

```ts
import type { GrammarRegistry } from './grammar-registry';
import {
    githubDark,
    githubLight,
    highlightCodeBlock,
    semanticOverlaysFromLspData,
    type GithubPalette,
} from './code-highlighter';
```

Immediately after the `./code-highlighter` import block, add:

```ts
import { stripFrontmatter } from './yaml-frontmatter';
```

Then locate the body of `renderKnitHtml` (around line 195). The current line is:

```ts
    const html = await args.renderMarkdown(args.markdownSource);
```

Replace it with:

```ts
    // Strip the YAML frontmatter before invoking the renderer so the
    // VS Code markdown pipeline never emits its `<table class="frontmatter">`
    // for the preview. The on-disk .md (which Pandoc export reads) is
    // untouched — the strip only mutates the in-memory string passed to
    // `args.renderMarkdown`. See
    // docs/superpowers/specs/2026-05-25-knit-preview-yaml-table-design.md.
    const html = await args.renderMarkdown(stripFrontmatter(args.markdownSource));
```

### - [ ] Step 4: Run tests to verify the new test passes

```bash
bun test tests/bun/render-html.test.ts
```

Expected: all tests pass, including the new strip-regression test.

### - [ ] Step 5: Run the full bun test suite to confirm no regressions elsewhere

```bash
bun test
```

Expected: all bun tests pass. Watch for failures in tests that feed a frontmatter-containing fixture into `renderKnitHtml` and previously expected the frontmatter to survive — there should be none (no existing tests depend on that behavior), but if one surfaces, it's a real expectation update.

### - [ ] Step 6: Commit

```bash
git add editors/vscode/src/knit/render-html.ts tests/bun/render-html.test.ts
git commit -m "$(cat <<'EOF'
fix(knit): strip YAML frontmatter from Knit Preview md->html

Calls stripFrontmatter on the markdownSource before invoking the
injected renderMarkdown (which production wires to VS Code's
`markdown.api.render`). Without this, the rendered preview HTML
contains a `<table class="frontmatter">` for every YAML block —
unwanted because YAML in an .Rmd is knit plumbing, not authorial
content. The on-disk .md is unchanged so Pandoc export still reads the
full YAML for title/author/output options/pandoc_args.
EOF
)"
```

---

## Task 3: Add the integration test exercising the real renderer

**Files:**
- Create: `editors/vscode/src/test/knit-preview-yaml-stripped.test.ts`

This test runs against the actual VS Code host (Mocha + `vscode-test`), invokes the real `runPostKnitRender`, and asserts that the resulting on-disk `.html` does not contain the frontmatter table. It catches regressions where someone changes the wiring in `post-knit-renderer.ts` and accidentally drops the strip.

### - [ ] Step 1: Create the integration test file

Create `editors/vscode/src/test/knit-preview-yaml-stripped.test.ts` with the following contents:

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from './helper';
import {
    runPostKnitRender,
    __resetRegistryCacheForTesting,
} from '../knit/post-knit-renderer';

/**
 * End-to-end check that Raven's Knit Preview md→html step strips the
 * YAML frontmatter from the markdown source before invoking VS Code's
 * `markdown.api.render`. Without the strip, the rendered HTML contains
 * the `<table class="frontmatter">` that VS Code's markdown extension
 * emits by default (or one of its alternate shapes if the user has set
 * `markdown.preview.frontMatter` differently).
 *
 * The fix lives in `renderKnitHtml` (see `render-html.ts`); this test
 * exercises the live VS Code wiring through `runPostKnitRender` so a
 * future regression in `post-knit-renderer.ts`'s use of `renderKnitHtml`
 * (e.g. a refactor that bypasses the strip) is caught.
 *
 * See docs/superpowers/specs/2026-05-25-knit-preview-yaml-table-design.md.
 */
suite('Knit Preview strips YAML frontmatter from md→html', () => {
    let tmp: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-knit-yaml-stripped-'));
        __resetRegistryCacheForTesting();
    });

    teardown(() => {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
        __resetRegistryCacheForTesting();
    });

    test('rendered .html contains no frontmatter table, even though the .md has YAML', async function () {
        this.timeout(30000);
        await activate();

        const mdPath = path.join(tmp, 'demo.md');
        const htmlPath = path.join(tmp, 'demo.html');
        // Simulate what knitr writes: the document keeps its YAML
        // frontmatter intact in the .md. The strip must happen on the
        // in-memory source the post-knit renderer passes to
        // markdown.api.render, NOT by editing this file on disk.
        const mdSource = [
            '---',
            'title: My Document Title',
            'author: The Author',
            'date: 2026-05-25',
            'output: html_document',
            '---',
            '',
            '# Body Heading',
            '',
            'KNIT-PREVIEW-YAML-STRIPPED-MARKER',
            '',
        ].join('\n');
        fs.writeFileSync(mdPath, mdSource, 'utf-8');

        const ravenExt = vscode.extensions.getExtension('jbearak.raven-r');
        assert.ok(ravenExt, 'raven extension must be present');
        const fakeContext = {
            extensionUri: ravenExt.extensionUri,
            subscriptions: [],
        } as unknown as vscode.ExtensionContext;

        await runPostKnitRender({
            mdPath,
            htmlPath,
            context: fakeContext,
            client: undefined,
        });

        assert.ok(
            fs.existsSync(htmlPath),
            `expected the renderer to have written ${htmlPath}`,
        );
        const html = fs.readFileSync(htmlPath, 'utf-8');

        // The body marker must be present — proves the renderer ran
        // and emitted the post-frontmatter content.
        assert.ok(
            html.includes('KNIT-PREVIEW-YAML-STRIPPED-MARKER'),
            'rendered HTML must include the body marker',
        );

        // Frontmatter must NOT be present in any of the shapes VS
        // Code's markdown extension emits today:
        //   - default `"table"` mode emits `<table class="frontmatter"`
        //   - `"codeBlock"` mode emits `class="frontmatter hljs"` etc.
        //   - any future shape using `data-vscode-context` with the
        //     frontMatter webview section
        assert.ok(
            !/<table[^>]*class="[^"]*\bfrontmatter\b/i.test(html),
            'rendered HTML must not contain a frontmatter <table>',
        );
        assert.ok(
            !/class="[^"]*\bfrontmatter\b[^"]*"/i.test(html),
            'rendered HTML must not contain any element with a `frontmatter` class',
        );
        assert.ok(
            !/data-vscode-context='[^']*frontMatter/i.test(html),
            'rendered HTML must not carry the frontmatter data-vscode-context',
        );

        // The literal YAML keys must not appear in the body either.
        // (The fixture used distinctive values so an incidental
        // substring match on `title` from CSS / metadata is implausible.)
        assert.ok(
            !html.includes('My Document Title'),
            'YAML title value must not appear in the rendered HTML body',
        );
        assert.ok(
            !html.includes('The Author'),
            'YAML author value must not appear in the rendered HTML body',
        );

        // The on-disk .md must still have its YAML — Pandoc export
        // re-reads this file and depends on the frontmatter for
        // title/author/output options.
        const mdAfter = fs.readFileSync(mdPath, 'utf-8');
        assert.ok(
            mdAfter.includes('title: My Document Title'),
            'on-disk .md must retain its YAML frontmatter',
        );
        assert.ok(
            mdAfter.includes('author: The Author'),
            'on-disk .md must retain its YAML frontmatter',
        );
    });
});
```

### - [ ] Step 2: Compile and run the integration suite

The `pretest` script compiles TypeScript first; `test` invokes `vscode-test`.

```bash
cd editors/vscode && bun run test
```

Expected: the new test passes alongside the existing knit suites. If the VS Code download is needed, the script fetches it on first run (can take a minute).

If you only want to run the new file (faster iteration):

```bash
cd editors/vscode && bun run compile:test && bun run test -- --run out/test/knit-preview-yaml-stripped.test.js
```

(`vscode-test`'s argument plumbing varies by version; the broad `bun run test` is the safe default.)

### - [ ] Step 3: Commit

```bash
git add editors/vscode/src/test/knit-preview-yaml-stripped.test.ts
git commit -m "$(cat <<'EOF'
test(knit): end-to-end check that Knit Preview HTML drops the YAML table

Runs runPostKnitRender against a real .md with frontmatter and asserts
that the rendered .html does not contain the VS Code markdown
extension's `<table class="frontmatter">` shape (or its alternate
class/data-vscode-context emissions). Also pins the invariant that the
on-disk .md keeps its YAML, so the Pandoc export path still gets the
title/author/output options.
EOF
)"
```

---

## Task 4: Update CLAUDE.md and docs/knit.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/knit.md`

### - [ ] Step 1: Add the CLAUDE.md invariant bullet

Open `CLAUDE.md` and locate the "Knit pipeline (Knit Preview + Pandoc Export)" key-invariants block (search for the literal string `**Knit pipeline (Knit Preview + Pandoc Export)**`). Find the bullet whose body starts with `Theme-palette role resolution uses a small R-code corpus` — that bullet is currently the last in the block.

Append a new bullet at the end of the block. The exact text to insert (after the closing of the last existing bullet, before the next top-level invariants block) is:

```markdown
  - **YAML frontmatter is stripped in `renderKnitHtml` before invoking `markdown.api.render`**, so the rendered preview HTML never contains VS Code's `<table class="frontmatter">`. The strip happens in memory on the string passed to the injected `renderMarkdown` — the on-disk `.md` keeps its frontmatter and Pandoc HTML export / webview "Export ▾" both re-read it from disk (they depend on the YAML for title/author/output options/`pandoc_args`). `stripFrontmatter` and `extractFrontmatter` in `yaml-frontmatter.ts` share a private `findFrontmatterEnd` predicate; the lockstep test in `tests/bun/yaml-frontmatter.test.ts` guards against drift. The integration test in `editors/vscode/src/test/knit-preview-yaml-stripped.test.ts` pins the end-to-end behavior.
```

### - [ ] Step 2: Update docs/knit.md step 10 of the pipeline

Open `docs/knit.md`. Find step 10 of the "What it does, step by step" section — the bullet that begins:

```markdown
10. **Post-knit render.** `knitr::knit` writes `<basename>.md` next to
    the source. Raven reads that markdown, calls VS Code's
    `markdown.api.render` to convert it to HTML (KaTeX math, image
    rewriting, scroll-sync metadata, and any registered `markdown-it`
    plugins all happen here), and then walks the result for
```

Replace the sentence `Raven reads that markdown, calls VS Code's \`markdown.api.render\` to convert it to HTML (KaTeX math, image rewriting, scroll-sync metadata, and any registered \`markdown-it\` plugins all happen here), and then walks the result for` with:

```markdown
    Raven reads that markdown, **strips the YAML frontmatter from the
    in-memory copy** (so the preview never shows a frontmatter table —
    the on-disk `.md` keeps its YAML for Pandoc export), then calls VS
    Code's `markdown.api.render` to convert it to HTML (KaTeX math,
    image rewriting, scroll-sync metadata, and any registered
    `markdown-it` plugins all happen here), and then walks the result
    for
```

### - [ ] Step 3: Verify docs files look right

```bash
git diff CLAUDE.md docs/knit.md
```

Expected: only the additions described above; no other lines touched.

### - [ ] Step 4: Commit

```bash
git add CLAUDE.md docs/knit.md
git commit -m "$(cat <<'EOF'
docs(knit): note the Knit Preview YAML-strip invariant

Records the rule in CLAUDE.md (alongside the other knit pipeline
invariants) and updates docs/knit.md's step-by-step description so
users reading the public docs see that the preview drops YAML while
the on-disk .md keeps it.
EOF
)"
```

---

## Task 5: Final verification across the project

### - [ ] Step 1: Run the full bun suite

```bash
bun test
```

Expected: all green. Tests that exercise `extractFrontmatter`, `stripFrontmatter`, the lockstep predicate, and `renderKnitHtml`'s strip-before-render all pass.

### - [ ] Step 2: Run the VS Code integration suite

```bash
cd editors/vscode && bun run test
```

Expected: all green, including `knit-preview-yaml-stripped.test.ts`, `knit-yaml-output-ignored.test.ts`, `post-knit-renderer.test.ts`, and the rest of the knit suites. The first run may take longer because `vscode-test` downloads the VS Code binary; subsequent runs are fast.

### - [ ] Step 3: Run the TypeScript type checker

```bash
cd editors/vscode && bun run typecheck
```

Expected: no errors. (Catches any drift in the public exports of `yaml-frontmatter.ts` or `render-html.ts` versus their consumers.)

### - [ ] Step 4: Confirm no inadvertent file changes

```bash
git status
```

Expected: clean (everything committed across tasks 1–4). If anything remains uncommitted, review and either fold it into the relevant earlier commit (via `git add` + `git commit --amend` only if you have not pushed) or add a small follow-up commit.

### - [ ] Step 5: Final sanity check — does the user-facing behavior actually change?

This is a manual visual check, not a scripted one. Open any `.Rmd` in the repo's demo/test fixtures that has a YAML frontmatter block, run `Raven: Knit Preview`, and confirm the rendered webview no longer shows the frontmatter table at the top. The preview should start at the first body element. (If the project's `docs/development.md` documents a launch-the-extension dance for manual checks, follow that.)

If the visual check passes, the implementation is complete.

---

## Acceptance criteria

1. `bun test` passes, including the new `stripFrontmatter` unit tests, the lockstep test against `extractFrontmatter`, and the `renderKnitHtml` strip-before-render regression test.
2. `cd editors/vscode && bun run test` passes, including the new `knit-preview-yaml-stripped.test.ts` integration test and all existing knit suites (`knit-yaml-output-ignored.test.ts`, `post-knit-renderer.test.ts`, `knit-progress-lifecycle.test.ts`, …).
3. `cd editors/vscode && bun run typecheck` reports no errors.
4. The rendered `.html` produced by `Raven: Knit Preview` on any `.Rmd` with YAML frontmatter does NOT contain `<table class="frontmatter"` or any element with a `frontmatter` class.
5. The on-disk `.md` produced by `knitr::knit` STILL contains the YAML frontmatter (Pandoc HTML export / webview "Export ▾" continue to work and render the title block).
6. `CLAUDE.md` records the new invariant; `docs/knit.md` mentions the strip in its step-by-step pipeline description.
