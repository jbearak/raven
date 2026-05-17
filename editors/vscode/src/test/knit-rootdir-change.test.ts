import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, sleep } from './helper';
import { KnitOutputPanel } from '../knit/knit-output-panel';

async function waitForPanelColumn(
    panel: vscode.WebviewPanel,
    timeoutMs = 2000,
): Promise<vscode.ViewColumn> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (panel.viewColumn !== undefined) return panel.viewColumn;
        await sleep(50);
    }
    throw new Error(`panel.viewColumn never resolved within ${timeoutMs}ms`);
}

/**
 * Highest-risk lifecycle branch: same source URI, different `rootDir`.
 * `localResourceRoots` is immutable post-creation, so the existing
 * panel must be disposed and recreated in its current column. The
 * dispose handler's identity guard must not delete the replacement
 * under the same key.
 *
 * See `docs/superpowers/specs/2026-05-17-knit-panel-per-file-design.md`.
 */
suite('KnitOutputPanel rootDir change recreates panel in place', () => {
    let tmp: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-knit-rootdir-'));
    });

    teardown(() => {
        KnitOutputPanel.disposeAllForTesting();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    });

    test('same source, different rootDir → disposes old panel, creates new in same column', async () => {
        await activate();
        const output = vscode.window.createOutputChannel('Knit Test');
        try {
            const dir1 = path.join(tmp, 'dir1');
            const dir2 = path.join(tmp, 'dir2');
            fs.mkdirSync(dir1, { recursive: true });
            fs.mkdirSync(dir2, { recursive: true });
            const out1 = path.join(dir1, 'out.html');
            const out2 = path.join(dir2, 'out.html');
            fs.writeFileSync(out1, '<html><body>1</body></html>', 'utf-8');
            fs.writeFileSync(out2, '<html><body>2</body></html>', 'utf-8');
            const src = vscode.Uri.file(path.join(tmp, 'src.Rmd'));

            await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: src, outputPath: out1, output },
            );
            const inst1 = KnitOutputPanel.getInstancesForTesting().get(src.fsPath);
            assert.ok(inst1);
            const panel1 = inst1.getPanelForTesting();
            const col1 = await waitForPanelColumn(panel1);
            const rootsBefore = panel1.webview.options.localResourceRoots!;
            assert.strictEqual(rootsBefore[0].fsPath, dir1);

            await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: src, outputPath: out2, output },
            );
            const instances = KnitOutputPanel.getInstancesForTesting();
            assert.strictEqual(
                instances.size, 1,
                'still exactly one panel for this source after rootDir change',
            );

            const inst2 = instances.get(src.fsPath);
            assert.ok(inst2);
            const panel2 = inst2.getPanelForTesting();
            assert.notStrictEqual(
                panel2, panel1,
                'a new WebviewPanel was created (old was disposed)',
            );
            const col2 = await waitForPanelColumn(panel2);
            assert.strictEqual(
                col2, col1,
                'replacement panel lands in the same column as the disposed one',
            );

            const rootsAfter = panel2.webview.options.localResourceRoots!;
            assert.strictEqual(
                rootsAfter[0].fsPath, dir2,
                'replacement panel has the new rootDir in localResourceRoots',
            );
        } finally {
            output.dispose();
        }
    });
});
