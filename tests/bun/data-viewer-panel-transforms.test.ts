/**
 * Panel-level commit protocol (F4): every paint and announcement installs
 * first, so the reader's committed transform always matches the painted
 * chips. Drives a real DataViewerPanel (in-process engine) on the tiny
 * fixture through a fake webview, like the panel sort/filter suites.
 *
 * tiny.x = [1, 2, 3, 4, 5].
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIX = join(__dirname, '..', '..', 'editors/vscode/test-fixtures/data-viewer', 'tiny.arrow');
let warnings: string[] = [];
let outputLines: string[] = [];

class MemKV {
    private m = new Map<string, unknown>();
    get<T>(k: string, d?: T): T | undefined { return (this.m.get(k) as T | undefined) ?? d; }
    update(k: string, v: unknown): Thenable<void> {
        if (v === undefined) this.m.delete(k); else this.m.set(k, v);
        return Promise.resolve();
    }
}

class FakeWebview {
    private listener: ((m: any) => void) | null = null;
    posted: any[] = [];
    /** Called for each post; may return a promise to delay it. */
    onPost: ((m: any) => Promise<unknown> | void) | undefined;
    onDidReceiveMessage(cb: (m: any) => void) { this.listener = cb; return { dispose() {} }; }
    postMessage(msg: any): Thenable<boolean> {
        this.posted.push(msg);
        const hold = this.onPost?.(msg);
        return hold ? hold.then(() => true) : Promise.resolve(true);
    }
    asWebviewUri(uri: any) { return uri; }
    cspSource = 'vscode-webview://x';
    deliver(m: any) { this.listener?.(m); }
}

class FakeWebviewPanel {
    webview = new FakeWebview();
    private disposeListeners: (() => void)[] = [];
    onDidDispose(cb: () => void) { this.disposeListeners.push(cb); return { dispose() {} }; }
    reveal() {}
    dispose() { this.disposeListeners.forEach(cb => cb()); }
}

async function flush(n = 6): Promise<void> {
    for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0));
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
    cleanups.length = 0;
    warnings = [];
    outputLines = [];
    mock.restore();
});

async function setup(opts: { savedSort?: any; savedFilter?: any } = {}) {
    mock.module('vscode', () => ({
        window: {
            createWebviewPanel: () => new FakeWebviewPanel(),
            createOutputChannel: () => ({ appendLine: (l: string) => outputLines.push(l), dispose() {} }),
            showWarningMessage: (msg: string) => { warnings.push(msg); return Promise.resolve(undefined); },
        },
        workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) },
        env: { clipboard: { writeText: async () => {} } },
        Uri: { joinPath: (base: any, ...parts: string[]) => ({ fsPath: [base?.fsPath ?? '', ...parts].join('/') }) },
        ViewColumn: { Active: -1 },
    }));
    const panelMod = await import('../../editors/vscode/src/data-viewer/panel');
    const arrowMod = await import('../../editors/vscode/src/data-viewer/arrow-reader');
    const { LayoutStore, schemaHash } = await import('../../editors/vscode/src/data-viewer/layout-state');
    const { ToolbarStateStore } = await import('../../editors/vscode/src/data-viewer/toolbar-state');
    const { SortStateStore } = await import('../../editors/vscode/src/data-viewer/sort-state');
    const { FilterStateStore } = await import('../../editors/vscode/src/data-viewer/filter-state');
    const kv = new MemKV();
    const sortStore = new SortStateStore(kv as any, 100);
    const filterStore = new FilterStateStore(kv as any, 100);
    const dir = mkdtempSync(join(tmpdir(), 'raven-transforms-'));
    const path = join(dir, 'tiny.arrow');
    copyFileSync(FIX, path);
    const reader = await arrowMod.ArrowSliceReader.open(path);
    cleanups.push(() => reader.close().catch(() => undefined));
    const hash = schemaHash(reader.schema.columns);
    if (opts.savedSort) await sortStore.save('tiny', hash, opts.savedSort);
    if (opts.savedFilter) await filterStore.save('tiny', hash, opts.savedFilter);
    const panel: any = await panelMod.DataViewerPanel.create(
        'tiny', reader, path,
        new LayoutStore(kv as any, 100), new ToolbarStateStore(kv as any, 100), sortStore, filterStore,
        { missingValueStyle: 'foreground', defaultDigits: 3, persistSort: true, persistFilters: true },
        { fsPath: '/no-dist' } as any,
        () => {},
    );
    const fake = panel.webviewPanel as FakeWebviewPanel;
    cleanups.push(() => fake.dispose());
    const wv = fake.webview;
    return { panel, wv, reader, sortStore, filterStore, hash };
}

const SORT_DESC = { keys: [{ columnIndex: 0, direction: 'desc' }], labelsOnWhenSorted: true };
const gt = (v: number) => [{
    id: 'e', columnIndex: 0, predicate: { kind: 'numCompare', op: '>', value: v }, enabled: true, includeMissing: false,
}];

async function rows(wv: FakeWebview, gen: number, requestId: number, extra: object = {}): Promise<any> {
    wv.deliver({ type: 'getRows', panelGeneration: gen, requestId, viewportGeneration: requestId, start: 0, end: 5, columns: [0], ...extra });
    await flush();
    return wv.posted.find(m => m.type === 'rows' && m.requestId === requestId);
}

const values = (r: any) => r.rows.map((x: any[]) => x[0]);

/** Rows the reader serves under its committed transform. */
async function committedRows(panel: any): Promise<number[]> {
    const out = await panel.engine.getRows({ start: 0, end: 5, columns: [0], viewportGeneration: Number.MAX_SAFE_INTEGER }, undefined);
    return out.rows.map((x: any[]) => x[0]);
}

describe('restore is one transaction', () => {
    test('saved sort + filter: one composed install, painted chips match the committed transform', async () => {
        const { panel, wv } = await setup({ savedSort: SORT_DESC, savedFilter: { entries: gt(2), labelsOnWhenFiltered: true } });
        let installs = 0;
        const orig = panel.coordinator.install.bind(panel.coordinator);
        panel.coordinator.install = (...a: any[]) => { installs++; return orig(...a); };
        wv.deliver({ type: 'webviewReady' });
        await flush(10);
        const init = wv.posted.find(m => m.type === 'init');
        expect(init.sort.keys).toEqual(SORT_DESC.keys);
        expect(init.filter.entries.length).toBe(1);
        expect(installs).toBe(1);
        expect(init.transformGeneration).toBe(panel.coordinator.committed.gen);
        expect(await committedRows(panel)).toEqual([5, 4, 3]);
    });

    test('a panel generation bump between prepared and commit aborts: nothing committed, no paint', async () => {
        const { panel, wv } = await setup({ savedSort: SORT_DESC });
        const coord = panel.coordinator;
        const origPrepare = coord.reader.prepare;
        coord.reader.prepare = async (gen: number, perm: any) => {
            await origPrepare(gen, perm);
            panel.generation += 1; // a refresh lands while prepared
        };
        await panel.paintWithRestore('init');
        expect(wv.posted.some(m => m.type === 'init')).toBe(false);
        expect(coord.committed.gen).toBe(0);
        expect(await committedRows(panel)).toEqual([1, 2, 3, 4, 5]);
    });

    test('commit a restore, bump the generation, re-send with no saved prefs: identity is committed', async () => {
        const { panel, wv, sortStore, hash } = await setup({ savedSort: SORT_DESC });
        wv.deliver({ type: 'webviewReady' });
        await flush(10);
        expect(await committedRows(panel)).toEqual([5, 4, 3, 2, 1]);
        await sortStore.clear('tiny', hash);
        wv.deliver({ type: 'webviewReady' });
        await flush(10);
        const init = wv.posted.filter(m => m.type === 'init').at(-1);
        expect(init.sort.keys).toEqual([]);
        expect(init.transformGeneration).toBe(panel.coordinator.committed.gen);
        expect(await committedRows(panel)).toEqual([1, 2, 3, 4, 5]);
    });

    test('partial restore failure: the sort fails, the filter still commits, and the user is warned', async () => {
        const { panel, wv, reader } = await setup({
            savedSort: { keys: [{ columnIndex: 1, direction: 'asc' }], labelsOnWhenSorted: true },
            savedFilter: { entries: gt(3), labelsOnWhenFiltered: true },
        });
        const orig = (reader as any).getBatch;
        // Fail only reads of column 1 (the sort key) in the scan.
        panel.engine.scan.reader.getBatch = function (i: number, cols: number[]) {
            if (cols.includes(1)) throw new Error('decode boom');
            return orig.call(this, i, cols);
        };
        wv.deliver({ type: 'webviewReady' });
        await flush(10);
        const init = wv.posted.find(m => m.type === 'init');
        expect(init.sort.keys).toEqual([]);
        expect(init.filter.entries.length).toBe(1);
        expect(await committedRows(panel)).toEqual([4, 5]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('sort');
        expect(warnings[0]).not.toContain('filter');
    });
});

describe('interactive transforms install before they announce', () => {
    test('the idle status and sortApplied are posted only after committed', async () => {
        const { panel, wv } = await setup();
        wv.deliver({ type: 'webviewReady' });
        await flush();
        const gen = wv.posted.find(m => m.type === 'init').panelGeneration;
        const seen: number[] = [];
        wv.onPost = m => {
            if ((m.type === 'sortStatus' && m.state === 'idle') || m.type === 'sortApplied') {
                seen.push(panel.coordinator.committed.gen);
            }
        };
        wv.deliver({ type: 'setSort', panelGeneration: gen, requestId: 1, keys: SORT_DESC.keys, labelsOn: true, formatOn: true, digits: 3 });
        await flush();
        const ack = wv.posted.find(m => m.type === 'sortApplied');
        expect(seen).toEqual([ack.transformGeneration, ack.transformGeneration]);
    });

    test('commit sort N, supersede with N+1, cancel N+1: the reader serves N and the chips show N', async () => {
        const { panel, wv } = await setup();
        wv.deliver({ type: 'webviewReady' });
        await flush();
        const gen = wv.posted.find(m => m.type === 'init').panelGeneration;
        wv.deliver({ type: 'setSort', panelGeneration: gen, requestId: 1, keys: SORT_DESC.keys, labelsOn: true, formatOn: true, digits: 3 });
        await flush();
        const n = wv.posted.find(m => m.type === 'sortApplied');
        // N+1 blocks in its column read until cancelled.
        const scanReader = panel.engine.scan.reader;
        const orig = scanReader.getBatch;
        let entered!: () => void;
        const enteredP = new Promise<void>(r => { entered = r; });
        scanReader.getBatch = async function (i: number, cols: number[]) {
            entered();
            await new Promise(r => setTimeout(r, 30));
            return orig.call(this, i, cols);
        };
        wv.deliver({ type: 'setSort', panelGeneration: gen, requestId: 2, keys: [{ columnIndex: 1, direction: 'asc' }], labelsOn: true, formatOn: true, digits: 3 });
        await enteredP;
        panel.sortAbort.abort();
        await flush(20);
        expect(wv.posted.find(m => m.type === 'sortApplied' && m.requestId === 2)).toBeUndefined();
        expect(panel.coordinator.committed.gen).toBe(n.transformGeneration);
        expect(panel.sort.keys).toEqual(SORT_DESC.keys);
        expect(await committedRows(panel)).toEqual([5, 4, 3, 2, 1]);
    });

    test('clear the sort with a filter active: rows stay filtered, in original order', async () => {
        const { panel, wv } = await setup();
        wv.deliver({ type: 'webviewReady' });
        await flush();
        const gen = wv.posted.find(m => m.type === 'init').panelGeneration;
        wv.deliver({ type: 'setSort', panelGeneration: gen, requestId: 1, keys: SORT_DESC.keys, labelsOn: true, formatOn: true, digits: 3 });
        await flush();
        wv.deliver({ type: 'setFilters', panelGeneration: gen, requestId: 2, entries: gt(2), labelsOn: true });
        await flush();
        expect(values(await rows(wv, gen, 10))).toEqual([5, 4, 3]);
        wv.deliver({ type: 'setSort', panelGeneration: gen, requestId: 3, keys: [], labelsOn: true, formatOn: true, digits: 3 });
        await flush();
        const ack = wv.posted.find(m => m.type === 'sortApplied' && m.requestId === 3);
        expect(ack.sort.keys).toEqual([]);
        expect(values(await rows(wv, gen, 11, { transformGeneration: ack.transformGeneration }))).toEqual([3, 4, 5]);
        expect(panel.filter.entries.length).toBe(1);
    });

    test('clear the filter with a sort active: rows stay sorted, all rows back', async () => {
        const { panel, wv } = await setup();
        wv.deliver({ type: 'webviewReady' });
        await flush();
        const gen = wv.posted.find(m => m.type === 'init').panelGeneration;
        wv.deliver({ type: 'setFilters', panelGeneration: gen, requestId: 1, entries: gt(2), labelsOn: true });
        await flush();
        wv.deliver({ type: 'setSort', panelGeneration: gen, requestId: 2, keys: SORT_DESC.keys, labelsOn: true, formatOn: true, digits: 3 });
        await flush();
        wv.deliver({ type: 'setFilters', panelGeneration: gen, requestId: 3, entries: [], labelsOn: true });
        await flush();
        const ack = wv.posted.find(m => m.type === 'filterApplied' && m.requestId === 3);
        expect(ack.nrowFiltered).toBe(5);
        expect(values(await rows(wv, gen, 10, { transformGeneration: ack.transformGeneration }))).toEqual([5, 4, 3, 2, 1]);
        expect(panel.sort.keys).toEqual(SORT_DESC.keys);
    });

    test('roll back to a generation older than N−1 through its snapshot descriptor', async () => {
        const { panel, wv, reader } = await setup();
        wv.deliver({ type: 'webviewReady' });
        await flush();
        const gen = wv.posted.find(m => m.type === 'init').panelGeneration;
        const sortOn = (requestId: number, col: number, dir: string, base?: number) => wv.deliver({
            type: 'setSort', panelGeneration: gen, requestId, rollbackBaseRequestId: base,
            keys: [{ columnIndex: col, direction: dir }], labelsOn: true, formatOn: true, digits: 3,
        });
        sortOn(1, 0, 'desc');
        await flush();
        sortOn(2, 0, 'asc', 1);
        await flush();
        // The third fails; the webview asks to roll back to request 1 (older than N−1).
        const scanReader = panel.engine.scan.reader;
        const orig = scanReader.getBatch;
        scanReader.getBatch = () => { throw new Error('boom'); };
        sortOn(3, 2, 'asc', 1);
        await flush(10);
        scanReader.getBatch = orig;
        const rb = wv.posted.find(m => m.type === 'sortApplied' && m.requestId === 3);
        expect(rb.rollback).toBe(true);
        expect(rb.sort.keys).toEqual(SORT_DESC.keys);
        expect(rb.transformGeneration).toBe(panel.coordinator.committed.gen);
        expect(await committedRows(panel)).toEqual([5, 4, 3, 2, 1]);
        void reader;
    });
});

describe('adoption interval through the panel', () => {
    test('copy and row requests name the generation on screen; commit N+1 waits for adopted N', async () => {
        const { panel, wv } = await setup();
        wv.deliver({ type: 'webviewReady', adoptsTransforms: true });
        await flush();
        const init = wv.posted.find(m => m.type === 'init');
        const gen = init.panelGeneration;
        wv.deliver({ type: 'adopted', panelGeneration: gen, transformGeneration: init.transformGeneration });
        wv.deliver({ type: 'setSort', panelGeneration: gen, requestId: 1, keys: SORT_DESC.keys, labelsOn: true, formatOn: true, digits: 3 });
        await flush();
        const n = wv.posted.find(m => m.type === 'sortApplied');
        // Not yet adopted: the screen still shows the init generation.
        expect(values(await rows(wv, gen, 10, { transformGeneration: init.transformGeneration }))).toEqual([1, 2, 3, 4, 5]);
        expect(values(await rows(wv, gen, 11, { transformGeneration: n.transformGeneration }))).toEqual([5, 4, 3, 2, 1]);
        // A filter now must wait for adopted N before committing.
        wv.deliver({ type: 'setFilters', panelGeneration: gen, requestId: 2, entries: gt(3), labelsOn: true });
        await flush(10);
        expect(wv.posted.find(m => m.type === 'filterApplied')).toBeUndefined();
        expect(panel.coordinator.committed.gen).toBe(n.transformGeneration);
        wv.deliver({ type: 'adopted', panelGeneration: gen, transformGeneration: n.transformGeneration });
        await flush(10);
        const f = wv.posted.find(m => m.type === 'filterApplied');
        expect(f.nrowFiltered).toBe(2);
        expect(values(await rows(wv, gen, 12, { transformGeneration: f.transformGeneration }))).toEqual([5, 4]);
    });

    test('a missing adopted ack is logged and the state re-sent', async () => {
        const { panel, wv } = await setup();
        wv.deliver({ type: 'webviewReady', adoptsTransforms: true });
        await flush();
        panel.coordinator.adoptionTimeoutMs = 40;
        const init = wv.posted.find(m => m.type === 'init');
        const gen = init.panelGeneration;
        wv.deliver({ type: 'adopted', panelGeneration: gen, transformGeneration: init.transformGeneration });
        // The sort commits, is announced, and its ack never comes.
        wv.deliver({ type: 'setSort', panelGeneration: gen, requestId: 1, keys: SORT_DESC.keys, labelsOn: true, formatOn: true, digits: 3 });
        await new Promise(r => setTimeout(r, 150));
        await flush(10);
        expect(outputLines.some(l => l.includes('no adopted ack'))).toBe(true);
        const replace = wv.posted.filter(m => m.type === 'replace').at(-1);
        expect(replace).toBeDefined();
        expect(replace.panelGeneration).toBeGreaterThan(gen);
        expect(replace.transformGeneration).toBe(panel.coordinator.committed.gen);
    });

    test('a stale reply after reopen is dropped', async () => {
        const { panel, wv } = await setup();
        wv.deliver({ type: 'webviewReady' });
        await flush();
        const gen = wv.posted.find(m => m.type === 'init').panelGeneration;
        const scanReader = panel.engine.readerCore.reader;
        const orig = scanReader.getRows.bind(scanReader);
        scanReader.getRows = async (req: any) => { await new Promise(r => setTimeout(r, 20)); return orig(req); };
        wv.deliver({ type: 'getRows', panelGeneration: gen, requestId: 77, viewportGeneration: 1, start: 0, end: 5, columns: [0] });
        wv.deliver({ type: 'webviewReady' });
        await new Promise(r => setTimeout(r, 60));
        await flush();
        expect(wv.posted.find(m => m.type === 'rows' && m.requestId === 77)).toBeUndefined();
    });
});
