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

const { FilterPopover } = await import('../../editors/vscode/src/data-viewer/webview/filter-popover');
const { ValueCountsPopover, formatEntry } = await import('../../editors/vscode/src/data-viewer/webview/value-counts-popover');
const { entryCell, setFilterFor } = await import('../../editors/vscode/src/data-viewer/webview/summary-model');
const { formatCell } = await import('../../editors/vscode/src/data-viewer/display-format');

/**
 * integer64 past 2^53 in the rendered filter popover and Value counts
 * popover: the bound that was typed is the bound that is applied, and a
 * counted ID shows its exact digits.
 */

let roots: Root[] = [];
afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    roots = [];
    document.body.innerHTML = '';
});

function mount(node: React.ReactElement): void {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => { root.render(node); });
}
const reactProps = (el: Element): any => Object.entries(el).find(([k]) => k.startsWith('__reactProps$'))![1];
const id = { name: 'id', arrowType: 'Int64', dictionaryShipped: false, isInteger: true, typeTag: '<int64>' } as any;

describe('a bound typed in the filter popover on an integer64 column', () => {
    const numberInput = () => document.querySelector('input.filter-popover-input[type="number"]') as HTMLInputElement;
    const apply = () => [...document.querySelectorAll('.filter-popover-footer button')].find(b => b.textContent === 'Apply') as HTMLButtonElement;

    test('a fraction past 2^53 is applied as typed, not as the double it rounds to', () => {
        const applied: any[] = [];
        mount(<FilterPopover column={id} columnIndex={0} anchor={{ leftPx: 0, topPx: 0 }}
            initial={{ id: 'f', columnIndex: 0, predicate: { kind: 'numCompare', op: '<', value: 3 }, enabled: true, includeMissing: false }}
            onApply={e => { applied.push(e); }} onCancel={() => {}} />);
        const input = numberInput();
        // The number input keeps the typed spelling (jsdom sanitizes its
        // value as the HTML standard says; so does Chromium).
        input.value = '9007199254740992.5';
        expect(input.value).toBe('9007199254740992.5');
        act(() => { reactProps(input).onChange({ target: input }); });
        act(() => { apply().click(); });
        expect(applied.at(-1).predicate).toEqual({ kind: 'numCompare', op: '<', value: '9007199254740992.5' });
    });

    test('reopened, the popover shows the typed text and re-applies it unchanged', () => {
        const applied: any[] = [];
        for (const typed of ['9007199254740992.5', '9.007199254740993e15', '9007199254740993']) {
            const predicate = { kind: 'numCompare' as const, op: '>=' as const, value: typed };
            mount(<FilterPopover column={id} columnIndex={0} anchor={{ leftPx: 0, topPx: 0 }}
                initial={{ id: 'f', columnIndex: 0, predicate, enabled: true, includeMissing: false }}
                onApply={e => { applied.push(e); }} onCancel={() => {}} />);
            expect(numberInput().value).toBe(typed);
            act(() => { apply().click(); });
            expect(applied.at(-1).predicate).toEqual(predicate);
            for (const root of roots) act(() => root.unmount());
            roots = [];
            document.body.innerHTML = '';
        }
    });

    test('on a double column the same text is still a double', () => {
        const applied: any[] = [];
        mount(<FilterPopover column={{ ...id, arrowType: 'Float64', isInteger: false }} columnIndex={0} anchor={{ leftPx: 0, topPx: 0 }}
            initial={{ id: 'f', columnIndex: 0, predicate: { kind: 'numCompare', op: '<', value: 3 }, enabled: true, includeMissing: false }}
            onApply={e => { applied.push(e); }} onCancel={() => {}} />);
        const input = numberInput();
        input.value = '2.5';
        act(() => { reactProps(input).onChange({ target: input }); });
        act(() => { apply().click(); });
        expect(applied.at(-1).predicate).toEqual({ kind: 'numCompare', op: '<', value: 2.5 });
    });
});

describe('Value counts on an integer64 column past the cap', () => {
    // What the scan worker sends past 100,000 distinct values: each ID by
    // its exact digits, with the bounds of its own count.
    const result = {
        columnIndex: 0, exact: false, approximateOrder: true, distinct: { value: 200_488, exact: false },
        present: 212_000, na: 0, order: 'desc',
        entries: [
            { value: '4611686018427387905', count: 6001, error: 0 },
            { value: '4611686018427387906', count: 6001, error: 2 },
            { value: 7, count: 3, error: 2 },
        ],
    };

    test('neighbouring IDs are listed apart with their own counts, and a pick filters on the exact ID', () => {
        const applied: any[] = [];
        const fmt = (e: any) => formatEntry(e, 'numeric', true,
            cell => formatCell(cell, id, undefined, { labelsOn: true, formatOn: true, digits: 3 }).text,
            v => entryCell(id, 'numeric', v));
        mount(<ValueCountsPopover column={id} kind="numeric" result={result as any} error={undefined} order="desc"
            leftPx={0} topPx={0} format={fmt} onOrder={() => {}} onApply={e => applied.push(e)} onClose={() => {}} />);
        const rows = [...document.querySelectorAll('[role="option"]')];
        expect(rows.map(r => r.querySelector('.value-counts-value')!.textContent))
            .toEqual(['4611686018427387905', '4611686018427387906', '7']);
        expect(rows.map(r => r.querySelector('.value-counts-count')!.textContent))
            .toEqual(['6,001', '≈ 6,001 ± 2', '≈ 3 ± 2']);
        expect(document.body.textContent).toContain('counts ≈');
        act(() => { (rows[1] as HTMLElement).click(); });
        const filter = [...document.querySelectorAll('button')].find(b => b.textContent?.startsWith('Filter'))!;
        act(() => { filter.click(); });
        expect(setFilterFor(id, 'numeric', applied[0], true)).toEqual({ kind: 'setIn', values: ['4611686018427387906'] });
    });
});
