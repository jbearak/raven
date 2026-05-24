/**
 * Bun preload that anchors the top-level binding shape of the `vscode`
 * module mock used by tests under `tests/bun/`.
 *
 * Why this exists: Bun's `mock.module()` for ESM modules fixes the SET
 * of top-level export names when the factory is FIRST INVOKED (i.e. on
 * the first `import` / `require` of the specifier after registration).
 * Subsequent `mock.module()` calls update the VALUES of those existing
 * bindings but cannot ADD new top-level names (JavaScriptCore's
 * synthetic ESM module's binding shape is fixed once instantiated).
 * Without this preload, the first test file that calls
 * `mock.module('vscode', …)` AND triggers an import of `vscode` pins
 * the binding shape to whatever subset of keys it declares; a later
 * test file's richer mock silently loses any keys not in the first
 * file's set. That is the failure mode that made
 * `tests/bun/export-commands.test.ts` fail in the full `bun test`
 * suite while passing in isolation: an earlier test (e.g.
 * `data-viewer-panel-persistence.test.ts`) registered a `vscode`
 * mock without `ProgressLocation` / `commands` and then imported a
 * file that pulled in `vscode`; `export-commands.ts` then read
 * `vscode.ProgressLocation.Notification` /
 * `vscode.commands.registerCommand` and got `undefined`.
 *
 * This file runs before any test file is loaded. It registers the
 * UNION of every top-level `vscode` key any test mock uses AND
 * triggers a synchronous evaluation of the factory by `require()`-ing
 * the specifier in the same tick — that's what locks in the binding
 * shape so test files can later call `mock.module('vscode', …)` to
 * override values for the keys they care about. When adding a new
 * top-level `vscode.*` member to any test mock, add a default here
 * too.
 */

import { mock } from 'bun:test';

mock.module('vscode', () => ({
    commands: {
        registerCommand: () => ({ dispose: () => {} }),
        executeCommand: async () => undefined,
    },
    env: {
        openExternal: async () => true,
        clipboard: { writeText: async () => undefined },
    },
    ProgressLocation: {
        SourceControl: 1,
        Window: 10,
        Notification: 15,
    },
    Uri: {
        file: (fsPath: string) => ({
            fsPath,
            path: fsPath,
            scheme: 'file',
            toString: () => `file://${fsPath}`,
        }),
        parse: (value: string) => ({
            fsPath: value,
            path: value,
            scheme: value.split(':', 1)[0],
            toString: () => value,
        }),
        joinPath: (base: { fsPath?: string } | undefined, ...parts: string[]) => ({
            fsPath: [base?.fsPath ?? '', ...parts].join('/'),
            toString: () => parts.join('/'),
        }),
    },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    window: {
        activeTextEditor: undefined,
        createOutputChannel: () => ({
            append: () => {},
            appendLine: () => {},
            show: () => {},
            dispose: () => {},
        }),
        createWebviewPanel: () => {
            throw new Error(
                "vscode preload mock: window.createWebviewPanel is not stubbed; override it via mock.module('vscode', …) in your test.",
            );
        },
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        withProgress: async (
            _opts: unknown,
            task: (progress: unknown, token: unknown) => Promise<unknown>,
        ) => {
            return await task(
                {},
                { onCancellationRequested: () => ({ dispose() {} }) },
            );
        },
    },
    workspace: {
        fs: {
            readFile: async () => new Uint8Array(),
        },
        getConfiguration: () => ({
            get: (_key: string, fallback?: unknown) => fallback,
        }),
        getWorkspaceFolder: () => undefined,
    },
}));

// Force the factory to evaluate NOW so JavaScriptCore instantiates the
// synthetic ESM module with the full set of top-level export names.
// Bun's `mock.module()` only registers the factory; the binding shape
// gets locked in on first import/require, and any later
// `mock.module()` re-registration can update values of existing keys
// but cannot add new keys. The cast is intentional — we don't need
// the namespace, just the side effect of evaluation.
require('vscode');
