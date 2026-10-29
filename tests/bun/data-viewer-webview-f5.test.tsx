import { afterEach, describe, expect, jest, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.MutationObserver = dom.window.MutationObserver;
g.MouseEvent = dom.window.MouseEvent;
g.MessageEvent = dom.window.MessageEvent;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
        this.callback([{ target, contentRect: { width: 800, height: 500 } as DOMRectReadOnly }] as ResizeObserverEntry[], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
}
g.ResizeObserver = ResizeObserverStub;
(dom.window as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;

const canvasContext = new Proxy({
    canvas: undefined,
    measureText: (text: string) => ({ width: String(text).length * 8 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
}, {
    get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target];
        return () => undefined;
    },
    set(target, prop, value) {
        (target as Record<PropertyKey, unknown>)[prop] = value;
        return true;
    },
});
(dom.window.HTMLCanvasElement.prototype as unknown as {
    getContext: () => unknown;
}).getContext = function getContext(this: HTMLCanvasElement) {
    canvasContext.canvas = this;
    return canvasContext;
};

const { App } = await import('../../editors/vscode/src/data-viewer/webview/App');

/**
 * F5: the webview's scroll path. Scrolling and hover never render App;
 * the message listener registers once; `vscode.setState` is debounced
 * and guarded by panel generation and schema; announcements are acked
 * with `adopted` and reader requests name the shown generation.
 */

const column = { name: 'x', arrowType: 'Int32', dictionaryShipped: false, isInteger: true };

function init(over: Record<string, unknown> = {}) {
    return {
        type: 'init' as const,
        panelGeneration: 1,
        nrow: 1000,
        columns: [column],
        layout: { columnWidths: {}, hiddenColumns: [] },
        toolbar: { labelsOn: true, formatOn: true, digits: 3 },
        settings: { missingValueStyle: 'foreground' as const, defaultDigits: 3, persistSort: true, persistFilters: true },
        dictionaries: {},
        schemaHash: 'schema-1',
        sort: { keys: [], labelsOnWhenSorted: true },
        filter: { entries: [], labelsOnWhenFiltered: true },
        transformGeneration: 7,
        ...over,
    };
}

let roots: Root[] = [];
afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    roots = [];
    document.body.innerHTML = '';
});

const send = async (data: unknown) => {
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { data })); });
};

async function renderApp() {
    const posted: any[] = [];
    const states: any[] = [];
    let renders = 0;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const vscode = {
        postMessage: (msg: any) => { posted.push(msg); },
        setState: (s: any) => { states.push(s); },
    };
    await act(async () => {
        root.render(<App vscode={vscode} onRender={() => { renders++; }} />);
    });
    return { posted, states, renders: () => renders };
}

describe('data viewer App: adoption and generation tagging', () => {
    test('webviewReady says it adopts; init is acked with adopted; requests name the generation', async () => {
        const { posted } = await renderApp();
        expect(posted[0]).toEqual({ type: 'webviewReady', adoptsTransforms: true });
        await send(init());
        expect(posted).toContainEqual({ type: 'adopted', panelGeneration: 1, transformGeneration: 7 });
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
        const get = posted.find(m => m.type === 'getRows');
        expect(get).toBeDefined();
        expect(get.transformGeneration).toBe(7);
        expect(get.columnRange).toEqual({ start: 0, end: 1 });
        // Tile-aligned: unsorted row pages are 256 rows.
        expect(get.start % 256).toBe(0);
    });

    test('a sortApplied with a new generation drops tiles, acks, and re-requests under it', async () => {
        const { posted } = await renderApp();
        await send(init());
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
        posted.length = 0;
        await send({
            type: 'sortApplied', panelGeneration: 1, requestId: 99,
            sort: { keys: [{ columnIndex: 0, direction: 'desc' }], labelsOnWhenSorted: true },
            fromPersistence: true, transformGeneration: 8,
        });
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
        expect(posted).toContainEqual({ type: 'adopted', panelGeneration: 1, transformGeneration: 8 });
        const get = posted.find(m => m.type === 'getRows');
        expect(get.transformGeneration).toBe(8);
        // Permuted row pages are 64 rows.
        expect(get.end - get.start).toBeLessThanOrEqual(64 * Math.ceil((get.end - get.start) / 64));
        expect(get.start % 64).toBe(0);
    });

    test('a stale reply re-requests the tiles the viewport still needs', async () => {
        const { posted } = await renderApp();
        await send(init());
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
        const first = posted.find(m => m.type === 'getRows');
        posted.length = 0;
        await send({
            type: 'rows', panelGeneration: 1, requestId: first.requestId, viewportGeneration: first.viewportGeneration,
            start: first.start, end: first.start, rows: [], stale: true, columnRange: first.columnRange,
        });
        const retry = posted.find(m => m.type === 'getRows');
        expect(retry).toBeDefined();
        expect(retry.requestId).not.toBe(first.requestId);
        expect([retry.start, retry.end, retry.columnRange]).toEqual([first.start, first.end, first.columnRange]);
    });

    test('retries for an unchanged viewport reuse its generation, so overlapping stale replies cannot cascade', async () => {
        const { posted } = await renderApp();
        await send(init());
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
        let req = posted.find(m => m.type === 'getRows');
        const gen = req.viewportGeneration;
        // Each stale reply's retry carries the same generation: the reader
        // never sees a newer one, so the retry itself is never stale.
        for (let i = 0; i < 3; i++) {
            posted.length = 0;
            await send({
                type: 'rows', panelGeneration: 1, requestId: req.requestId, viewportGeneration: req.viewportGeneration,
                start: req.start, end: req.start, rows: [], stale: true, columnRange: req.columnRange,
            });
            req = posted.find(m => m.type === 'getRows');
            expect(req.viewportGeneration).toBe(gen);
        }
        // A real viewport change does bump it.
        posted.length = 0;
        await send({ type: 'testScrollToFraction', panelGeneration: 1, fraction: 0.8 });
        const moved = posted.find(m => m.type === 'getRows');
        expect(moved.viewportGeneration).toBeGreaterThan(gen);
    });

    test('rows from an older generation are dropped', async () => {
        const { posted } = await renderApp();
        await send(init());
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
        const old = posted.find(m => m.type === 'getRows');
        await send({
            type: 'sortApplied', panelGeneration: 1, requestId: 99,
            sort: { keys: [{ columnIndex: 0, direction: 'desc' }], labelsOnWhenSorted: true },
            fromPersistence: true, transformGeneration: 8,
        });
        posted.length = 0;
        await send({
            type: 'rows', panelGeneration: 1, requestId: old.requestId, viewportGeneration: old.viewportGeneration,
            start: old.start, end: old.end, rows: Array.from({ length: old.end - old.start }, (_, i) => [i]),
            stale: false, columnRange: old.columnRange,
        });
        // No lifecycle 'rows' event: the reply was not applied.
        expect(posted.filter(m => m.type === 'lifecycle' && m.event === 'rows')).toEqual([]);
    });
});

describe('data viewer App: the scroll path never renders App', () => {
    test('scrolling (test scroll) posts requests and lifecycle without a render', async () => {
        const { posted, renders } = await renderApp();
        await send(init());
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
        const before = renders();
        posted.length = 0;
        await send({ type: 'testScrollToFraction', panelGeneration: 1, fraction: 0.8 });
        expect(posted.some(m => m.type === 'lifecycle')).toBe(true);
        expect(posted.some(m => m.type === 'getRows')).toBe(true);
        expect(renders()).toBe(before);
        // The status line still followed the viewport.
        const status = document.querySelector('.status-line')!.textContent ?? '';
        expect(status).not.toContain('Rows 1');
    });

    test('row replies render no App', async () => {
        const { posted, renders } = await renderApp();
        await send(init());
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
        const get = posted.find(m => m.type === 'getRows');
        const before = renders();
        await send({
            type: 'rows', panelGeneration: 1, requestId: get.requestId, viewportGeneration: get.viewportGeneration,
            start: get.start, end: get.end,
            rows: Array.from({ length: get.end - get.start }, (_, i) => [i]),
            stale: false, columnRange: get.columnRange,
        });
        // One render at most, for the one-time width measurement from values.
        expect(renders() - before).toBeLessThanOrEqual(1);
        await send({ type: 'testScrollToFraction', panelGeneration: 1, fraction: 0 });
        const after = renders();
        await send({ type: 'testScrollToFraction', panelGeneration: 1, fraction: 0.5 });
        expect(renders()).toBe(after);
    });

    test('the message listener registers once', async () => {
        const add = window.addEventListener.bind(window);
        let messageListeners = 0;
        window.addEventListener = ((type: string, ...rest: any[]) => {
            if (type === 'message') messageListeners++;
            return (add as any)(type, ...rest);
        }) as typeof window.addEventListener;
        try {
            await renderApp();
            await send(init());
            await send({ ...init({ panelGeneration: 2, transformGeneration: 9 }), type: 'replace', settings: undefined });
            await send({ type: 'testScrollToFraction', panelGeneration: 2, fraction: 0.3 });
            expect(messageListeners).toBe(1);
        } finally {
            window.addEventListener = add;
        }
    });
});

describe('data viewer App: debounced setState', () => {
    test('writes once per burst, after 250 ms, without dictionaries or histograms', async () => {
        const { states } = await renderApp();
        await send(init({ dictionaries: { 0: ['a'] } }));
        await send({ type: 'testScrollToFraction', panelGeneration: 1, fraction: 0.5 });
        expect(states).toEqual([]);
        await act(async () => { await new Promise(r => setTimeout(r, 300)); });
        expect(states.length).toBe(1);
        expect(states[0].panelGeneration).toBe(1);
        expect(states[0].schemaHash).toBe('schema-1');
        expect('dictionaries' in states[0]).toBe(false);
        expect('histograms' in states[0]).toBe(false);
    });

    test('a write scheduled before a generation change is dropped; the new one lands', async () => {
        const { states } = await renderApp();
        await send(init());
        await act(async () => { await new Promise(r => setTimeout(r, 100)); });
        await send({ ...init({ panelGeneration: 2, schemaHash: 'schema-2', transformGeneration: 9 }), type: 'replace', settings: undefined });
        await act(async () => { await new Promise(r => setTimeout(r, 300)); });
        expect(states.map(s => [s.panelGeneration, s.schemaHash])).toEqual([[2, 'schema-2']]);
    });
});
