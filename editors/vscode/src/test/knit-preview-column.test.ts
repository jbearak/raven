import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, sleep } from './helper';
import { KnitOutputPanel } from '../knit/knit-output-panel';

async function waitForPreviewColumn(timeoutMs = 2000): Promise<vscode.ViewColumn> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const col = KnitOutputPanel.getPreviewColumnForTesting();
        if (col !== undefined) return col;
        await sleep(50);
    }
    throw new Error(`previewColumn never anchored within ${timeoutMs}ms`);
}

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
 * `previewColumn` is the anchor for new panels — they stack as tabs in
 * one column instead of scattering. When the registry empties, the
 * preview column resets to `undefined`; the next knit re-anchors to
 * `ViewColumn.Beside`.
 *
 * See `docs/superpowers/specs/2026-05-17-knit-panel-per-file-design.md`.
 */
suite('KnitOutputPanel preview column anchoring', () => {
    let tmp: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-knit-prev-col-'));
    });

    teardown(() => {
        KnitOutputPanel.disposeAllForTesting();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    });

    test('previewColumn resets when registry empties, then re-anchors on next knit', async () => {
        await activate();
        const output = vscode.window.createOutputChannel('Knit Test');
        try {
            const outA = path.join(tmp, 'a.html');
            const outB = path.join(tmp, 'b.html');
            fs.writeFileSync(outA, '<html><body>A</body></html>', 'utf-8');
            fs.writeFileSync(outB, '<html><body>B</body></html>', 'utf-8');
            const srcA = vscode.Uri.file(path.join(tmp, 'a.Rmd'));
            const srcB = vscode.Uri.file(path.join(tmp, 'b.Rmd'));

            await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: srcA, outputPath: outA, output },
            );
            const anchoredAfterA = await waitForPreviewColumn();

            // Dispose A's panel via the testing API — simulates the
            // user closing the only knit panel.
            KnitOutputPanel.disposeAllForTesting();
            // anchoredAfterA is referenced for the contract narrative
            // below; not asserted directly because VS Code's column
            // assignment for a single Beside panel is implementation-
            // defined under tests (typically ViewColumn.Two).
            void anchoredAfterA;
            assert.strictEqual(
                KnitOutputPanel.getPreviewColumnForTesting(),
                undefined,
                'preview column resets to undefined when registry empties',
            );
            assert.strictEqual(KnitOutputPanel.getInstancesForTesting().size, 0);

            // Knit B — re-anchors. The new column may or may not be
            // the same as anchoredAfterA depending on VS Code's
            // current focus; the contract is only that it is now
            // defined.
            await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: srcB, outputPath: outB, output },
            );
            const anchoredAfterB = await waitForPreviewColumn();

            // Knit A again — A's new panel lands in B's column (the
            // current preview column).
            await KnitOutputPanel.showOrUpdate(
                {} as vscode.ExtensionContext,
                { sourceUri: srcA, outputPath: outA, output },
            );
            const panelA = KnitOutputPanel.getInstancesForTesting()
                .get(srcA.fsPath)?.getPanelForTesting();
            assert.ok(panelA);
            const panelAColumn = await waitForPanelColumn(panelA);
            assert.strictEqual(
                panelAColumn, anchoredAfterB,
                'subsequent new knit lands in the current preview column',
            );
        } finally {
            output.dispose();
        }
    });
});
