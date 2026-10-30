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
 * Phase 5 in the webview: the ⋯ menu (Copy as R code, Refresh), find
 * (Cmd/Ctrl+F) and go to row (Cmd/Ctrl+G), pins from the column menu,
 * and the status line's selection summary.
 */

const columns = [
    { name: 'mpg', arrowType: 'Float64', dictionaryShipped: false, isInteger: false },
    { name: 'cyl', arrowType: 'Int32', dictionaryShipped: false, isInteger: true },
    { name: 'note', arrowType: 'Utf8', dictionaryShipped: false, isInteger: false },
];

function init(over: Record<string, unknown> = {}) {
    return {
        type: 'init' as const,
        panelGeneration: 1,
        nrow: 100,
        columns,
        layout: { columnWidths: {}, hiddenColumns: [] },
        toolbar: { labelsOn: true, formatOn: true, digits: 3, summariesOn: false },
        settings: { missingValueStyle: 'foreground' as const, defaultDigits: 3, persistSort: true, persistFilters: true },
        schemaHash: 'schema-1',
        sort: { keys: [], labelsOnWhenSorted: true },
        filter: { entries: [], labelsOnWhenFiltered: true },
        transformGeneration: 1,
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
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

async function renderApp() {
    const posted: any[] = [];
    let renders = 0;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const vscode = { postMessage: (msg: any) => { posted.push(msg); }, setState: () => {} };
    await act(async () => {
        root.render(<App vscode={vscode} onRender={() => { renders++; }} />);
    });
    return { posted, renders: () => renders };
}

function key(k: string, mods: { meta?: boolean } = {}) {
    act(() => {
        window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, metaKey: mods.meta ?? false, ctrlKey: false, bubbles: true }));
    });
}

// Drive React's handlers directly (jsdom's synthetic input and key
// events don't reach React's change tracking here).
function reactProps(el: Element): any {
    return Object.entries(el).find(([k]) => k.startsWith('__reactProps$'))![1];
}

function setInput(input: HTMLInputElement, value: string) {
    act(() => {
        input.value = value;
        reactProps(input).onChange({ target: input });
    });
}

function pressIn(el: HTMLElement, k: string, shift = false) {
    act(() => {
        reactProps(el).onKeyDown({ key: k, shiftKey: shift, preventDefault() {}, stopPropagation() {} });
    });
}

function rowsReply(posted: any[], over: Record<string, unknown> = {}) {
    const req = [...posted].reverse().find(m => m.type === 'getRows');
    const width = req.columnRange ? req.columnRange.end - req.columnRange.start : req.columns.length;
    const rows = [];
    for (let r = req.start; r < req.end; r++) {
        const row = [];
        for (let c = 0; c < width; c++) row.push(c === 2 ? `n${r}` : r === 1 && c === 0 ? null : r + c);
        rows.push(row);
    }
    return {
        type: 'rows', panelGeneration: 1, requestId: req.requestId, viewportGeneration: req.viewportGeneration,
        start: req.start, end: req.end, rows, stale: false, ...(req.columnRange ? { columnRange: req.columnRange } : {}), ...over,
    };
}

describe('the ⋯ menu', () => {
    test('lists find, go to row, Copy as R code with a base R / data.table submenu, and Refresh', async () => {
        const { posted } = await renderApp();
        await send(init());
        const more = document.querySelector('[aria-label="More actions"]') as HTMLButtonElement;
        act(() => { more.click(); });
        const items = () => [...document.querySelectorAll('.workflow-menu [role="menuitem"]')].map(e => e.textContent ?? '');
        expect(items().map(t => t.replace(/(⌘|Ctrl\+)/, 'MOD'))).toEqual([
            'Find…MODF', 'Go to row…MODG', 'Copy as R code (dplyr)', 'Copy as R code▸', 'Refresh…',
        ]);
        const sub = [...document.querySelectorAll('.workflow-menu [role="menuitem"]')].find(e => e.textContent?.startsWith('Copy as R code▸')) as HTMLButtonElement;
        act(() => { sub.click(); });
        const dt = [...document.querySelectorAll('.workflow-submenu [role="menuitem"]')].find(e => e.textContent === 'data.table') as HTMLButtonElement;
        posted.length = 0;
        act(() => { dt.click(); });
        expect(posted).toContainEqual(expect.objectContaining({ type: 'copyAsCode', flavor: 'data.table', hiddenColumns: [] }));
        expect(document.querySelector('.workflow-menu')).toBeNull();

        act(() => { more.click(); });
        const refresh = [...document.querySelectorAll('.workflow-menu [role="menuitem"]')].find(e => e.textContent === 'Refresh…') as HTMLButtonElement;
        posted.length = 0;
        act(() => { refresh.click(); });
        expect(posted).toEqual([{ type: 'refresh', panelGeneration: 1 }]);
    });

    test('a notice from the host shows in the toast slot', async () => {
        await renderApp();
        await send(init());
        await send({ type: 'notice', panelGeneration: 1, ok: true, message: 'Copied as R code (dplyr)' });
        expect(document.querySelector('.toast')?.textContent).toBe('Copied as R code (dplyr)');
    });
});

describe('find', () => {
    test('Cmd+F opens the bar; typing searches the visible columns, Enter steps, the reply selects and counts', async () => {
        const { posted } = await renderApp();
        await send(init({ layout: { columnWidths: {}, hiddenColumns: [1] } }));
        key('f', { meta: true });
        const input = document.querySelector('.find-bar input') as HTMLInputElement;
        expect(input).not.toBeNull();
        posted.length = 0;
        setInput(input, 'n4');
        await wait(260);
        const find = posted.find(m => m.type === 'find');
        expect(find).toMatchObject({ query: 'n4', columns: [0, 2], labelsOn: true, formatOn: true, digits: 3, transformGeneration: 1 });
        expect(document.querySelector('.find-bar .grid-bar-status')?.textContent).toBe('Searching…');
        await send({ type: 'findResult', panelGeneration: 1, requestId: find.requestId, count: 11, position: 4, index: 0, transformGeneration: 1 });
        expect(document.querySelector('.find-bar .grid-bar-status')?.textContent).toBe('1 of 11');
        const lc = [...posted].reverse().find(m => m.type === 'lifecycle' && m.event === 'find');
        expect(lc.focusCell).toEqual({ row: 4, col: 0 });
        posted.length = 0;
        pressIn(input, 'Enter');
        expect(posted).toContainEqual(expect.objectContaining({ type: 'findStep', direction: 1, from: 4 }));
        pressIn(input, 'Enter', true);
        expect(posted).toContainEqual(expect.objectContaining({ type: 'findStep', direction: -1, from: 4 }));
        // A stale reply (an older request) is ignored.
        await send({ type: 'findResult', panelGeneration: 1, requestId: find.requestId, count: 1, position: 9, index: 0, transformGeneration: 1 });
        expect(document.querySelector('.find-bar .grid-bar-status')?.textContent).toBe('1 of 11');
        posted.length = 0;
        pressIn(input, 'Escape');
        expect(document.querySelector('.find-bar')).toBeNull();
        expect(posted).toContainEqual({ type: 'cancelFind', panelGeneration: 1 });
    });

    test('a reply for a transform the grid no longer shows searches again', async () => {
        const { posted } = await renderApp();
        await send(init());
        key('f', { meta: true });
        const input = document.querySelector('.find-bar input') as HTMLInputElement;
        setInput(input, 'x');
        await wait(260);
        const find = posted.find(m => m.type === 'find');
        posted.length = 0;
        await send({ type: 'findResult', panelGeneration: 1, requestId: find.requestId, count: 3, position: 1, index: 0, transformGeneration: 0 });
        expect(posted.filter(m => m.type === 'find')).toHaveLength(1);
    });
});

describe('go to row', () => {
    test('Cmd+G; an R row number goes straight there in natural order, #n is a display position', async () => {
        const { posted } = await renderApp();
        await send(init());
        key('g', { meta: true });
        const input = document.querySelector('.goto-bar input') as HTMLInputElement;
        setInput(input, '42');
        posted.length = 0;
        pressIn(input, 'Enter');
        expect(posted.some(m => m.type === 'goToRow')).toBe(false);
        expect([...posted].reverse().find(m => m.type === 'lifecycle')?.focusCell).toEqual({ row: 41, col: 0 });
        setInput(input, '#7');
        pressIn(input, 'Enter');
        expect([...posted].reverse().find(m => m.type === 'lifecycle')?.focusCell).toEqual({ row: 6, col: 0 });
        setInput(input, '500');
        pressIn(input, 'Enter');
        expect(document.querySelector('.goto-bar .grid-bar-status')?.textContent).toBe('The data has 100 rows');
        setInput(input, 'abc');
        pressIn(input, 'Enter');
        expect(input.getAttribute('aria-invalid')).toBe('true');
    });

    test('under a sort or filter, the host maps the R row number', async () => {
        const { posted } = await renderApp();
        await send(init({ sort: { keys: [{ columnIndex: 0, direction: 'desc' }], labelsOnWhenSorted: true } }));
        key('g', { meta: true });
        const input = document.querySelector('.goto-bar input') as HTMLInputElement;
        setInput(input, '10');
        posted.length = 0;
        pressIn(input, 'Enter');
        const req = posted.find(m => m.type === 'goToRow');
        expect(req).toMatchObject({ rowNumber: 10, transformGeneration: 1 });
        await send({ type: 'rowPosition', panelGeneration: 1, requestId: req.requestId, rowNumber: 10, position: -1 });
        expect(document.querySelector('.goto-bar .grid-bar-status')?.textContent).toBe('Row 10 is filtered out');
        setInput(input, '10');
        pressIn(input, 'Enter');
        const req2 = [...posted].reverse().find(m => m.type === 'goToRow');
        await send({ type: 'rowPosition', panelGeneration: 1, requestId: req2.requestId, rowNumber: 10, position: 77 });
        expect([...posted].reverse().find(m => m.type === 'lifecycle')?.focusCell).toEqual({ row: 77, col: 0 });
    });
});

describe('pins', () => {
    test('a pinned layout freezes the column after the gutter, ahead of schema order', async () => {
        const { posted } = await renderApp();
        await send(init({ layout: { columnWidths: {}, hiddenColumns: [], pinnedColumns: [2] } }));
        await wait(20);
        const req = [...posted].reverse().find(m => m.type === 'getRows');
        expect(req.columns).toEqual([2, 0, 1]);
    });

    test('the column menu offers Pin column, or Unpin column when pinned', async () => {
        const { ColumnContextMenu } = await import('../../editors/vscode/src/data-viewer/webview/column-context-menu');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        roots.push(root);
        let toggled = 0;
        const render = (pinned: boolean) => act(() => {
            root.render(<ColumnContextMenu leftPx={0} topPx={0} onCopy={() => {}} onClose={() => {}}
                pin={{ pinned, onToggle: () => { toggled++; } }} />);
        });
        render(false);
        const item = () => [...document.querySelectorAll('.context-menu-item')].find(e => /pin column/i.test(e.textContent ?? '')) as HTMLButtonElement;
        expect(item().textContent).toBe('Pin column');
        act(() => { item().click(); });
        expect(toggled).toBe(1);
        render(true);
        expect(item().textContent).toBe('Unpin column');
    });
});

describe('selection summary', () => {
    test('a selection over loaded numeric cells shows count, NA, sum and mean; App does not render on scroll', async () => {
        const { posted, renders } = await renderApp();
        await send(init());
        await wait(20);
        await send(rowsReply(posted));
        key('a', { meta: true });
        const text = document.querySelector('.status-line-selection')?.textContent ?? '';
        // Cmd+A selects every data column over the 100 loaded rows: the
        // numeric columns sum 0..99 (row 1 NA) and 1..100.
        expect(text).toBe('300 cells · 1 NA · Σ 9,999 · mean 50.2462');
        const before = renders();
        await send({ type: 'testScrollToFraction', panelGeneration: 1, fraction: 0.5 });
        await wait(50);
        expect(renders()).toBe(before);
    });
});
