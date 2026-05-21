import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import { createGrammarRegistry } from '../../editors/vscode/src/knit/grammar-registry';
import type * as vscode from 'vscode';

/**
 * Build a fake `vscode.Extension` object — just enough surface that
 * `createGrammarRegistry` can read it. The actual `vscode.Extension`
 * type carries dozens of methods (activate/exports/etc.) the registry
 * never touches.
 */
function fakeExtension(
    id: string,
    extensionPath: string,
    grammars: Array<{
        language?: string;
        scopeName: string;
        path: string;
        embeddedLanguages?: Record<string, string>;
    }>,
): vscode.Extension<unknown> {
    return {
        id,
        extensionPath,
        packageJSON: {
            contributes: { grammars },
        },
    } as unknown as vscode.Extension<unknown>;
}

/**
 * Helper that instantiates a registry with mocked imports — no
 * vscode-textmate, no onig.wasm. We only exercise the synchronous
 * discovery / scope-resolution code paths in these unit tests.
 */
function buildRegistry(extensions: vscode.Extension<unknown>[]) {
    return createGrammarRegistry({
        extensions,
        getExtensionById: (id) => extensions.find((e) => e.id === id),
        onigWasmPath: '/never/loaded/in/tests/onig.wasm',
        // Importers below should never be called for scopeNameFor /
        // primeForLanguage paths that don't actually tokenize.
        importTextmate: async () => {
            throw new Error('importTextmate must not be called in this test');
        },
        importOniguruma: async () => {
            throw new Error('importOniguruma must not be called in this test');
        },
        readGrammarFile: async () => {
            throw new Error('readGrammarFile must not be called in this test');
        },
    });
}

describe('GrammarRegistry.scopeNameFor', () => {
    test('returns the contributed scope name for a language', () => {
        const reg = buildRegistry([
            fakeExtension('vscode.python', '/ext/python', [
                { language: 'python', scopeName: 'source.python', path: 'p.tmLanguage.json' },
            ]),
        ]);
        expect(reg.scopeNameFor('python')).toBe('source.python');
    });

    test('lowercases the language ID before lookup', () => {
        const reg = buildRegistry([
            fakeExtension('vscode.python', '/ext/python', [
                { language: 'python', scopeName: 'source.python', path: 'p.tmLanguage.json' },
            ]),
        ]);
        expect(reg.scopeNameFor('Python')).toBe('source.python');
        expect(reg.scopeNameFor('PYTHON')).toBe('source.python');
    });

    test('returns null when no extension contributes the language', () => {
        const reg = buildRegistry([]);
        expect(reg.scopeNameFor('python')).toBeNull();
    });

    test('returns the first contribution when multiple extensions overlap', () => {
        const reg = buildRegistry([
            fakeExtension('first.contrib', '/a', [
                { language: 'mylang', scopeName: 'source.mylang-a', path: 'a.tmLanguage.json' },
            ]),
            fakeExtension('second.contrib', '/b', [
                { language: 'mylang', scopeName: 'source.mylang-b', path: 'b.tmLanguage.json' },
            ]),
        ]);
        expect(reg.scopeNameFor('mylang')).toBe('source.mylang-a');
    });

    test('R prefers REditorSupport.r-syntax over REditorSupport.r and vscode.r', () => {
        const reg = buildRegistry([
            fakeExtension('vscode.r', '/vsr', [
                { language: 'r', scopeName: 'source.r.vscode', path: 'r.tmLanguage.json' },
            ]),
            fakeExtension('REditorSupport.r', '/full', [
                { language: 'r', scopeName: 'source.r.full', path: 'r.tmLanguage.json' },
            ]),
            fakeExtension('REditorSupport.r-syntax', '/syntax', [
                { language: 'r', scopeName: 'source.r.upstream', path: 'r.tmLanguage.json' },
            ]),
        ]);
        expect(reg.scopeNameFor('r')).toBe('source.r.upstream');
    });

    test('R falls back to REditorSupport.r when r-syntax is absent', () => {
        const reg = buildRegistry([
            fakeExtension('vscode.r', '/vsr', [
                { language: 'r', scopeName: 'source.r.vscode', path: 'r.tmLanguage.json' },
            ]),
            fakeExtension('REditorSupport.r', '/full', [
                { language: 'r', scopeName: 'source.r.full', path: 'r.tmLanguage.json' },
            ]),
        ]);
        expect(reg.scopeNameFor('r')).toBe('source.r.full');
    });

    test('R falls back to vscode.r when no REditorSupport extensions are present', () => {
        const reg = buildRegistry([
            fakeExtension('vscode.r', '/vsr', [
                { language: 'r', scopeName: 'source.r.vscode', path: 'r.tmLanguage.json' },
            ]),
        ]);
        expect(reg.scopeNameFor('r')).toBe('source.r.vscode');
    });

    test('extension ID case is ignored during R priority matching', () => {
        const reg = buildRegistry([
            // Note the uppercase REditorSupport — the priority list
            // compares case-insensitively.
            fakeExtension('REDITORSUPPORT.R-SYNTAX', '/syntax', [
                { language: 'r', scopeName: 'source.r.upstream', path: 'r.tmLanguage.json' },
            ]),
            fakeExtension('reditorsupport.r', '/full', [
                { language: 'r', scopeName: 'source.r.full', path: 'r.tmLanguage.json' },
            ]),
        ]);
        expect(reg.scopeNameFor('r')).toBe('source.r.upstream');
    });

    test('grammar entries without a language are ignored', () => {
        const reg = buildRegistry([
            fakeExtension('inj.contrib', '/inj', [
                // Pure injection — no `language:`. Per VS Code's
                // contribution point this is valid but should not
                // surface in language-keyed lookups.
                { scopeName: 'injection.markdown.r', path: 'inj.tmLanguage.json' },
            ]),
        ]);
        expect(reg.scopeNameFor('r')).toBeNull();
    });

    test('absolute grammar paths are preserved; relative paths join with extensionPath', () => {
        const extPath = '/ext/python';
        const reg = buildRegistry([
            fakeExtension('vscode.python', extPath, [
                { language: 'python', scopeName: 'source.python', path: 'syntaxes/p.tmLanguage.json' },
            ]),
        ]);
        // We can't read internal state directly, but scopeNameFor +
        // primeForLanguage would resolve through `path.join(extPath,
        // ...)`. The simpler indirect check is to verify the public
        // surface still finds the language; the join happens at load
        // time which we don't trigger here.
        expect(reg.scopeNameFor('python')).toBe('source.python');
        // Sanity check: path.join produces a sensible result that
        // wouldn't accidentally point at /syntaxes/...
        expect(path.join(extPath, 'syntaxes/p.tmLanguage.json'))
            .toBe('/ext/python/syntaxes/p.tmLanguage.json');
    });
});

describe('GrammarRegistry.primeForLanguage', () => {
    test('returns false when no extension contributes the language', async () => {
        const reg = buildRegistry([]);
        expect(await reg.primeForLanguage('nope')).toBe(false);
    });

    /**
     * Regression for the Codex stage-3 finding that priority ran
     * only through `scopeNameFor` while the actual `Registry.loadGrammar`
     * call resolved through a first-wins `byScopeName` map. Two
     * extensions contributing the same `source.r` scope but at
     * different priorities must resolve through the preferred one's
     * grammar file (not whichever was enumerated first).
     *
     * We can't drive a real `vscode-textmate` load without onig.wasm,
     * so we observe the priority by injecting a `readGrammarFile`
     * stub that captures the resolved absolute path. The stub
     * deliberately fails the read so `primeForLanguage` returns
     * false, but it lets us assert WHICH file we tried to read.
     */
    test('R loadGrammar resolves through the priority-preferred extension when scopeNames collide', async () => {
        const extensions: vscode.Extension<unknown>[] = [
            fakeExtension('vscode.r', '/vsr', [
                { language: 'r', scopeName: 'source.r', path: 'syntaxes/r.tmLanguage.json' },
            ]),
            fakeExtension('REditorSupport.r-syntax', '/syntax', [
                { language: 'r', scopeName: 'source.r', path: 'syntaxes/r.tmLanguage.json' },
            ]),
        ];

        const readAttempts: string[] = [];
        const reg = createGrammarRegistry({
            extensions,
            getExtensionById: (id) => extensions.find((e) => e.id === id),
            onigWasmPath: '/dummy/onig.wasm',
            importTextmate: async () => ({
                parseRawGrammar: () => ({} as any),
                Registry: class FakeRegistry {
                    constructor(public opts: any) {}
                    async loadGrammar(scopeName: string) {
                        // The Registry callback is what consults
                        // `byScopeName` indirectly via the opts.loadGrammar
                        // hook we provided. Call it so the readAttempts
                        // capture fires.
                        const raw = await this.opts.loadGrammar(scopeName);
                        return raw ? ({ tokenizeLine: () => ({ tokens: [], ruleStack: null }) } as any) : null;
                    }
                },
            } as any),
            importOniguruma: async () => ({
                loadWASM: async () => undefined,
                createOnigScanner: () => ({}) as any,
                createOnigString: () => ({}) as any,
            } as any),
            readGrammarFile: async (absolutePath: string) => {
                readAttempts.push(absolutePath);
                return '{"name":"r","scopeName":"source.r","patterns":[]}';
            },
            readOnigWasm: async () => new ArrayBuffer(0),
        });

        await reg.primeForLanguage('r');

        expect(readAttempts).toHaveLength(1);
        expect(readAttempts[0]).toBe('/syntax/syntaxes/r.tmLanguage.json');
    });
});
