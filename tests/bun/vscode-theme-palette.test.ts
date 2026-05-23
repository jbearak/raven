import { describe, test, expect } from 'bun:test';
import {
    resolveActiveThemePalette,
    type ExtensionLike,
    type ThemePaletteArgs,
} from '../../editors/vscode/src/knit/vscode-theme-palette';
import type {
    GrammarRegistry,
    LineTokenization,
    ScopeToken,
    ThemeSetting,
    ThemeExtractionApi,
} from '../../editors/vscode/src/knit/grammar-registry';

/**
 * Tiny harness that fakes the parts of `GrammarRegistry` the extractor
 * touches. We never load real grammars or onig.wasm — the resolver's
 * scope-selector matching delegates to vscode-textmate at production
 * time, but for unit tests we fake the matcher directly so we can
 * exercise customization layering, include chains, and validation
 * without WASM cost.
 *
 * The fake's `extractWithTheme` records the merged settings it was
 * handed and exposes a `tokenizeLine2ForLanguage` that returns a
 * Uint32Array where each role's probe yields the index the caller
 * specifies via `roleColors`. The `colorMap` is also caller-controlled.
 */
/**
 * Fake registry. The corpus-based extractor calls
 * `tokenizeLineForLanguage` (theme-independent, before
 * `extractWithTheme`) to recover scope chains, then
 * `tokenizeLine2ForLanguage` (inside the theme lock) to read colors.
 *
 * For most structural tests we don't care about per-role color
 * resolution (those scenarios live in the real-grammar test file),
 * so the fake's default `tokenStream` returns no tokens — the
 * corpus iterates with zero votes and the resolver falls back to
 * the GitHub palette. Tests that DO want to drive role-color votes
 * supply a `tokenStream` that returns tokens with specific scope
 * chains for specific lines.
 */
function fakeRegistry(opts: {
    /**
     * Per-line scope tokens. Called by `tokenizeLineForLanguage`.
     * Default: empty array for every line.
     */
    tokenStream?: (line: string) => readonly ScopeToken[];
    /**
     * Per-line color index for the first token. Called by
     * `tokenizeLine2ForLanguage`. The fake produces one binary
     * token at offset 0 with this fg index.
     */
    snippetIndex?: (line: string) => number;
    colorMap?: readonly string[];
    recordedSettings?: { value: readonly ThemeSetting[] };
    primeForR?: boolean;
}): Pick<GrammarRegistry, 'extractWithTheme' | 'primeForLanguage' | 'tokenizeLineForLanguage'> {
    const tokenStream = opts.tokenStream ?? (() => []);
    const snippetIndex = opts.snippetIndex ?? (() => 0);
    const colorMap = opts.colorMap ?? [];
    return {
        async primeForLanguage(_lang: string) {
            return opts.primeForR ?? true;
        },
        async tokenizeLineForLanguage(_lang, line, _state) {
            const tokens = tokenStream(line);
            return { tokens, ruleStack: null } satisfies LineTokenization;
        },
        async extractWithTheme<T>(
            settings: readonly ThemeSetting[],
            inner: (api: ThemeExtractionApi) => Promise<T>,
        ): Promise<T> {
            if (opts.recordedSettings) opts.recordedSettings.value = settings;
            const api: ThemeExtractionApi = {
                colorMap,
                async tokenizeLine2ForLanguage(_lang, line, _state) {
                    const fgIndex = snippetIndex(line);
                    // One binary token at offset 0 with the given
                    // fg index. Metadata layout matches
                    // vscode-textmate's MetadataConsts: fg is bits
                    // 15..23.
                    const metadata = (fgIndex & 0x1ff) << 15;
                    return { tokens: new Uint32Array([0, metadata]), ruleStack: null };
                },
            };
            return inner(api);
        },
    };
}

/**
 * Build a scope-token stream for one specific corpus line. Helper for
 * tests that want to drive role-color votes deterministically.
 */
function singleTokenAtOffset(scopes: readonly string[]): readonly ScopeToken[] {
    return [{ startIndex: 0, endIndex: 1, scopes }];
}

/**
 * Build an `ExtensionLike` carrying a single themes contribution.
 * The packageJSON shape matches what `vscode.Extension.packageJSON`
 * exposes at runtime.
 */
function fakeThemeExtension(args: {
    extensionPath: string;
    /** Optional override for the extension's own id (defaults to a fixed publisher.name). */
    extensionId?: string;
    id?: string;
    label?: string;
    themeRelativePath: string;
}): ExtensionLike {
    return {
        id: args.extensionId ?? 'fake.theme.publisher',
        extensionPath: args.extensionPath,
        packageJSON: {
            contributes: {
                themes: [
                    {
                        id: args.id,
                        label: args.label,
                        uiTheme: 'vs-dark',
                        path: args.themeRelativePath,
                    },
                ],
            },
        },
    };
}

/**
 * Stub readFile from a name → content map. Throws on missing keys so
 * a test that misnames a fixture path fails loudly rather than
 * silently emitting the GitHub fallback.
 */
function readFileFrom(table: Record<string, string>) {
    return async (absolutePath: string): Promise<string> => {
        if (absolutePath in table) return table[absolutePath];
        throw new Error(`unexpected read: ${absolutePath}`);
    };
}

function baseArgs(overrides: Partial<ThemePaletteArgs>): ThemePaletteArgs {
    return {
        candidateThemeIds: ['Test Dark'],
        isLight: false,
        extensions: [],
        tokenColorCustomizations: undefined,
        semanticTokenColorCustomizations: undefined,
        registry: fakeRegistry({}),
        readFile: async () => { throw new Error('readFile must not be called'); },
        ...overrides,
    };
}

describe('resolveActiveThemePalette — discovery', () => {
    test('fails when no candidate theme ids are supplied', async () => {
        const out = await resolveActiveThemePalette(baseArgs({ candidateThemeIds: [] }));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('no-theme-id');
    });

    test('fails when no contributed theme matches any candidate', async () => {
        const out = await resolveActiveThemePalette(baseArgs({ extensions: [] }));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('theme-not-found');
    });

    test('matches by `id` field on the contribution', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/exts/test',
            id: 'theme-id-X',
            themeRelativePath: 'themes/x.json',
        });
        const file = '/exts/test/themes/x.json';
        const themeJson = JSON.stringify({
            type: 'dark',
            tokenColors: [],
            colors: { 'editor.background': '#222222', 'editor.foreground': '#eeeeee' },
        });
        const out = await resolveActiveThemePalette(baseArgs({
            candidateThemeIds: ['theme-id-X'],
            extensions: [ext],
            readFile: readFileFrom({ [file]: themeJson }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.background).toBe('#222222');
            expect(out.palette.foreground).toBe('#eeeeee');
        }
    });

    test('falls back to `label` field when `id` is absent', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/exts/test',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        const file = '/exts/test/theme.json';
        const out = await resolveActiveThemePalette(baseArgs({
            candidateThemeIds: ['Test Dark'],
            extensions: [ext],
            readFile: readFileFrom({
                [file]: JSON.stringify({ type: 'dark', tokenColors: [], colors: {} }),
            }),
        }));
        expect(out.ok).toBe(true);
    });
});

describe('resolveActiveThemePalette — parsing', () => {
    test('rejects tmTheme (XML/plist) format', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/exts',
            label: 'Test Dark',
            themeRelativePath: 'theme.tmTheme',
        });
        const file = '/exts/theme.tmTheme';
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile: readFileFrom({
                [file]: '<?xml version="1.0"?><plist><dict></dict></plist>',
            }),
        }));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('unsupported-format');
    });

    test('surfaces parse errors with reason="parse-error"', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/exts',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        const file = '/exts/theme.json';
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile: readFileFrom({ [file]: '{not: valid JSON' }),
        }));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('parse-error');
    });

    test('strips // and /* */ comments before parsing JSON-with-comments', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/exts',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        const file = '/exts/theme.json';
        const themeJson = `{
            // a line comment
            "type": "dark",
            /* a block
               comment */
            "tokenColors": [],
            "colors": {
                "editor.background": "#101010",
                "editor.foreground": "#cccccc"
            }
        }`;
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile: readFileFrom({ [file]: themeJson }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.background).toBe('#101010');
        }
    });

    test('strips trailing commas (some themes ship .jsonc with them)', async () => {
        // Regression for Tokyo Night Light, which has trailing
        // commas before `}` in its `colors` block. Without stripping,
        // JSON.parse rejects the file and the theme falls back to
        // GitHub palette.
        const ext = fakeThemeExtension({
            extensionPath: '/exts',
            label: 'Trailing Comma',
            themeRelativePath: 'theme.json',
        });
        const file = '/exts/theme.json';
        // Both kinds of trailing comma: object-trailing and array-trailing.
        const themeJson = `{
            "type": "dark",
            "tokenColors": [
                { "scope": "keyword", "settings": { "foreground": "#aaa" } },
            ],
            "colors": {
                "editor.background": "#101010",
                "editor.foreground": "#cccccc",
            }
        }`;
        const out = await resolveActiveThemePalette(baseArgs({
            candidateThemeIds: ['Trailing Comma'],
            extensions: [ext],
            readFile: readFileFrom({ [file]: themeJson }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.background).toBe('#101010');
            expect(out.palette.foreground).toBe('#cccccc');
        }
    });

    test('does NOT strip commas inside string literals', async () => {
        // The trailing-comma pass must be string-aware. A value like
        // `"foo, "` ends with `,` then ` "`, which superficially
        // resembles a trailing comma but is INSIDE a string literal.
        const ext = fakeThemeExtension({
            extensionPath: '/exts',
            label: 'String Comma',
            themeRelativePath: 'theme.json',
        });
        const file = '/exts/theme.json';
        const themeJson = `{
            "type": "dark",
            "name": "foo, bar",
            "tokenColors": [],
            "colors": {}
        }`;
        const out = await resolveActiveThemePalette(baseArgs({
            candidateThemeIds: ['String Comma'],
            extensions: [ext],
            readFile: readFileFrom({ [file]: themeJson }),
        }));
        expect(out.ok).toBe(true);
    });

    test('preserves // inside string literals (does not strip them)', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/exts',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        const file = '/exts/theme.json';
        // Adversarial: a `//` inside a JSON string must NOT be treated
        // as a line comment. If our stripper got it wrong, the
        // resulting JSON would be syntactically broken or the value
        // would be silently truncated.
        const themeJson = `{
            "type": "dark",
            "name": "the // theme",
            "tokenColors": [],
            "colors": {}
        }`;
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile: readFileFrom({ [file]: themeJson }),
        }));
        expect(out.ok).toBe(true);
    });

    test('rejects parse errors that bubble up through include chains', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/exts',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        const root = '/exts/theme.json';
        const child = '/exts/base.json';
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile: readFileFrom({
                [root]: JSON.stringify({ include: './base.json', tokenColors: [], colors: {} }),
                [child]: '{ this is not json',
            }),
        }));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('parse-error');
    });
});

describe('resolveActiveThemePalette — include chains', () => {
    test('resolves include paths relative to the including file, not the entry point', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/exts',
            label: 'Test Dark',
            themeRelativePath: 'themes/dark/index.json',
        });
        const entry = '/exts/themes/dark/index.json';
        // The include path is relative to the entry file's dir. A
        // naive resolution against the extension root would look at
        // /exts/base.json and miss the actual file at
        // /exts/themes/dark/base.json.
        const base = '/exts/themes/dark/base.json';
        const readFile = readFileFrom({
            [entry]: JSON.stringify({
                include: './base.json',
                tokenColors: [],
                colors: { 'editor.background': '#abcdef' },
            }),
            [base]: JSON.stringify({
                tokenColors: [],
                colors: { 'editor.foreground': '#fedcba' },
            }),
        });
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile,
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.background).toBe('#abcdef');
            expect(out.palette.foreground).toBe('#fedcba');
        }
    });

    test('current file `colors` overrides included file `colors` (later wins)', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/exts',
            label: 'Test Dark',
            themeRelativePath: 'index.json',
        });
        const readFile = readFileFrom({
            '/exts/index.json': JSON.stringify({
                include: './base.json',
                tokenColors: [],
                // This wins.
                colors: { 'editor.background': '#999999' },
            }),
            '/exts/base.json': JSON.stringify({
                tokenColors: [],
                colors: { 'editor.background': '#111111' },
            }),
        });
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile,
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.background).toBe('#999999');
        }
    });

    test('detects include cycles after realpath canonicalization', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/exts',
            label: 'Test Dark',
            themeRelativePath: 'a.json',
        });
        const readFile = readFileFrom({
            '/exts/a.json': JSON.stringify({
                include: './b.json',
                tokenColors: [],
                colors: {},
            }),
            '/exts/b.json': JSON.stringify({
                include: './a.json',
                tokenColors: [],
                colors: {},
            }),
        });
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile,
            // realPath as identity — paths already match so the
            // visited check should fire after one round trip.
            realPath: async (p) => p,
        }));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('cycle-detected');
    });

    test('diamond include graphs are NOT misidentified as cycles', async () => {
        // entry → mid AND entry → base; mid → base. The base file is
        // reached via two distinct paths but never via a back-edge —
        // this is a valid DAG, not a cycle. Built-in themes like
        // dark_plus.json have shapes like this in practice.
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'Test Dark',
            themeRelativePath: 'entry.json',
        });
        const readFile = readFileFrom({
            '/e/entry.json': JSON.stringify({
                include: './mid.json',
                tokenColors: [{ scope: 'comment', settings: { foreground: '#aaaaaa' } }],
                colors: { 'editor.background': '#aabbcc' },
            }),
            '/e/mid.json': JSON.stringify({
                include: './base.json',
                tokenColors: [{ scope: 'keyword', settings: { foreground: '#bbcccc' } }],
                colors: {},
            }),
            '/e/base.json': JSON.stringify({
                tokenColors: [{ scope: 'string', settings: { foreground: '#cccccc' } }],
                colors: { 'editor.foreground': '#ffffff' },
            }),
        });
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile,
            realPath: async (p) => p,
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.background).toBe('#aabbcc');
            expect(out.palette.foreground).toBe('#ffffff');
        }
    });

    test('cycle detection uses realpath to canonicalize symlinks', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/exts',
            label: 'Test Dark',
            themeRelativePath: 'a.json',
        });
        // /exts/a.json includes /exts/by-symlink/a.json — but the
        // symlink really points back to /exts/a.json. Without
        // realpath canonicalization the cycle check misses it.
        const readFile = readFileFrom({
            '/exts/a.json': JSON.stringify({
                include: './by-symlink/a.json',
                tokenColors: [],
                colors: {},
            }),
        });
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile,
            realPath: async (p) => p === '/exts/by-symlink/a.json' ? '/exts/a.json' : p,
        }));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('cycle-detected');
    });
});

describe('resolveActiveThemePalette — color extraction', () => {
    function singleThemeArgs(overrides: Partial<ThemePaletteArgs> = {}): ThemePaletteArgs {
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        const readFile = readFileFrom({
            '/e/theme.json': JSON.stringify({
                type: 'dark',
                tokenColors: [
                    { scope: 'comment', settings: { foreground: '#aaaaaa' } },
                ],
                colors: {
                    'editor.background': '#1e1e1e',
                    'editor.foreground': '#cccccc',
                },
            }),
        });
        return baseArgs({ extensions: [ext], readFile, ...overrides });
    }

    test('reads bg/fg from `colors` and routes them through the role palette', async () => {
        const out = await resolveActiveThemePalette(singleThemeArgs());
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.background).toBe('#1e1e1e');
            expect(out.palette.foreground).toBe('#cccccc');
        }
    });

    test('uses the GitHub fallback when bg/fg are missing', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile: readFileFrom({
                '/e/theme.json': JSON.stringify({
                    type: 'dark', tokenColors: [], colors: {},
                }),
            }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            // githubDark.background.
            expect(out.palette.background).toBe('#161b22');
            expect(out.palette.foreground).toBe('#c9d1d9');
        }
    });

    test('drops invalid hex values and falls back to the GitHub palette', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            isLight: true,  // route fallback through githubLight
            readFile: readFileFrom({
                '/e/theme.json': JSON.stringify({
                    type: 'dark',
                    tokenColors: [],
                    colors: {
                        'editor.background': 'expression(alert(1))',
                        'editor.foreground': '#ccc',
                    },
                }),
            }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            // Invalid bg drops to githubLight.background.
            expect(out.palette.background).toBe('#f6f8fa');
            // Valid 3-digit hex passes through.
            expect(out.palette.foreground).toBe('#ccc');
        }
    });
});

describe('resolveActiveThemePalette — vscode-textmate probing', () => {
    test('one corpus token contributes one vote for the matching role', async () => {
        // Drive a single corpus line ('# a representative comment')
        // through the fake so it yields a token with the comment
        // scope. Color index 2 maps to '#aabbcc'. Every other corpus
        // line yields no tokens, so the comment role gets exactly one
        // vote at '#aabbcc'.
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile: readFileFrom({
                '/e/theme.json': JSON.stringify({ type: 'dark', tokenColors: [], colors: {} }),
            }),
            registry: fakeRegistry({
                tokenStream: (line) =>
                    line === '# a representative comment'
                        ? singleTokenAtOffset(['source.r', 'comment.line.r'])
                        : [],
                snippetIndex: (line) =>
                    line === '# a representative comment' ? 2 : 0,
                colorMap: ['', '#000000', '#aabbcc'],
            }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.roles.comment).toBe('#aabbcc');
            // Other roles got no votes → noMatchFg fallback (#000000
            // here since tokenColors has no empty-scope rule). This
            // matches what vscode-textmate paints unmatched tokens, so
            // the rendered output matches the editor.
            expect(out.palette.roles.keyword).toBe('#000000');
        }
    });

    test('the no-match foreground is filtered out of voting, then used as the role fallback', async () => {
        // Theme has an empty-scope default rule with foreground
        // '#deadbe'. The fake makes EVERY token's color resolve to
        // '#deadbe' (the no-match default). The filter drops every
        // vote — no role gets a theme-specific color — and each role
        // falls back to the empty-scope-rule color (#deadbe), which
        // is exactly what vscode-textmate would paint these tokens
        // and what the editor would render.
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile: readFileFrom({
                '/e/theme.json': JSON.stringify({
                    type: 'dark',
                    tokenColors: [{ settings: { foreground: '#deadbe' } }],
                    colors: {},
                }),
            }),
            registry: fakeRegistry({
                tokenStream: () => singleTokenAtOffset(['source.r', 'keyword.control.r']),
                snippetIndex: () => 1,
                colorMap: ['', '#deadbe'],
            }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            // Every vote was #deadbe → filtered out → role falls
            // back to noMatchFg (#deadbe per the empty-scope rule).
            // The rendered output matches the editor: unstyled
            // tokens are painted #deadbe in both.
            expect(out.palette.roles.keyword).toBe('#deadbe');
        }
    });

    test('returns grammar-unavailable when the R grammar cannot be primed', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile: readFileFrom({
                '/e/theme.json': JSON.stringify({
                    type: 'dark', tokenColors: [], colors: {},
                }),
            }),
            registry: fakeRegistry({ primeForR: false }),
        }));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('grammar-unavailable');
    });
});

describe('resolveActiveThemePalette — customizations layering', () => {
    function customizationsArgs(overrides: Partial<ThemePaletteArgs>): ThemePaletteArgs {
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'My Theme',
            themeRelativePath: 'theme.json',
        });
        return baseArgs({
            candidateThemeIds: ['My Theme'],
            extensions: [ext],
            readFile: readFileFrom({
                '/e/theme.json': JSON.stringify({
                    type: 'dark', tokenColors: [], colors: {},
                }),
            }),
            ...overrides,
        });
    }

    test('appends top-level textMateRules from tokenColorCustomizations', async () => {
        const recorded: { value: readonly ThemeSetting[] } = { value: [] };
        await resolveActiveThemePalette(customizationsArgs({
            registry: fakeRegistry({
                snippetIndex: () => 0,
                colorMap: [],
                recordedSettings: recorded,
            }),
            tokenColorCustomizations: {
                textMateRules: [
                    { scope: 'comment', settings: { foreground: '#deadbe' } },
                ],
            },
        }));
        expect(recorded.value).toHaveLength(1);
        expect(recorded.value[0].scope).toBe('comment');
        expect(recorded.value[0].settings.foreground).toBe('#deadbe');
    });

    test('layers per-theme [Label] block AFTER the top-level rules', async () => {
        const recorded: { value: readonly ThemeSetting[] } = { value: [] };
        await resolveActiveThemePalette(customizationsArgs({
            registry: fakeRegistry({
                snippetIndex: () => 0,
                colorMap: [],
                recordedSettings: recorded,
            }),
            tokenColorCustomizations: {
                textMateRules: [
                    { scope: 'keyword', settings: { foreground: '#111111' } },
                ],
                '[My Theme]': {
                    textMateRules: [
                        { scope: 'keyword', settings: { foreground: '#222222' } },
                    ],
                },
            },
        }));
        // Order matters — TextMate's "later rule wins" means the
        // per-theme rule must come AFTER the fallback. Both rules
        // make it into the merged list.
        expect(recorded.value).toHaveLength(2);
        expect(recorded.value[0].settings.foreground).toBe('#111111');
        expect(recorded.value[1].settings.foreground).toBe('#222222');
    });

    test('ignores `[OtherTheme]` blocks when the active label does not match', async () => {
        const recorded: { value: readonly ThemeSetting[] } = { value: [] };
        await resolveActiveThemePalette(customizationsArgs({
            registry: fakeRegistry({
                snippetIndex: () => 0,
                colorMap: [],
                recordedSettings: recorded,
            }),
            tokenColorCustomizations: {
                '[Some Other Theme]': {
                    textMateRules: [
                        { scope: 'keyword', settings: { foreground: '#ffaa00' } },
                    ],
                },
            },
        }));
        expect(recorded.value).toHaveLength(0);
    });

    test('semanticTokenColors.function overrides the TextMate probe for the function role', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'My Theme',
            themeRelativePath: 'theme.json',
        });
        const out = await resolveActiveThemePalette(baseArgs({
            candidateThemeIds: ['My Theme'],
            extensions: [ext],
            readFile: readFileFrom({
                '/e/theme.json': JSON.stringify({
                    type: 'dark',
                    tokenColors: [],
                    semanticTokenColors: { function: '#aabbcc' },
                    colors: {},
                }),
            }),
            registry: fakeRegistry({
                // The grammar probe returns index 1 (a valid color)
                // for the function snippet — without the semantic
                // override the role would resolve to colorMap[1].
                snippetIndex: (s) => s.startsWith('foo') ? 1 : 0,
                colorMap: ['#000000', '#ffffff'],
            }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            // The semantic override wins, not the TextMate probe.
            expect(out.palette.roles.function).toBe('#aabbcc');
        }
    });

    test('semanticTokenColorCustomizations layers on top of theme semanticTokenColors', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'My Theme',
            themeRelativePath: 'theme.json',
        });
        const out = await resolveActiveThemePalette(baseArgs({
            candidateThemeIds: ['My Theme'],
            extensions: [ext],
            readFile: readFileFrom({
                '/e/theme.json': JSON.stringify({
                    type: 'dark',
                    tokenColors: [],
                    semanticTokenColors: { function: '#111111' },
                    colors: {},
                }),
            }),
            semanticTokenColorCustomizations: {
                rules: { function: { foreground: '#222222' } },
            },
            registry: fakeRegistry({ snippetIndex: () => 0, colorMap: ['#000000'] }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.roles.function).toBe('#222222');
        }
    });

    test('ignores semantic-token keys with modifiers (e.g. function.declaration)', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'My Theme',
            themeRelativePath: 'theme.json',
        });
        const out = await resolveActiveThemePalette(baseArgs({
            candidateThemeIds: ['My Theme'],
            extensions: [ext],
            readFile: readFileFrom({
                '/e/theme.json': JSON.stringify({
                    type: 'dark',
                    tokenColors: [],
                    // Both `function` (bare) and `function.declaration`
                    // (modifier selector). Only the bare form should
                    // be honored.
                    semanticTokenColors: {
                        function: '#aabbcc',
                        'function.declaration': '#ddeeff',
                    },
                    colors: {},
                }),
            }),
            registry: fakeRegistry({ snippetIndex: () => 0, colorMap: ['#000000'] }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.roles.function).toBe('#aabbcc');
        }
    });
});
