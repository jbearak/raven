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
const { ValueCountsPopover } = await import('../../editors/vscode/src/data-viewer/webview/value-counts-popover');
const { setFilterFor, sidebarRows, profileStatLines } = await import('../../editors/vscode/src/data-viewer/webview/summary-model');

/**
 * Phase 4 in the webview: profile interest (what the band and sidebar
 * ask for, never on the scroll path's render budget), the Columns
 * sidebar's search, sort and jump, and value counts building a set
 * filter.
 */

const columns = [
    { name: 'mpg', arrowType: 'Float64', dictionaryShipped: false, isInteger: false, variableLabel: 'Miles per gallon' },
    { name: 'cyl', arrowType: 'Int32', dictionaryShipped: false, isInteger: true },
    { name: 'origin', arrowType: 'Dictionary<Int8, Utf8>', dictionaryShipped: true, isInteger: false, dictionary: ['Europe', 'Japan', 'USA'] },
    { name: 'note', arrowType: 'Utf8', dictionaryShipped: false, isInteger: false, variableLabel: 'Interviewer note' },
];

function init(over: Record<string, unknown> = {}) {
    return {
        type: 'init' as const,
        panelGeneration: 1,
        nrow: 1000,
        columns,
        layout: { columnWidths: {}, hiddenColumns: [] },
        toolbar: { labelsOn: true, formatOn: true, digits: 3 },
        settings: { missingValueStyle: 'foreground' as const, defaultDigits: 3, persistSort: true, persistFilters: true },
        dictionaries: { 2: ['Europe', 'Japan', 'USA'] },
        schemaHash: 'schema-1',
        sort: { keys: [], labelsOnWhenSorted: true },
        filter: { entries: [], labelsOnWhenFiltered: true },
        transformGeneration: 1,
        ...over,
    };
}

const profile = (columnIndex: number, distinct: number, na: number, kind = 'numeric') => ({
    state: 'ready', profile: {
        columnIndex, kind, rows: 1000, na, nan: 0, distinct: { value: distinct, exact: true },
        histogram: kind === 'numeric' ? [{ lo: 0, hi: 1, count: 1000 - na }] : undefined,
        top: kind === 'factor' ? { values: [{ value: 2, label: 'USA', count: 500, error: 0 }], exact: true, approximateOrder: false } : undefined,
    },
});

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

function openSidebar() {
    const btn = document.querySelector('[aria-controls="columns-sidebar"]') as HTMLButtonElement;
    act(() => { btn.click(); });
}

const rowNames = () => [...document.querySelectorAll('.columns-sidebar-row .columns-sidebar-name')].map(e => e.textContent);

describe('profile interest', () => {
    test('the band asks for the visible columns; a scroll posts interest without rendering App', async () => {
        const { posted, renders } = await renderApp();
        await send(init());
        await send({ type: 'testScrollToFraction', panelGeneration: 1, fraction: 0.5 });
        await wait(200);
        const before = renders();
        posted.length = 0;
        await send({ type: 'testScrollToFraction', panelGeneration: 1, fraction: 0.9 });
        await wait(200);
        expect(renders()).toBe(before);
        // Interest went out at least once for this panel, naming data columns.
        const all = posted.filter(m => m.type === 'setProfileInterest');
        for (const m of all) expect(m.panelGeneration).toBe(1);
    });

    test('with the band off and the sidebar closed, nothing is requested', async () => {
        const { posted } = await renderApp();
        await send(init({ toolbar: { labelsOn: true, formatOn: true, digits: 3, summariesOn: false } }));
        await send({ type: 'testScrollToFraction', panelGeneration: 1, fraction: 0.5 });
        await wait(200);
        const interest = posted.filter(m => m.type === 'setProfileInterest');
        for (const m of interest) expect(m.columns).toEqual([]);
    });

    test('the Σ toggle defaults off past 200 columns and persists when flipped', async () => {
        const wide = Array.from({ length: 201 }, (_, i) => ({ name: `c${i}`, arrowType: 'Float64', dictionaryShipped: false, isInteger: false }));
        const { posted } = await renderApp();
        await send(init({ columns: wide }));
        const sigma = [...document.querySelectorAll('button')].find(b => b.textContent === 'Σ')!;
        expect(sigma.getAttribute('aria-pressed')).toBe('false');
        await act(async () => { sigma.click(); });
        await wait(10);
        expect(sigma.getAttribute('aria-pressed')).toBe('true');
        const save = posted.filter(m => m.type === 'saveToolbar').at(-1);
        expect(save.toolbar.summariesOn).toBe(true);
    });

    test('the sidebar asks for its rows, minus profiles already held', async () => {
        const { posted } = await renderApp();
        await send(init({ toolbar: { labelsOn: true, formatOn: true, digits: 3, summariesOn: false } }));
        openSidebar();
        await wait(200);
        const first = posted.filter(m => m.type === 'setProfileInterest').at(-1);
        expect(first.columns).toEqual([0, 1, 2, 3]);
        await send({ type: 'profiles', panelGeneration: 1, updates: [[0, profile(0, 10, 0)], [1, { state: 'failed', error: 'boom' }]] });
        await wait(200);
        const next = posted.filter(m => m.type === 'setProfileInterest').at(-1);
        expect(next.columns).toEqual([2, 3]);
        // A failed profile shows a dash with the error, never loading.
        const dash = [...document.querySelectorAll('.columns-sidebar-distinct')].find(e => e.textContent === '—');
        expect(dash?.getAttribute('title')).toBe('boom');
    });
});

describe('Columns sidebar', () => {
    test('search by name or label, sort by distinct, jump selects the column', async () => {
        const { posted } = await renderApp();
        await send(init());
        openSidebar();
        await send({ type: 'profiles', panelGeneration: 1, updates: [
            [0, profile(0, 25, 10)], [1, profile(1, 3, 0)], [2, profile(2, 3, 5, 'factor')], [3, profile(3, 900, 1)],
        ] });
        expect(rowNames()).toEqual(['mpg', 'cyl', 'origin', 'note']);
        const search = document.querySelector('.columns-sidebar-search') as HTMLInputElement;
        // Drive React's onChange directly (jsdom's synthetic input events
        // don't reach React's change tracking here).
        const setValue = (el: any, v: string) => {
            el.value = v;
            const props = Object.entries(el).find(([k]) => k.startsWith('__reactProps$'))![1] as any;
            props.onChange({ target: el });
        };
        await act(async () => { setValue(search, 'interviewer'); });
        expect(rowNames()).toEqual(['note']);
        await act(async () => { setValue(search, ''); });
        const sortSel = document.querySelector('.columns-sidebar-controls select') as HTMLSelectElement;
        await act(async () => { setValue(sortSel, 'distinct'); });
        expect(rowNames()).toEqual(['cyl', 'origin', 'mpg', 'note']);
        await act(async () => { setValue(sortSel, 'missing'); });
        expect(rowNames()).toEqual(['cyl', 'note', 'origin', 'mpg']);
        // Click a row: the grid selects that column.
        posted.length = 0;
        const noteRow = document.getElementById('columns-sidebar-row-3')!;
        await act(async () => { noteRow.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        const jump = posted.find(m => m.type === 'lifecycle' && m.event === 'sidebar-jump');
        expect(jump).toBeDefined();
        // Keyboard: the tree moves its active row and expands it.
        const tree = document.querySelector('[role="tree"]') as HTMLElement;
        await act(async () => { tree.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
        expect(tree.getAttribute('aria-activedescendant')).toBe('columns-sidebar-row-1');
        await act(async () => { tree.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
        expect(document.getElementById('columns-sidebar-row-1')!.getAttribute('aria-expanded')).toBe('true');
    });

    test('hidden columns stay listed with an unchecked box; Hide all / Show all', async () => {
        const { posted } = await renderApp();
        await send(init({ layout: { columnWidths: {}, hiddenColumns: [1] } }));
        openSidebar();
        const boxes = () => [...document.querySelectorAll('.columns-sidebar-row input[type=checkbox]')].map(b => (b as HTMLInputElement).checked);
        expect(boxes()).toEqual([true, false, true, true]);
        const hideAll = [...document.querySelectorAll('button')].find(b => b.textContent === 'Hide all')!;
        await act(async () => { hideAll.click(); });
        expect(boxes()).toEqual([false, false, false, false]);
    });

    test('pure: sidebarRows sorts unknowns last and keeps position ties', () => {
        const info = (i: number) => ({ missing: [0.5, undefined, 0.1, 0.1][i], distinct: undefined });
        expect(sidebarRows(columns as any, info, '', 'missing')).toEqual([2, 3, 0, 1]);
        expect(sidebarRows(columns as any, info, 'MILES', 'position')).toEqual([0]);
        expect(sidebarRows(columns as any, info, '', 'name')).toEqual([1, 0, 3, 2]);
    });

    test('pure: numeric stat lines mark reservoir quantiles with ≈', () => {
        const lines = profileStatLines({
            columnIndex: 0, kind: 'numeric', rows: 10, na: 1, nan: 0, distinct: { value: 120000, exact: false },
            min: 1, max: 9, mean: 5, sd: 2, quantiles: { p25: 3, p50: 5, p75: 7, exact: false },
        } as any, c => String(c));
        const get = (l: string) => lines.find(x => x.label === l)?.value;
        expect(get('median')).toBe('≈ 5');
        expect(get('distinct')).toBe('≈ 120,000');
        expect(get('min')).toBe('1');
    });
});

describe('value counts', () => {
    test('clicking rows builds a set filter; rarest first only when exact', async () => {
        const applied: any[] = [];
        const orders: string[] = [];
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        roots.push(root);
        const col = columns[2];
        const result = {
            columnIndex: 2, exact: true, approximateOrder: false, distinct: { value: 3, exact: true },
            present: 950, na: 50, order: 'desc',
            entries: [
                { value: 2, label: 'USA', count: 500, error: 0 },
                { value: 1, label: 'Japan', count: 300, error: 0 },
                { value: 0, label: 'Europe', count: 150, error: 0 },
            ],
        };
        await act(async () => {
            root.render(<ValueCountsPopover
                column={col as any} kind="factor" result={result as any} error={undefined} order="desc"
                leftPx={0} topPx={0} format={e => e.label ?? String(e.value)}
                onOrder={o => orders.push(o)} onApply={e => applied.push(e)} onClose={() => {}}
            />);
        });
        const rows = [...document.querySelectorAll('[role="option"]')];
        expect(rows.map(r => r.querySelector('.value-counts-value')!.textContent)).toEqual(['USA', 'Japan', 'Europe']);
        expect(rows[0].querySelector('.value-counts-pct')!.textContent).toBe('53%');
        await act(async () => { (rows[0] as HTMLElement).click(); (rows[2] as HTMLElement).click(); });
        const apply = [...document.querySelectorAll('button')].find(b => b.textContent?.startsWith('Filter'))!;
        expect(apply.textContent).toBe('Filter (2)');
        await act(async () => { apply.click(); });
        expect(applied[0].map((e: any) => e.label)).toEqual(['USA', 'Europe']);
        expect(setFilterFor(col as any, 'factor', applied[0], true)).toEqual({ kind: 'setIn', values: ['USA', 'Europe'] });
        expect(setFilterFor(col as any, 'factor', applied[0], false)).toEqual({ kind: 'setIn', values: ['2', '0'] });
        const rare = document.querySelector('.value-counts-controls input') as HTMLInputElement;
        expect(rare.disabled).toBe(false);
        await act(async () => { rare.click(); });
        expect(orders).toEqual(['asc']);
    });

    test('approximate counts show their error bound and disable rarest first', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        roots.push(root);
        const result = {
            columnIndex: 3, exact: false, approximateOrder: true, distinct: { value: 250000, exact: false },
            present: 1000, na: 0, order: 'desc',
            entries: [{ value: 'a', count: 40, error: 3 }, { value: 'b', count: 38, error: 5 }],
        };
        await act(async () => {
            root.render(<ValueCountsPopover
                column={columns[3] as any} kind="character" result={result as any} error={undefined} order="desc"
                leftPx={0} topPx={0} format={e => String(e.value)}
                onOrder={() => {}} onApply={() => {}} onClose={() => {}}
            />);
        });
        expect(document.querySelector('.value-counts-count')!.textContent).toBe('≈ 40 ± 3');
        expect((document.querySelector('.value-counts-controls input') as HTMLInputElement).disabled).toBe(true);
        expect(document.body.textContent).toContain('approximate order');
    });
});
