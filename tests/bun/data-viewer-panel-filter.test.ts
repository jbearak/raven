/**
 * Panel-level round-trip for filter: setFilters → filterApplied (with
 * filtered indices) → subsequent getRows returns only matching rows →
 * filter + sort compose correctly → saveFilter persists via
 * FilterStateStore → next init restores the filter.
 *
 * Mocks `vscode` like the existing panel-sort test, and drives the
 * panel via the FakeWebview shim.
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
    const dir = mkdtempSync(join(tmpdir(), 'raven-panel-filter-'));
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
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
}

/** Resources to tear down even when a test assertion throws. afterEach
 *  walks these in reverse order so readers are closed before panels are
 *  disposed. */
type Cleanup = () => Promise<void> | void;
let pendingCleanups: Cleanup[] = [];

afterEach(async () => {
    const list = pendingCleanups.reverse();
    pendingCleanups = [];
    for (const c of list) {
        try { await c(); } catch { /* swallow */ }
    }
    mock.restore();
});

type PanelTestContext = {
    panel: any;
    reader: any;
    fakePanel: FakeWebviewPanel;
    fakeWebview: FakeWebview;
    sortStore: any;
    filterStore: any;
    kv: MemKV;
    tempPath: string;
    arrowMod: any;
    panelMod: any;
    filterMod: any;
};

async function setupPanel(
    settingsOverride?: Partial<typeof TEST_SETTINGS>,
    existingKv?: MemKV,
): Promise<PanelTestContext> {
    const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod, filterMod } = await loadPanel();
    const kv = existingKv ?? new MemKV();
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
        filterStore,
        kv,
        tempPath,
        arrowMod,
        panelMod,
        filterMod,
    };
}

describe('DataViewerPanel: filter round-trips', () => {
    test('init carries EMPTY_FILTER and histograms with numeric columns', async () => {
        const { fakeWebview } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        expect(init).toBeDefined();
        // Filter should be the empty sentinel.
        expect(init.filter).toEqual({ entries: [], labelsOnWhenFiltered: true });
        // tiny.arrow has col 0 = x (Int32) — at least that key must be present.
        expect(init.histograms).toBeDefined();
        expect(Object.keys(init.histograms).length).toBeGreaterThan(0);
        expect(init.histograms[0]).toBeDefined();
        expect(Array.isArray(init.histograms[0])).toBe(true);
        expect(init.histograms[0].length).toBeGreaterThan(0);
    });

    test('setFilters round-trip: filterStatus pending → filterApplied, then getRows returns matching rows', async () => {
        const { fakeWebview } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const gen = init.panelGeneration;

        // x = [1,2,3,4,5]; filter x > 2 should keep rows [3,4,5] = 3 rows.
        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 10,
            entries: [{
                id: 'e1',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '>', value: 2 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await flush();

        const statusMsgs = fakeWebview.posted.filter(m => m.type === 'filterStatus');
        expect(statusMsgs.map((m: any) => m.state)).toEqual(['pending', 'idle']);

        const applied = fakeWebview.posted.find(
            m => m.type === 'filterApplied' && m.requestId === 10,
        ) as any;
        expect(applied).toBeDefined();
        expect(applied.nrowFiltered).toBe(3);
        expect(applied.fromPersistence).toBe(false);

        // getRows with the active filter should return the 3 matching rows in
        // original order: 3, 4, 5.
        fakeWebview.deliverFromWebview({
            type: 'getRows',
            panelGeneration: gen,
            requestId: 11,
            viewportGeneration: 1,
            start: 0,
            end: 3,
            columns: [0],
        });
        await flush();
        const rows = fakeWebview.posted.find(
            m => m.type === 'rows' && m.requestId === 11,
        ) as any;
        expect(rows).toBeDefined();
        expect(rows.rows.map((r: any[]) => r[0])).toEqual([3, 4, 5]);
    });

    test('filter + sort compose: desc sort on filtered rows', async () => {
        const { fakeWebview } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const gen = init.panelGeneration;

        // Apply desc sort first.
        fakeWebview.deliverFromWebview({
            type: 'setSort',
            panelGeneration: gen,
            requestId: 1,
            keys: [{ columnIndex: 0, direction: 'desc' }],
            labelsOn: true,
            formatOn: true,
            digits: 3,
        });
        await flush();

        // Then apply filter x > 2.
        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 2,
            entries: [{
                id: 'e1',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '>', value: 2 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await flush();

        // getRows should reflect sort desc + filter > 2: [5,4,3].
        fakeWebview.deliverFromWebview({
            type: 'getRows',
            panelGeneration: gen,
            requestId: 3,
            viewportGeneration: 1,
            start: 0,
            end: 3,
            columns: [0],
        });
        await flush();
        const rows = fakeWebview.posted.find(
            m => m.type === 'rows' && m.requestId === 3,
        ) as any;
        expect(rows).toBeDefined();
        expect(rows.rows.map((r: any[]) => r[0])).toEqual([5, 4, 3]);
    });

    test('saveFilter persists and restore on panel recreate sends filterApplied(fromPersistence:true)', async () => {
        const { fakeWebview, kv, filterStore } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const gen = init.panelGeneration;
        const hash = init.schemaHash;

        // Apply x > 2 filter.
        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 20,
            entries: [{
                id: 'e1',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '>', value: 2 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await flush();

        // Webview "echoes" saveFilter back (debounced in real life).
        fakeWebview.deliverFromWebview({
            type: 'saveFilter',
            panelGeneration: gen,
            schemaHash: hash,
            filter: {
                entries: [{
                    id: 'e1',
                    columnIndex: 0,
                    predicate: { kind: 'numCompare', op: '>', value: 2 },
                    enabled: true,
                    includeMissing: false,
                }],
                labelsOnWhenFiltered: true,
            },
        });
        await flush();

        // Verify FilterStateStore has the entry (before restoring mocks).
        const stored = await filterStore.load('tiny', hash);
        expect(stored).toBeDefined();
        expect(stored?.entries.length).toBe(1);
        expect((stored?.entries[0].predicate as any).value).toBe(2);

        // Recreate the panel using the same kv (persisted state).
        mock.restore();
        const { panelMod: pm2, arrowMod: am2, layoutMod: lm2,
                 toolbarMod: tm2, sortMod: sm2, filterMod: fm2 } = await loadPanel();
        const layoutStore2 = new lm2.LayoutStore(kv as any, 100);
        const toolbarStore2 = new tm2.ToolbarStateStore(kv as any, 100);
        const sortStore2 = new sm2.SortStateStore(kv as any, 100);
        const filterStore2 = new fm2.FilterStateStore(kv as any, 100);
        const path2 = tempCopyOf('tiny.arrow');
        const reader2 = await am2.ArrowSliceReader.open(path2);
        pendingCleanups.push(() => reader2.close().catch(() => undefined));
        const panel2 = await pm2.DataViewerPanel.create(
            'tiny', reader2, path2,
            layoutStore2, toolbarStore2, sortStore2, filterStore2,
            TEST_SETTINGS,
            { fsPath: '/x', toString: () => '/x' } as any,
            () => {},
        );
        const fakePanel2 = (panel2 as any).webviewPanel as FakeWebviewPanel;
        pendingCleanups.push(() => fakePanel2.dispose());
        const fakeWebview2 = fakePanel2.webview;

        fakeWebview2.deliverFromWebview({ type: 'webviewReady' });
        await flush();

        // init should carry the restored filter.
        const init2 = fakeWebview2.posted.find(m => m.type === 'init') as any;
        expect(init2).toBeDefined();
        expect(init2.filter.entries.length).toBe(1);
        expect((init2.filter.entries[0].predicate as any).value).toBe(2);

        // A filterApplied(fromPersistence:true) must also be posted.
        const restoredApplied = fakeWebview2.posted.find(
            m => m.type === 'filterApplied' && m.fromPersistence === true,
        ) as any;
        expect(restoredApplied).toBeDefined();
        expect(restoredApplied.nrowFiltered).toBe(3);
    });

    test('setFilters with empty entries clears the filter', async () => {
        const { fakeWebview } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const gen = init.panelGeneration;

        // Apply filter first.
        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 30,
            entries: [{
                id: 'e1',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '>', value: 2 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await flush();

        // Now clear the filter.
        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 31,
            entries: [],
            labelsOn: true,
        });
        await flush();

        const clearApplied = fakeWebview.posted.filter(
            m => m.type === 'filterApplied' && m.requestId === 31,
        ) as any[];
        expect(clearApplied.length).toBe(1);
        // nrowFiltered should equal total nrow (5) when filter is cleared.
        expect(clearApplied[0].nrowFiltered).toBe(5);

        // Subsequent getRows should return all 5 rows.
        fakeWebview.deliverFromWebview({
            type: 'getRows',
            panelGeneration: gen,
            requestId: 32,
            viewportGeneration: 1,
            start: 0,
            end: 5,
            columns: [0],
        });
        await flush();
        const rows = fakeWebview.posted.find(
            m => m.type === 'rows' && m.requestId === 32,
        ) as any;
        expect(rows).toBeDefined();
        expect(rows.rows.map((r: any[]) => r[0])).toEqual([1, 2, 3, 4, 5]);
    });
});
