/**
 * Panel-level round-trip for sort: setSort → sortApplied (with built
 * permutation) → subsequent getRows returns rows in sorted order →
 * saveSort persists via SortStateStore → next init restores the sort.
 *
 * Mocks `vscode` like the existing panel-persistence test, and drives
 * the panel via the FakeWebview shim. This is the closest we get to a
 * VS Code integration test within the bun harness; the live-VS Code
 * suite (covering DOM-level header arrow rendering and real click
 * events) is a follow-on.
 */

import { describe, test, expect, mock } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_SRC = (n: string) =>
    join(HERE, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);

function tempCopyOf(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'raven-panel-sort-'));
    const dst = join(dir, name);
    copyFileSync(FIX_SRC(name), dst);
    return dst;
}

class MemKV {
    private m = new Map<string, unknown>();
    get<T>(k: string, d?: T): T | undefined {
        return (this.m.get(k) as T | undefined) ?? d;
    }
    update(k: string, v: unknown): Thenable<void> {
        if (v === undefined) this.m.delete(k);
        else this.m.set(k, v);
        return Promise.resolve();
    }
}

class FakeWebview {
    private listener: ((m: any) => void) | null = null;
    public posted: any[] = [];
    onDidReceiveMessage(cb: (m: any) => void) {
        this.listener = cb;
        return { dispose() {} };
    }
    postMessage(msg: any): Thenable<boolean> {
        this.posted.push(msg);
        return Promise.resolve(true);
    }
    asWebviewUri(uri: any) { return uri; }
    cspSource = 'vscode-webview://x';
    deliverFromWebview(m: any) { this.listener?.(m); }
}

class FakeWebviewPanel {
    public webview = new FakeWebview();
    private disposeListeners: Array<() => void> = [];
    onDidDispose(cb: () => void) {
        this.disposeListeners.push(cb);
        return { dispose() {} };
    }
    reveal() {}
    dispose() {
        this.disposeListeners.forEach(cb => cb());
    }
}

async function loadPanel() {
    mock.module('vscode', () => ({
        window: {
            createWebviewPanel: () => new FakeWebviewPanel(),
            createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
        },
        workspace: {
            getConfiguration: () => ({
                get: (_k: string, def?: unknown) => def,
            }),
        },
        env: { clipboard: { writeText: async () => {} } },
        Uri: {
            joinPath: (base: any, ...parts: string[]) => ({
                fsPath: [base?.fsPath ?? '', ...parts].join('/'),
                toString: () => parts.join('/'),
            }),
        },
        ViewColumn: { Active: -1 },
    }));

    const panelMod = await import('../../editors/vscode/src/data-viewer/panel');
    const arrowMod = await import('../../editors/vscode/src/data-viewer/arrow-reader');
    const layoutMod = await import('../../editors/vscode/src/data-viewer/layout-state');
    const toolbarMod = await import('../../editors/vscode/src/data-viewer/toolbar-state');
    const sortMod = await import('../../editors/vscode/src/data-viewer/sort-state');
    return { panelMod, arrowMod, layoutMod, toolbarMod, sortMod };
}

const TEST_SETTINGS = {
    missingValueStyle: 'foreground' as const,
    defaultDigits: 3,
    persistSort: true,
};

async function flush(): Promise<void> {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
}

describe('DataViewerPanel: setSort → sortApplied round-trip', () => {
    test('setSort builds a permutation and broadcasts sortApplied', async () => {
        const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod } = await loadPanel();
        const kv = new MemKV();
        const layoutStore = new layoutMod.LayoutStore(kv as any, 100);
        const toolbarStore = new toolbarMod.ToolbarStateStore(kv as any, 100);
        const sortStore = new sortMod.SortStateStore(kv as any, 100);
        const reader = await arrowMod.ArrowSliceReader.open(tempCopyOf('tiny.arrow'));
        const panel = await panelMod.DataViewerPanel.create(
            'tiny', reader, tempCopyOf('tiny.arrow'),
            layoutStore, toolbarStore, sortStore,
            TEST_SETTINGS,
            { fsPath: '/x', toString: () => '/x' } as any,
            () => {},
        );
        const fakePanel = (panel as any).webviewPanel as FakeWebviewPanel;
        const fakeWebview = fakePanel.webview;

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        expect(init.sort).toEqual({ keys: [], labelsOnWhenSorted: true, nrowWhenSorted: 0 });

        // tiny.x = [1,2,3,4,5]; desc → [4,3,2,1,0]
        fakeWebview.deliverFromWebview({
            type: 'setSort',
            panelGeneration: init.panelGeneration,
            requestId: 1,
            keys: [{ columnIndex: 0, direction: 'desc' }],
            labelsOn: true,
            formatOn: true,
            digits: 3,
        });
        await flush();
        const ack = fakeWebview.posted.find(m => m.type === 'sortApplied') as any;
        expect(ack).toBeDefined();
        expect(ack.fromPersistence).toBe(false);
        expect(ack.sort.keys).toEqual([{ columnIndex: 0, direction: 'desc' }]);
        expect(ack.sort.nrowWhenSorted).toBe(5);

        // sortStatus pending → idle pair should be present.
        const statusMessages = fakeWebview.posted.filter(m => m.type === 'sortStatus');
        expect(statusMessages.map(m => m.state)).toEqual(['pending', 'idle']);

        await reader.close().catch(() => undefined);
        fakePanel.dispose();
        mock.restore();
    });

    test('subsequent getRows uses the active permutation', async () => {
        const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod } = await loadPanel();
        const kv = new MemKV();
        const layoutStore = new layoutMod.LayoutStore(kv as any, 100);
        const toolbarStore = new toolbarMod.ToolbarStateStore(kv as any, 100);
        const sortStore = new sortMod.SortStateStore(kv as any, 100);
        const reader = await arrowMod.ArrowSliceReader.open(tempCopyOf('tiny.arrow'));
        const panel = await panelMod.DataViewerPanel.create(
            'tiny', reader, tempCopyOf('tiny.arrow'),
            layoutStore, toolbarStore, sortStore,
            TEST_SETTINGS,
            { fsPath: '/x', toString: () => '/x' } as any,
            () => {},
        );
        const fakePanel = (panel as any).webviewPanel as FakeWebviewPanel;
        const fakeWebview = fakePanel.webview;

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;

        // Apply desc sort on x.
        fakeWebview.deliverFromWebview({
            type: 'setSort',
            panelGeneration: init.panelGeneration,
            requestId: 1,
            keys: [{ columnIndex: 0, direction: 'desc' }],
            labelsOn: true, formatOn: true, digits: 3,
        });
        await flush();

        // Request the visible window.
        fakeWebview.deliverFromWebview({
            type: 'getRows',
            panelGeneration: init.panelGeneration,
            requestId: 2,
            viewportGeneration: 1,
            start: 0,
            end: 5,
            columns: [0],
        });
        await flush();
        const rows = fakeWebview.posted.find(m => m.type === 'rows' && m.requestId === 2) as any;
        expect(rows).toBeDefined();
        expect(rows.rows.map((r: any[]) => r[0])).toEqual([5, 4, 3, 2, 1]);
        expect(rows.originalRowIndices).toEqual([4, 3, 2, 1, 0]);

        await reader.close().catch(() => undefined);
        fakePanel.dispose();
        mock.restore();
    });

    test('saveSort persists and next init restores the sort', async () => {
        const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod } = await loadPanel();
        const kv = new MemKV();
        const layoutStore = new layoutMod.LayoutStore(kv as any, 100);
        const toolbarStore = new toolbarMod.ToolbarStateStore(kv as any, 100);
        const sortStore = new sortMod.SortStateStore(kv as any, 100);
        const reader = await arrowMod.ArrowSliceReader.open(tempCopyOf('tiny.arrow'));
        const panel = await panelMod.DataViewerPanel.create(
            'tiny', reader, tempCopyOf('tiny.arrow'),
            layoutStore, toolbarStore, sortStore,
            TEST_SETTINGS,
            { fsPath: '/x', toString: () => '/x' } as any,
            () => {},
        );
        const fakePanel = (panel as any).webviewPanel as FakeWebviewPanel;
        const fakeWebview = fakePanel.webview;

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const hash = init.schemaHash;

        // Webview "echoes" saveSort back (debounced in real life).
        fakeWebview.deliverFromWebview({
            type: 'saveSort',
            panelGeneration: init.panelGeneration,
            schemaHash: hash,
            sort: {
                keys: [{ columnIndex: 0, direction: 'desc' }],
                labelsOnWhenSorted: true,
                nrowWhenSorted: 5,
            },
        });
        await flush();
        const stored = await sortStore.load('tiny', hash);
        expect(stored).toEqual({
            keys: [{ columnIndex: 0, direction: 'desc' }],
            labelsOnWhenSorted: true,
            nrowWhenSorted: 5,
        });

        // Trigger a replace; the saved sort should restore.
        const path2 = tempCopyOf('tiny.arrow');
        const reader2 = await arrowMod.ArrowSliceReader.open(path2);
        await panel.replace(reader2, path2);
        await flush();
        const replace = fakeWebview.posted.find(m => m.type === 'replace') as any;
        expect(replace).toBeDefined();
        expect(replace.sort.keys).toEqual([{ columnIndex: 0, direction: 'desc' }]);

        // Confirm the restored permutation is applied to subsequent getRows.
        fakeWebview.deliverFromWebview({
            type: 'getRows',
            panelGeneration: replace.panelGeneration,
            requestId: 9,
            viewportGeneration: 1,
            start: 0, end: 5, columns: [0],
        });
        await flush();
        const rows = fakeWebview.posted.find(m => m.type === 'rows' && m.requestId === 9) as any;
        expect(rows.rows.map((r: any[]) => r[0])).toEqual([5, 4, 3, 2, 1]);

        await reader2.close().catch(() => undefined);
        fakePanel.dispose();
        mock.restore();
    });

    test('setSort with empty keys clears the permutation', async () => {
        const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod } = await loadPanel();
        const kv = new MemKV();
        const layoutStore = new layoutMod.LayoutStore(kv as any, 100);
        const toolbarStore = new toolbarMod.ToolbarStateStore(kv as any, 100);
        const sortStore = new sortMod.SortStateStore(kv as any, 100);
        const reader = await arrowMod.ArrowSliceReader.open(tempCopyOf('tiny.arrow'));
        const panel = await panelMod.DataViewerPanel.create(
            'tiny', reader, tempCopyOf('tiny.arrow'),
            layoutStore, toolbarStore, sortStore,
            TEST_SETTINGS,
            { fsPath: '/x', toString: () => '/x' } as any,
            () => {},
        );
        const fakePanel = (panel as any).webviewPanel as FakeWebviewPanel;
        const fakeWebview = fakePanel.webview;

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;

        // Apply, then clear.
        fakeWebview.deliverFromWebview({
            type: 'setSort',
            panelGeneration: init.panelGeneration,
            requestId: 1,
            keys: [{ columnIndex: 0, direction: 'desc' }],
            labelsOn: true, formatOn: true, digits: 3,
        });
        await flush();
        fakeWebview.deliverFromWebview({
            type: 'setSort',
            panelGeneration: init.panelGeneration,
            requestId: 2,
            keys: [],
            labelsOn: true, formatOn: true, digits: 3,
        });
        await flush();

        // Verify the second sortApplied carries an empty sort and no
        // pending-status pair (clear is synchronous in the host).
        const acks = fakeWebview.posted.filter(m => m.type === 'sortApplied') as any[];
        expect(acks).toHaveLength(2);
        expect(acks[1].sort.keys).toEqual([]);

        // Subsequent getRows reads in identity order (no permutation).
        fakeWebview.deliverFromWebview({
            type: 'getRows',
            panelGeneration: init.panelGeneration,
            requestId: 3,
            viewportGeneration: 1,
            start: 0, end: 5, columns: [0],
        });
        await flush();
        const rows = fakeWebview.posted.find(m => m.type === 'rows' && m.requestId === 3) as any;
        expect(rows.rows.map((r: any[]) => r[0])).toEqual([1, 2, 3, 4, 5]);
        expect(rows.originalRowIndices).toBeUndefined();

        await reader.close().catch(() => undefined);
        fakePanel.dispose();
        mock.restore();
    });

    test('persistSort=false skips sortStore writes', async () => {
        const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod } = await loadPanel();
        const kv = new MemKV();
        const layoutStore = new layoutMod.LayoutStore(kv as any, 100);
        const toolbarStore = new toolbarMod.ToolbarStateStore(kv as any, 100);
        const sortStore = new sortMod.SortStateStore(kv as any, 100);
        const reader = await arrowMod.ArrowSliceReader.open(tempCopyOf('tiny.arrow'));
        const panel = await panelMod.DataViewerPanel.create(
            'tiny', reader, tempCopyOf('tiny.arrow'),
            layoutStore, toolbarStore, sortStore,
            { ...TEST_SETTINGS, persistSort: false },
            { fsPath: '/x', toString: () => '/x' } as any,
            () => {},
        );
        const fakePanel = (panel as any).webviewPanel as FakeWebviewPanel;
        const fakeWebview = fakePanel.webview;

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;

        fakeWebview.deliverFromWebview({
            type: 'saveSort',
            panelGeneration: init.panelGeneration,
            schemaHash: init.schemaHash,
            sort: {
                keys: [{ columnIndex: 0, direction: 'desc' }],
                labelsOnWhenSorted: true,
                nrowWhenSorted: 5,
            },
        });
        await flush();
        const stored = await sortStore.load('tiny', init.schemaHash);
        expect(stored).toBeUndefined();

        await reader.close().catch(() => undefined);
        fakePanel.dispose();
        mock.restore();
    });
});
