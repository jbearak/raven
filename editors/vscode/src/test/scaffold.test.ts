/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    GITIGNORE_TEMPLATE,
    LINTR_TEMPLATE,
    createScaffoldFile,
} from '../scaffold';
import { activate } from './helper';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;

const vscodeRoot = path.resolve(__dirname, '..', '..');
const packageJsonPath = path.join(vscodeRoot, 'package.json');

interface CommandContribution {
    command: string;
    title: string;
}

function loadCommandContributions(): CommandContribution[] {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as {
        contributes?: { commands?: CommandContribution[] };
    };
    return pkg.contributes?.commands ?? [];
}

suite('scaffold templates', () => {
    test('.gitignore template contains the canonical R ignores', () => {
        const expected = [
            '.Rhistory',
            '.RData',
            '.Ruserdata',
            '.Rproj.user/',
            '.Renviron',
        ];
        for (const line of expected) {
            assert.ok(
                GITIGNORE_TEMPLATE.includes(line),
                `.gitignore template must include "${line}"`,
            );
        }
    });

    test('.gitignore template ends with a newline', () => {
        assert.ok(
            GITIGNORE_TEMPLATE.endsWith('\n'),
            '.gitignore template should end with a trailing newline',
        );
    });

    test('.lintr template wraps line_length_linter inside linters_with_defaults', () => {
        assert.ok(
            /linters\s*:\s*linters_with_defaults\s*\(/.test(LINTR_TEMPLATE),
            '.lintr template must set `linters:` to a linters_with_defaults() call',
        );
        assert.ok(
            /line_length_linter\(\s*120\s*\)/.test(LINTR_TEMPLATE),
            '.lintr template must enable line_length_linter(120)',
        );
    });

    test('.lintr template ends with a newline', () => {
        assert.ok(
            LINTR_TEMPLATE.endsWith('\n'),
            '.lintr template should end with a trailing newline',
        );
    });
});

suite('scaffold package.json contributions', () => {
    test('declares raven.scaffold.gitignore and raven.scaffold.lintr commands', () => {
        const commands = loadCommandContributions();
        const byId = new Map(commands.map((c) => [c.command, c.title]));
        assert.strictEqual(
            byId.get('raven.scaffold.gitignore'),
            'Raven: Create .gitignore',
            'raven.scaffold.gitignore must be declared with the Raven: prefix',
        );
        assert.strictEqual(
            byId.get('raven.scaffold.lintr'),
            'Raven: Create .lintr',
            'raven.scaffold.lintr must be declared with the Raven: prefix',
        );
    });
});

suite('scaffold integration', () => {
    test('createScaffoldFile writes the requested content to the workspace folder', async function () {
        this.timeout(15000);
        await activate();
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, 'a workspace folder must be open in the test harness');
        const fileName = `.raven-scaffold-test-${Date.now()}.tmp`;
        const target = vscode.Uri.joinPath(folder.uri, fileName);
        try {
            const result = await createScaffoldFile(folder, fileName, 'hello\n');
            assert.ok(result, 'createScaffoldFile should return a URI on success');
            const bytes = await vscode.workspace.fs.readFile(target);
            assert.strictEqual(Buffer.from(bytes).toString('utf8'), 'hello\n');
        } finally {
            try {
                await vscode.workspace.fs.delete(target);
            } catch {
                // best-effort cleanup
            }
        }
    });

    test('extension registers both scaffold commands', async function () {
        this.timeout(15000);
        await activate();
        const all = await vscode.commands.getCommands(true);
        assert.ok(
            all.includes('raven.scaffold.gitignore'),
            'raven.scaffold.gitignore must be registered after activation',
        );
        assert.ok(
            all.includes('raven.scaffold.lintr'),
            'raven.scaffold.lintr must be registered after activation',
        );
    });
});
