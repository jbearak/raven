/**
 * Phase 5 on the host: Copy as R code, go to row, find, and refresh,
 * through a real DataViewerPanel (in-process engine) on the tiny fixture
 * and a fake webview, like the panel transform suites.
 *
 * tiny.x = [1, 2, 3, 4, 5]; tiny.s = [a, b, NA, d, e].
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIX = join(__dirname, '..', '..', 'editors/vscode/test-fixtures/data-viewer', 'tiny.arrow');
let warnings: string[] = [];
let outputLines: string[] = [];
let clipboard: string[] = [];
let infos: string[] = [];
let modalAnswer: string | undefined;
let modals: { msg: string; detail?: string }[] = [];
let sent: string[] = [];

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
    clipboard = [];
    infos = [];
    modals = [];
    sent = [];
    modalAnswer = undefined;
    mock.restore();
});

async function setup(opts: { savedSort?: any; savedFilter?: any; source?: any; persistSort?: boolean; title?: string } = {}) {
    mock.module('vscode', () => ({
        window: {
            createWebviewPanel: () => new FakeWebviewPanel(),
            createOutputChannel: () => ({ appendLine: (l: string) => outputLines.push(l), dispose() {} }),
            showWarningMessage: (msg: string, opts?: any) => {
                if (opts?.modal) { modals.push({ msg, detail: opts.detail }); return Promise.resolve(modalAnswer); }
                warnings.push(msg);
                return Promise.resolve(undefined);
            },
            showInformationMessage: (msg: string) => { infos.push(msg); return Promise.resolve(undefined); },
        },
        workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) },
        env: { clipboard: { writeText: async (t: string) => { clipboard.push(t); } } },
        Uri: { joinPath: (base: any, ...parts: string[]) => ({ fsPath: [base?.fsPath ?? '', ...parts].join('/') }) },
        ViewColumn: { Active: -1 },
    }));
    mock.module('../../editors/vscode/src/send-to-r/r-terminal-manager', () => ({
        get_or_create_r_terminal: async () => ({ name: 'R' }),
    }));
    mock.module('../../editors/vscode/src/send-to-r/send-code', () => ({
        get_send_options: () => ({ sendMethod: 'auto', autoTempFileThresholdLines: 25 }),
        send_code: (_t: unknown, code: string) => { sent.push(code); },
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
        opts.title ?? 'tiny', reader, path,
        new LayoutStore(kv as any, 100), new ToolbarStateStore(kv as any, 100), sortStore, filterStore,
        { missingValueStyle: 'foreground', defaultDigits: 3, persistSort: opts.persistSort ?? true, persistFilters: true, uiLocale: 'en' },
        { fsPath: '/no-dist' } as any,
        () => {},
        opts.source ?? {},
    );
    const fake = panel.webviewPanel as FakeWebviewPanel;
    cleanups.push(() => fake.dispose());
    const wv = fake.webview;
    return { panel, wv, reader, sortStore, filterStore, hash, arrowMod, dir };
}


const SORT_DESC = { keys: [{ columnIndex: 0, direction: 'desc' }], labelsOnWhenSorted: true };

async function ready(wv: FakeWebview): Promise<number> {
    wv.deliver({ type: 'webviewReady' });
    await flush(10);
    return wv.posted.find(m => m.type === 'init').panelGeneration;
}

async function sortDesc(wv: FakeWebview, gen: number): Promise<void> {
    wv.deliver({ type: 'setSort', panelGeneration: gen, requestId: 1, keys: SORT_DESC.keys, labelsOn: true, formatOn: true, digits: 3 });
    await flush(20);
}

const last = (wv: FakeWebview, type: string) => [...wv.posted].reverse().find(m => m.type === type);

describe('Copy as R code', () => {
    test('writes the committed sort and the hidden columns against the View() expression', async () => {
        const { wv } = await setup({ source: { expression: 'tiny', sourceKind: 'data.frame' } });
        const gen = await ready(wv);
        await sortDesc(wv, gen);
        wv.deliver({ type: 'copyAsCode', panelGeneration: gen, requestId: 5, flavor: 'dplyr', hiddenColumns: [6] });
        await flush();
        expect(clipboard).toHaveLength(1);
        expect(clipboard[0]).toContain('tiny |>\n  arrange(desc(x)) |>\n  select(-lbl)');
        expect(last(wv, 'notice')).toMatchObject({ ok: true, message: 'Copied as R code (dplyr)' });
    });

    test('without a View() expression, or for a vector, it explains instead', async () => {
        const { wv } = await setup();
        const gen = await ready(wv);
        wv.deliver({ type: 'copyAsCode', panelGeneration: gen, requestId: 5, flavor: 'base', hiddenColumns: [] });
        await flush();
        expect(clipboard).toHaveLength(0);
        expect(last(wv, 'notice')).toMatchObject({ ok: false, message: expect.stringContaining('unknown') });
    });
});

describe('go to row', () => {
    test('maps an R row number through the sort on screen; filtered-out or out-of-range rows are -1', async () => {
        const { wv } = await setup();
        const gen = await ready(wv);
        await sortDesc(wv, gen);
        const tg = last(wv, 'sortApplied').transformGeneration;
        wv.deliver({ type: 'goToRow', panelGeneration: gen, requestId: 9, rowNumber: 2, transformGeneration: tg });
        await flush();
        // x = 1..5 sorted descending: R row 2 (x = 2) is display row 3.
        expect(last(wv, 'rowPosition')).toMatchObject({ requestId: 9, rowNumber: 2, position: 3 });
        wv.deliver({ type: 'goToRow', panelGeneration: gen, requestId: 10, rowNumber: 99, transformGeneration: tg });
        await flush();
        expect(last(wv, 'rowPosition')).toMatchObject({ requestId: 10, position: -1 });
    });
});

describe('find', () => {
    test('replies with the count and the first match at or after `from`; steps wrap', async () => {
        const { wv } = await setup();
        const gen = await ready(wv);
        await sortDesc(wv, gen);
        const tg = last(wv, 'sortApplied').transformGeneration;
        // s = a, b, NA, d, e; x = 1..5. "a" matches s = "a" (row 0) and NA (row 2).
        wv.deliver({ type: 'find', panelGeneration: gen, requestId: 11, query: 'A', columns: [2], labelsOn: true, formatOn: true, digits: 3, from: 0, transformGeneration: tg });
        await flush(10);
        // Sorted by x descending, R rows 3 and 1 are display rows 2 and 4.
        expect(last(wv, 'findResult')).toMatchObject({ requestId: 11, count: 2, position: 2, index: 0, transformGeneration: tg });
        wv.deliver({ type: 'findStep', panelGeneration: gen, requestId: 12, from: 2, direction: 1 });
        await flush();
        expect(last(wv, 'findResult')).toMatchObject({ requestId: 12, position: 4, index: 1 });
        wv.deliver({ type: 'findStep', panelGeneration: gen, requestId: 13, from: 4, direction: 1 });
        await flush();
        expect(last(wv, 'findResult')).toMatchObject({ requestId: 13, position: 2, index: 0 });
        wv.deliver({ type: 'findStep', panelGeneration: gen, requestId: 14, from: 2, direction: -1 });
        await flush();
        expect(last(wv, 'findResult')).toMatchObject({ requestId: 14, position: 4, index: 1 });
    });

    test('a newer find supersedes a running one; cancelFind forgets the matches', async () => {
        const { wv } = await setup();
        const gen = await ready(wv);
        wv.deliver({ type: 'find', panelGeneration: gen, requestId: 20, query: '1', columns: [0], labelsOn: true, formatOn: true, digits: 3, from: 0 });
        wv.deliver({ type: 'find', panelGeneration: gen, requestId: 21, query: '5', columns: [0], labelsOn: true, formatOn: true, digits: 3, from: 0 });
        await flush(10);
        const results = wv.posted.filter(m => m.type === 'findResult');
        expect(results.map(r => r.requestId)).toEqual([21]);
        expect(results[0]).toMatchObject({ count: 1, position: 4 });
        wv.deliver({ type: 'cancelFind', panelGeneration: gen });
        wv.deliver({ type: 'findStep', panelGeneration: gen, requestId: 22, from: 0, direction: 1 });
        await flush();
        expect(wv.posted.filter(m => m.type === 'findResult')).toHaveLength(1);
    });
});

describe('refresh', () => {
    test('shows the View() call and asks; declining sends nothing', async () => {
        const { wv } = await setup({ source: { expression: 'subset(tiny, x > 1)', sourceKind: 'data.frame' }, title: 'subset(tiny, x > 1)' });
        const gen = await ready(wv);
        wv.deliver({ type: 'refresh', panelGeneration: gen });
        await flush();
        expect(modals).toHaveLength(1);
        expect(modals[0].msg).toBe('Re-run View(subset(tiny, x > 1)) in the R console?');
        expect(modals[0].detail).toContain('evaluated again');
        expect(sent).toEqual([]);
    });

    test('a titled view re-runs with its title; without an expression it explains', async () => {
        const { wv } = await setup({ source: { expression: 'tiny', sourceKind: 'data.frame' }, title: 'My "data"' });
        const gen = await ready(wv);
        modalAnswer = 'Re-run';
        wv.deliver({ type: 'refresh', panelGeneration: gen });
        await flush();
        expect(sent).toEqual(['View(tiny, title = "My \\"data\\"")']);
        const s2 = await setup();
        const gen2 = await ready(s2.wv);
        s2.wv.deliver({ type: 'refresh', panelGeneration: gen2 });
        await flush();
        expect(infos[0]).toContain('no View() expression');
    });

    test('confirmed: the re-run keeps the sort when the schema matches, even with persistence off', async () => {
        const { panel, wv, arrowMod, dir } = await setup({ source: { expression: 'tiny', sourceKind: 'data.frame' }, persistSort: false });
        const gen = await ready(wv);
        await sortDesc(wv, gen);
        modalAnswer = 'Re-run';
        wv.deliver({ type: 'refresh', panelGeneration: gen });
        await flush();
        expect(sent).toEqual(['View(tiny)']);
        const path2 = join(dir, 'tiny2.arrow');
        copyFileSync(FIX, path2);
        const reader2 = await arrowMod.ArrowSliceReader.open(path2);
        await panel.replace(reader2, path2, { expression: 'tiny', sourceKind: 'data.frame' });
        await flush(20);
        const rep = last(wv, 'replace');
        expect(rep.sort.keys).toEqual(SORT_DESC.keys);
        // Without a refresh, persistence off drops it.
        const path3 = join(dir, 'tiny3.arrow');
        copyFileSync(FIX, path3);
        const reader3 = await arrowMod.ArrowSliceReader.open(path3);
        await panel.replace(reader3, path3, { expression: 'tiny', sourceKind: 'data.frame' });
        await flush(20);
        expect(last(wv, 'replace').sort.keys).toEqual([]);
    });
});
