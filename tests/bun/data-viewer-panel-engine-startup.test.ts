/**
 * Engine startup races. The panel starts its engine (the worker threads)
 * with an await in `create()` and in `replace()`; the webview can send
 * messages and the user can close the tab while that await is pending.
 *
 * `WorkerEngine.start` is replaced by a gate the test releases, so each
 * await point is hit deterministically. The "workers" are in-process
 * `LocalEngine`s on their own reader, like the real reader thread.
 *
 * tiny.x = [1, 2, 3, 4, 5].
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'editors/vscode/src/data-viewer');
const FIX = join(__dirname, '..', '..', 'editors/vscode/test-fixtures/data-viewer', 'tiny.arrow');

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
    onDidReceiveMessage(cb: (m: any) => void) { this.listener = cb; return { dispose() {} }; }
    /** Acks every announcement like the webview's `adoptTransform`. */
    postMessage(msg: any): Thenable<boolean> {
        this.posted.push(msg);
        if (msg.transformGeneration !== undefined && msg.type !== 'rows') {
            setTimeout(() => this.deliver({
                type: 'adopted', panelGeneration: msg.panelGeneration, transformGeneration: msg.transformGeneration,
            }), 0);
        }
        return Promise.resolve(true);
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

async function flush(n = 8): Promise<void> {
    for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0));
}

/** One gated engine start: resolved by the test with `release()`. */
type Gate = { engine?: any; disposed: boolean; holdDispose?: Promise<void>; release: () => Promise<void> };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
    cleanups.length = 0;
    mock.restore();
});

async function setup() {
    const panels: FakeWebviewPanel[] = [];
    const gates: Gate[] = [];
    const arrowMod = await import(`${SRC}/arrow-reader`);
    const { LocalEngine } = await import(`${SRC}/engine`);
    mock.module('vscode', () => ({
        window: {
            createWebviewPanel: () => { const p = new FakeWebviewPanel(); panels.push(p); return p; },
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
            showWarningMessage: () => Promise.resolve(undefined),
            showErrorMessage: () => Promise.resolve(undefined),
        },
        workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) },
        env: { clipboard: { writeText: async () => {} } },
        Uri: { joinPath: (base: any, ...parts: string[]) => ({ fsPath: [base?.fsPath ?? '', ...parts].join('/') }) },
        ViewColumn: { Active: -1 },
    }));
    mock.module(`${SRC}/worker-engine`, () => ({
        WorkerEngine: {
            start: (opts: { filePath: string }) => new Promise(resolve => {
                // Open now, as a real thread would: a close during startup
                // unlinks the file.
                const opening = arrowMod.ArrowSliceReader.open(opts.filePath);
                const gate: Gate = {
                    disposed: false,
                    release: async () => {
                        const reader = await opening;
                        const engine = new LocalEngine(reader);
                        const dispose = engine.dispose.bind(engine);
                        engine.dispose = async () => { gate.disposed = true; await gate.holdDispose; await dispose(); await reader.close(); };
                        gate.engine = engine;
                        resolve(engine);
                        await flush();
                    },
                };
                gates.push(gate);
            }),
        },
    }));
    const panelMod = await import(`${SRC}/panel`);
    const { DataViewerManager } = await import(`${SRC}/manager`);
    const { LayoutStore } = await import(`${SRC}/layout-state`);
    const { ToolbarStateStore } = await import(`${SRC}/toolbar-state`);
    const { SortStateStore } = await import(`${SRC}/sort-state`);
    const { FilterStateStore } = await import(`${SRC}/filter-state`);
    // The worker factory is used only when both bundles exist.
    const ext = mkdtempSync(join(tmpdir(), 'raven-engine-startup-'));
    mkdirSync(join(ext, 'dist'));
    writeFileSync(join(ext, 'dist', 'data-viewer-reader.js'), '');
    writeFileSync(join(ext, 'dist', 'data-viewer-worker.js'), '');
    const kv = new MemKV();
    const stores = [
        new LayoutStore(kv as any, 100), new ToolbarStateStore(kv as any, 100),
        new SortStateStore(kv as any, 100), new FilterStateStore(kv as any, 100),
    ] as const;
    const settings = { missingValueStyle: 'foreground', defaultDigits: 3, persistSort: true, persistFilters: true };
    const copy = (name: string) => { const p = join(ext, name); copyFileSync(FIX, p); return p; };
    const openReader = async (path: string) => {
        const r = await arrowMod.ArrowSliceReader.open(path);
        cleanups.push(() => r.close().catch(() => undefined));
        return r;
    };
    const create = async (path: string) => panelMod.DataViewerPanel.create(
        'tiny', await openReader(path), path, ...stores, settings as any, { fsPath: ext } as any, () => {},
    );
    const manager = new DataViewerManager({ fsPath: ext } as any, ...stores, () => settings as any);
    cleanups.push(async () => {
        for (const p of panels) p.dispose();
        for (const g of gates) if (!g.engine) await g.release().catch(() => undefined);
        for (const g of gates) await g.engine?.dispose().catch(() => undefined);
    });
    return { panels, gates, create, copy, openReader, manager };
}

/** Wait until `pred` holds, flushing the event loop between checks. */
async function until(pred: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !pred(); i++) await flush(1);
}

async function rowsFor(wv: FakeWebview, init: any, requestId: number): Promise<any> {
    wv.deliver({
        type: 'getRows', panelGeneration: init.panelGeneration, transformGeneration: init.transformGeneration,
        requestId, viewportGeneration: requestId, start: 0, end: 5, columns: [0],
    });
    await until(() => wv.posted.some(m => m.type === 'rows' && m.requestId === requestId));
    return wv.posted.find(m => m.type === 'rows' && m.requestId === requestId);
}

describe('engine startup in create()', () => {
    test('webviewReady while the engine starts: the first paint comes from the installed engine and rows arrive', async () => {
        const { panels, gates, create, copy } = await setup();
        const creating = create(copy('a.arrow'));
        await until(() => gates.length === 1);
        const wv = panels[0].webview;
        wv.deliver({ type: 'webviewReady', adoptsTransforms: true });
        await flush();
        // Nothing paints from a temporary engine while the real one starts.
        expect(wv.posted.some(m => m.type === 'init')).toBe(false);
        await gates[0].release();
        const panel: any = await creating;
        await until(() => wv.posted.some(m => m.type === 'init'));
        const init = wv.posted.find(m => m.type === 'init');
        expect(panel.engineValue).toBe(gates[0].engine);
        expect(init.transformGeneration).toBe(gates[0].engine.coordinator.committed.gen);
        const r = await rowsFor(wv, init, 101);
        expect(r.rows.map((x: any[]) => x[0])).toEqual([1, 2, 3, 4, 5]);
    });

    test('tab closed while the engine starts: the engine is disposed, not installed', async () => {
        const { panels, gates, create, copy } = await setup();
        const creating = create(copy('a.arrow'));
        await until(() => gates.length === 1);
        panels[0].dispose();
        await flush();
        await gates[0].release();
        const panel: any = await creating;
        expect(panel.isDisposed).toBe(true);
        expect(gates[0].disposed).toBe(true);
        expect(panel.engineValue).toBeUndefined();
    });

    test('manager: a panel closed during startup is not registered; the next View() opens a new tab', async () => {
        const { panels, gates, copy, manager } = await setup();
        const first = manager.onViewDataRequested({ panelName: 'race', filePath: copy('a.arrow'), nrow: 5, sessionId: 'x' } as any);
        await until(() => gates.length === 1);
        panels[0].dispose();
        await flush();
        await gates[0].release();
        await first;
        expect(gates[0].disposed).toBe(true);
        expect(manager.getPanelNames()).toEqual([]);
        const second = manager.onViewDataRequested({ panelName: 'race', filePath: copy('b.arrow'), nrow: 5, sessionId: 'x' } as any);
        await until(() => gates.length === 2);
        await gates[1].release();
        await second;
        expect(panels.length).toBe(2);
        expect(manager.getPanelNames()).toEqual(['race']);
    });

    test('manager: a closed panel whose disposal finishes late does not unregister its same-name successor', async () => {
        const { panels, gates, copy, manager } = await setup();
        const first = manager.onViewDataRequested({ panelName: 'race', filePath: copy('a.arrow'), nrow: 5, sessionId: 'x' } as any);
        await until(() => gates.length === 1);
        await gates[0].release();
        await first;
        // Close, then open the same name before the first disposal settles.
        let finishDispose!: () => void;
        gates[0].holdDispose = new Promise<void>(r => { finishDispose = r; });
        panels[0].dispose();
        const second = manager.onViewDataRequested({ panelName: 'race', filePath: copy('b.arrow'), nrow: 5, sessionId: 'x' } as any);
        await until(() => gates.length === 2);
        await gates[1].release();
        await second;
        expect(manager.getPanelNames()).toEqual(['race']);
        finishDispose();
        await flush();
        expect(panels.length).toBe(2);
        expect(manager.getPanelNames()).toEqual(['race']);
    });
});

describe('engine startup in replace()', () => {
    test('requests during the new engine start wait for it and are answered by it', async () => {
        const { panels, gates, create, copy, openReader } = await setup();
        const creating = create(copy('a.arrow'));
        await until(() => gates.length === 1);
        await gates[0].release();
        const panel: any = await creating;
        const wv = panels[0].webview;
        wv.deliver({ type: 'webviewReady', adoptsTransforms: true });
        await until(() => wv.posted.some(m => m.type === 'init'));
        const path = copy('b.arrow');
        const replacing = panel.replace(await openReader(path), path);
        await until(() => gates.length === 2);
        const before = wv.posted.length;
        wv.deliver({ type: 'webviewReady', adoptsTransforms: true });
        await flush();
        expect(wv.posted.length).toBe(before);
        await gates[1].release();
        await replacing;
        await until(() => wv.posted.filter(m => m.type === 'init' || m.type === 'replace').length === 3);
        const init = wv.posted.filter(m => m.type === 'init' || m.type === 'replace').at(-1);
        expect(panel.engineValue).toBe(gates[1].engine);
        expect(gates[0].disposed).toBe(true);
        expect(init.transformGeneration).toBe(gates[1].engine.coordinator.committed.gen);
        const r = await rowsFor(wv, init, 202);
        expect(r.rows.map((x: any[]) => x[0])).toEqual([1, 2, 3, 4, 5]);
    });

    test('tab closed while the new engine starts: both engines are disposed', async () => {
        const { panels, gates, create, copy, openReader } = await setup();
        const creating = create(copy('a.arrow'));
        await until(() => gates.length === 1);
        await gates[0].release();
        const panel: any = await creating;
        const path = copy('b.arrow');
        const replacing = panel.replace(await openReader(path), path);
        await until(() => gates.length === 2);
        panels[0].dispose();
        await flush();
        await gates[1].release();
        await replacing;
        expect(gates[0].disposed).toBe(true);
        expect(gates[1].disposed).toBe(true);
        expect(panel.engineValue).toBeUndefined();
    });
});
