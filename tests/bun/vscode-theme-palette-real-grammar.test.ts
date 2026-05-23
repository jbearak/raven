/**
 * Real-grammar integration tests for `resolveActiveThemePalette`.
 *
 * These tests use the actual REditorSupport-style R grammar (whichever
 * `vscode.r` ships with the current VS Code install) together with
 * vscode-textmate's real `Registry.setTheme` + `tokenizeLine2`
 * machinery. They catch a class of bugs the fake-registry tests can't:
 * specifically, what vscode-textmate's `colorMap` actually contains
 * when a probe matches the theme's "no rule for this scope" default,
 * which differs from the simulated index-0 case our fake uses.
 *
 * Symptom this test guards against: a theme whose `tokenColors` array
 * has rules for SOME scopes but no top-level empty-scope default rule.
 * vscode-textmate uses a hardcoded `#000000` foreground for tokens
 * that don't match any rule. If the extractor naively returns that
 * color for a probe that fell through to the default, the user sees
 * near-invisible black text on the dark code-block background.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import { createGrammarRegistry } from '../../editors/vscode/src/knit/grammar-registry';
import {
    resolveActiveThemePalette,
    type ExtensionLike,
} from '../../editors/vscode/src/knit/vscode-theme-palette';
import type * as vscode from 'vscode';

const VSCODE_R_PATH =
    '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/r';

function resolveOnigWasm(): string | undefined {
    try {
        return require.resolve('vscode-oniguruma/release/onig.wasm');
    } catch {
        return undefined;
    }
}

const ONIG_WASM = resolveOnigWasm();

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
    if (ONIG_WASM === undefined) return false;
    try {
        fs.accessSync(path.join(VSCODE_R_PATH, 'syntaxes', 'r.tmLanguage.json'));
        fs.accessSync(ONIG_WASM);
        return true;
    } catch {
        return false;
    }
}

const itLive = rExtensionAvailable() ? test : test.skip;

/**
 * Build a real R-grammar registry mirroring the production wiring.
 */
function makeRegistry() {
    const rExt = makeRExtension();
    return createGrammarRegistry({
        extensions: [rExt],
        getExtensionById: (id) => (id === 'vscode.r' ? rExt : undefined),
        // `itLive` gates on `rExtensionAvailable()`, which guarantees
        // ONIG_WASM is defined here.
        onigWasmPath: ONIG_WASM as string,
    });
}

/**
 * Theme contribution shape `vscode-theme-palette.ts` expects. The
 * theme JSON lives on disk so the extractor's `readFile` injection can
 * read it.
 */
function makeThemeExtension(themePath: string): ExtensionLike {
    return {
        id: 'test.themes',
        extensionPath: path.dirname(themePath),
        packageJSON: {
            contributes: {
                themes: [
                    {
                        label: 'Test Dark Sparse',
                        path: path.basename(themePath),
                    },
                ],
            },
        },
    };
}

describe('resolveActiveThemePalette — against the real R grammar', () => {
    itLive(
        'roles whose probe scope has NO theme rule fall back to noMatchFg (matches editor)',
        async () => {
            // Sparse theme: only `string` and `comment` have token
            // rules. `keyword`, `function`, `number`, `operator`,
            // `variable`, `type`, `punctuation`, `constant` have NO
            // matching rule. There is NO top-level empty-scope default
            // rule in `tokenColors` either — only `colors.editor.*`
            // sets editor background/foreground.
            //
            // What the EDITOR would show for these unstyled tokens:
            // vscode-textmate falls back to `#000000` (its hardcoded
            // default when no empty-scope rule exists). So the editor
            // paints them `#000000`.
            //
            // Our resolver must mirror that — paint unstyled roles
            // with `#000000` too, not with GitHub palette colors that
            // the editor would never produce.
            const tmpDir = fs.mkdtempSync(
                path.join(require('os').tmpdir(), 'raven-theme-palette-'),
            );
            const themePath = path.join(tmpDir, 'sparse.json');
            try {
                fs.writeFileSync(
                    themePath,
                    JSON.stringify({
                        type: 'dark',
                        colors: {
                            'editor.background': '#0e1116',
                            'editor.foreground': '#c9d1d9',
                        },
                        tokenColors: [
                            {
                                scope: 'string',
                                settings: { foreground: '#a5d6ff' },
                            },
                            {
                                scope: 'comment',
                                settings: { foreground: '#8b949e' },
                            },
                        ],
                    }),
                    'utf-8',
                );

                const registry = makeRegistry();
                const out = await resolveActiveThemePalette({
                    workbenchColorThemeId: 'Test Dark Sparse',
                    isLight: false,
                    extensions: [makeThemeExtension(themePath)],
                    tokenColorCustomizations: undefined,
                    semanticTokenColorCustomizations: undefined,
                    registry,
                    readFile: (p) => fs.promises.readFile(p, 'utf-8'),
                });
                expect(out.ok).toBe(true);
                if (!out.ok) return;

                // The rules we DID supply should round-trip.
                expect(out.palette.roles.string).toBe('#a5d6ff');
                expect(out.palette.roles.comment).toBe('#8b949e');

                // The rules we DID NOT supply must fall back to
                // `#000000` — vscode-textmate's hardcoded default
                // when no empty-scope rule exists in tokenColors.
                // That's what the editor itself shows for these
                // tokens, so our rendering should match. The previous
                // GitHub-palette fallback would have produced colors
                // (#ff7b72, #d2a8ff, ...) the editor never produces.
                const noMatchFg = '#000000';
                const unstyled: Array<keyof typeof out.palette.roles> = [
                    'keyword', 'number', 'function', 'type',
                    'variable', 'operator', 'punctuation', 'constant',
                ];
                for (const role of unstyled) {
                    expect(
                        out.palette.roles[role].toLowerCase(),
                        `role=${role} resolved to ${out.palette.roles[role]} (expected noMatchFg ${noMatchFg})`,
                    ).toBe(noMatchFg);
                }
            } finally {
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
            }
        },
    );

    itLive(
        'roles whose probe scope DOES have a theme rule return the theme color',
        async () => {
            const tmpDir = fs.mkdtempSync(
                path.join(require('os').tmpdir(), 'raven-theme-palette-'),
            );
            const themePath = path.join(tmpDir, 'sparse.json');
            try {
                fs.writeFileSync(
                    themePath,
                    JSON.stringify({
                        type: 'dark',
                        colors: {
                            'editor.background': '#0e1116',
                            'editor.foreground': '#c9d1d9',
                        },
                        tokenColors: [
                            {
                                scope: ['keyword', 'keyword.control'],
                                settings: { foreground: '#deadbe' },
                            },
                            {
                                scope: 'comment',
                                settings: { foreground: '#cafe11' },
                            },
                            {
                                scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'],
                                settings: { foreground: '#abcdef' },
                            },
                        ],
                    }),
                    'utf-8',
                );

                const registry = makeRegistry();
                const out = await resolveActiveThemePalette({
                    workbenchColorThemeId: 'Test Dark Sparse',
                    isLight: false,
                    extensions: [makeThemeExtension(themePath)],
                    tokenColorCustomizations: undefined,
                    semanticTokenColorCustomizations: undefined,
                    registry,
                    readFile: (p) => fs.promises.readFile(p, 'utf-8'),
                });
                expect(out.ok).toBe(true);
                if (!out.ok) return;

                expect(out.palette.roles.keyword.toLowerCase()).toBe('#deadbe');
                expect(out.palette.roles.comment.toLowerCase()).toBe('#cafe11');
                expect(out.palette.roles.function.toLowerCase()).toBe('#abcdef');
                expect(out.palette.background).toBe('#0e1116');
                expect(out.palette.foreground).toBe('#c9d1d9');
            } finally {
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
            }
        },
    );

    itLive(
        'punctuation role is NOT poisoned by string-delimiter "punctuation" tokens',
        async () => {
            // Regression for the corpus-vote bug: the `"` in a string
            // literal has scope chain ending in
            // `punctuation.definition.string.begin.r`, so scopeToRole
            // classifies it as punctuation. But vscode-textmate's
            // selector matcher resolves its color via the outer
            // `string.quoted.double.r` scope — meaning the theme paints
            // it the string color. A naive vote would attribute the
            // string color to the punctuation role and paint ALL
            // punctuation (commas, parens) with the string color.
            //
            // The fix: ambiguous tokens (non-string/non-comment role
            // with string/comment in their chain) are filtered out of
            // voting.
            const tmpDir = fs.mkdtempSync(
                path.join(require('os').tmpdir(), 'raven-theme-palette-'),
            );
            const themePath = path.join(tmpDir, 'string-bias.json');
            try {
                fs.writeFileSync(
                    themePath,
                    JSON.stringify({
                        type: 'dark',
                        colors: {
                            'editor.background': '#0e1116',
                            'editor.foreground': '#c9d1d9',
                        },
                        tokenColors: [
                            // Only the `string` selector is defined.
                            // Naively, every `"` in the corpus would
                            // contribute a punctuation-role vote of
                            // '#a5d6ff'.
                            {
                                scope: 'string',
                                settings: { foreground: '#a5d6ff' },
                            },
                        ],
                    }),
                    'utf-8',
                );

                const registry = makeRegistry();
                const out = await resolveActiveThemePalette({
                    workbenchColorThemeId: 'Test Dark Sparse',
                    isLight: false,
                    extensions: [makeThemeExtension(themePath)],
                    tokenColorCustomizations: undefined,
                    semanticTokenColorCustomizations: undefined,
                    registry,
                    readFile: (p) => fs.promises.readFile(p, 'utf-8'),
                });
                expect(out.ok).toBe(true);
                if (!out.ok) return;

                // string role still resolves to the theme color.
                expect(out.palette.roles.string).toBe('#a5d6ff');
                // punctuation role is NOT '#a5d6ff' — that would mean
                // commas / parens get painted as if they were inside
                // a string. With no clean punctuation rule in the
                // theme, the role falls back to noMatchFg (#000000
                // when no empty-scope rule), matching what the editor
                // would render for unstyled punctuation.
                expect(out.palette.roles.punctuation).toBe('#000000');
            } finally {
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
            }
        },
    );

    itLive(
        'theme that styles entity.name.function colors the function role from the function declaration in the corpus',
        async () => {
            // The corpus contains `square <- function(arg) { ... }`,
            // which the R grammar tokenizes with `entity.name.function.r`
            // on `square`. A theme that styles `entity.name.function`
            // should color the function role accordingly, even if
            // `support.function` (the builtin selector) is absent.
            const tmpDir = fs.mkdtempSync(
                path.join(require('os').tmpdir(), 'raven-theme-palette-'),
            );
            const themePath = path.join(tmpDir, 'declared.json');
            try {
                fs.writeFileSync(
                    themePath,
                    JSON.stringify({
                        type: 'dark',
                        colors: {
                            'editor.background': '#0e1116',
                            'editor.foreground': '#c9d1d9',
                        },
                        tokenColors: [
                            {
                                scope: 'entity.name.function',
                                settings: { foreground: '#facade' },
                            },
                        ],
                    }),
                    'utf-8',
                );

                const registry = makeRegistry();
                const out = await resolveActiveThemePalette({
                    workbenchColorThemeId: 'Test Dark Sparse',
                    isLight: false,
                    extensions: [makeThemeExtension(themePath)],
                    tokenColorCustomizations: undefined,
                    semanticTokenColorCustomizations: undefined,
                    registry,
                    readFile: (p) => fs.promises.readFile(p, 'utf-8'),
                });
                expect(out.ok).toBe(true);
                if (!out.ok) return;
                expect(out.palette.roles.function.toLowerCase()).toBe('#facade');
            } finally {
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
            }
        },
    );

    itLive(
        'theme with an explicit empty-scope default rule uses THAT color (not GitHub) for unstyled roles',
        async () => {
            // Some themes DO supply an empty-scope default rule that
            // sets a foreground different from `colors.editor.foreground`.
            // vscode-textmate uses that empty-scope-rule color for any
            // unmatched token — so that's what the EDITOR shows for
            // unstyled tokens, and what our resolver must use as the
            // fallback for unstyled roles.
            const tmpDir = fs.mkdtempSync(
                path.join(require('os').tmpdir(), 'raven-theme-palette-'),
            );
            const themePath = path.join(tmpDir, 'with-default.json');
            try {
                fs.writeFileSync(
                    themePath,
                    JSON.stringify({
                        type: 'dark',
                        colors: {
                            'editor.background': '#0e1116',
                            'editor.foreground': '#c9d1d9',
                        },
                        tokenColors: [
                            // Empty-scope default rule with a
                            // foreground that differs from
                            // editor.foreground. vscode-textmate uses
                            // THIS for no-match tokens.
                            {
                                settings: {
                                    foreground: '#deadbe',
                                    background: '#0e1116',
                                },
                            },
                            {
                                scope: 'string',
                                settings: { foreground: '#a5d6ff' },
                            },
                        ],
                    }),
                    'utf-8',
                );

                const registry = makeRegistry();
                const out = await resolveActiveThemePalette({
                    workbenchColorThemeId: 'Test Dark Sparse',
                    isLight: false,
                    extensions: [makeThemeExtension(themePath)],
                    tokenColorCustomizations: undefined,
                    semanticTokenColorCustomizations: undefined,
                    registry,
                    readFile: (p) => fs.promises.readFile(p, 'utf-8'),
                });
                expect(out.ok).toBe(true);
                if (!out.ok) return;

                // `string` has an explicit rule — keeps the theme color.
                expect(out.palette.roles.string.toLowerCase()).toBe('#a5d6ff');
                // `keyword` has no specific rule → falls through to
                // the empty-scope default (#deadbe). vscode-textmate
                // paints unmatched tokens with #deadbe, so the editor
                // shows them as #deadbe. Our role fallback must use
                // the SAME color so the rendered output matches the
                // editor — not a GitHub palette color.
                expect(out.palette.roles.keyword.toLowerCase()).toBe('#deadbe');
            } finally {
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
            }
        },
    );
});
