# Handoff: rendered-HTML code blocks are monochrome

## Goal

The `rmd-html-syntax-highlighting` feature — currently the tip of the
branch `worktree-rmd-html-syntax-highlighting` (worktree at
`/Users/jmb/repos/Extensions/raven/.claude/worktrees/rmd-html-syntax-highlighting`)
— is supposed to paint code blocks in `Raven: Knit`'s output HTML
using the GitHub light/dark palette. The full pipeline compiles,
all tests pass, but the visible result is broken: code blocks in
both the VS Code Knit Output panel and the standalone HTML
(opened in a browser) render as **flat monochrome black/grey
text**, with none of the function names, operators, strings, or
keywords coloured.

Demo input: `demo/rmarkdown-quarto/analysis.Rmd`. After running
`Raven: Knit` on it, the editor shows full syntax highlighting on
the source (function names in the function colour, `<-` in an
operator colour, strings in an orange colour), but the rendered
HTML next to it shows everything in the default colour.

## Recommended approach

Use the **superpowers:systematic-debugging** skill. The bug is a
silent failure: the pipeline runs end-to-end without errors and
produces a self-contained HTML with what *looks like* properly
shaped spans — but the spans aren't producing visible colour. The
unit tests pass because they use toy tokenizers that always emit
the expected scopes; the real grammar's output is the gap.

**First step: write a smoke test that reproduces the symptom.**
Run `Raven: Knit` on `demo/rmarkdown-quarto/analysis.Rmd` (or
inline the source into a VS Code integration test that drives the
full pipeline), then assert that the resulting `.html` contains
distinct CSS colour values for `library`, `mtcars`, `<-`, `=`,
`"MPG vs Weight"`, etc. — at minimum, that the HTML has multiple
distinct hex colours inside `<pre><code class="language-r">`. The
current `editors/vscode/src/test/post-knit-renderer.test.ts`
suite uses `client: undefined` and asserts only structure, so it's
not catching this.

## Architecture you'll be working in

The pipeline (all under `editors/vscode/src/knit/`):

1. `runKnitCommand` (`knit-commands.ts`) builds the R expression
   via `buildKnitExpression` in `r-expression.ts`. It now calls
   `knitr::knit(input, output = '<basename>.md', ...)` and emits
   `cat('Output created: ', out, '\\n', sep = '')`.
2. After R succeeds, `renderOutcome`'s ok branch invokes
   `runPostKnitRender` (`post-knit-renderer.ts`).
3. `runPostKnitRender` reads `<basename>.md`, force-activates
   `vscode.markdown-language-features` + `vscode.markdown-math`,
   builds a cached `GrammarRegistry` from `vscode.extensions.all`
   (via `getOrCreateRegistry`), reads KaTeX CSS from
   `vscode.markdown-math`'s contributed `markdown.previewStyles`
   (note: flat key with a literal dot, NOT nested), and calls
   `renderKnitHtml` in `render-html.ts`.
4. `renderKnitHtml`:
   - Calls `markdown.api.render(source)` via
     `vscode.commands.executeCommand` to get HTML.
   - Walks the HTML for `<pre><code class="...language-X...">`
     blocks via a loose regex (`render-html.ts:rewriteCodeBlocks`).
   - For each block:
     - Extracts the language ID (`extractLanguageId`).
     - HTML-decodes the body (`decodeCodeBlock` reverses `&amp;
       &lt; &gt; &quot; &#39;`).
     - For R blocks, fetches `raven/semanticTokensForRString` from
       the LSP and decodes via `semanticOverlaysFromLspData` in
       `code-highlighter.ts`.
     - Calls `highlightCodeBlock` which calls
       `registry.tokenizeLineForLanguage(langId, line, ruleStack)`
       per line and walks scope-token boundaries to emit
       `<span style="color:...">` runs via `paintLine`.
   - Composes a stylesheet from `github-colors.ts` palettes.
5. Writes `<basename>.html` atomically (`writeFileAtomic`).
6. `KnitOutputPanel.updateContent` loads that `.html` into a
   srcdoc iframe (untouched from the existing webview code).

The grammar layer:

- `grammar-registry.ts` lazy-loads `vscode-textmate` and
  `vscode-oniguruma`. The Oniguruma WASM lives at
  `<context.extensionUri>/dist/onig.wasm`; the build script
  copies it from `node_modules/vscode-oniguruma/release/onig.wasm`.
- R grammar resolution uses the priority list
  `reditorsupport.r-syntax`, `reditorsupport.r`, `vscode.r`.
- `collectGrammarContributions` runs two passes so `byScopeName`
  reflects the same priority logic as `pickContribution` (fixed
  during stage 3's Codex review).
- `tokenizeLineForLanguage` uses the NON-binary `tokenizeLine`
  variant so we get scope name arrays (e.g.
  `['source.r', 'entity.name.function.r']`) rather than an opaque
  theme-color index.
- `scopeToRole` in `github-colors.ts` maps scope arrays
  innermost-first to a small token-role vocabulary.

## Most likely suspects (in priority order)

1. **The R grammar isn't being loaded at runtime.**
   - The user's screenshot shows the editor highlights R chunks of
     the `.Rmd` perfectly — so they DO have an R grammar installed.
     But our `getOrCreateRegistry` may be silently picking up the
     wrong language ID, or `tokenizeLineForLanguage` may be
     returning `null` for every line (in which case
     `tokenizeWithScopes` falls back to bare escapeHtml).
   - Add logging in `post-knit-renderer.ts` /
     `grammar-registry.ts` to confirm whether
     `primeForLanguage('r')` returns true at runtime against the
     user's installed grammars.

2. **Markdown-it / VS Code's pipeline emits an unexpected class
   string and `extractLanguageId` fails.**
   - The preflight test showed `<pre><code data-line="12"
     class="language-r code-line" dir="auto">`. My regex matches
     `class="..."` and `class='...'`. But what if VS Code's
     pipeline emits the class without quotes, or escapes the `r`
     class in some way? Check the actual class string at runtime.

3. **The R-grammar `tokenizeLine` returns scopes my
   `scopeToRole` mapping doesn't handle.**
   - REditorSupport's R grammar uses scopes like
     `entity.name.function.r`, `meta.function-call.r`,
     `keyword.operator.assignment.r`, `support.function.r`, etc.
     `scopeToRole` covers `entity.name.function`,
     `support.function`, `keyword.operator.*`, etc. But maybe
     REditorSupport uses `meta.function-call.r` for call heads
     without `entity.name.function.r` — and our mapping doesn't
     catch `meta.function-call.*`. Inspect the actual scope
     arrays the live grammar produces for `library(ggplot2)`.

4. **vscode-textmate's `tokenizeLine` is returning `null` early
   because the grammar reference isn't resolving its includes.**
   - REditorSupport's grammar may `include` an embedded grammar
     (e.g. for backslash escapes in strings). If that include
     can't be resolved by our Registry's `loadGrammar` callback
     (which only honours scope names registered in
     `byScopeName`), the engine might bail out silently.

5. **CRLF / line splitting drift between `markdown.api.render`'s
   output and `highlightCodeBlock`'s splitter.**
   - We split on `\n` and trim trailing `\r`. If the rendered
     HTML preserves `\r\n` inside code blocks (unlikely but
     possible) and our decoder doesn't strip it from the
     pre-tokenize string, the grammar's first-line patterns
     might fail to anchor.

6. **The `<pre><code>` regex misses a real-world variant.**
   - The regex requires `<code` directly after `<pre`. VS Code's
     pipeline could in theory emit `<pre data-line="12"><code>`
     or `<pre><code\n  class="...">`. Worth verifying via the
     live HTML.

## What to verify first

```bash
# Drive a real knit and inspect the produced HTML:
cd /Users/jmb/repos/Extensions/raven/.claude/worktrees/rmd-html-syntax-highlighting
# Trigger Raven: Knit on demo/rmarkdown-quarto/analysis.Rmd, then:
cat demo/rmarkdown-quarto/analysis.html | head -200
```

Look for:
- The actual `<pre><code class="...">` shape.
- Whether code blocks contain any `<span style="color:...">` runs
  at all (versus naked text).
- Whether the encoded source text matches what was in the source
  file (i.e., that HTML decoding round-trips).

Then trace the grammar resolution: add a `console.log` in
`grammar-registry.ts:loadGrammar` to print the resolved
`absolutePath` and whether `parseRawGrammar` produces a non-null
result. Add another in `code-highlighter.ts:tokenizeWithScopes`
to log the scope arrays the first few tokens carry, so we know
what the live grammar is actually emitting.

## Tests you should add (TDD-style)

1. A VS Code integration test that knits the real
   `demo/rmarkdown-quarto/analysis.Rmd` (or a minimal Rmd with one
   R chunk) end-to-end and asserts the resulting `.html`:
   - Contains at least N distinct hex colours inside the
     `<pre><code class="language-r">` body.
   - Specifically contains the function colour
     (`githubLight.roles.function` = `#8250df`) on `library`.
   - Specifically contains the string colour
     (`githubLight.roles.string` = `#0a3069`) on the literal
     `"MPG vs Weight"`.

2. A bun test that exercises `paintLine` against scope arrays
   matching what REditorSupport's R grammar actually emits.
   Grep the grammar JSON
   (`.vscode-test/.../app/extensions/r/syntaxes/r.tmLanguage.json`
   or REditorSupport.r-syntax's installed grammar) for the scope
   names it uses for function call heads, operators, and
   strings, and write the test against those exact scope
   strings.

## Don't regress

- The chunk-aware semantic tokens for `.Rmd` / `.qmd` documents
  (in the LSP) work in the editor — keep that pathway intact.
- The format-gating refusal flow (non-HTML output formats) still
  works; the related VS Code integration tests in
  `editors/vscode/src/test/knit-html-only.test.ts` should
  continue to pass.
- The atomic-write + grammar-registry-cache fixes from stage 4's
  Codex review should NOT regress; see
  `editors/vscode/src/knit/post-knit-renderer.ts:writeFileAtomic`
  and `getOrCreateRegistry`.

## Commits on the branch (in order)

```
9c4b6b01 docs(knit): document the HTML-only knit pipeline and the new highlighter
45b54964 fix(knit): atomic .html write and process-wide grammar registry cache
dba8e4e0 feat(knit): wire post-knit HTML rendering into Raven: Knit
0e975d8e feat(knit): switch R subprocess to knitr::knit, predict .md output path TS-side
aae12420 feat(knit): post-knit HTML rendering orchestration
7ddcf63a fix(knit): preserve R grammar priority through Registry.loadGrammar; clip LSP overlay tokens to line EOL
e58b770a feat(knit): grammar-aware code highlighter for the knit pipeline
fa64d4be feat(knit): refuse non-HTML output formats with a copy-paste command
a076201d feat(lsp): chunk-aware semantic tokens for Rmd/Quarto
```

The goal `/goal Implement this spec and submit a PR after it
passes codex adversarial review. To aid in this outcome, use codex
to review your work after each stage` is still active; please run
a Codex review on the fix once you have it.
