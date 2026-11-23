/**
 * End-to-end persistence test: simulates the webview-extension message
 * round-trip without a real VS Code host. Mocks `vscode` minimally to
 * stand up a DataViewerPanel, fires saveLayout / saveToolbar through
 * its message handler, then triggers a replace and asserts the next
 * init/replace message carries the persisted state.
 *
 * Reproduces and guards the user-reported bug: hiding a column does
 * not survive a subsequent View(x) call.
 */

import { afterEach, describe, test, expect, mock } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_SRC = (n: string) =>
    join(HERE, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);

// Copy the fixture into a tempdir for each test — DataViewerPanel.replace
// unlinks the old file on swap, which would otherwise destroy the shared
// fixture and break subsequent tests.
function tempCopyOf(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'raven-panel-test-'));
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

type CapturedMessage = { type: string; [k: string]: unknown };

class FakeWebview {
    private listener: ((m: any) => void) | null = null;
    public posted: CapturedMessage[] = [];
    onDidReceiveMessage(cb: (m: any) => void) {
        this.listener = cb;
        return { dispose() {} };
    }
    postMessage(msg: CapturedMessage): Thenable<boolean> {
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
    public disposed = false;
    onDidDispose(cb: () => void) {
        this.disposeListeners.push(cb);
        return { dispose() {} };
    }
    reveal() {}
    dispose() {
        this.disposed = true;
        this.disposeListeners.forEach(cb => cb());
    }
}

async function loadPanel() {
    // Mock vscode just enough that panel.ts can import + instantiate.
    mock.module('vscode', () => ({
        window: {
            createWebviewPanel: () => new FakeWebviewPanel(),
            createOutputChannel: () => ({
                appendLine: () => {},
                dispose: () => {},
            }),
        },
        workspace: {
            getConfiguration: () => ({
                get: (_k: string, def?: unknown) => def,
            }),
        },
        env: {
            clipboard: { writeText: async () => {} },
        },
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

/**
 * Wait for `pred` instead of a fixed number of timer ticks. What a panel
 * posts depends on file reads, and the first panel in a process pays for
 * cold modules too, so "one tick later" holds only for some test orders.
 */
async function until(pred: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!(await pred())) {
        if (Date.now() > deadline) throw new Error('until: condition not met within 5 s');
        await new Promise(r => setTimeout(r, 1));
    }
}

/** The webview boots: send `webviewReady` and wait for the first paint. */
async function ready(webview: FakeWebview): Promise<void> {
    webview.deliverFromWebview({ type: 'webviewReady' });
    await until(() => webview.posted.some(m => m.type === 'init'));
}

// Close what a test opened even when an assertion fails first: a reader
// left open is closed by the garbage collector later, and bun reports
// that as an error in whichever test is running then.
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
    for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
    cleanups.length = 0;
    mock.restore();
});

const TEST_SETTINGS = {
    missingValueStyle: 'foreground' as const,
    defaultDigits: 3,
    persistSort: true,
    persistFilters: true,
};

describe('DataViewerPanel persistence round-trip', () => {
    test('saveLayout from webview → next replace carries persisted layout', async () => {
        const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod, filterMod } = await loadPanel();
        const kv = new MemKV();
        const layoutStore = new layoutMod.LayoutStore(kv as any, 100);
        const toolbarStore = new toolbarMod.ToolbarStateStore(kv as any, 100);
        const sortStore = new sortMod.SortStateStore(kv as any, 100);
        const filterStore = new filterMod.FilterStateStore(kv as any, 100);

        const path1 = tempCopyOf('tiny.arrow');
        const reader = await arrowMod.ArrowSliceReader.open(path1);
        const panel = await panelMod.DataViewerPanel.create(
            'tiny',
            reader,
            path1,
            layoutStore,
            toolbarStore,
            sortStore,
            filterStore,
            TEST_SETTINGS,
            { fsPath: '/x', toString: () => '/x' } as any,
            () => {},
        );
        const fakePanel = (panel as any).webviewPanel as FakeWebviewPanel;
        cleanups.push(() => fakePanel.dispose());
        const fakeWebview = fakePanel.webview;

        // Webview boots → init lands.
        await ready(fakeWebview);

        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        expect(init).toBeDefined();
        expect(init.layout).toEqual({ columnWidths: {}, hiddenColumns: [] });
        expect(typeof init.schemaHash).toBe('string');
        expect(init.schemaHash.length).toBeGreaterThan(0);
        const hash = init.schemaHash as string;

        // User hides column 0 — saveLayout from webview.
        fakeWebview.deliverFromWebview({
            type: 'saveLayout',
            panelGeneration: init.panelGeneration,
            schemaHash: hash,
            layout: { columnWidths: {}, hiddenColumns: [0] },
        });
        await until(async () => (await layoutStore.load('tiny', hash))?.hiddenColumns.length === 1);

        const stored = await layoutStore.load('tiny', hash);
        expect(stored).toEqual({ columnWidths: {}, hiddenColumns: [0] });

        // Trigger a replace with the same fixture (same schemaHash).
        const path2 = tempCopyOf('tiny.arrow');
        const reader2 = await arrowMod.ArrowSliceReader.open(path2);
        cleanups.push(() => reader2.close().catch(() => undefined));
        await panel.replace(reader2, path2);
        await until(() => fakeWebview.posted.some(m => m.type === 'replace'));

        const replace = fakeWebview.posted.find(m => m.type === 'replace') as any;
        expect(replace).toBeDefined();
        expect(replace.layout).toEqual({ columnWidths: {}, hiddenColumns: [0] });

    });

    test('saveToolbar from webview → next replace carries persisted toolbar', async () => {
        const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod, filterMod } = await loadPanel();
        const kv = new MemKV();
        const layoutStore = new layoutMod.LayoutStore(kv as any, 100);
        const toolbarStore = new toolbarMod.ToolbarStateStore(kv as any, 100);
        const sortStore = new sortMod.SortStateStore(kv as any, 100);
        const filterStore = new filterMod.FilterStateStore(kv as any, 100);

        const path1 = tempCopyOf('tiny.arrow');
        const reader = await arrowMod.ArrowSliceReader.open(path1);
        const panel = await panelMod.DataViewerPanel.create(
            'tiny', reader, path1,
            layoutStore, toolbarStore, sortStore, filterStore,
            TEST_SETTINGS,
            { fsPath: '/x', toString: () => '/x' } as any,
            () => {},
        );
        const fakePanel = (panel as any).webviewPanel as FakeWebviewPanel;
        cleanups.push(() => fakePanel.dispose());
        const fakeWebview = fakePanel.webview;

        await ready(fakeWebview);

        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        expect(init.toolbar).toEqual({ labelsOn: true, formatOn: true, digits: 3 });
        const hash = init.schemaHash as string;

        fakeWebview.deliverFromWebview({
            type: 'saveToolbar',
            panelGeneration: init.panelGeneration,
            schemaHash: hash,
            toolbar: { labelsOn: false, formatOn: false, digits: 5 },
        });
        await until(async () => (await toolbarStore.load('tiny', hash))?.digits === 5);

        const stored = await toolbarStore.load('tiny', hash);
        expect(stored).toEqual({ labelsOn: false, formatOn: false, digits: 5 });

        const path2 = tempCopyOf('tiny.arrow');
        const reader2 = await arrowMod.ArrowSliceReader.open(path2);
        cleanups.push(() => reader2.close().catch(() => undefined));
        await panel.replace(reader2, path2);
        await until(() => fakeWebview.posted.some(m => m.type === 'replace'));

        const replace = fakeWebview.posted.find(m => m.type === 'replace') as any;
        expect(replace.toolbar).toEqual({ labelsOn: false, formatOn: false, digits: 5 });

    });

    test('saveLayout from a stale generation still persists (no race-drop)', async () => {
        const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod, filterMod } = await loadPanel();
        const kv = new MemKV();
        const layoutStore = new layoutMod.LayoutStore(kv as any, 100);
        const toolbarStore = new toolbarMod.ToolbarStateStore(kv as any, 100);
        const sortStore = new sortMod.SortStateStore(kv as any, 100);
        const filterStore = new filterMod.FilterStateStore(kv as any, 100);

        const path1 = tempCopyOf('tiny.arrow');
        const reader = await arrowMod.ArrowSliceReader.open(path1);
        const panel = await panelMod.DataViewerPanel.create(
            'tiny', reader, path1,
            layoutStore, toolbarStore, sortStore, filterStore,
            TEST_SETTINGS,
            { fsPath: '/x', toString: () => '/x' } as any,
            () => {},
        );
        const fakePanel = (panel as any).webviewPanel as FakeWebviewPanel;
        cleanups.push(() => fakePanel.dispose());
        const fakeWebview = fakePanel.webview;

        await ready(fakeWebview);
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        const hash = init.schemaHash as string;

        // Bump generation as if a replace happened first.
        const path2 = tempCopyOf('tiny.arrow');
        const reader2 = await arrowMod.ArrowSliceReader.open(path2);
        cleanups.push(() => reader2.close().catch(() => undefined));
        await panel.replace(reader2, path2);
        await until(() => fakeWebview.posted.some(m => m.type === 'replace'));

        // Now an "old" saveLayout from the previous generation arrives.
        // It must still be honored because schemaHash is unchanged.
        fakeWebview.deliverFromWebview({
            type: 'saveLayout',
            panelGeneration: 0, // stale!
            schemaHash: hash,
            layout: { columnWidths: { 1: 200 }, hiddenColumns: [2] },
        });
        await until(async () => (await layoutStore.load('tiny', hash))?.hiddenColumns.length === 1);

        const stored = await layoutStore.load('tiny', hash);
        expect(stored).toEqual({ columnWidths: { 1: 200 }, hiddenColumns: [2] });

    });

    test('stale copy request gets copyDone so the webview clears Copying status', async () => {
        const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod, filterMod } = await loadPanel();
        const kv = new MemKV();
        const layoutStore = new layoutMod.LayoutStore(kv as any, 100);
        const toolbarStore = new toolbarMod.ToolbarStateStore(kv as any, 100);
        const sortStore = new sortMod.SortStateStore(kv as any, 100);
        const filterStore = new filterMod.FilterStateStore(kv as any, 100);

        const path1 = tempCopyOf('tiny.arrow');
        const reader = await arrowMod.ArrowSliceReader.open(path1);
        const panel = await panelMod.DataViewerPanel.create(
            'tiny', reader, path1,
            layoutStore, toolbarStore, sortStore, filterStore,
            TEST_SETTINGS,
            { fsPath: '/x', toString: () => '/x' } as any,
            () => {},
        );
        const fakePanel = (panel as any).webviewPanel as FakeWebviewPanel;
        cleanups.push(() => fakePanel.dispose());
        const fakeWebview = fakePanel.webview;

        await ready(fakeWebview);
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        expect(init).toBeDefined();

        const path2 = tempCopyOf('tiny.arrow');
        const reader2 = await arrowMod.ArrowSliceReader.open(path2);
        cleanups.push(() => reader2.close().catch(() => undefined));
        await panel.replace(reader2, path2);
        await until(() => fakeWebview.posted.some(m => m.type === 'replace'));

        const beforeCopy = fakeWebview.posted.length;
        fakeWebview.deliverFromWebview({
            type: 'copy',
            panelGeneration: init.panelGeneration,
            requestId: 42,
            range: { rowStart: 0, rowEnd: 1, colIndices: [0] },
            labelsOn: true,
            formatOn: true,
            digits: 3,
            includeHeader: false,
        });
        await until(() => fakeWebview.posted.slice(beforeCopy).some(m => m.type === 'copyDone'));

        const copyDone = fakeWebview.posted.slice(beforeCopy)
            .find(m => m.type === 'copyDone') as any;
        expect(copyDone).toEqual({
            type: 'copyDone',
            panelGeneration: init.panelGeneration,
            requestId: 42,
            ok: false,
            error: 'Data changed before copy completed',
        });

    });

    test('copy that becomes stale during row read still gets copyDone', async () => {
        const { panelMod, arrowMod, layoutMod, toolbarMod, sortMod, filterMod } = await loadPanel();
        const kv = new MemKV();
        const layoutStore = new layoutMod.LayoutStore(kv as any, 100);
        const toolbarStore = new toolbarMod.ToolbarStateStore(kv as any, 100);
        const sortStore = new sortMod.SortStateStore(kv as any, 100);
        const filterStore = new filterMod.FilterStateStore(kv as any, 100);

        const path1 = tempCopyOf('tiny.arrow');
        const reader = await arrowMod.ArrowSliceReader.open(path1);
        let releaseRows!: () => void;
        let rowsRequested = false;
        (reader as any).getRows = async () => {
            rowsRequested = true;
            await new Promise<void>(resolve => { releaseRows = resolve; });
            return { rows: [[1]], stale: false };
        };

        const panel = await panelMod.DataViewerPanel.create(
            'tiny', reader, path1,
            layoutStore, toolbarStore, sortStore, filterStore,
            TEST_SETTINGS,
            { fsPath: '/x', toString: () => '/x' } as any,
            () => {},
        );
        const fakePanel = (panel as any).webviewPanel as FakeWebviewPanel;
        cleanups.push(() => fakePanel.dispose());
        const fakeWebview = fakePanel.webview;

        await ready(fakeWebview);
        const init = fakeWebview.posted.find(m => m.type === 'init') as any;
        expect(init).toBeDefined();

        const beforeCopy = fakeWebview.posted.length;
        fakeWebview.deliverFromWebview({
            type: 'copy',
            panelGeneration: init.panelGeneration,
            requestId: 43,
            range: { rowStart: 0, rowEnd: 1, colIndices: [0] },
            labelsOn: false,
            formatOn: true,
            digits: 3,
            includeHeader: false,
        });
        await until(() => rowsRequested);
        expect(rowsRequested).toBe(true);

        const path2 = tempCopyOf('tiny.arrow');
        const reader2 = await arrowMod.ArrowSliceReader.open(path2);
        cleanups.push(() => reader2.close().catch(() => undefined));
        // Release the rows only once the replace has made the copy stale.
        const generation = (panel as any).generation;
        const replacePromise = panel.replace(reader2, path2);
        await until(() => (panel as any).generation !== generation);
        releaseRows();
        await replacePromise;
        await until(() => fakeWebview.posted.slice(beforeCopy).some(m => m.type === 'copyDone'));

        const copyDone = fakeWebview.posted.slice(beforeCopy)
            .find(m => m.type === 'copyDone') as any;
        expect(copyDone).toEqual({
            type: 'copyDone',
            panelGeneration: init.panelGeneration,
            requestId: 43,
            ok: false,
            error: 'Data changed before copy completed',
        });

    });
});
