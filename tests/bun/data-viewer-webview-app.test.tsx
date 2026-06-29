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

describe('data viewer App copy status', () => {
    function dispatchKey(key: string) {
        window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key,
            ctrlKey: true,
            bubbles: true,
        }));
    }

    test('a replace that supersedes an in-flight copy clears the Copying toast', async () => {
        await renderApp();

        // Select all + copy → the host is sent a `copy` request and the toast
        // shows "Copying..." while the host reads rows.
        await act(async () => { dispatchKey('a'); });
        await act(async () => { dispatchKey('c'); });
        expect(document.body.textContent).toContain('Copying...');

        // The host bumps the generation (e.g. View() re-run) and replaces the
        // data before the copy finishes. The stale `copyDone` it posts carries
        // the old generation and is dropped by the webview's generation guard,
        // so the replace itself must clear the stuck "Copying..." toast.
        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', {
                data: { ...initMessage(), type: 'replace', panelGeneration: 2 },
            }));
        });
        expect(document.body.textContent).not.toContain('Copying...');
    });

    test('a stale copy-complete timer does not blank a newer copy in-flight toast', async () => {
        await renderApp();

        // Fake timers from here so the 2.5s clear timer armed by copyDone can be
        // advanced synchronously rather than slept on.
        jest.useFakeTimers();
        try {
            // Copy A completes in gen 1 → "Copied" toast plus a 2.5s clear timer.
            await act(async () => {
                window.dispatchEvent(new MessageEvent('message', {
                    data: { type: 'copyDone', panelGeneration: 1, requestId: 0, ok: true },
                }));
            });
            expect(document.body.textContent).toContain('Copied');

            // A replace bumps the generation, then a fresh copy B starts in gen 2.
            await act(async () => {
                window.dispatchEvent(new MessageEvent('message', {
                    data: { ...initMessage(), type: 'replace', panelGeneration: 2 },
                }));
            });
            await act(async () => { dispatchKey('a'); });
            await act(async () => { dispatchKey('c'); });
            expect(document.body.textContent).toContain('Copying...');

            // Copy A's stale 2.5s clear timer must have been cancelled; if it
            // fires it would blank copy B's still-in-flight "Copying..." toast.
            await act(async () => { jest.advanceTimersByTime(2600); });
            expect(document.body.textContent).toContain('Copying...');
        } finally {
            jest.useRealTimers();
        }
    });

    test('a pending copy-clear timer does not blank a later error toast', async () => {
        await renderApp();

        jest.useFakeTimers();
        try {
            // A successful copy arms the 2.5s clear timer.
            await act(async () => {
                window.dispatchEvent(new MessageEvent('message', {
                    data: { type: 'copyDone', panelGeneration: 1, requestId: 0, ok: true },
                }));
            });
            // Within that window a host error reuses the shared toast slot.
            await act(async () => {
                window.dispatchEvent(new MessageEvent('message', {
                    data: { type: 'error', message: 'Boom' },
                }));
            });
            expect(document.body.textContent).toContain('Boom');

            // The copy's stale clear timer must not fire and blank the error.
            await act(async () => { jest.advanceTimersByTime(2600); });
            expect(document.body.textContent).toContain('Boom');
        } finally {
            jest.useRealTimers();
        }
    });

    test('a same-shape replace does not wipe a freshly-shown error toast', async () => {
        await renderApp();

        // A host error shows in the shared toast slot.
        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'error', message: 'Boom' },
            }));
        });
        expect(document.body.textContent).toContain('Boom');

        // A replace that is not superseding an in-flight copy must leave the
        // error toast in place (only an orphaned "Copying..." is cleared).
        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', {
                data: { ...initMessage(), type: 'replace', panelGeneration: 2 },
            }));
        });
        expect(document.body.textContent).toContain('Boom');
    });
});

describe('data viewer App restore banner debounce', () => {
    function restorePendingMessage(restoreId: number) {
        return {
            type: 'restorePending' as const,
            panelGeneration: 1,
            restoreId,
            sort: true,
            filter: true,
        };
    }

    test('shows the restore banner after the debounce, then clears it on completion', async () => {
        await renderApp();

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: restorePendingMessage(1) }));
        });
        // Debounced: nothing is shown immediately.
        expect(document.body.textContent).not.toContain('Skip and show data now');

        await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
        expect(document.body.textContent).toContain('Skip and show data now');

        // The restore completing (replace) clears the banner.
        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: { ...initMessage(), type: 'replace' } }));
        });
        expect(document.body.textContent).not.toContain('Skip and show data now');
    });

    test('a restore completing before the debounce never flashes a stale banner', async () => {
        await renderApp();

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: restorePendingMessage(1) }));
        });
        // Completes immediately, before the 200ms debounce elapses.
        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: { ...initMessage(), type: 'replace' } }));
        });
        // Even after the debounce window passes, the superseded timer must not
        // surface the banner (clearTimeout plus the restoreId staleness guard).
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
        expect(document.body.textContent).not.toContain('Skip and show data now');
    });
});
