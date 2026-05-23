import { describe, test, expect } from 'bun:test';
import {
    resolveActiveThemePalette,
    type ExtensionLike,
    type ThemePaletteArgs,
} from '../../editors/vscode/src/knit/vscode-theme-palette';
import type {
    GrammarRegistry,
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
function fakeRegistry(opts: {
    /** Per-snippet → foreground color index map. */
    snippetIndex: (snippet: string) => number;
    colorMap: readonly string[];
    /**
     * If set, `extractWithTheme` saves the merged settings here so
     * tests can assert on what got threaded through.
     */
    recordedSettings?: { value: readonly ThemeSetting[] };
    primeForR?: boolean;
}): Pick<GrammarRegistry, 'extractWithTheme' | 'primeForLanguage'> {
    return {
        async primeForLanguage(_lang: string) {
            return opts.primeForR ?? true;
        },
        async extractWithTheme<T>(
            settings: readonly ThemeSetting[],
            inner: (api: ThemeExtractionApi) => Promise<T>,
        ): Promise<T> {
            if (opts.recordedSettings) opts.recordedSettings.value = settings;
            const api: ThemeExtractionApi = {
                colorMap: opts.colorMap,
                async tokenizeLine2ForLanguage(_lang, line, _state) {
                    const fgIndex = opts.snippetIndex(line);
                    // Encode `(startIndex=0, metadata)` where metadata
                    // has the foreground bits set. Layout matches
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
        workbenchColorThemeId: 'Test Dark',
        isLight: false,
        extensions: [],
        tokenColorCustomizations: undefined,
        semanticTokenColorCustomizations: undefined,
        registry: fakeRegistry({ snippetIndex: () => 0, colorMap: [] }),
        readFile: async () => { throw new Error('readFile must not be called'); },
        ...overrides,
    };
}

describe('resolveActiveThemePalette — discovery', () => {
    test('fails when workbench.colorTheme is empty', async () => {
        const out = await resolveActiveThemePalette(baseArgs({ workbenchColorThemeId: '' }));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('no-theme-id');
    });

    test('fails when no contributed theme matches the id', async () => {
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
            workbenchColorThemeId: 'theme-id-X',
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
            workbenchColorThemeId: 'Test Dark',
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
    test('reads role colors from the registry colorMap when probes hit non-default indices', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        // The fake yields different indices per snippet so we can
        // assert the resolver wired the right one into each role.
        // colorMap[0] is default (treated as "no theme color").
        // colorMap[0] is reserved; colorMap[1] is the default fg.
        // Probes that fall through to the default are filtered, so
        // colorMap[1] = '#aabbcc' acts as the "no rule matched"
        // sentinel here. Every other index is a distinct role color.
        const colorMap = ['', '#aabbcc', '#aa0000', '#00aa00', '#0000aa', '#aaaa00', '#aa00aa', '#00aaaa'];
        const snippetIndex = (snippet: string): number => {
            if (snippet.startsWith('if ')) return 2;          // keyword
            if (snippet === '"x"') return 3;                  // string
            if (snippet === '42') return 4;                   // number
            if (snippet === '# x') return 5;                  // comment
            if (snippet === 'library(x)') return 6;           // function (probe snippet)
            if (snippet === 'list(1)') return 7;              // type (probe snippet)
            return 1;  // default fg — filtered by extractor
        };
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile: readFileFrom({
                '/e/theme.json': JSON.stringify({
                    type: 'dark',
                    // Empty-scope default rule with foreground
                    // matching colorMap[1]. This sets the
                    // extractor's noMatchFg so the filter knows
                    // which color to drop.
                    tokenColors: [
                        { settings: { foreground: '#aabbcc', background: '#101010' } },
                    ],
                    colors: { 'editor.background': '#101010' },
                }),
            }),
            registry: fakeRegistry({ snippetIndex, colorMap }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.roles.keyword).toBe('#aa0000');
            expect(out.palette.roles.string).toBe('#00aa00');
            expect(out.palette.roles.number).toBe('#0000aa');
            expect(out.palette.roles.comment).toBe('#aaaa00');
            expect(out.palette.roles.function).toBe('#aa00aa');
            expect(out.palette.roles.type).toBe('#00aaaa');
            // variable: probe falls through to default → filtered →
            // GitHub fallback (#ffa657 for dark).
            expect(out.palette.roles.variable).toBe('#ffa657');
        }
    });

    test('roles whose probe yields index 0 (default fg) fall through to GitHub palette', async () => {
        const ext = fakeThemeExtension({
            extensionPath: '/e',
            label: 'Test Dark',
            themeRelativePath: 'theme.json',
        });
        // Every probe returns index 0 — no theme rule matched.
        const out = await resolveActiveThemePalette(baseArgs({
            extensions: [ext],
            readFile: readFileFrom({
                '/e/theme.json': JSON.stringify({
                    type: 'dark', tokenColors: [], colors: {},
                }),
            }),
            registry: fakeRegistry({
                snippetIndex: () => 0,
                colorMap: ['#000000'],
            }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            // githubDark colors for every role.
            expect(out.palette.roles.keyword).toBe('#ff7b72');
            expect(out.palette.roles.string).toBe('#a5d6ff');
        }
    });

    test('filters out probes that match the theme\'s empty-scope default foreground', async () => {
        // Theme has no rules for our probe scopes but DOES have an
        // empty-scope default rule (`{ settings: { foreground: '#deadbe' } }`).
        // vscode-textmate uses #deadbe for any token whose scope didn't
        // match a specific rule. Without the filter we'd paint every
        // role with #deadbe — the screenshot regression that motivated
        // this fix. With the filter, every role falls back to GitHub.
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
                    tokenColors: [
                        // Empty-scope default rule.
                        { settings: { foreground: '#deadbe', background: '#111111' } },
                    ],
                    colors: {},
                }),
            }),
            // Every probe returns the empty-scope default foreground.
            registry: fakeRegistry({
                snippetIndex: () => 1,
                colorMap: ['', '#deadbe'],
            }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            // All roles filtered → GitHub fallback.
            expect(out.palette.roles.keyword).toBe('#ff7b72');
            expect(out.palette.roles.function).toBe('#d2a8ff');
            expect(out.palette.roles.comment).toBe('#8b949e');
        }
    });

    test('filters out probes that match #000000 when the theme has no empty-scope default rule', async () => {
        // Theme has SOME tokenColors rules but no empty-scope default.
        // vscode-textmate falls back to its hardcoded #000000 for any
        // unmatched scope. Without the filter, those roles would
        // render as black text on dark backgrounds — the original bug.
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
                    tokenColors: [
                        { scope: 'string', settings: { foreground: '#a5d6ff' } },
                    ],
                    colors: { 'editor.foreground': '#c9d1d9' },
                }),
            }),
            // Probes for non-string roles return colorMap[1] = '#000000'
            // (vscode-textmate's hardcoded default when no empty-scope
            // rule exists). The string probe returns colorMap[2].
            registry: fakeRegistry({
                snippetIndex: (s) => s === '"x"' ? 2 : 1,
                colorMap: ['', '#000000', '#a5d6ff'],
            }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.palette.roles.string).toBe('#a5d6ff');
            // Every other role falls back to GitHub (#000000 was
            // filtered out as "no rule matched").
            expect(out.palette.roles.keyword).toBe('#ff7b72');
            expect(out.palette.roles.function).toBe('#d2a8ff');
        }
    });

    test('discards colorMap entries that fail the hex regex', async () => {
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
            registry: fakeRegistry({
                snippetIndex: () => 1,
                // index 1 is a bogus value that should fail validation
                // and route the role through the GitHub fallback.
                colorMap: ['#000000', 'url(steal-data)'],
            }),
        }));
        expect(out.ok).toBe(true);
        if (out.ok) {
            // Every role falls back to githubDark.
            expect(out.palette.roles.keyword).toBe('#ff7b72');
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
            registry: fakeRegistry({
                snippetIndex: () => 0,
                colorMap: [],
                primeForR: false,
            }),
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
            workbenchColorThemeId: 'My Theme',
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
            workbenchColorThemeId: 'My Theme',
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
            workbenchColorThemeId: 'My Theme',
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
            workbenchColorThemeId: 'My Theme',
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
