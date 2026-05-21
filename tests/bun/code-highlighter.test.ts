import { describe, test, expect } from 'bun:test';
import {
    escapeHtml,
    githubDark,
    githubLight,
    highlightCodeBlock,
    paletteForThemeClasses,
    scopeToRole,
    semanticOverlaysFromLspData,
    type SemanticOverlay,
} from '../../editors/vscode/src/knit/code-highlighter';
import type {
    GrammarRegistry,
    LineTokenization,
    ScopeToken,
} from '../../editors/vscode/src/knit/grammar-registry';

/**
 * Fake grammar registry. Each language ID maps to a function that
 * tokenizes one line of source. This lets the highlighter unit tests
 * drive predictable scope arrays without paying the vscode-textmate +
 * onig.wasm cost.
 */
function fakeRegistry(
    tokenizers: Record<string, (line: string) => ScopeToken[]>,
): GrammarRegistry {
    return {
        async tokenizeLineForLanguage(languageId, line) {
            const tokenizer = tokenizers[languageId.toLowerCase()];
            if (!tokenizer) return null;
            const tokens = tokenizer(line);
            return { tokens, ruleStack: null } satisfies LineTokenization;
        },
        scopeNameFor(languageId) {
            return tokenizers[languageId.toLowerCase()] ? `source.${languageId}` : null;
        },
        async primeForLanguage(languageId) {
            return Boolean(tokenizers[languageId.toLowerCase()]);
        },
    };
}

describe('escapeHtml', () => {
    test('escapes the five HTML metacharacters', () => {
        expect(escapeHtml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
    });
});

describe('scopeToRole', () => {
    test('prefers the innermost matching scope', () => {
        expect(scopeToRole(['source.r', 'entity.name.function.r'])).toBe('function');
    });

    test('maps comment scopes', () => {
        expect(scopeToRole(['source.r', 'comment.line.number-sign.r'])).toBe('comment');
    });

    test('returns null when no scope matches', () => {
        expect(scopeToRole(['source.r'])).toBeNull();
    });

    test('keyword operator wins over plain keyword', () => {
        expect(scopeToRole(['source.r', 'keyword.operator.assignment.r'])).toBe('operator');
        expect(scopeToRole(['source.r', 'keyword.control.r'])).toBe('keyword');
    });

    test('support.function maps to function', () => {
        expect(scopeToRole(['source.r', 'support.function.r'])).toBe('function');
    });
});

describe('paletteForThemeClasses', () => {
    test('null (browser) defaults to light palette', () => {
        expect(paletteForThemeClasses(null)).toBe(githubLight);
    });

    test('vscode-light → light', () => {
        expect(paletteForThemeClasses('vscode-light')).toBe(githubLight);
        expect(paletteForThemeClasses('vscode-high-contrast-light extra-class')).toBe(githubLight);
    });

    test('default and dark → dark', () => {
        expect(paletteForThemeClasses('vscode-dark')).toBe(githubDark);
        expect(paletteForThemeClasses('vscode-high-contrast')).toBe(githubDark);
        expect(paletteForThemeClasses('something-else')).toBe(githubDark);
    });
});

describe('semanticOverlaysFromLspData', () => {
    test('decodes a single function token on the first line', () => {
        // `library(ggplot2)` — emit a `function` semantic token covering
        // the 7-char `library` identifier at column 0 on line 0.
        const source = 'library(ggplot2)';
        const data = [0, 0, 7, 0, 0];
        expect(semanticOverlaysFromLspData(data, source)).toEqual([
            { start: 0, end: 7, role: 'function' },
        ] satisfies SemanticOverlay[]);
    });

    test('decodes deltas across lines', () => {
        // Two tokens: `add` (defn) on line 0 col 0 width 3, `add` (call)
        // on line 1 col 10 width 3 — the same delta encoding the live
        // LSP would emit for `add <- function(x) x\nresult <- add(1)`.
        const source = 'add <- function(x) x\nresult <- add(1)';
        const data = [
            0, 0, 3, 0, 0,
            1, 10, 3, 0, 0,
        ];
        expect(semanticOverlaysFromLspData(data, source)).toEqual([
            { start: 0, end: 3, role: 'function' },
            { start: 31, end: 34, role: 'function' },
        ] satisfies SemanticOverlay[]);
    });

    test('skips tokens whose tokenType does not match the request', () => {
        // Synthetic: type 1 should be dropped when caller asks for type 0.
        const source = 'foo bar';
        const data = [0, 0, 3, 0, 0, 0, 4, 3, 1, 0];
        expect(semanticOverlaysFromLspData(data, source)).toEqual([
            { start: 0, end: 3, role: 'function' },
        ] satisfies SemanticOverlay[]);
    });

    test('ignores tokens that fall past EOL of the document', () => {
        // Adversarial: a token claiming to live on line 5 of a one-line
        // source must be silently dropped, not panic.
        const source = 'short';
        const data = [5, 0, 3, 0, 0];
        expect(semanticOverlaysFromLspData(data, source)).toEqual([]);
    });

    test('clips overrunning length to source end', () => {
        const source = 'abc';
        const data = [0, 0, 100, 0, 0];
        expect(semanticOverlaysFromLspData(data, source)).toEqual([
            { start: 0, end: 3, role: 'function' },
        ] satisfies SemanticOverlay[]);
    });
});

describe('highlightCodeBlock', () => {
    /**
     * Tiny faked grammar: marks every contiguous run of letters as a
     * function call head, every digit run as a number, and the literal
     * `<-` as an operator. Lets us assert spans without depending on a
     * real R grammar.
     */
    function toyRTokenizer(line: string): ScopeToken[] {
        const tokens: ScopeToken[] = [];
        let i = 0;
        while (i < line.length) {
            const ch = line[i];
            if (/[A-Za-z]/.test(ch)) {
                let j = i + 1;
                while (j < line.length && /[A-Za-z0-9_.]/.test(line[j])) j++;
                tokens.push({
                    startIndex: i,
                    endIndex: j,
                    scopes: ['source.r', 'entity.name.function.r'],
                });
                i = j;
                continue;
            }
            if (/[0-9]/.test(ch)) {
                let j = i + 1;
                while (j < line.length && /[0-9]/.test(line[j])) j++;
                tokens.push({
                    startIndex: i,
                    endIndex: j,
                    scopes: ['source.r', 'constant.numeric.r'],
                });
                i = j;
                continue;
            }
            if (ch === '<' && line[i + 1] === '-') {
                tokens.push({
                    startIndex: i,
                    endIndex: i + 2,
                    scopes: ['source.r', 'keyword.operator.assignment.r'],
                });
                i += 2;
                continue;
            }
            tokens.push({
                startIndex: i,
                endIndex: i + 1,
                scopes: ['source.r'],
            });
            i++;
        }
        return tokens;
    }

    test('emits palette-colored spans from grammar scopes', async () => {
        const registry = fakeRegistry({ r: toyRTokenizer });
        const html = await highlightCodeBlock({
            source: 'add <- 1',
            languageId: 'r',
            palette: githubLight,
            registry,
        });
        // `add` → function, `<-` → operator, `1` → number, spaces stay
        // bare. Spans nest correctly and surrounding spaces escape clean.
        expect(html).toBe(
            `<span style="color:${githubLight.roles.function}">add</span>` +
            ` ` +
            `<span style="color:${githubLight.roles.operator}">&lt;-</span>` +
            ` ` +
            `<span style="color:${githubLight.roles.number}">1</span>`,
        );
    });

    test('overlay promotes a span past the grammar mapping', async () => {
        // Grammar would scope every letter run as a function (per the
        // toy tokenizer), so we can't distinguish — pick a deliberately
        // mis-tokenizing grammar that marks identifiers as `variable`.
        const flatRegistry = fakeRegistry({
            r: (line) => [{
                startIndex: 0,
                endIndex: line.length,
                scopes: ['source.r', 'variable.other.r'],
            }],
        });
        const html = await highlightCodeBlock({
            source: 'library',
            languageId: 'r',
            palette: githubLight,
            registry: flatRegistry,
            overlays: [{ start: 0, end: 7, role: 'function' }],
        });
        // The overlay must beat the grammar's `variable` role.
        expect(html).toBe(
            `<span style="color:${githubLight.roles.function}">library</span>`,
        );
    });

    test('multi-line input round-trips newlines', async () => {
        const registry = fakeRegistry({ r: toyRTokenizer });
        const html = await highlightCodeBlock({
            source: 'a\nb',
            languageId: 'r',
            palette: githubLight,
            registry,
        });
        expect(html).toBe(
            `<span style="color:${githubLight.roles.function}">a</span>\n` +
            `<span style="color:${githubLight.roles.function}">b</span>`,
        );
    });

    test('empty source returns empty string without a grammar fetch', async () => {
        let calls = 0;
        const registry: GrammarRegistry = {
            tokenizeLineForLanguage: async () => {
                calls++;
                return null;
            },
            scopeNameFor: () => 'source.r',
            primeForLanguage: async () => {
                calls++;
                return true;
            },
        };
        const html = await highlightCodeBlock({
            source: '',
            languageId: 'r',
            palette: githubLight,
            registry,
        });
        expect(html).toBe('');
        expect(calls).toBe(0);
    });

    test('unknown language returns escaped source without coloring', async () => {
        const registry = fakeRegistry({ r: toyRTokenizer });
        const html = await highlightCodeBlock({
            source: 'a < b > c',
            languageId: 'no-such-language',
            palette: githubLight,
            registry,
        });
        expect(html).toBe('a &lt; b &gt; c');
    });
});
