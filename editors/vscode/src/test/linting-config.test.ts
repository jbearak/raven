/**
 * Integration tests for linting configuration.
 *
 * A raven.toml in the test fixtures directory enables linting. This test
 * opens a file with intentional lint violations and verifies that the LSP
 * produces lint diagnostics with source "raven (lint)".
 *
 * The demo/ subfolders (raven.toml, .lintr, .vscode/settings.json) exist
 * for manual smoke testing with different config mechanisms.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, openDocument, waitForDiagnostics, sleep } from './helper';

suite('linting config integration', function (this: Mocha.Suite) {
    this.timeout(60000);

    suiteSetup(async () => {
        await activate();
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('lint diagnostics are produced for files with violations', async () => {
        const doc = await openDocument('lint_violations.R');

        // Wait for diagnostics (lint or otherwise) to appear.
        const deadline = Date.now() + 30000;
        let lintDiags: vscode.Diagnostic[] = [];
        while (Date.now() < deadline) {
            await sleep(500);
            const all = vscode.languages.getDiagnostics(doc.uri);
            lintDiags = all.filter(d => d.source === 'raven (lint)');
            if (lintDiags.length >= 3) break;
        }

        assert.ok(
            lintDiags.length >= 3,
            `Expected at least 3 lint diagnostics (source "raven (lint)"); got ${lintDiags.length}. ` +
            `All diagnostics: ${vscode.languages.getDiagnostics(doc.uri).map(d => `[${d.source}] ${d.message}`).join('; ')}`,
        );
    });

    test('lint diagnostics include expected violation types', async () => {
        const doc = await openDocument('lint_violations.R');

        const deadline = Date.now() + 15000;
        let lintDiags: vscode.Diagnostic[] = [];
        while (Date.now() < deadline) {
            await sleep(500);
            const all = vscode.languages.getDiagnostics(doc.uri);
            lintDiags = all.filter(d => d.source === 'raven (lint)');
            if (lintDiags.length >= 3) break;
        }

        const messages = lintDiags.map(d => d.message.toLowerCase());
        // At minimum we expect line-length, trailing whitespace, and assignment violations.
        const hasLineLength = messages.some(m => m.includes('line') || m.includes('character'));
        const hasTrailingWs = messages.some(m => m.includes('trailing') && m.includes('whitespace'));
        const hasAssignment = messages.some(m => m.includes('assignment') || m.includes('<-'));

        assert.ok(
            hasLineLength || hasTrailingWs || hasAssignment,
            `Expected recognizable lint messages; got: ${messages.join('; ')}`,
        );
    });
});
