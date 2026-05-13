/// <reference types="mocha" />

import * as assert from 'assert';
import * as vscode from 'vscode';
import { detect_r_package } from '../r-package-detection';
import { activate } from './helper';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;
declare const suiteTeardown: Mocha.HookFunction;

async function writeDescription(folder: vscode.Uri, content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.joinPath(folder, 'DESCRIPTION');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return uri;
}

async function safeDelete(uri: vscode.Uri): Promise<void> {
    try {
        await vscode.workspace.fs.delete(uri);
    } catch {
        // best-effort cleanup
    }
}

/**
 * Snapshot and restore `raven.packages.packageMode` at workspace scope.
 *
 * `config.get(...)` returns the merged effective value (workspace ?? user
 * ?? default), so naively saving its result and writing it back would
 * persist the default value into `.vscode/settings.json` even when the
 * workspace originally had no override. Round-trip via `.inspect()` so
 * tests can faithfully restore "no workspace value" → `undefined`.
 */
async function withPackageMode<T>(
    value: string,
    body: () => Promise<T>,
): Promise<T> {
    const config = vscode.workspace.getConfiguration('raven');
    const original = config.inspect<string>('packages.packageMode')?.workspaceValue;
    try {
        await config.update(
            'packages.packageMode',
            value,
            vscode.ConfigurationTarget.Workspace,
        );
        return await body();
    } finally {
        await config.update(
            'packages.packageMode',
            original,
            vscode.ConfigurationTarget.Workspace,
        );
    }
}

suite('r-package detection', () => {
    // `config.update(key, undefined, Workspace)` clears the key but VS Code
    // leaves the `.vscode/settings.json` file behind, possibly empty. Sweep
    // it on suite teardown so the fixture workspace stays clean between
    // test runs and doesn't pollute `git status`.
    suiteTeardown(async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        // VS Code's settings.json write after `update(key, undefined)` is
        // best-effort but doesn't remove the file when no keys remain.
        // Wait a moment for the pending write to land before inspecting.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const dotVscode = vscode.Uri.joinPath(folder.uri, '.vscode');
        const settings = vscode.Uri.joinPath(dotVscode, 'settings.json');
        try {
            const bytes = await vscode.workspace.fs.readFile(settings);
            const text = Buffer.from(bytes).toString('utf8').trim();
            if (text === '' || text === '{}' || text === '{\n}') {
                await safeDelete(settings);
                // Also remove the now-empty .vscode dir, but only if empty —
                // a real test/fixture file there would survive.
                try {
                    const entries = await vscode.workspace.fs.readDirectory(dotVscode);
                    if (entries.length === 0) await safeDelete(dotVscode);
                } catch {
                    // .vscode missing — nothing else to clean.
                }
            }
        } catch {
            // No settings.json — nothing to clean.
        }
    });

    test('packageMode "disabled" forces the answer to false even when DESCRIPTION exists', async function () {
        this.timeout(15000);
        await activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'test harness must open a workspace folder');
        const desc = await writeDescription(folder.uri, 'Package: ravenTestPkg\n');
        try {
            await withPackageMode('disabled', async () => {
                assert.strictEqual(await detect_r_package(), false);
            });
        } finally {
            await safeDelete(desc);
        }
    });

    test('packageMode "enabled" forces the answer to true even without a DESCRIPTION file', async function () {
        this.timeout(15000);
        await activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'test harness must open a workspace folder');
        const desc = vscode.Uri.joinPath(folder.uri, 'DESCRIPTION');
        await safeDelete(desc);
        await withPackageMode('enabled', async () => {
            assert.strictEqual(await detect_r_package(), true);
        });
    });

    test('packageMode "auto" rejects a DESCRIPTION file missing the Package: field', async function () {
        this.timeout(15000);
        await activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'test harness must open a workspace folder');
        const desc = await writeDescription(folder.uri, 'Title: Not a package\n');
        try {
            await withPackageMode('auto', async () => {
                assert.strictEqual(await detect_r_package(), false);
            });
        } finally {
            await safeDelete(desc);
        }
    });

    test('packageMode "auto" accepts a DESCRIPTION file with a non-empty Package: field', async function () {
        this.timeout(15000);
        await activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'test harness must open a workspace folder');
        const desc = await writeDescription(
            folder.uri,
            'Package: ravenTestPkg\nTitle: Example\nVersion: 0.0.1\n',
        );
        try {
            await withPackageMode('auto', async () => {
                assert.strictEqual(await detect_r_package(), true);
            });
        } finally {
            await safeDelete(desc);
        }
    });
});
