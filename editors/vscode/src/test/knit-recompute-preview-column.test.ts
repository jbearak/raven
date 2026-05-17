import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate } from './helper';
import { KnitOutputPanel } from '../knit/knit-output-panel';

/**
 * Drive `recomputePreviewColumn` directly via `setInstancesForTesting`
 * + `setPreviewColumnForTesting` + `recomputePreviewColumnForTesting`,
 * exercising the column-tracking state machine without relying on VS
 * Code to simulate a real drag.
 *
 * See `docs/superpowers/specs/2026-05-17-knit-panel-per-file-design.md`.
 */
suite('KnitOutputPanel recomputePreviewColumn', () => {
    teardown(() => {
        KnitOutputPanel.disposeAllForTesting();
    });

    test('empty registry → previewColumn becomes undefined', async () => {
        await activate();
        KnitOutputPanel.setInstancesForTesting([]);
        KnitOutputPanel.setPreviewColumnForTesting(vscode.ViewColumn.One);
        KnitOutputPanel.recomputePreviewColumnForTesting();
        assert.strictEqual(KnitOutputPanel.getPreviewColumnForTesting(), undefined);
    });

    test('one panel in current preview column → stays put', async () => {
        await activate();
        KnitOutputPanel.setInstancesForTesting([
            { key: 'a', viewColumn: vscode.ViewColumn.One },
        ]);
        KnitOutputPanel.setPreviewColumnForTesting(vscode.ViewColumn.One);
        KnitOutputPanel.recomputePreviewColumnForTesting();
        assert.strictEqual(
            KnitOutputPanel.getPreviewColumnForTesting(),
            vscode.ViewColumn.One,
        );
    });

    test('one panel in a different column → adopts that column', async () => {
        await activate();
        KnitOutputPanel.setInstancesForTesting([
            { key: 'a', viewColumn: vscode.ViewColumn.One },
        ]);
        KnitOutputPanel.setPreviewColumnForTesting(vscode.ViewColumn.Two);
        KnitOutputPanel.recomputePreviewColumnForTesting();
        assert.strictEqual(
            KnitOutputPanel.getPreviewColumnForTesting(),
            vscode.ViewColumn.One,
            'adopt the surviving panel\'s column so the next knit clusters with it',
        );
    });

    test('two panels split across columns → previewColumn stays where it still has occupants', async () => {
        await activate();
        KnitOutputPanel.setInstancesForTesting([
            { key: 'a', viewColumn: vscode.ViewColumn.One },
            { key: 'b', viewColumn: vscode.ViewColumn.Two },
        ]);
        KnitOutputPanel.setPreviewColumnForTesting(vscode.ViewColumn.One);
        KnitOutputPanel.recomputePreviewColumnForTesting();
        assert.strictEqual(
            KnitOutputPanel.getPreviewColumnForTesting(),
            vscode.ViewColumn.One,
        );
    });

    test('two panels both moved to a third column → adopts that column', async () => {
        await activate();
        KnitOutputPanel.setInstancesForTesting([
            { key: 'a', viewColumn: vscode.ViewColumn.Three },
            { key: 'b', viewColumn: vscode.ViewColumn.Three },
        ]);
        KnitOutputPanel.setPreviewColumnForTesting(vscode.ViewColumn.One);
        KnitOutputPanel.recomputePreviewColumnForTesting();
        assert.strictEqual(
            KnitOutputPanel.getPreviewColumnForTesting(),
            vscode.ViewColumn.Three,
        );
    });

    test('survivor without a viewColumn → previewColumn becomes undefined', async () => {
        // Edge case: VS Code reports `undefined` for a panel that is
        // currently hidden / not visible. If no surviving panel has a
        // concrete column, there is nothing to anchor to.
        await activate();
        KnitOutputPanel.setInstancesForTesting([
            { key: 'a', viewColumn: undefined },
        ]);
        KnitOutputPanel.setPreviewColumnForTesting(vscode.ViewColumn.One);
        KnitOutputPanel.recomputePreviewColumnForTesting();
        assert.strictEqual(
            KnitOutputPanel.getPreviewColumnForTesting(),
            undefined,
        );
    });
});
