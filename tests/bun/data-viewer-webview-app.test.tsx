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

const column = {
    name: 'x',
    arrowType: 'Int32',
    dictionaryShipped: false,
    isInteger: true,
};

const activeFilter = {
    entries: [{
        id: 'e1',
        columnIndex: 0,
        predicate: { kind: 'numCompare' as const, op: '>' as const, value: 2 },
        enabled: true,
        includeMissing: false,
    }],
    labelsOnWhenFiltered: true,
};

const emptyFilter = {
    entries: [],
    labelsOnWhenFiltered: true,
};

let roots: Root[] = [];

afterEach(() => {
    for (const root of roots) {
        act(() => root.unmount());
    }
    roots = [];
    document.body.innerHTML = '';
});

function initMessage() {
    return {
        type: 'init' as const,
        panelGeneration: 1,
        nrow: 5,
        columns: [column],
        layout: { columnWidths: {}, hiddenColumns: [] },
        toolbar: { labelsOn: true, formatOn: true, digits: 3 },
        settings: { missingValueStyle: 'foreground' as const, defaultDigits: 3, persistSort: true, persistFilters: true },
        dictionaries: {},
        schemaHash: 'schema-1',
        sort: { keys: [], labelsOnWhenSorted: true },
        filter: activeFilter,
    };
}

async function renderApp() {
    const posted: any[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const vscode = {
        postMessage: (msg: any) => { posted.push(msg); },
        setState: () => undefined,
    };

    await act(async () => {
        root.render(<App vscode={vscode} />);
    });
    await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data: initMessage() }));
    });
    posted.length = 0;
    return { posted };
}

async function clickClearAllFilters() {
    const clear = document.querySelector<HTMLButtonElement>('button[aria-label="Clear all filters"]');
    expect(clear).not.toBeNull();
    await act(async () => {
        clear!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

describe('data viewer App filter persistence', () => {
    test('does not save a rollback filterApplied response', async () => {
        const { posted } = await renderApp();

        await clickClearAllFilters();
        const request = posted.find(m => m.type === 'setFilters');
        expect(request).toBeDefined();
        posted.length = 0;

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'filterApplied',
                    panelGeneration: 1,
                    requestId: request.requestId,
                    filter: activeFilter,
                    nrowFiltered: 3,
                    fromPersistence: false,
                    rollback: true,
                    error: 'filter failed',
                },
            }));
        });
        await new Promise(resolve => setTimeout(resolve, 350));

        expect(posted.filter(m => m.type === 'saveFilter')).toEqual([]);
    });

    test('saves a successful user filterApplied response immediately', async () => {
        const { posted } = await renderApp();

        await clickClearAllFilters();
        const request = posted.find(m => m.type === 'setFilters');
        expect(request).toBeDefined();
        posted.length = 0;

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'filterApplied',
                    panelGeneration: 1,
                    requestId: request.requestId,
                    filter: emptyFilter,
                    nrowFiltered: 5,
                    fromPersistence: false,
                },
            }));
        });

        expect(posted.filter(m => m.type === 'saveFilter')).toEqual([{
            type: 'saveFilter',
            panelGeneration: 1,
            schemaHash: 'schema-1',
            filter: emptyFilter,
        }]);
    });
});
