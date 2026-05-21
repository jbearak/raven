import { describe, test, expect } from 'bun:test';
import {
    composeStylesheet,
    decodeCodeBlock,
    extractLanguageId,
    renderKnitHtml,
} from '../../editors/vscode/src/knit/render-html';
import { githubDark, githubLight } from '../../editors/vscode/src/knit/code-highlighter';
import type {
    GrammarRegistry,
    ScopeToken,
} from '../../editors/vscode/src/knit/grammar-registry';

function fakeRegistry(
    tokenizers: Record<string, (line: string) => ScopeToken[]>,
): GrammarRegistry {
    return {
        async tokenizeLineForLanguage(languageId, line) {
            const tokenizer = tokenizers[languageId.toLowerCase()];
            if (!tokenizer) return null;
            return { tokens: tokenizer(line), ruleStack: null };
        },
        scopeNameFor(languageId) {
            return tokenizers[languageId.toLowerCase()] ? `source.${languageId}` : null;
        },
        async primeForLanguage(languageId) {
            return Boolean(tokenizers[languageId.toLowerCase()]);
        },
    };
}

describe('extractLanguageId', () => {
    test('finds language-X in a single class attribute', () => {
        expect(extractLanguageId(' data-line="2" class="language-r code-line" dir="auto"')).toBe('r');
    });

    test('matches single-quoted attributes too', () => {
        expect(extractLanguageId(" class='language-python'")).toBe('python');
    });

    test('lowercases the language id', () => {
        expect(extractLanguageId(' class="language-R"')).toBe('r');
    });

    test('returns null when no language- class is present', () => {
        expect(extractLanguageId(' class="code-line"')).toBeNull();
        expect(extractLanguageId('')).toBeNull();
    });
});

describe('decodeCodeBlock', () => {
    test('reverses the standard HTML escapes', () => {
        expect(decodeCodeBlock('a &amp; b &lt;= c &gt; d &quot;e&quot; f&#39;g'))
            .toBe(`a & b <= c > d "e" f'g`);
    });

    test('double-escaped ampersands round-trip correctly', () => {
        // `&amp;lt;` should decode to `&lt;`, not `<`.
        expect(decodeCodeBlock('&amp;lt;')).toBe('&lt;');
    });

    test('strips inline highlight.js wrapper spans before decoding entities', () => {
        // VS Code's `markdown.api.render` pre-tokenizes code blocks
        // via markdown-it's `highlight` hook (highlight.js by
        // default), so the `<code>` body we receive contains nested
        // `<span class="hljs-...">…</span>` wrappers. Those tags are
        // markup, not source — they must be stripped before we
        // hand the text to vscode-textmate or the grammar will
        // tokenize the literal HTML markup as code.
        const encoded =
            'library<span class="hljs-punctuation">(</span>' +
            'ggplot2<span class="hljs-punctuation">)</span>';
        expect(decodeCodeBlock(encoded)).toBe('library(ggplot2)');
    });

    test('preserves user-source `<` (entity-escaped) after stripping markup', () => {
        // Source `x <- 1` arrives as `x <span class="hljs-keyword">&lt;-</span> 1`.
        // After stripping spans + decoding entities we should be left
        // with `x <- 1` exactly.
        const encoded = 'x <span class="hljs-keyword">&lt;-</span> 1';
        expect(decodeCodeBlock(encoded)).toBe('x <- 1');
    });

    test('does not eat literal `&lt;span&gt;` text inside the source', () => {
        // Pathological: the source itself literally contains `<span>`.
        // The renderer escapes it to `&lt;span&gt;`. After our pass
        // there are no real tags to strip, and entity-decoding
        // restores the literal text.
        expect(decodeCodeBlock('foo &lt;span&gt; bar')).toBe('foo <span> bar');
    });
});

describe('composeStylesheet', () => {
    test('null themeClasses emits both palettes via prefers-color-scheme', () => {
        const css = composeStylesheet(null);
        expect(css).toContain('color-scheme: light dark');
        expect(css).toContain('prefers-color-scheme: dark');
        expect(css).toContain(githubLight.background);
        expect(css).toContain(githubDark.background);
    });

    test('vscode-light produces only the light palette and no media query', () => {
        const css = composeStylesheet('vscode-light');
        expect(css).toContain('color-scheme: light');
        expect(css).not.toContain('prefers-color-scheme');
        expect(css).toContain(githubLight.background);
        expect(css).not.toContain(githubDark.background);
    });

    test('vscode-dark produces only the dark palette and no media query', () => {
        const css = composeStylesheet('vscode-dark');
        expect(css).toContain('color-scheme: dark');
        expect(css).not.toContain('prefers-color-scheme');
        expect(css).toContain(githubDark.background);
        expect(css).not.toContain(githubLight.background);
    });
});

describe('renderKnitHtml', () => {
    /** Toy R tokenizer (same shape as the code-highlighter test). */
    function toyRTokenizer(line: string): ScopeToken[] {
        const tokens: ScopeToken[] = [];
        let i = 0;
        while (i < line.length) {
            const ch = line[i];
            if (/[A-Za-z]/.test(ch)) {
                let j = i + 1;
                while (j < line.length && /[A-Za-z0-9_.]/.test(line[j])) j++;
                tokens.push({ startIndex: i, endIndex: j, scopes: ['source.r', 'entity.name.function.r'] });
                i = j;
                continue;
            }
            tokens.push({ startIndex: i, endIndex: i + 1, scopes: ['source.r'] });
            i++;
        }
        return tokens;
    }

    test('rewrites an R code block with grammar-aware spans', async () => {
        // markdown.api.render produces this shape (highlight.js spans
        // around the source). We use a simpler raw form here.
        const fakeHtml =
            '<p>prose</p>\n<pre><code class="language-r">library</code></pre>\n<p>after</p>';
        const out = await renderKnitHtml({
            markdownSource: 'irrelevant — renderMarkdown returns a fixed value',
            renderMarkdown: async () => fakeHtml,
            registry: fakeRegistry({ r: toyRTokenizer }),
        });

        // The body must include a span with the function color.
        expect(out).toContain(
            `<span style="color:${githubLight.roles.function}">library</span>`,
        );
        // Surrounding prose is preserved.
        expect(out).toContain('<p>prose</p>');
        expect(out).toContain('<p>after</p>');
    });

    test('leaves untagged code blocks intact', async () => {
        const fakeHtml = '<pre><code>raw text &amp; symbols</code></pre>';
        const out = await renderKnitHtml({
            markdownSource: 'x',
            renderMarkdown: async () => fakeHtml,
            registry: fakeRegistry({ r: toyRTokenizer }),
        });

        // The bare `<pre><code>raw text &amp; symbols</code></pre>`
        // must round-trip without spans or escaping changes.
        expect(out).toContain('<pre><code>raw text &amp; symbols</code></pre>');
    });

    test('overlays R function semantic tokens on top of the grammar', async () => {
        // Pretend the grammar mis-tokenizes the identifier as a
        // variable; the LSP overlay should still promote it to
        // function color.
        const fakeHtml = '<pre><code class="language-r">library</code></pre>';
        const flatTokenizer = (_line: string): ScopeToken[] => [{
            startIndex: 0,
            endIndex: 7,
            scopes: ['source.r', 'variable.other.r'],
        }];
        // LSP semantic tokens for `library` (7 chars from col 0, line 0).
        const tokensData = [0, 0, 7, 0, 0];
        const out = await renderKnitHtml({
            markdownSource: 'x',
            renderMarkdown: async () => fakeHtml,
            registry: fakeRegistry({ r: flatTokenizer }),
            fetchRSemanticTokens: async () => tokensData,
        });

        expect(out).toContain(
            `<span style="color:${githubLight.roles.function}">library</span>`,
        );
    });

    test('non-R blocks do not call fetchRSemanticTokens', async () => {
        const fakeHtml = '<pre><code class="language-python">import math</code></pre>';
        let fetchCalled = false;
        await renderKnitHtml({
            markdownSource: 'x',
            renderMarkdown: async () => fakeHtml,
            registry: fakeRegistry({ python: toyRTokenizer }),
            fetchRSemanticTokens: async () => {
                fetchCalled = true;
                return [];
            },
        });
        expect(fetchCalled).toBe(false);
    });

    test('inlines KaTeX CSS when provided', async () => {
        const fakeHtml = '<p>math</p>';
        const out = await renderKnitHtml({
            markdownSource: 'x',
            renderMarkdown: async () => fakeHtml,
            registry: fakeRegistry({}),
            katexCss: '.katex { color: blue; }',
        });
        expect(out).toContain('.katex { color: blue; }');
    });

    test('produces a self-contained document with doctype, head, body', async () => {
        const fakeHtml = '<p>hi</p>';
        const out = await renderKnitHtml({
            markdownSource: 'x',
            renderMarkdown: async () => fakeHtml,
            registry: fakeRegistry({}),
        });
        expect(out).toMatch(/^<!doctype html>/i);
        expect(out).toContain('<head>');
        expect(out).toContain('<body>');
        expect(out).toContain('<p>hi</p>');
    });

    test('decodes HTML entities in the code block before tokenizing', async () => {
        // `&lt;-` is markdown-it's escape of `<-`. The decoder must
        // turn it back into `<-` before the toy tokenizer sees it, so
        // the toy tokenizer's "letters → function" rule fires on
        // `f` rather than on `f&` or some malformed sequence.
        const fakeHtml = '<pre><code class="language-r">f &lt;- 1</code></pre>';
        const out = await renderKnitHtml({
            markdownSource: 'x',
            renderMarkdown: async () => fakeHtml,
            registry: fakeRegistry({ r: toyRTokenizer }),
        });
        // The `<` MUST be HTML-escaped in the OUTPUT (because we're
        // re-encoding code-block text for HTML safety). The
        // `<span>` wrapper around `f` MUST appear at start.
        expect(out).toContain(
            `<span style="color:${githubLight.roles.function}">f</span>`,
        );
        expect(out).toContain('&lt;-');
    });

    test('emits a dark palette when themeClasses says dark', async () => {
        const fakeHtml = '<pre><code class="language-r">library</code></pre>';
        const out = await renderKnitHtml({
            markdownSource: 'x',
            renderMarkdown: async () => fakeHtml,
            registry: fakeRegistry({ r: toyRTokenizer }),
            themeClasses: 'vscode-dark',
        });
        expect(out).toContain(
            `<span style="color:${githubDark.roles.function}">library</span>`,
        );
        expect(out).toContain(githubDark.background);
        expect(out).not.toContain(githubLight.background);
    });

    test('falls back to grammar-only when fetchRSemanticTokens throws', async () => {
        const fakeHtml = '<pre><code class="language-r">library</code></pre>';
        const out = await renderKnitHtml({
            markdownSource: 'x',
            renderMarkdown: async () => fakeHtml,
            registry: fakeRegistry({ r: toyRTokenizer }),
            fetchRSemanticTokens: async () => {
                throw new Error('lsp unreachable');
            },
        });
        // The toy tokenizer scopes letters as functions, so we still
        // get a function span — the overlay just isn't applied.
        expect(out).toContain(
            `<span style="color:${githubLight.roles.function}">library</span>`,
        );
    });
});
