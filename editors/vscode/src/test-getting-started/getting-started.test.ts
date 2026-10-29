// Walks through docs/getting-started.md step by step against the real
// extension, so the tutorial can't drift from what Raven does in VS Code.
//
// The workspace is a temp copy of docs/examples/snippets/getting-started-before
// made by .vscode-test.mjs (label `getting-started`), outside the repo so no
// raven.toml or .lintr above it can change the result. The same files are
// shown in the tutorial and checked against `raven check` by
// crates/raven/tests/docs_examples.rs. scripts/fresh-install-check.sh runs
// this file against an installed VSIX on a machine without R.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { awaitActive, sleep, waitForDiagnosticsMatching } from '../test/helper';

function workspaceFile(name: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'getting-started tests need the tutorial workspace open');
    return vscode.Uri.joinPath(folder.uri, name);
}

function hoverText(hovers: vscode.Hover[] | undefined): string {
    return (hovers ?? [])
        .flatMap(h => h.contents)
        .map(c => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))
        .join('\n');
}

suite('Getting started tutorial', () => {
    let doc: vscode.TextDocument;
    let editor: vscode.TextEditor;

    suiteSetup(async () => {
        const ext = vscode.extensions.all.find(e => e.id === 'jbearak.raven-r');
        assert.ok(ext, 'Raven extension is not installed');
        if (!ext.isActive) {
            await ext.activate();
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        assert.ok(root, 'no workspace folder');
        for (let dir = root; dir !== path.dirname(dir); dir = path.dirname(dir)) {
            for (const name of ['raven.toml', '.lintr']) {
                assert.ok(!fs.existsSync(path.join(dir, name)), `${path.join(dir, name)} would change the tutorial's results`);
            }
        }
        doc = await vscode.workspace.openTextDocument(workspaceFile('main.R'));
        editor = await vscode.window.showTextDocument(doc);
        await awaitActive(editor);
    });

    test('step 3: the typo gets an undefined-variable warning', async () => {
        const diagnostics = await waitForDiagnosticsMatching(
            doc.uri,
            ds => ds.some(d => d.message.includes('summarize_score is not defined')),
            30000,
        );
        const typo = diagnostics.find(d => d.message.includes('summarize_score is not defined'));
        assert.ok(typo, `step 3: expected "summarize_score is not defined", got ${JSON.stringify(diagnostics.map(d => d.message))}`);
        assert.strictEqual(typo.severity, vscode.DiagnosticSeverity.Warning, 'step 3: expected a warning');
        assert.strictEqual(typo.range.start.line, 3, 'step 3: expected the warning on line 4');
        assert.strictEqual(diagnostics.length, 1, `step 3: expected only the typo, got ${JSON.stringify(diagnostics.map(d => d.message))}`);
    });

    test('step 4: adding the missing "s" clears the warning', async () => {
        const line = doc.lineAt(3);
        const at = line.text.indexOf('summarize_score(');
        assert.ok(at >= 0, 'step 4: tutorial line not found');
        await editor.edit(b => b.insert(new vscode.Position(3, at + 'summarize_score'.length), 's'));
        const after = await waitForDiagnosticsMatching(doc.uri, ds => ds.length === 0, 30000);
        assert.deepStrictEqual(after.map(d => d.message), [], 'step 4: expected no diagnostics after the fix');
    });

    test('step 5: go to definition opens helpers.R', async () => {
        const position = new vscode.Position(3, doc.lineAt(3).text.indexOf('summarize_scores') + 3);
        let locations: (vscode.Location | vscode.LocationLink)[] | undefined;
        for (let attempt = 0; attempt < 20 && !locations?.length; attempt++) {
            locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, position);
            if (!locations?.length) await sleep(250);
        }
        assert.ok(locations?.length, 'step 5: expected a definition');
        const target = 'targetUri' in locations[0] ? locations[0].targetUri : locations[0].uri;
        assert.strictEqual(path.basename(target.fsPath), 'helpers.R', 'step 5: expected the definition in helpers.R');
    });

    test('step 5: hover shows the definition and its file', async () => {
        const position = new vscode.Position(3, doc.lineAt(3).text.indexOf('summarize_scores') + 3);
        const text = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, position));
        assert.ok(text.includes('summarize_scores <- function'), `step 5: hover should show the definition, got:\n${text}`);
        assert.ok(text.includes('helpers.R'), `step 5: hover should name helpers.R, got:\n${text}`);
    });

    test('step 5: completion offers summarize_scores', async () => {
        const end = doc.lineAt(doc.lineCount - 1).range.end;
        await editor.edit(b => b.insert(end, '\nsumm'));
        const position = doc.lineAt(doc.lineCount - 1).range.end;
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            position,
        );
        const labels = (list?.items ?? []).map(i => (typeof i.label === 'string' ? i.label : i.label.label));
        assert.ok(labels.includes('summarize_scores'), `step 5: expected summarize_scores in completions`);
    });

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });
});
