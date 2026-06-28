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
    test('init carries EMPTY_FILTER and does NOT eagerly compute histograms', async () => {
        const { fakeWebview } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        expect(init).toBeDefined();
        // Filter should be the empty sentinel.
        expect(init.filter).toEqual({ entries: [], labelsOnWhenFiltered: true });
        // Histograms are no longer precomputed at init — they would force a
        // full-frame scan before the grid can paint (the ~1-minute empty-grid
        // regression on large frames). They are fetched lazily per column via
        // getHistogram when a filter popover opens. See histograms.ts.
        expect(init.histograms).toBeUndefined();
    });

    test('REGRESSION: init paints without any batch-level scan (histograms stay lazy)', async () => {
        // The original regression: histograms were precomputed for every
        // numeric column inside sendInit, blocking the grid from painting
        // until the entire frame had been scanned (~49s on a 10M×50 frame).
        // The old test suite asserted histograms were PRESENT in init, which
        // locked the slow behavior in. This asserts the opposite invariant:
        // sending init must not decode a single record batch. Histogram work
        // (the only per-row scan in this surface) happens lazily on
        // getHistogram. Re-introducing any full-frame scan on the paint path
        // makes getBatchCalls non-zero and fails here.
        const { fakeWebview, reader } = await setupPanel();
        // reader.open() (in setupPanel) already counted its batches; start
        // counting only the batch decodes the panel triggers from here on.
        let getBatchCalls = 0;
        const origGetBatch = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = (i: number) => { getBatchCalls++; return origGetBatch(i); };

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        expect(init).toBeDefined();
        expect(getBatchCalls).toBe(0);

        // Opening a numeric filter is what legitimately triggers the
        // single-column scan — proving the scan still exists, just deferred.
        fakeWebview.deliverFromWebview({
            type: 'getHistogram',
            panelGeneration: init.panelGeneration,
            requestId: 30,
            columnIndex: 0,
        });
        await flush();
        expect(getBatchCalls).toBeGreaterThan(0);
    });

    test('getHistogram round-trip: lazily computes one numeric column on demand', async () => {
        const { fakeWebview } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const gen = init.panelGeneration;

        // tiny.arrow col 0 = x (Int32). Request its histogram on demand.
        fakeWebview.deliverFromWebview({
            type: 'getHistogram',
            panelGeneration: gen,
            requestId: 20,
            columnIndex: 0,
        });
        await flush();

        const hist = fakeWebview.posted.find(
            m => m.type === 'histogram' && m.requestId === 20,
        ) as any;
        expect(hist).toBeDefined();
        expect(hist.columnIndex).toBe(0);
        expect(Array.isArray(hist.bins)).toBe(true);
        expect(hist.bins.length).toBe(50);
        expect(hist.bins.reduce((s: number, b: any) => s + b.count, 0)).toBe(5);
    });

    test('getHistogram always replies (empty bins) when the column scan throws', async () => {
        // A reply MUST be posted even on a decode failure, or the webview's
        // in-flight marker for the column never clears and the brush stays
        // blank forever with no retry. Degrade to no brush, never silence.
        const { fakeWebview, reader } = await setupPanel();
        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;

        (reader as any).getBatch = () => { throw new Error('decode boom'); };
        fakeWebview.deliverFromWebview({
            type: 'getHistogram',
            panelGeneration: init.panelGeneration,
            requestId: 40,
            columnIndex: 0,
        });
        await flush();

        const hist = fakeWebview.posted.find(
            m => m.type === 'histogram' && m.requestId === 40,
        ) as any;
        expect(hist).toBeDefined();
        expect(hist.bins).toEqual([]);
    });

    test('getHistogram replies with empty bins for an out-of-range column index', async () => {
        const { fakeWebview } = await setupPanel();
        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;

        fakeWebview.deliverFromWebview({
            type: 'getHistogram',
            panelGeneration: init.panelGeneration,
            requestId: 41,
            columnIndex: 9999,
        });
        await flush();

        const hist = fakeWebview.posted.find(
            m => m.type === 'histogram' && m.requestId === 41,
        ) as any;
        expect(hist).toBeDefined();
        expect(hist.bins).toEqual([]);
    });

    test('getHistogram for a non-numeric column replies [] without scanning', async () => {
        // Trust boundary: the UI only requests numeric/labelledNumeric columns
        // (colKind gate), but a malformed/future caller must not trigger a
        // wasted full-column scan that can only return [].
        const { fakeWebview, reader } = await setupPanel();
        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;

        let getBatchCalls = 0;
        const origGetBatch = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = (i: number) => { getBatchCalls++; return origGetBatch(i); };

        // tiny.arrow col 2 = s (Utf8) — not numeric, no histogram brush.
        fakeWebview.deliverFromWebview({
            type: 'getHistogram',
            panelGeneration: init.panelGeneration,
            requestId: 42,
            columnIndex: 2,
        });
        await flush();

        const hist = fakeWebview.posted.find(
            m => m.type === 'histogram' && m.requestId === 42,
        ) as any;
        expect(hist).toBeDefined();
        expect(hist.bins).toEqual([]);
        expect(getBatchCalls).toBe(0);
    });

    test('getHistogram and setSort do not read batches concurrently', async () => {
        const { fakeWebview, reader } = await setupPanel();
        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;

        let firstEntered!: () => void;
        const firstEnteredPromise = new Promise<void>(resolve => { firstEntered = resolve; });
        let releaseFirst!: () => void;
        const releaseFirstPromise = new Promise<void>(resolve => { releaseFirst = resolve; });
        let activeReads = 0;
        let firstRead = true;
        const origGetBatch = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = async (i: number) => {
            if (activeReads > 0) throw new Error('concurrent batch read');
            activeReads += 1;
            try {
                if (firstRead) {
                    firstRead = false;
                    firstEntered();
                    await releaseFirstPromise;
                }
                return await origGetBatch(i);
            } finally {
                activeReads -= 1;
            }
        };

        fakeWebview.deliverFromWebview({
            type: 'getHistogram',
            panelGeneration: init.panelGeneration,
            requestId: 50,
            columnIndex: 0,
        });
        await firstEnteredPromise;

        fakeWebview.deliverFromWebview({
            type: 'setSort',
            panelGeneration: init.panelGeneration,
            requestId: 51,
            keys: [{ columnIndex: 0, direction: 'desc' }],
            labelsOn: true,
            formatOn: true,
            digits: 3,
        });
        await flush();
        releaseFirst();
        await flush();

        expect(fakeWebview.posted.filter(m => m.type === 'error')).toEqual([]);
        const hist = fakeWebview.posted.find(
            m => m.type === 'histogram' && m.requestId === 50,
        ) as any;
        expect(hist).toBeDefined();
        const sortAck = fakeWebview.posted.find(
            m => m.type === 'sortApplied' && m.requestId === 51,
        ) as any;
        expect(sortAck).toBeDefined();
        expect(sortAck.sort.keys).toEqual([{ columnIndex: 0, direction: 'desc' }]);
    });

    test('webview reload aborts an active histogram without replying to the stale request', async () => {
        const { fakeWebview, reader } = await setupPanel();
        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;

        let triggeredReload = false;
        let readCount = 0;
        const origGetBatch = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = async (i: number) => {
            readCount += 1;
            if (readCount > 1) throw new Error('histogram read after abort');
            if (!triggeredReload) {
                triggeredReload = true;
                fakeWebview.deliverFromWebview({ type: 'webviewReady' });
            }
            return origGetBatch(i);
        };

        fakeWebview.deliverFromWebview({
            type: 'getHistogram',
            panelGeneration: init.panelGeneration,
            requestId: 52,
            columnIndex: 0,
        });
        await flush();

        expect(fakeWebview.posted.filter(m => m.type === 'histogram' && m.requestId === 52))
            .toEqual([]);
        expect(readCount).toBe(1);
        const initMessages = fakeWebview.posted.filter(m => m.type === 'init') as any[];
        expect(initMessages.length).toBeGreaterThanOrEqual(2);
    });

    test('webview reload aborts an active filter before the next batch read', async () => {
        const { fakeWebview, reader } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;

        let readCount = 0;
        const origGetBatch = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = async (i: number) => {
            readCount += 1;
            if (readCount === 1) {
                fakeWebview.deliverFromWebview({ type: 'webviewReady' });
                return await origGetBatch(i);
            }
            throw new Error('filter read after abort');
        };

        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: init.panelGeneration,
            requestId: 54,
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

        expect(fakeWebview.posted.filter(m => m.type === 'filterApplied' && m.requestId === 54))
            .toEqual([]);
        expect(fakeWebview.posted.filter(m => m.type === 'error')).toEqual([]);
        expect(readCount).toBe(1);
    });

    test('webview reload suppresses a non-abort error from an aborted histogram', async () => {
        const { fakeWebview, reader } = await setupPanel();
        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;

        let firstEntered!: () => void;
        const firstEnteredPromise = new Promise<void>(resolve => { firstEntered = resolve; });
        let rejectRead!: (err: Error) => void;
        const readPromise = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
        let firstRead = true;
        const origGetBatch = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = async (i: number) => {
            if (firstRead) {
                firstRead = false;
                firstEntered();
                return await readPromise;
            }
            return await origGetBatch(i);
        };

        fakeWebview.deliverFromWebview({
            type: 'getHistogram',
            panelGeneration: init.panelGeneration,
            requestId: 53,
            columnIndex: 0,
        });
        await firstEnteredPromise;

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        rejectRead(new Error('decode failed after abort'));
        await flush();

        expect(fakeWebview.posted.filter(m => m.type === 'histogram' && m.requestId === 53))
            .toEqual([]);
        expect(fakeWebview.posted.filter(m => m.type === 'error')).toEqual([]);
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

    test('overlapping setFilter and setSort serialize and compose', async () => {
        const { fakeWebview, reader } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const gen = init.panelGeneration;

        let firstEntered!: () => void;
        const firstEnteredPromise = new Promise<void>(resolve => { firstEntered = resolve; });
        let releaseFirst!: () => void;
        const releaseFirstPromise = new Promise<void>(resolve => { releaseFirst = resolve; });
        let activeReads = 0;
        let firstRead = true;
        const origGetBatch = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = async (i: number) => {
            if (activeReads > 0) throw new Error('concurrent batch read');
            activeReads += 1;
            try {
                if (firstRead) {
                    firstRead = false;
                    firstEntered();
                    await releaseFirstPromise;
                }
                return await origGetBatch(i);
            } finally {
                activeReads -= 1;
            }
        };

        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 80,
            entries: [{
                id: 'e1',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '>', value: 2 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await firstEnteredPromise;

        fakeWebview.deliverFromWebview({
            type: 'setSort',
            panelGeneration: gen,
            requestId: 81,
            keys: [{ columnIndex: 0, direction: 'desc' }],
            labelsOn: true,
            formatOn: true,
            digits: 3,
        });
        await flush();
        releaseFirst();
        await flush();

        expect(fakeWebview.posted.filter(m => m.type === 'error')).toEqual([]);
        expect(fakeWebview.posted.find(
            m => m.type === 'filterApplied' && m.requestId === 80,
        )).toBeDefined();
        expect(fakeWebview.posted.find(
            m => m.type === 'sortApplied' && m.requestId === 81,
        )).toBeDefined();

        fakeWebview.deliverFromWebview({
            type: 'getRows',
            panelGeneration: gen,
            requestId: 82,
            viewportGeneration: 1,
            start: 0,
            end: 3,
            columns: [0],
        });
        await flush();
        const rows = fakeWebview.posted.find(
            m => m.type === 'rows' && m.requestId === 82,
        ) as any;
        expect(rows.rows.map((r: any[]) => r[0])).toEqual([5, 4, 3]);
    });

    test('overlapping setFilters requests do not read batches concurrently and latest wins', async () => {
        const { fakeWebview, reader } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const gen = init.panelGeneration;

        let firstEntered!: () => void;
        const firstEnteredPromise = new Promise<void>(resolve => { firstEntered = resolve; });
        let releaseFirst!: () => void;
        const releaseFirstPromise = new Promise<void>(resolve => { releaseFirst = resolve; });
        let activeReads = 0;
        let firstRead = true;
        const origGetBatch = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = async (i: number) => {
            if (activeReads > 0) throw new Error('concurrent batch read');
            activeReads += 1;
            try {
                if (firstRead) {
                    firstRead = false;
                    firstEntered();
                    await releaseFirstPromise;
                }
                return await origGetBatch(i);
            } finally {
                activeReads -= 1;
            }
        };

        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 1,
            entries: [{
                id: 'e1',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '>', value: 2 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await firstEnteredPromise;

        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 2,
            entries: [{
                id: 'e2',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '<', value: 4 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await flush();
        releaseFirst();
        await flush();

        expect(fakeWebview.posted.filter(m => m.type === 'error')).toEqual([]);
        const applied = fakeWebview.posted.filter(m => m.type === 'filterApplied') as any[];
        expect(applied.map(m => m.requestId)).toEqual([2]);
        expect(applied[0].filter.entries).toEqual([{
            id: 'e2',
            columnIndex: 0,
            predicate: { kind: 'numCompare', op: '<', value: 4 },
            enabled: true,
            includeMissing: false,
        }]);
        expect(applied[0].nrowFiltered).toBe(3);

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
        expect(rows.rows.map((r: any[]) => r[0])).toEqual([1, 2, 3]);
    });

    test('setFilters read failure rolls back pending state to the authoritative filter', async () => {
        const { fakeWebview, reader } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const gen = init.panelGeneration;
        const previousEntry = {
            id: 'e1',
            columnIndex: 0,
            predicate: { kind: 'numCompare' as const, op: '>' as const, value: 2 },
            enabled: true,
            includeMissing: false,
        };

        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 70,
            entries: [previousEntry],
            labelsOn: true,
        });
        await flush();
        const previousApplied = fakeWebview.posted.find(
            m => m.type === 'filterApplied' && m.requestId === 70,
        ) as any;
        expect(previousApplied.nrowFiltered).toBe(3);

        const origGetBatch = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = async () => {
            throw new Error('filter decode boom');
        };

        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 71,
            entries: [{
                id: 'e2',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '<', value: 4 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await flush();

        const rollback = fakeWebview.posted.find(
            m => m.type === 'filterApplied' && m.requestId === 71,
        ) as any;
        expect(rollback).toBeDefined();
        expect(rollback.filter.entries).toEqual([previousEntry]);
        expect(rollback.nrowFiltered).toBe(3);
        expect(rollback.fromPersistence).toBe(false);
        expect(rollback.rollback).toBe(true);
        expect(rollback.error).toBe('filter decode boom');
        expect(fakeWebview.posted.filter(m => m.type === 'error')).toEqual([]);

        (reader as any).getBatch = origGetBatch;
        fakeWebview.deliverFromWebview({
            type: 'getRows',
            panelGeneration: gen,
            requestId: 72,
            viewportGeneration: 1,
            start: 0,
            end: 3,
            columns: [0],
        });
        await flush();
        const rows = fakeWebview.posted.find(
            m => m.type === 'rows' && m.requestId === 72,
        ) as any;
        expect(rows.rows.map((r: any[]) => r[0])).toEqual([3, 4, 5]);
    });

    test('failed newer filter does not roll back to an unpublished superseded filter', async () => {
        const { fakeWebview, reader } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const gen = init.panelGeneration;

        let firstIdleReached!: () => void;
        const firstIdleReachedPromise = new Promise<void>(resolve => { firstIdleReached = resolve; });
        let releaseFirstIdle!: () => void;
        const releaseFirstIdlePromise = new Promise<void>(resolve => { releaseFirstIdle = resolve; });
        const origPostMessage = fakeWebview.postMessage.bind(fakeWebview);
        fakeWebview.postMessage = ((msg: any) => {
            const result = origPostMessage(msg);
            if (msg.type === 'filterStatus' && msg.requestId === 73 && msg.state === 'idle') {
                firstIdleReached();
                return releaseFirstIdlePromise.then(() => true);
            }
            return result;
        }) as any;

        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 73,
            entries: [{
                id: 'e1',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '>', value: 2 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await firstIdleReachedPromise;

        const origGetBatch = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = async () => {
            throw new Error('second filter decode boom');
        };
        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 74,
            rollbackBaseRequestId: 0,
            entries: [{
                id: 'e2',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '<', value: 4 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await flush();
        releaseFirstIdle();
        await flush();

        const rollback = fakeWebview.posted.find(
            m => m.type === 'filterApplied' && m.requestId === 74,
        ) as any;
        expect(rollback).toBeDefined();
        expect(rollback.filter.entries).toEqual([]);
        expect(rollback.nrowFiltered).toBe(5);
        expect(rollback.rollback).toBe(true);
        expect(rollback.error).toBe('second filter decode boom');
        expect(fakeWebview.posted.filter(m => m.type === 'error')).toEqual([]);

        (reader as any).getBatch = origGetBatch;
        fakeWebview.deliverFromWebview({
            type: 'getRows',
            panelGeneration: gen,
            requestId: 75,
            viewportGeneration: 1,
            start: 0,
            end: 5,
            columns: [0],
        });
        await flush();
        const rows = fakeWebview.posted.find(
            m => m.type === 'rows' && m.requestId === 75,
        ) as any;
        expect(rows.rows.map((r: any[]) => r[0])).toEqual([1, 2, 3, 4, 5]);
    });

    test('failed newer filter does not roll back to an applied ack the webview ignored', async () => {
        const { fakeWebview, reader } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const gen = init.panelGeneration;

        const origPostMessage = fakeWebview.postMessage.bind(fakeWebview);
        fakeWebview.postMessage = ((msg: any) => {
            const result = origPostMessage(msg);
            if (msg.type === 'filterApplied' && msg.requestId === 76) {
                return new Promise<boolean>(() => {});
            }
            return result;
        }) as any;

        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 76,
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

        const origGetBatch = (reader as any).getBatch.bind(reader);
        (reader as any).getBatch = async () => {
            throw new Error('third filter decode boom');
        };
        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 77,
            rollbackBaseRequestId: 0,
            entries: [{
                id: 'e2',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '<', value: 4 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await flush();

        const rollback = fakeWebview.posted.find(
            m => m.type === 'filterApplied' && m.requestId === 77,
        ) as any;
        expect(rollback).toBeDefined();
        expect(rollback.filter.entries).toEqual([]);
        expect(rollback.nrowFiltered).toBe(5);
        expect(rollback.rollback).toBe(true);
        expect(rollback.error).toBe('third filter decode boom');
        expect(fakeWebview.posted.filter(m => m.type === 'error')).toEqual([]);

        (reader as any).getBatch = origGetBatch;
        fakeWebview.deliverFromWebview({
            type: 'getRows',
            panelGeneration: gen,
            requestId: 78,
            viewportGeneration: 1,
            start: 0,
            end: 5,
            columns: [0],
        });
        await flush();
        const rows = fakeWebview.posted.find(
            m => m.type === 'rows' && m.requestId === 78,
        ) as any;
        expect(rows.rows.map((r: any[]) => r[0])).toEqual([1, 2, 3, 4, 5]);
    });

    test('webview reload suppresses a non-abort error from an aborted interactive filter', async () => {
        const { fakeWebview, reader } = await setupPanel();

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const gen = init.panelGeneration;

        let firstEntered!: () => void;
        const firstEnteredPromise = new Promise<void>(resolve => { firstEntered = resolve; });
        let releaseFirst!: () => void;
        const releaseFirstPromise = new Promise<void>(resolve => { releaseFirst = resolve; });
        let firstRead = true;
        (reader as any).getBatch = async () => {
            if (firstRead) {
                firstRead = false;
                firstEntered();
                await releaseFirstPromise;
            }
            throw new Error('late filter decode boom');
        };

        fakeWebview.deliverFromWebview({
            type: 'setFilters',
            panelGeneration: gen,
            requestId: 60,
            entries: [{
                id: 'e1',
                columnIndex: 0,
                predicate: { kind: 'numCompare', op: '>', value: 2 },
                enabled: true,
                includeMissing: false,
            }],
            labelsOn: true,
        });
        await firstEnteredPromise;

        fakeWebview.deliverFromWebview({ type: 'webviewReady' });
        await flush();
        releaseFirst();
        await flush();

        expect(fakeWebview.posted.filter(m => m.type === 'error')).toEqual([]);
        expect(fakeWebview.posted.filter(m => m.type === 'filterApplied' && m.requestId === 60))
            .toEqual([]);
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
