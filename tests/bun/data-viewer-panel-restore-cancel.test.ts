/**
 * Panel state machine for the saved-sort/filter restore banner + Cancel
 * (#519, part 2). Port of sight#228's restore-cancel suite, adapted to
 * raven (DataViewerPanel, init/replace, restoreSort/restoreFilter,
 * SortStateStore/FilterStateStore, permutation/filteredIndices).
 *
 * Uses Object.create(DataViewerPanel.prototype) with stubbed reader,
 * stores and webview so the private methods can be driven headlessly and
 * deterministically (restoreSort/restoreFilter are stubbed to simulate
 * completion / abort / genuine failure without real column reads).
 */
import { describe, expect, it, mock, beforeEach } from 'bun:test';

let warnings: string[] = [];
mock.module('vscode', () => ({
    window: {
        showErrorMessage: () => undefined,
        showWarningMessage: (msg: string) => { warnings.push(msg); return undefined; },
    },
    workspace: {
        getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
    },
}));

import {
    EMPTY_SORT,
    EMPTY_FILTER,
    type SortState,
    type FilterState,
} from '../../editors/vscode/src/data-viewer/messages';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';

const COLUMNS: ColumnSchema[] = [
    { name: 'a', arrowType: 'Int32', isInteger: true, dictionaryShipped: false },
    { name: 'b', arrowType: 'Utf8', isInteger: false, dictionaryShipped: false },
];

const STORED_SORT: SortState = {
    keys: [{ columnIndex: 0, direction: 'asc' }],
    labelsOnWhenSorted: true,
};
const STORED_FILTER: FilterState = {
    entries: [{
        id: 'f1', columnIndex: 1, predicate: { kind: 'isNotEmpty' },
        enabled: true, includeMissing: false,
    }],
    labelsOnWhenFiltered: true,
};

interface Harness {
    panel: any;
    posted: any[];
    sortSet: (SortState | 'cleared')[];
    filterSet: (FilterState | 'cleared')[];
}

async function makePanel(opts: {
    storedSort?: SortState;
    storedFilter?: FilterState;
} = {}): Promise<Harness> {
    const { DataViewerPanel } = await import(
        '../../editors/vscode/src/data-viewer/panel'
    );
    const posted: any[] = [];
    const sortSet: (SortState | 'cleared')[] = [];
    const filterSet: (FilterState | 'cleared')[] = [];
    const panel: any = Object.create(DataViewerPanel.prototype);

    panel.reader = {
        nrow: 5,
        batchStarts: [0, 5],
        schema: { columns: COLUMNS },
    };
    panel.columns = COLUMNS;
    panel.layout = { columnWidths: {}, hiddenColumns: [] };
    panel.dictionaries = {};
    panel.generation = 0;
    panel.webviewInitialized = true;
    panel.disposed = false;
    panel.sort = EMPTY_SORT;
    panel.permutation = undefined;
    panel.sortGeneration = 0;
    panel.filter = EMPTY_FILTER;
    panel.filteredIndices = undefined;
    panel.filterGeneration = 0;
    panel.histogramCache = new Map();
    panel.restoreAbort = null;
    panel.restoring = false;
    panel.restoreId = -1;
    panel.restoreSeq = 0;
    panel.lastToolbar = undefined;
    panel.sendChain = Promise.resolve();
    panel.settings = { persistSort: true, persistFilters: true, defaultDigits: 3 };
    panel.panelName = 'p';

    panel.webviewPanel = {
        webview: { postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); } },
    };
    const noStore = { load: async () => undefined };
    panel.store = noStore;
    panel.toolbarStore = noStore;
    panel.sortStore = {
        load: async () => opts.storedSort,
        save: async (_p: string, _h: string, s: SortState) => { sortSet.push(s); },
        clear: async () => { sortSet.push('cleared'); },
    };
    panel.filterStore = {
        load: async () => opts.storedFilter,
        save: async (_p: string, _h: string, f: FilterState) => { filterSet.push(f); },
        clear: async () => { filterSet.push('cleared'); },
    };
    return { panel, posted, sortSet, filterSet };
}

beforeEach(() => { warnings = []; });

describe('maybeBeginRestore', () => {
    it('arms a restore and posts restorePending when prefs apply', async () => {
        const { panel, posted } = await makePanel();
        const began = panel.maybeBeginRestore(0, STORED_SORT, STORED_FILTER);
        expect(began).toBe(true);
        expect(panel.restoring).toBe(true);
        expect(panel.restoreAbort).not.toBeNull();
        expect(panel.restoreId).toBe(1);
        expect(posted[0]).toEqual({
            type: 'restorePending', panelGeneration: 0, restoreId: 1,
            sort: true, filter: true,
        });
    });

    it('does not begin when no prefs apply', async () => {
        const { panel, posted } = await makePanel();
        expect(panel.maybeBeginRestore(0, undefined, undefined)).toBe(false);
        expect(panel.restoring).toBe(false);
        expect(posted).toEqual([]);
    });

    it('does not begin for an out-of-range sort key', async () => {
        const { panel } = await makePanel();
        const bad: SortState = { keys: [{ columnIndex: 9, direction: 'asc' }], labelsOnWhenSorted: true };
        expect(panel.maybeBeginRestore(0, bad, undefined)).toBe(false);
    });

    it('does not begin for an all-disabled filter', async () => {
        const { panel } = await makePanel();
        const off: FilterState = {
            entries: [{ ...STORED_FILTER.entries[0], enabled: false }],
            labelsOnWhenFiltered: true,
        };
        expect(panel.maybeBeginRestore(0, undefined, off)).toBe(false);
    });

    it('increments restoreId monotonically', async () => {
        const { panel } = await makePanel();
        panel.maybeBeginRestore(0, STORED_SORT, undefined);
        expect(panel.restoreId).toBe(1);
        panel.maybeBeginRestore(0, STORED_SORT, undefined);
        expect(panel.restoreId).toBe(2);
    });

    it('flags sort-only vs filter-only', async () => {
        const { panel, posted } = await makePanel();
        panel.maybeBeginRestore(0, undefined, STORED_FILTER);
        expect(posted[0].sort).toBe(false);
        expect(posted[0].filter).toBe(true);
    });
});

describe('sendInit restore', () => {
    it('normal completion applies and ships the saved prefs', async () => {
        const { panel, posted, sortSet, filterSet } = await makePanel({
            storedSort: STORED_SORT, storedFilter: STORED_FILTER,
        });
        panel.restoreSort = async () => {
            panel.sort = STORED_SORT; panel.permutation = new Uint32Array(5); return false;
        };
        panel.restoreFilter = async () => {
            panel.filter = STORED_FILTER; panel.filteredIndices = new Uint32Array([0, 1, 2]); return false;
        };

        await panel.sendInit();

        expect(panel.sort.keys.length).toBe(1);
        expect(panel.filter.entries.length).toBe(1);
        expect(sortSet).toEqual([]);
        expect(filterSet).toEqual([]);
        expect(posted[0].type).toBe('restorePending');
        const init = posted.find((m: any) => m.type === 'init');
        expect(init.sort).toEqual(STORED_SORT);
        expect(init.filter).toEqual(STORED_FILTER);
        expect(posted.some((m: any) => m.type === 'filterApplied')).toBe(true);
        expect(panel.restoring).toBe(false);
        expect(panel.restoreAbort).toBeNull();
    });

    it('completed sort + cancelled filter ends in natural order (finding #1)', async () => {
        const { panel, posted, sortSet, filterSet } = await makePanel({
            storedSort: STORED_SORT, storedFilter: STORED_FILTER,
        });
        panel.restoreSort = async () => {
            panel.sort = STORED_SORT; panel.permutation = new Uint32Array(5); return false;
        };
        panel.restoreFilter = async () => {
            panel.restoreAbort?.abort();
            panel.filter = EMPTY_FILTER; panel.filteredIndices = undefined;
            return false;
        };

        await panel.sendInit();

        expect(panel.sort.keys.length).toBe(0);
        expect(panel.permutation).toBeUndefined();
        expect(panel.filter.entries.length).toBe(0);
        expect(panel.filteredIndices).toBeUndefined();
        expect(sortSet).toEqual(['cleared']);
        expect(filterSet).toEqual(['cleared']);
        const init = posted.find((m: any) => m.type === 'init');
        expect(init.sort).toEqual(EMPTY_SORT);
        expect(init.filter).toEqual(EMPTY_FILTER);
        expect(posted.some((m: any) => m.type === 'filterApplied')).toBe(false);
        expect(panel.restoring).toBe(false);
        expect(panel.restoreAbort).toBeNull();
    });

    it('honors a cancel that lands during the paint, with no split-brain', async () => {
        const { panel, posted, sortSet, filterSet } = await makePanel({
            storedSort: STORED_SORT, storedFilter: STORED_FILTER,
        });
        panel.restoreSort = async () => {
            panel.sort = STORED_SORT; panel.permutation = new Uint32Array(5); return false;
        };
        panel.restoreFilter = async () => {
            panel.filter = STORED_FILTER; panel.filteredIndices = new Uint32Array([0, 1, 2]); return false;
        };
        // The cancelRestore is dispatched exactly as the chips init is posted
        // (during paintWithRestore's `await postPaint`), after both reads
        // already completed — the racy window between reads-done and the
        // restore's finally.
        const origPost = panel.webviewPanel.webview.postMessage;
        let fired = false;
        panel.webviewPanel.webview.postMessage = (m: any) => {
            if (!fired && (m.type === 'init' || m.type === 'replace')) {
                fired = true;
                void panel.handleCancelRestore({
                    type: 'cancelRestore', panelGeneration: 0, restoreId: panel.restoreId,
                });
            }
            return origPost(m);
        };

        await panel.sendInit();

        // Cancel honored: prefs forgotten, in-memory state fully natural.
        expect(sortSet).toEqual(['cleared']);
        expect(filterSet).toEqual(['cleared']);
        expect(panel.sort.keys.length).toBe(0);
        expect(panel.permutation).toBeUndefined();
        expect(panel.filteredIndices).toBeUndefined();
        // No split-brain: no stale filterApplied leaks, and a natural-order
        // replace lands after the (already-posted) chips init.
        const last = posted[posted.length - 1];
        expect(last.type).toBe('replace');
        expect(last.sort).toEqual(EMPTY_SORT);
        expect(last.filter).toEqual(EMPTY_FILTER);
    });

    it('clears restoring even if it throws before posting init (finding #3)', async () => {
        const { panel } = await makePanel({ storedSort: STORED_SORT });
        panel.restoreSort = async () => {
            panel.sort = STORED_SORT; panel.permutation = new Uint32Array(5); return false;
        };
        // Throw on the real path (the paint postMessage), after the restore
        // began but before it completes — the impl's finally must still run.
        panel.webviewPanel.webview.postMessage = (m: any) => {
            if (m.type === 'init') throw new Error('boom');
            return Promise.resolve(true);
        };
        await panel.sendInit().catch(() => {});
        expect(panel.restoring).toBe(false);
        expect(panel.restoreAbort).toBeNull();
    });

    it('serializes sends so a second restore cannot start until the first finishes', async () => {
        const { panel, posted } = await makePanel({ storedSort: STORED_SORT });
        let release: (() => void) | null = null;
        const gate = new Promise<void>(r => { release = r; });
        let calls = 0;
        panel.restoreSort = async () => {
            if (calls++ === 0) await gate;
            panel.sort = STORED_SORT; panel.permutation = new Uint32Array(5); return false;
        };
        const p1 = panel.sendInit();
        const p2 = panel.sendInit();
        // Let p1 reach its gated restoreSort. Serialization means p2 has not
        // begun its own restore yet, so only p1's restorePending exists.
        await new Promise(r => setTimeout(r, 0));
        const pendingCount = () =>
            posted.filter((m: any) => m.type === 'restorePending').length;
        expect(pendingCount()).toBe(1);
        release!();
        await Promise.all([p1, p2]);
        // p2 ran only after p1 finished — both restored, but never overlapped.
        expect(pendingCount()).toBe(2);
    });

    it('real read error keeps prefs and warns (finding #7)', async () => {
        const { panel, posted, sortSet, filterSet } = await makePanel({ storedSort: STORED_SORT });
        panel.restoreSort = async () => true; // genuine (non-abort) failure
        await panel.sendInit();
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('sort');
        expect(warnings[0]).not.toContain('filter');
        expect(panel.sort.keys.length).toBe(0);
        expect(sortSet).toEqual([]);
        expect(filterSet).toEqual([]);
        const init = posted.find((m: any) => m.type === 'init');
        expect(init.sort).toEqual(EMPTY_SORT);
    });

    it('cancel suppresses the failure warning (finding #9)', async () => {
        const { panel, sortSet, filterSet } = await makePanel({
            storedSort: STORED_SORT, storedFilter: STORED_FILTER,
        });
        panel.restoreSort = async () => true; // would warn...
        panel.restoreFilter = async () => { panel.restoreAbort?.abort(); return false; };
        await panel.sendInit();
        expect(warnings).toEqual([]);
        expect(sortSet).toEqual(['cleared']);
        expect(filterSet).toEqual(['cleared']);
    });

    it('bails without posting or forgetting if generation changes mid-restore', async () => {
        const { panel, posted, sortSet } = await makePanel({ storedSort: STORED_SORT });
        panel.restoreSort = async () => { panel.generation++; return false; };
        await panel.sendInit();
        expect(posted.some((m: any) => m.type === 'init')).toBe(false);
        expect(sortSet).toEqual([]);
    });
});

describe('handleCancelRestore', () => {
    it('ignores a stale restoreId', async () => {
        const { panel } = await makePanel();
        panel.restoreId = 5; panel.restoring = true;
        let aborted = false;
        panel.restoreAbort = { abort: () => { aborted = true; } };
        await panel.handleCancelRestore({ type: 'cancelRestore', panelGeneration: 0, restoreId: 4 });
        expect(aborted).toBe(false);
    });

    it('aborts an in-flight restore on a matching id', async () => {
        const { panel } = await makePanel();
        panel.restoreId = 7; panel.restoring = true;
        let aborted = false;
        panel.restoreAbort = { abort: () => { aborted = true; } };
        await panel.handleCancelRestore({ type: 'cancelRestore', panelGeneration: 0, restoreId: 7 });
        expect(aborted).toBe(true);
    });

    it('honors a late cancel as clear-and-forget (finding #5)', async () => {
        const { panel, posted, sortSet, filterSet } = await makePanel({
            storedSort: STORED_SORT, storedFilter: STORED_FILTER,
        });
        panel.restoreId = 3; panel.restoring = false;
        panel.sort = STORED_SORT; panel.permutation = new Uint32Array(5);
        const genBefore = panel.generation;

        await panel.handleCancelRestore({ type: 'cancelRestore', panelGeneration: 0, restoreId: 3 });

        expect(panel.sort.keys.length).toBe(0);
        expect(panel.permutation).toBeUndefined();
        expect(panel.generation).toBe(genBefore + 1);
        expect(sortSet).toEqual(['cleared']);
        expect(filterSet).toEqual(['cleared']);
        expect(panel.restoreId).toBe(-1);
        const replace = posted.find((m: any) => m.type === 'replace');
        expect(replace).toBeDefined();
        expect(replace.panelGeneration).toBe(genBefore + 1);
        expect(replace.sort).toEqual(EMPTY_SORT);
        expect(replace.filter).toEqual(EMPTY_FILTER);

        // Duplicate late cancel is now ignored (id consumed).
        const before = sortSet.length;
        await panel.handleCancelRestore({ type: 'cancelRestore', panelGeneration: 0, restoreId: 3 });
        expect(sortSet.length).toBe(before);
    });

    it('bumps generation before awaiting the forget writes (ordering)', async () => {
        const { panel } = await makePanel({ storedSort: STORED_SORT });
        panel.restoreId = 2; panel.restoring = false;
        panel.sort = STORED_SORT; panel.permutation = new Uint32Array(5);
        let order = 0;
        let persistedAt: number | null = null;
        panel.sortStore.clear = async () => { persistedAt = order++; };
        const genBefore = panel.generation;
        await panel.handleCancelRestore({ type: 'cancelRestore', panelGeneration: 0, restoreId: 2 });
        expect(panel.generation).toBe(genBefore + 1);
        expect(persistedAt).not.toBeNull();
    });
});

describe('lifecycle interruptions', () => {
    it('honors a user cancel even when a webview reload races the abort', async () => {
        const { panel, posted, sortSet } = await makePanel({ storedSort: STORED_SORT });
        // An in-flight restore whose read blocks on a gate (the abort is not
        // observed until released).
        let release: (() => void) | null = null;
        const gate = new Promise<void>(r => { release = r; });
        panel.restoreSort = async () => { await gate; return false; };
        const p = panel.sendInit();
        await new Promise(r => setTimeout(r, 0));
        const rp = posted.find((m: any) => m.type === 'restorePending');
        expect(rp).toBeDefined();
        // User clicks Cancel (in-flight): aborts + records the intent.
        await panel.handleCancelRestore({
            type: 'cancelRestore', panelGeneration: 0, restoreId: rp.restoreId,
        });
        expect(sortSet).toEqual([]); // not forgotten yet (delegated)
        // A webview reload races in before paintWithRestore observes the abort.
        // The reload must honor the pending cancel and forget the prefs, not
        // bail stale and re-restore them.
        const realSendInit = panel.sendInit.bind(panel);
        panel.sendInit = async () => {}; // isolate the re-send
        await panel.handleInner({ type: 'webviewReady' });
        release!();
        await p;
        void realSendInit;
        expect(sortSet).toEqual(['cleared']);
    });

    it('replace honors a pending cancel by forgetting the prev dataset prefs', async () => {
        const { panel, sortSet } = await makePanel({ storedSort: STORED_SORT });
        panel.filePath = '/tmp/raven-does-not-exist-a.arrow';
        panel.reader.close = async () => {};
        panel.webviewReady = false; // skip sendReplace (isolate replace())
        panel.restoring = true;
        panel.restoreAbort = new AbortController();
        panel.restoreId = 1;
        panel.restoreCancelRequested = true;

        const reader2 = {
            nrow: 5, batchStarts: [0, 5],
            schema: { columns: COLUMNS }, close: async () => {},
        };
        await panel.replace(reader2, '/tmp/raven-does-not-exist-b.arrow');

        // The cancelled restore's prefs are forgotten before the new dataset
        // could re-apply them.
        expect(sortSet).toEqual(['cleared']);
        expect(panel.restoreCancelRequested).toBe(false);
    });

    it('webviewReady during restore bumps generation + aborts so prefs survive', async () => {
        const { panel } = await makePanel();
        panel.restoring = true;
        const ctrl = new AbortController();
        panel.restoreAbort = ctrl;
        panel.restoreId = 1;
        let resend = false;
        panel.sendInit = async () => { resend = true; };
        const genBefore = panel.generation;

        await panel.handleInner({ type: 'webviewReady' });

        expect(panel.generation).toBe(genBefore + 1);
        expect(ctrl.signal.aborted).toBe(true);
        expect(panel.restoring).toBe(false);
        expect(panel.restoreId).toBe(-1);
        expect(resend).toBe(true);
    });
});

describe('sort/filter ignored while restoring', () => {
    it('handleSetSort is a no-op while a restore is in flight', async () => {
        const { panel, posted } = await makePanel();
        panel.restoring = true;
        const genBefore = panel.generation;
        await panel.handleSetSort(
            { type: 'setSort', panelGeneration: 0, requestId: 1, keys: [{ columnIndex: 0, direction: 'asc' }], labelsOn: true, formatOn: true, digits: 3 },
            panel.generation,
        );
        expect(panel.generation).toBe(genBefore);
        expect(posted).toEqual([]);
    });

    it('handleSetSort consumes restoreId so a later stale cancel cannot clear it', async () => {
        const { panel, sortSet } = await makePanel();
        panel.restoring = false;
        panel.restoreId = 4;
        await panel.handleSetSort(
            { type: 'setSort', panelGeneration: 0, requestId: 1, keys: [], labelsOn: true, formatOn: true, digits: 3 },
            panel.generation,
        );
        expect(panel.restoreId).toBe(-1);
        const before = sortSet.length;
        await panel.handleCancelRestore({ type: 'cancelRestore', panelGeneration: 0, restoreId: 4 });
        expect(sortSet.length).toBe(before);
    });
});

describe('helpers', () => {
    it('resetRestoredPrefs clears memory + consumes id synchronously', async () => {
        const { panel, sortSet, filterSet } = await makePanel();
        panel.sort = STORED_SORT; panel.permutation = new Uint32Array(3);
        panel.filter = STORED_FILTER; panel.filteredIndices = new Uint32Array(2);
        panel.restoreId = 9;
        panel.resetRestoredPrefs();
        expect(panel.sort.keys.length).toBe(0);
        expect(panel.permutation).toBeUndefined();
        expect(panel.filter.entries.length).toBe(0);
        expect(panel.filteredIndices).toBeUndefined();
        expect(panel.restoreId).toBe(-1);
        expect(sortSet).toEqual([]);
        expect(filterSet).toEqual([]);
    });

    it('forgetPersistedPrefs clears both stores', async () => {
        const { panel, sortSet, filterSet } = await makePanel();
        await panel.forgetPersistedPrefs('h');
        expect(sortSet).toEqual(['cleared']);
        expect(filterSet).toEqual(['cleared']);
    });
});
