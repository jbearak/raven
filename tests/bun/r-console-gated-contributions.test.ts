/**
 * Manifest rules for contributions that only work while Raven's R console is
 * enabled, and the context key behind the chunk-navigation keys
 * (editors/vscode/src/chunks/chunk-navigation.ts).
 *
 * - Ctrl/Cmd+PageDown and Ctrl/Cmd+PageUp are VS Code's Next/Previous
 *   Editor on Windows and Linux. Raven binds them to chunk navigation only
 *   in a document that has chunks (`raven.editorHasChunks`); anywhere else
 *   they must still switch tabs.
 * - The `raven-r` debugger and its breakpoint languages are enabled only
 *   while the console is (`raven.rConsoleEnabled`): its adapter is
 *   registered only then, and F5 must otherwise go to another R debugger or
 *   none.
 */
import { describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PACKAGE_JSON = path.resolve(__dirname, '..', '..', 'editors', 'vscode', 'package.json');
const contributes = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).contributes as {
    keybindings: Array<{ command: string; key?: string; mac?: string; when?: string }>;
    debuggers: Array<{ type: string; when?: string }>;
    breakpoints: Array<{ language: string; when?: string }>;
};

/** `when` as a set of top-level `&&` conjuncts. */
function conjuncts(when: string | undefined): string[] {
    return (when ?? '').split('&&').map((c) => c.trim()).filter(Boolean);
}

describe('chunk navigation keys', () => {
    const page_keys = contributes.keybindings.filter((k) =>
        /pageup|pagedown/i.test(`${k.key ?? ''} ${k.mac ?? ''}`) && k.command.startsWith('raven.'));

    test('both chunk-navigation commands are bound', () => {
        expect(page_keys.map((k) => k.command).sort()).toEqual(['raven.goToNextChunk', 'raven.goToPreviousChunk']);
    });

    test('fire only in a document with chunks, so they otherwise switch editors', () => {
        for (const k of page_keys) {
            expect(conjuncts(k.when)).toContain('raven.editorHasChunks');
            expect(conjuncts(k.when)).toContain('raven.rConsoleEnabled');
        }
    });
});

describe('the raven-r debugger', () => {
    test('is enabled only while the R console is', () => {
        const dbg = contributes.debuggers.find((d) => d.type === 'raven-r');
        expect(dbg).toBeDefined();
        expect(conjuncts(dbg!.when)).toEqual(['raven.rConsoleEnabled']);
    });

    test("contributes breakpoints only while the R console is", () => {
        expect(contributes.breakpoints.map((b) => b.language).sort()).toEqual(['quarto', 'r', 'rmd']);
        for (const b of contributes.breakpoints) expect(conjuncts(b.when)).toEqual(['raven.rConsoleEnabled']);
    });
});

// ------------------------------------------------- the context key's upkeep

type Listener<T> = (e: T) => void;
const active_listeners: Array<Listener<unknown>> = [];
const change_listeners: Array<Listener<{ document: unknown }>> = [];
const context_values: Array<[string, unknown]> = [];
const window_mock: { activeTextEditor: unknown } = { activeTextEditor: undefined };
const disposable = () => ({ dispose() {} });

mock.module('vscode', () => ({
    Disposable: class { constructor(private fn: () => void = () => undefined) {} dispose() { this.fn(); } },
    commands: {
        registerCommand: disposable,
        executeCommand: async (cmd: string, key: string, value: unknown) => {
            if (cmd === 'setContext') context_values.push([key, value]);
        },
    },
    window: {
        get activeTextEditor() { return window_mock.activeTextEditor; },
        onDidChangeActiveTextEditor: (cb: Listener<unknown>) => { active_listeners.push(cb); return disposable(); },
    },
    workspace: {
        getConfiguration: () => ({ get: (_k: string, fallback?: unknown) => fallback }),
        onDidChangeTextDocument: (cb: Listener<{ document: unknown }>) => { change_listeners.push(cb); return disposable(); },
    },
}));

const { register_chunk_navigation, HAS_CHUNKS_CONTEXT } = await import('../../editors/vscode/src/chunks/chunk-navigation');

function doc(text: string, languageId = 'r', file = '/w/a.R') {
    const d = {
        text,
        languageId,
        uri: { fsPath: file, path: file, scheme: 'file' },
        getText: () => d.text,
        get lineCount() { return d.text.split('\n').length; },
        lineAt: (i: number) => ({ text: d.text.split('\n')[i] ?? '' }),
    };
    return d;
}
const last = () => context_values.filter(([k]) => k === HAS_CHUNKS_CONTEXT).at(-1)?.[1];

describe('raven.editorHasChunks', () => {
    test('follows the active editor and edits to its document', async () => {
        const plain = doc('x <- 1\ny <- 2\n');
        const cells = doc('# %%\nx <- 1\n# %%\ny <- 2\n', 'r', '/w/b.R');
        const rmd = doc('---\ntitle: t\n---\n\n```{r}\nx <- 1\n```\n', 'rmd', '/w/c.Rmd');
        window_mock.activeTextEditor = { document: plain };
        const ctx = { subscriptions: [] as Array<{ dispose(): void }> };
        register_chunk_navigation(ctx as never);
        expect(last()).toBe(false);

        window_mock.activeTextEditor = { document: cells };
        for (const l of active_listeners) l(window_mock.activeTextEditor);
        expect(last()).toBe(true);

        window_mock.activeTextEditor = { document: rmd };
        for (const l of active_listeners) l(window_mock.activeTextEditor);
        expect(last()).toBe(true);

        window_mock.activeTextEditor = undefined;
        for (const l of active_listeners) l(undefined);
        expect(last()).toBe(false);

        // Adding a cell marker to a plain script turns the keys on.
        window_mock.activeTextEditor = { document: plain };
        for (const l of active_listeners) l(window_mock.activeTextEditor);
        expect(last()).toBe(false);
        plain.text = '# %%\n' + plain.text;
        for (const l of change_listeners) l({ document: plain });
        await new Promise((r) => setTimeout(r, 300));
        expect(last()).toBe(true);
        for (const d of ctx.subscriptions) d.dispose();
    });
});
