import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from './helper';
import { KnitOutputPanel } from '../knit/knit-output-panel';
import { previewArtifactPaths } from '../knit/raven-knit-paths';
import { ravenKnitRoot } from '../knit/preview-persistence';

/**
 * Integration coverage for `KnitOutputPanel.restore` — the
 * `WebviewPanelSerializer` entry point that rebuilds a Knit Preview
 * panel after a window reload/restart.
 *
 * See `docs/superpowers/specs/2026-06-22-knit-preview-persistence-design.md`.
 */
suite('KnitOutputPanel.restore (serializer rebuild)', () => {
    let tmp: string;
    const createdPreviewDirs: string[] = [];

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-knit-restore-'));
        fs.mkdirSync(ravenKnitRoot(), { recursive: true });
    });

    teardown(() => {
        KnitOutputPanel.disposeAllForTesting();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
        for (const d of createdPreviewDirs) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
        }
        createdPreviewDirs.length = 0;
    });

    function makePanel(): vscode.WebviewPanel {
        return vscode.window.createWebviewPanel(
            'raven.knitOutput',
            'Knit Preview',
            vscode.ViewColumn.One,
            { enableScripts: true },
        );
    }

    test('adopts the old-session artifact into the current session and rebuilds', async () => {
        await activate();
        const output = vscode.window.createOutputChannel('Knit Restore Test');
        const panel = makePanel();
        try {
            const src = vscode.Uri.file(path.join(tmp, 'doc.Rmd'));
            const current = previewArtifactPaths(src.fsPath);
            createdPreviewDirs.push(current.previewDir);
            assert.ok(!fs.existsSync(current.htmlPath), 'precondition: no current artifact');

            // Old-session dir with the same basename the current path expects.
            const oldDir = fs.mkdtempSync(path.join(ravenKnitRoot(), 'restore-old-'));
            const oldHtml = path.join(oldDir, path.basename(current.htmlPath));
            fs.writeFileSync(oldHtml, '<html><body>RESTORED-MARKER-7Q</body></html>', 'utf-8');

            await KnitOutputPanel.restore(
                {} as vscode.ExtensionContext,
                panel,
                { sourceFsPath: src.fsPath, outputPath: oldHtml },
                output,
            );

            const inst = KnitOutputPanel.getInstancesForTesting().get(src.fsPath);
            assert.ok(inst, 'a panel instance is registered for the source');
            assert.ok(
                fs.existsSync(current.htmlPath),
                'artifact was adopted into the current-session path',
            );
            assert.ok(
                panel.webview.html.includes('RESTORED-MARKER-7Q'),
                'rebuilt panel renders the adopted content',
            );
            // localResourceRoots re-applied to the adopted dir.
            const roots = panel.webview.options.localResourceRoots!;
            assert.strictEqual(roots[0].fsPath, current.previewDir);
        } finally {
            output.dispose();
        }
    });

    test('shows the knit-again placeholder when nothing is left to restore', async () => {
        await activate();
        const output = vscode.window.createOutputChannel('Knit Restore Test');
        const panel = makePanel();
        try {
            const src = vscode.Uri.file(path.join(tmp, 'gone.Rmd'));
            const current = previewArtifactPaths(src.fsPath);
            createdPreviewDirs.push(current.previewDir);

            // Persisted path is under the knit tree (containment ok) but the
            // file is gone — parent exists so containment resolves cleanly.
            const oldDir = fs.mkdtempSync(path.join(ravenKnitRoot(), 'restore-gone-'));
            const goneHtml = path.join(oldDir, path.basename(current.htmlPath));

            await KnitOutputPanel.restore(
                {} as vscode.ExtensionContext,
                panel,
                { sourceFsPath: src.fsPath, outputPath: goneHtml },
                output,
            );

            const inst = KnitOutputPanel.getInstancesForTesting().get(src.fsPath);
            assert.ok(inst, 'instance still registered so Knit again works');
            assert.ok(
                panel.webview.html.includes('Knit again'),
                'placeholder points the user at the Knit again button',
            );
        } finally {
            output.dispose();
        }
    });

    test('disposes the panel and registers nothing when state has no source', async () => {
        await activate();
        const output = vscode.window.createOutputChannel('Knit Restore Test');
        const panel = makePanel();
        let disposed = false;
        panel.onDidDispose(() => { disposed = true; });
        try {
            await KnitOutputPanel.restore(
                {} as vscode.ExtensionContext,
                panel,
                { outputPath: '/whatever' },
                output,
            );
            assert.strictEqual(disposed, true, 'panel was disposed');
            assert.strictEqual(
                KnitOutputPanel.getInstancesForTesting().size,
                0,
                'no instance registered for a sourceless restore',
            );
        } finally {
            output.dispose();
        }
    });
});
