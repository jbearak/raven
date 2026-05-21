/**
 * Smoke test: drive the full `renderKnitHtml` pipeline against the
 * REAL R TextMate grammar shipped by VS Code's built-in `vscode.r`
 * extension. The handoff doc reports that the rendered HTML produces
 * monochrome code blocks even though the unit tests pass — so this
 * test reproduces the symptom against the real grammar.
 *
 * Assertions:
 *   - the produced HTML contains multiple distinct
 *     `var(--raven-c-XXX)` references inside `<pre><code
 *     class="language-r">` (one per distinct token role the grammar
 *     resolved to — that's the canary for "the grammar actually
 *     painted multiple roles")
 *   - `library` is painted with the `--raven-c-function` variable
 *     (which the stylesheet's `:root` rule binds to the palette's
 *     function color — light or dark depending on
 *     `prefers-color-scheme`)
 *
 * The test loads vscode-textmate + vscode-oniguruma from the real
 * `editors/vscode/node_modules`. No VS Code launch needed.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import { createGrammarRegistry } from '../../editors/vscode/src/knit/grammar-registry';
import { renderKnitHtml } from '../../editors/vscode/src/knit/render-html';
import type * as vscode from 'vscode';

const VSCODE_R_PATH =
    '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/r';
const ONIG_WASM = require.resolve('vscode-oniguruma/release/onig.wasm');

function makeRExtension(): vscode.Extension<unknown> {
    const pkg = JSON.parse(
        fs.readFileSync(path.join(VSCODE_R_PATH, 'package.json'), 'utf-8'),
    );
    return {
        id: 'vscode.r',
        extensionPath: VSCODE_R_PATH,
        packageJSON: pkg,
    } as unknown as vscode.Extension<unknown>;
}

function rExtensionAvailable(): boolean {
    try {
        fs.accessSync(path.join(VSCODE_R_PATH, 'syntaxes', 'r.tmLanguage.json'));
        fs.accessSync(ONIG_WASM);
        return true;
    } catch {
        return false;
    }
}

const itLive = rExtensionAvailable() ? test : test.skip;

describe('renderKnitHtml against the real R grammar', () => {
    itLive('produces colored spans (multiple distinct hex colours) for analysis.Rmd-style content', async () => {
        const rExt = makeRExtension();
        const registry = createGrammarRegistry({
            extensions: [rExt],
            getExtensionById: (id) => (id === 'vscode.r' ? rExt : undefined),
            onigWasmPath: ONIG_WASM,
        });

        // Mimic what `markdown.api.render` produces for an R fenced
        // block — `<pre><code class="language-r">…</code></pre>` with
        // highlight.js wrapper spans pre-injected by markdown-it's
        // `highlight` hook. The real VS Code render emits structure
        // like `library<span class="hljs-punctuation">(</span>…`; our
        // pipeline must strip those wrapper spans before tokenizing
        // (otherwise the grammar tokenizes the literal HTML markup
        // and the output is monochrome — see the handoff bug).
        const rSource = [
            'library(ggplot2)',
            'data <- mtcars',
            'ggplot(data, aes(x = wt, y = mpg)) +',
            '  geom_point() +',
            '  labs(title = "MPG vs Weight")',
        ].join('\n');
        // Pre-render the source in the same shape VS Code's
        // `markdown.api.render` emits: HTML-escape the user text, then
        // inject a few `<span class="hljs-…">` wrappers around the
        // punctuation that highlight.js actually wraps. Anything else
        // is a stand-in — the property we're locking down is that
        // `renderKnitHtml` strips the wrappers before tokenizing.
        const escape = (s: string) =>
            s
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        const inner = escape(rSource)
            .replace(/\(/g, '<span class="hljs-punctuation">(</span>')
            .replace(/\)/g, '<span class="hljs-punctuation">)</span>')
            .replace(/&lt;-/g, '<span class="hljs-operator">&lt;-</span>')
            .replace(/&quot;([^&]+)&quot;/g, '<span class="hljs-string">&quot;$1&quot;</span>');
        const renderedMarkdown =
            `<pre><code class="language-r">${inner}</code></pre>`;

        const finalHtml = await renderKnitHtml({
            markdownSource: '```r\n' + rSource + '\n```\n',
            renderMarkdown: async () => renderedMarkdown,
            registry,
            // No LSP overlay — we want to see whether the grammar
            // alone paints anything.
        });

        // Extract just the `<pre><code class="language-r">...</code></pre>` body.
        const blockMatch = finalHtml.match(
            /<pre><code class="language-r">([\s\S]*?)<\/code><\/pre>/,
        );
        expect(blockMatch).not.toBeNull();
        const body = blockMatch![1];

        // Collect every distinct `color:var(--raven-c-XXX)` in the
        // body. Spans now use CSS variables (so the stylesheet's
        // palette can be swapped under `prefers-color-scheme: dark`
        // without re-rendering); the "different roles got painted"
        // canary therefore looks for distinct variable references
        // rather than distinct hex colors.
        const roleVars = new Set<string>();
        for (const m of body.matchAll(/color:var\((--raven-c-[a-z]+)\)/g)) {
            roleVars.add(m[1]);
        }

        // Symptom assertions — these should all be true under a
        // working highlighter.
        expect(
            roleVars.size,
            `expected multiple distinct --raven-c-* role references inside the R code block but found ${
                roleVars.size
            } (${[...roleVars].join(', ')})\n---HTML body---\n${body}`,
        ).toBeGreaterThanOrEqual(2);

        // `library` should resolve to the function role — either via
        // the grammar's scope chain or via Raven's LSP overlay (not
        // exercised here). We assert the function-role CSS variable
        // appears on the `library` span.
        expect(
            body,
            `expected --raven-c-function (the function role) on the library span\n---HTML body---\n${body}`,
        ).toContain('color:var(--raven-c-function)">library');
    });

    itLive('grammar registry can prime the R language', async () => {
        const rExt = makeRExtension();
        const registry = createGrammarRegistry({
            extensions: [rExt],
            getExtensionById: (id) => (id === 'vscode.r' ? rExt : undefined),
            onigWasmPath: ONIG_WASM,
        });
        expect(await registry.primeForLanguage('r')).toBe(true);
    });

    itLive('tokenizes library(ggplot2) into multiple non-trivial scope chains', async () => {
        const rExt = makeRExtension();
        const registry = createGrammarRegistry({
            extensions: [rExt],
            getExtensionById: (id) => (id === 'vscode.r' ? rExt : undefined),
            onigWasmPath: ONIG_WASM,
        });
        const tokenization = await registry.tokenizeLineForLanguage(
            'r',
            'library(ggplot2)',
            null,
        );
        expect(tokenization).not.toBeNull();
        const scopeChains = tokenization!.tokens.map((t) => t.scopes.join(' | '));
        // Sanity dump for debugging
        const dump = tokenization!.tokens.map((t) => ({
            range: [t.startIndex, t.endIndex] as const,
            text: 'library(ggplot2)'.slice(t.startIndex, t.endIndex),
            scopes: [...t.scopes],
        }));
        // We expect at LEAST one scope to point at the function call
        // head. The exact scope name depends on the grammar version,
        // but it should include `function-call` or `entity.name.function`.
        const allScopes = tokenization!.tokens.flatMap((t) => [...t.scopes]);
        const hasFunctionishScope = allScopes.some((s) =>
            /function/.test(s),
        );
        expect(
            hasFunctionishScope,
            `expected a function-related scope in ${JSON.stringify(scopeChains)}; dump=${JSON.stringify(dump, null, 2)}`,
        ).toBe(true);
    });
});
