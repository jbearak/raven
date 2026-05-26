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

import { describe, test, expect, mock, afterEach } from 'bun:test';
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
    const filterMod = await import('../../editors/vscode/src/data-viewer/filter-state');
    return { panelMod, arrowMod, layoutMod, toolbarMod, sortMod, filterMod };
}

const TEST_SETTINGS = {
    missingValueStyle: 'foreground' as const,
    defaultDigits: 3,
    persistSort: true,
    persistFilters: true,
};

async function flush(): Promise<void> {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
}

/** Resources to tear down even when a test assertion throws. afterEach
 *  walks these in reverse order so readers are closed before their
 *  panels are disposed. */
type Cleanup = () => Promise<void> | void;
let pendingCleanups: Cleanup[] = [];

afterEach(async () => {
    const list = pendingCleanups.reverse();
    pendingCleanups = [];
    for (const c of list) {
        try { await c(); } catch { /* swallow — best effort */ }
    }
    mock.restore();
});

type PanelTestContext = {
    panel: any;
    reader: any;
    fakePanel: FakeWebviewPanel;
    fakeWebview: FakeWebview;
    sortStore: any;
    tempPath: string;
    arrowMod: any;
    panelMod: any;
};

/** Set up a DataViewerPanel against the tiny fixture. Registers
 *  failure-safe cleanups (reader close + fake-panel dispose) with
 *  afterEach so a thrown assertion still releases resources. */
async function setupPanel(settingsOverride?: Partial<typeof TEST_SETTINGS>): Promise<PanelTestContext> {
    const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod, filterMod } = await loadPanel();
    const kv = new MemKV();
    const layoutStore = new layoutMod.LayoutStore(kv as any, 100);
    const toolbarStore = new toolbarMod.ToolbarStateStore(kv as any, 100);
    const sortStore = new sortMod.SortStateStore(kv as any, 100);
    const filterStore = new filterMod.FilterStateStore(kv as any, 100);
    const tempPath = tempCopyOf('tiny.arrow');
    const reader = await arrowMod.ArrowSliceReader.open(tempPath);
    pendingCleanups.push(() => reader.close().catch(() => undefined));
    const panel = await panelMod.DataViewerPanel.create(
        'tiny', reader, tempPath,
        layoutStore, toolbarStore, sortStore, filterStore,
        { ...TEST_SETTINGS, ...settingsOverride },
        { fsPath: '/x', toString: () => '/x' } as any,
        () => {},
    );
    const fakePanel = (panel as any).webviewPanel as FakeWebviewPanel;
    pendingCleanups.push(() => fakePanel.dispose());
    return {
        panel,
        reader,
        fakePanel,
        fakeWebview: fakePanel.webview,
        sortStore,
        tempPath,
        arrowMod,
        panelMod,
    };
}

describe('DataViewerPanel: setSort → sortApplied round-trip', () => {
    test('setSort builds a permutation and broadcasts sortApplied', async () => {
        const { fakeWebview } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        expect(init.sort).toEqual({ keys: [], labelsOnWhenSorted: true });

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
        expect(ack.sort.labelsOnWhenSorted).toBe(true);

        // sortStatus pending → idle pair should be present.
        const statusMessages = fakeWebview.posted.filter(m => m.type === 'sortStatus');
        expect(statusMessages.map(m => m.state)).toEqual(['pending', 'idle']);
    });

    test('subsequent getRows uses the active permutation', async () => {
        const { fakeWebview } = await setupPanel();

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
    });

    test('saveSort persists and next init restores the sort', async () => {
        const { panel, fakeWebview, sortStore, arrowMod } = await setupPanel();

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
            },
        });
        await flush();
        const stored = await sortStore.load('tiny', hash);
        expect(stored).toEqual({
            keys: [{ columnIndex: 0, direction: 'desc' }],
            labelsOnWhenSorted: true,
        });

        // Trigger a replace; the saved sort should restore. The replace
        // path opens its own reader and panel.replace() unlinks the
        // previous file, so the second reader gets its own temp copy.
        const path2 = tempCopyOf('tiny.arrow');
        const reader2 = await arrowMod.ArrowSliceReader.open(path2);
        pendingCleanups.push(() => reader2.close().catch(() => undefined));
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
    });

    test('setSort with empty keys clears the permutation', async () => {
        const { fakeWebview } = await setupPanel();

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
    });

    test('persistSort=false skips sortStore writes', async () => {
        const { fakeWebview, sortStore } = await setupPanel({ persistSort: false });

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
            },
        });
        await flush();
        const stored = await sortStore.load('tiny', init.schemaHash);
        expect(stored).toBeUndefined();
    });
});
