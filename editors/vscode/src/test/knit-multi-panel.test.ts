import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, sleep } from './helper';
import { KnitOutputPanel } from '../knit/knit-output-panel';

/**
 * Poll until `previewColumn` is anchored, or fail after timeoutMs. The
 * panel is created with `ViewColumn.Beside` + `preserveFocus: true`, so
 * VS Code may not assign a concrete `viewColumn` until the panel
 * becomes visible (fires `onDidChangeViewState`, which triggers
 * `recomputePreviewColumn`).
 */
async function waitForPreviewColumn(timeoutMs = 2000): Promise<vscode.ViewColumn> {
    const deadline = Date.now() + timeoutMs;
    let last: vscode.ViewColumn | undefined;
    while (Date.now() < deadline) {
        last = KnitOutputPanel.getPreviewColumnForTesting();
        if (last !== undefined) return last;
        await sleep(50);
    }
    throw new Error(`previewColumn never anchored within ${timeoutMs}ms`);
}

/**
 * Per-source-path registry: knitting two different `.Rmd` files in one
 * window must produce two distinct panels. Re-knitting the first must
 * reuse its panel. Each panel must own a distinct `localResourceRoots`.
 *
 * See `docs/superpowers/specs/2026-05-17-knit-panel-per-file-design.md`.
 */
suite('KnitOutputPanel multi-panel registry', () => {
    let tmp: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-knit-multi-'));
    });

    teardown(() => {
        KnitOutputPanel.disposeAllForTesting();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    });

    test('two sources produce two panels in the same preview column with distinct roots', async () => {
        await activate();
        const output = vscode.window.createOutputChannel('Knit Test');
        try {
            const dirA = path.join(tmp, 'a');
            const dirB = path.join(tmp, 'b');
            fs.mkdirSync(dirA, { recursive: true });
            fs.mkdirSync(dirB, { recursive: true });
            const outA = path.join(dirA, 'a.html');
            const outB = path.join(dirB, 'b.html');
            fs.writeFileSync(outA, '<html><body>A</body></html>', 'utf-8');
            fs.writeFileSync(outB, '<html><body>B</body></html>', 'utf-8');
            const srcA = vscode.Uri.file(path.join(tmp, 'a.Rmd'));
            const srcB = vscode.Uri.file(path.join(tmp, 'b.Rmd'));

            await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: srcA, outputPath: outA, output },
            );
            // Wait for A's panel to resolve its viewColumn before
            // opening B — otherwise previewColumn is still undefined
            // when B's showOrUpdate runs and B falls back to Beside,
            // which may land in a different column than A.
            await waitForPreviewColumn();
            await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: srcB, outputPath: outB, output },
            );

            const instances = KnitOutputPanel.getInstancesForTesting();
            assert.strictEqual(instances.size, 2, 'two distinct sources → two panels');

            const instA = instances.get(srcA.fsPath);
            const instB = instances.get(srcB.fsPath);
            assert.ok(instA, 'panel for A.Rmd should exist');
            assert.ok(instB, 'panel for B.Rmd should exist');
            assert.notStrictEqual(instA, instB, 'panels for different sources are distinct');

            const panelA = instA.getPanelForTesting();
            const panelB = instB.getPanelForTesting();
            const previewColumn = await waitForPreviewColumn();
            assert.strictEqual(panelA.viewColumn, previewColumn);
            assert.strictEqual(panelB.viewColumn, previewColumn);

            // Per-panel localResourceRoots isolation: neither panel can
            // resolve resources from the other's output directory.
            const rootsA = panelA.webview.options.localResourceRoots!;
            const rootsB = panelB.webview.options.localResourceRoots!;
            assert.strictEqual(rootsA.length, 1);
            assert.strictEqual(rootsB.length, 1);
            assert.strictEqual(rootsA[0].fsPath, dirA);
            assert.strictEqual(rootsB[0].fsPath, dirB);
            assert.notStrictEqual(rootsA[0].fsPath, rootsB[0].fsPath);

            // Re-knit A — reuses A's panel, B's panel untouched.
            await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: srcA, outputPath: outA, output },
            );
            const instances2 = KnitOutputPanel.getInstancesForTesting();
            assert.strictEqual(instances2.size, 2, 're-knit of A does not add a panel');
            assert.strictEqual(
                instances2.get(srcA.fsPath)?.getPanelForTesting(),
                panelA,
                're-knit of A reuses the same WebviewPanel reference',
            );
            assert.strictEqual(
                instances2.get(srcB.fsPath)?.getPanelForTesting(),
                panelB,
                'B\'s panel is untouched by re-knit of A',
            );
        } finally {
            output.dispose();
        }
    });
});
