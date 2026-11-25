import { afterEach, describe, expect, test } from 'bun:test';
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
 * What the toolbar and sidebar show, in the rendered App. Cell text is
 * drawn on a canvas that jsdom doesn't lay out, so what a cell shows is
 * covered through `formatCell` (data-viewer-display-format.test.ts) and
 * the host's TSV copy, which the grid shares.
 */

function init(columns: unknown[], over: Record<string, unknown> = {}) {
    return {
        type: 'init' as const,
        panelGeneration: 1,
        nrow: 2,
        columns,
        layout: { columnWidths: {}, hiddenColumns: [] },
        toolbar: { labelsOn: true, formatOn: true, digits: 3 },
        settings: { missingValueStyle: 'foreground' as const, defaultDigits: 3, persistSort: true, persistFilters: true },
        dictionaries: {},
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
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const vscode = { postMessage: (msg: any) => { posted.push(msg); }, setState: () => {} };
    await act(async () => { root.render(<App vscode={vscode} />); });
    return { posted };
}

const float = (name: string, over: Record<string, unknown> = {}) =>
    ({ name, arrowType: 'Float64', dictionaryShipped: false, isInteger: false, ...over });
const formatToggle = () => [...document.querySelectorAll('button.toggle')].find(b => b.textContent === 'Format') as HTMLButtonElement | undefined;
const digits = () => document.querySelector('select.digits') as HTMLSelectElement | null;

describe('the Format toggle and the digits dropdown', () => {
    // `DOLLAR8` on 12.75 shows `$13`: without the toggle there is no way
    // back to the stored value.
    for (const format of ['DOLLAR8', 'DOLLAR8.', 'F8.0', '%9.0f', 'Z3.']) {
        test(`a frame whose only float is formatted ${format} offers Format, not digits`, async () => {
            const { posted } = await renderApp();
            await send(init([float('price', { isInteger: true, format })]));
            expect(formatToggle()?.className).toBe('toggle active');
            expect(digits()).toBeNull();
            act(() => { formatToggle()!.click(); });
            expect(formatToggle()?.className).toBe('toggle');
            // What the host formats copied cells with.
            await wait(400);
            expect(posted.filter(m => m.type === 'saveToolbar').at(-1)?.toolbar.formatOn).toBe(false);
        });
    }

    test('a source format with decimals offers Format without the digits it ignores', async () => {
        await renderApp();
        await send(init([float('pct', { format: 'PERCENT8.2' })]));
        expect(formatToggle()).toBeDefined();
        expect(digits()).toBeNull();
    });

    test('an ordinary float beside it brings the digits dropdown back', async () => {
        await renderApp();
        await send(init([float('price', { isInteger: true, format: 'DOLLAR8' }), float('x')]));
        expect(formatToggle()).toBeDefined();
        expect(digits()?.disabled).toBe(false);
        act(() => { formatToggle()!.click(); });
        expect(digits()?.disabled).toBe(true);
    });

    test('integers, and a float whose format only declares whole numbers, offer neither', async () => {
        await renderApp();
        await send(init([
            { name: 'n', arrowType: 'Int32', dictionaryShipped: false, isInteger: true, format: 'DOLLAR8' },
            float('legacy', { isInteger: true, format: 'FIX8' }),
        ]));
        expect(formatToggle()).toBeUndefined();
        expect(digits()).toBeNull();
    });
});

describe('quartiles in the Columns sidebar', () => {
    const profileOf = (quantiles: { p25: number; p50: number; p75: number; exact: boolean }) => ({
        type: 'profiles', panelGeneration: 1, updates: [[0, {
            state: 'ready', profile: {
                columnIndex: 0, kind: 'numeric', rows: 200_000, na: 0, nan: 0, distinct: { value: 200_000, exact: true },
                min: 0, max: 199_999, mean: 99_999.5, sd: 57_735, quantiles,
                histogram: [{ lo: 0, hi: 199_999, count: 200_000 }],
            },
        }]],
    });

    // The host sends the second profile on its own after a sort; the
    // sidebar stays open and expanded throughout.
    test('a replacement for a profile the webview holds swaps the sampled quartiles for exact ones', async () => {
        const { posted } = await renderApp();
        await send(init([float('x')], { nrow: 200_000 }));
        const btn = document.querySelector('[aria-controls="columns-sidebar"]') as HTMLButtonElement;
        act(() => { btn.click(); });
        await send(profileOf({ p25: 50_021.5, p50: 99_826, p75: 150_021.5, exact: false }));
        const tree = document.querySelector('[role="tree"]') as HTMLElement;
        await act(async () => { tree.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
        await act(async () => { tree.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
        const row = () => document.getElementById('columns-sidebar-row-0')!.textContent ?? '';
        expect(row()).toContain('median≈ 99,826');
        expect(row()).toContain('p25≈ 50,021.5');
        // Holding the profile, the webview asks for nothing more.
        await wait(250);
        expect(posted.filter(m => m.type === 'setProfileInterest').at(-1)?.columns).toEqual([]);

        await send(profileOf({ p25: 49_999.75, p50: 99_999.5, p75: 149_999.25, exact: true }));
        expect(row()).toContain('median99,999.5');
        expect(row()).toContain('p2549,999.75');
        expect(row()).not.toContain('≈');
    });
});
