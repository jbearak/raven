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
    panel.sortSnapshots = new Map([[0, { sort: EMPTY_SORT }]]);
    panel.filter = EMPTY_FILTER;
    panel.filteredIndices = undefined;
    panel.filterGeneration = 0;
    panel.filterSnapshots = new Map([[0, { filter: EMPTY_FILTER }]]);
    panel.histogramCache = new Map();
    panel.histogramAborts = new Set();
    panel.restoreAbort = null;
    panel.restoring = false;
    panel.restorePainted = false;
    panel.restoreId = -1;
    panel.restoreSeq = 0;
    panel.pendingForgetHashes = new Set();
    panel.lastForgetGen = new Map();
    panel.lastToolbar = undefined;
    panel.sendChain = Promise.resolve();
    panel.transformChain = Promise.resolve();
    panel.prefStoreChain = Promise.resolve();
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

    it('drops prefs while a late clear-and-forget is in flight (#548 review)', async () => {
        // A late clear-and-forget marks pendingForgetHash before awaiting the
        // store clears. A webviewReady/replace that re-reads the store inside
        // that window must NOT re-restore the prefs the user just cancelled.
        const { panel, posted } = await makePanel({
            storedSort: STORED_SORT, storedFilter: STORED_FILTER,
        });
        // Mirror the real restoreSort/restoreFilter: act only when given prefs.
        panel.restoreSort = async (saved: SortState | undefined) => {
            if (saved) { panel.sort = STORED_SORT; panel.permutation = new Uint32Array(5); }
            return false;
        };
        panel.restoreFilter = async (saved: FilterState | undefined) => {
            if (saved) { panel.filter = STORED_FILTER; panel.filteredIndices = new Uint32Array([0, 1, 2]); }
            return false;
        };
        // Simulate the in-flight forget window for this schema.
        panel.pendingForgetHashes.add(panel.currentSchemaHash());

        await panel.sendInit();

        // No restore begins; the paint shows natural order.
        expect(posted.filter((m: any) => m.type === 'restorePending')).toEqual([]);
        expect(panel.restoring).toBe(false);
        expect(panel.sort.keys.length).toBe(0);
        expect(panel.filter.entries.length).toBe(0);
        const init = posted.find((m: any) => m.type === 'init');
        expect(init.sort).toEqual(EMPTY_SORT);
        expect(init.filter).toEqual(EMPTY_FILTER);
    });

    it('restores normally once the forget completes and clears the marker (control)', async () => {
        const { panel, posted } = await makePanel({
            storedSort: STORED_SORT, storedFilter: STORED_FILTER,
        });
        panel.restoreSort = async (saved: SortState | undefined) => {
            if (saved) { panel.sort = STORED_SORT; panel.permutation = new Uint32Array(5); }
            return false;
        };
        panel.restoreFilter = async (saved: FilterState | undefined) => {
            if (saved) { panel.filter = STORED_FILTER; panel.filteredIndices = new Uint32Array([0, 1, 2]); }
            return false;
        };
        // pendingForgetHashes is empty: no forget in flight.

        await panel.sendInit();

        expect(posted.filter((m: any) => m.type === 'restorePending').length).toBe(1);
        expect(panel.sort.keys.length).toBe(1);
        expect(panel.filter.entries.length).toBe(1);
    });

    it('tracks overlapping forgets per-schema so they cannot clobber each other (#548 codex)', async () => {
        // Two late clear-and-forgets for different schemas can be in flight at
        // once; a single marker would let the second overwrite the first and
        // un-suppress its restore. The Set keeps them independent.
        const { panel, posted } = await makePanel({
            storedSort: STORED_SORT, storedFilter: STORED_FILTER,
        });
        panel.restoreSort = async (saved: SortState | undefined) => {
            if (saved) { panel.sort = STORED_SORT; panel.permutation = new Uint32Array(5); }
            return false;
        };
        panel.restoreFilter = async (saved: FilterState | undefined) => {
            if (saved) { panel.filter = STORED_FILTER; panel.filteredIndices = new Uint32Array([0, 1, 2]); }
            return false;
        };
        const hashA = panel.currentSchemaHash();
        panel.pendingForgetHashes.add(hashA);
        panel.pendingForgetHashes.add('schema-B-hash');
        // A forget for the OTHER schema completing must not un-suppress schema A.
        panel.pendingForgetHashes.delete('schema-B-hash');

        await panel.sendInit();

        expect(posted.filter((m: any) => m.type === 'restorePending')).toEqual([]);
        expect(panel.sort.keys.length).toBe(0);
        expect(panel.filter.entries.length).toBe(0);
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

    it('a webview reload during the paint keeps prefs (lifecycle abort, not a cancel)', async () => {
        const { panel, sortSet } = await makePanel({ storedSort: STORED_SORT });
        panel.restoreSort = async () => {
            panel.sort = STORED_SORT; panel.permutation = new Uint32Array(5); return false;
        };
        // Prevent the reload's re-send from recursing in this isolated test.
        panel.sendInit = async () => {};
        // A webview reload lands during the paint (after the reads completed).
        // It bumps generation + aborts — but it is NOT a user Cancel, so the
        // prefs must survive (the queued re-send re-restores them).
        const origPost = panel.webviewPanel.webview.postMessage;
        let fired = false;
        panel.webviewPanel.webview.postMessage = (m: any) => {
            if (!fired && m.type === 'init') {
                fired = true;
                void panel.handleInner({ type: 'webviewReady' });
            }
            return origPost(m);
        };

        await panel.paintWithRestore('init');

        // The reload bailed paintWithRestore stale; prefs were NOT forgotten.
        expect(sortSet).toEqual([]);
    });

    it('honors a cancel that lands during the filterApplied post', async () => {
        const { panel, posted, filterSet } = await makePanel({
            storedFilter: STORED_FILTER,
        });
        panel.restoreSort = async () => false;
        panel.restoreFilter = async () => {
            panel.filter = STORED_FILTER;
            panel.filteredIndices = new Uint32Array([0, 1, 2]);
            return false;
        };
        // The cancel lands during the (second) post-decision await: the
        // filterApplied post, after the chips init was already posted.
        const origPost = panel.webviewPanel.webview.postMessage;
        panel.webviewPanel.webview.postMessage = (m: any) => {
            if (m.type === 'filterApplied') {
                void panel.handleCancelRestore({
                    type: 'cancelRestore', panelGeneration: 0, restoreId: panel.restoreId,
                });
            }
            return origPost(m);
        };

        await panel.sendInit();

        // Cancel honored: prefs forgotten, grid ends in natural order.
        expect(filterSet).toEqual(['cleared']);
        expect(panel.filteredIndices).toBeUndefined();
        const last = posted[posted.length - 1];
        expect(last.type).toBe('replace');
        expect(last.filter).toEqual(EMPTY_FILTER);
    });

    it('does not let a fully-honored cancel linger (no spurious forget later)', async () => {
        const { panel, sortSet } = await makePanel({ storedSort: STORED_SORT });
        // User cancels during the read (via handleCancelRestore in-flight),
        // which sets restoreCancelRequested.
        panel.restoreSort = async () => {
            await panel.handleCancelRestore({
                type: 'cancelRestore', panelGeneration: 0, restoreId: panel.restoreId,
            });
            return false;
        };

        await panel.sendInit();

        // The cancel was fully honored (prefs forgotten) AND the intent flag
        // is cleared — so a later replace() cannot mistake it for a fresh
        // pending cancel and wrongly forget re-saved prefs.
        expect(sortSet).toEqual(['cleared']);
        expect(panel.restoreCancelRequested).toBe(false);
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

    it('acks a post-paint sort request as a rollback instead of stranding the pill (#550)', async () => {
        // After paintWithRestore posts init/replace it sets restorePainted, but
        // `restoring` stays true until its `finally`. A sort fired in that
        // window must be reconciled (rolled back to the painted sort) so the
        // webview's optimistic "Sorting…" pill clears, not dropped silently.
        const { panel, posted, sortSet } = await makePanel();
        panel.restoring = true;
        panel.restorePainted = true;
        panel.sort = STORED_SORT;
        panel.permutation = new Uint32Array(5);
        const genBefore = panel.generation;

        await panel.handleSetSort(
            { type: 'setSort', panelGeneration: 0, requestId: 7, keys: [{ columnIndex: 1, direction: 'desc' }], labelsOn: true, formatOn: true, digits: 3 },
            panel.generation,
        );

        // The interactive request is still declined (no generation/sort change)
        // but the webview is told to roll back to the painted, authoritative sort.
        expect(panel.generation).toBe(genBefore);
        expect(panel.sortGeneration).toBe(0);
        expect(panel.sort).toEqual(STORED_SORT);
        expect(posted.length).toBe(1);
        expect(posted[0]).toMatchObject({
            type: 'sortApplied', requestId: 7, rollback: true, fromPersistence: false,
        });
        expect(posted[0].sort).toEqual(STORED_SORT);
        // A rollback ack must not persist as a new preference.
        expect(sortSet).toEqual([]);
    });

    it('acks a post-paint filter request as a rollback instead of stranding the pill (#550)', async () => {
        const { panel, posted, filterSet } = await makePanel();
        panel.restoring = true;
        panel.restorePainted = true;
        panel.filter = STORED_FILTER;
        panel.filteredIndices = new Uint32Array([0, 1, 2]);
        const genBefore = panel.generation;

        await panel.handleSetFilters(
            { type: 'setFilters', panelGeneration: 0, requestId: 9, rollbackBaseRequestId: 0, entries: [], labelsOn: true },
            panel.generation,
        );

        expect(panel.generation).toBe(genBefore);
        expect(panel.filterGeneration).toBe(0);
        expect(panel.filter).toEqual(STORED_FILTER);
        expect(posted.length).toBe(1);
        expect(posted[0]).toMatchObject({
            type: 'filterApplied', requestId: 9, rollback: true, fromPersistence: false,
        });
        expect(posted[0].filter).toEqual(STORED_FILTER);
        expect(posted[0].nrowFiltered).toBe(3);
        expect(filterSet).toEqual([]);
    });

    it('still drops a pre-paint sort request silently (restore not yet painted)', async () => {
        // Before the paint, the imminent init/replace resets the webview's
        // optimistic pill, so the silent drop is correct (and an ack here would
        // reference the not-yet-restored in-memory sort).
        const { panel, posted } = await makePanel();
        panel.restoring = true;
        panel.restorePainted = false;
        const genBefore = panel.generation;

        await panel.handleSetSort(
            { type: 'setSort', panelGeneration: 0, requestId: 3, keys: [{ columnIndex: 0, direction: 'asc' }], labelsOn: true, formatOn: true, digits: 3 },
            panel.generation,
        );

        expect(panel.generation).toBe(genBefore);
        expect(posted).toEqual([]);
    });

    it('reconciles an interactive sort fired in the post-paint window (#550)', async () => {
        // End-to-end through paintWithRestore: the webview unblocks on the
        // restore's filterApplied and immediately fires an interactive setSort,
        // which reaches the host while `restoring` is still true.
        const { panel, posted } = await makePanel({ storedFilter: STORED_FILTER });
        panel.restoreSort = async () => false;
        panel.restoreFilter = async () => {
            panel.filter = STORED_FILTER;
            panel.filteredIndices = new Uint32Array([0, 1, 2]);
            return false;
        };
        const origPost = panel.webviewPanel.webview.postMessage;
        let fired = false;
        panel.webviewPanel.webview.postMessage = (m: any) => {
            const r = origPost(m);
            if (!fired && m.type === 'filterApplied') {
                fired = true;
                void panel.handleSetSort(
                    { type: 'setSort', panelGeneration: 0, requestId: 42, keys: [{ columnIndex: 0, direction: 'asc' }], labelsOn: true, formatOn: true, digits: 3 },
                    panel.generation,
                );
            }
            return r;
        };

        await panel.sendInit();

        // The stray sort got a rollback ack (its pill clears) rather than silence.
        const ack = posted.find((m: any) => m.type === 'sortApplied' && m.requestId === 42);
        expect(ack).toBeDefined();
        expect(ack.rollback).toBe(true);
        expect(panel.restoring).toBe(false);
        expect(panel.restorePainted).toBe(false);
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

    it('abortAndClearRestore clears restorePainted alongside restoring (#550)', async () => {
        // restorePainted is part of the restore-in-flight state; a lifecycle
        // abort must clear it too so it cannot linger stale into a later send.
        const { panel } = await makePanel();
        panel.restoring = true;
        panel.restorePainted = true;
        panel.restoreAbort = new AbortController();
        panel.restoreId = 3;
        panel.abortAndClearRestore();
        expect(panel.restoring).toBe(false);
        expect(panel.restorePainted).toBe(false);
        expect(panel.restoreAbort).toBeNull();
        expect(panel.restoreId).toBe(-1);
    });

    it('forgetPersistedPrefs clears both stores', async () => {
        const { panel, sortSet, filterSet } = await makePanel();
        await panel.forgetPersistedPrefs('h');
        expect(sortSet).toEqual(['cleared']);
        expect(filterSet).toEqual(['cleared']);
    });

    it('forgetPersistedPrefs still clears the filter when the sort clear rejects (#548 review)', async () => {
        const { panel, sortSet, filterSet } = await makePanel();
        panel.sortStore.clear = async () => { throw new Error('sort clear boom'); };
        // Must not reject, and must still attempt the filter clear — otherwise a
        // cancelled restore would forget only the sort and re-restore the filter.
        await panel.forgetPersistedPrefs('h');
        expect(sortSet).toEqual([]);
        expect(filterSet).toEqual(['cleared']);
    });

    it('forgetPersistedPrefs still clears the sort when the filter clear rejects (#548 review)', async () => {
        const { panel, sortSet, filterSet } = await makePanel();
        panel.filterStore.clear = async () => { throw new Error('filter clear boom'); };
        await panel.forgetPersistedPrefs('h');
        expect(sortSet).toEqual(['cleared']);
        expect(filterSet).toEqual([]);
    });

    it('forgetPersistedPrefs honors the persist-* settings (skips disabled stores)', async () => {
        const { panel, sortSet, filterSet } = await makePanel();
        panel.settings = { persistSort: false, persistFilters: true, defaultDigits: 3 };
        await panel.forgetPersistedPrefs('h');
        expect(sortSet).toEqual([]);
        expect(filterSet).toEqual(['cleared']);
    });

    it('forgetPersistedPrefs records the forget epoch at the current generation (#552)', async () => {
        const { panel } = await makePanel();
        panel.generation = 3;
        await panel.forgetPersistedPrefs('h');
        expect(panel.lastForgetGen.get('h')).toBe(3);
    });

    it('drops a stale-generation saveSort/saveFilter below the forget epoch (#552)', async () => {
        const { panel, sortSet, filterSet } = await makePanel();
        // A forget for schema "h" was recorded at generation 2; saves issued from
        // the pre-forget view (generation 1) are stale and must not resurrect it.
        panel.lastForgetGen.set('h', 2);
        await panel.handleInner({
            type: 'saveSort', panelGeneration: 1, schemaHash: 'h', sort: STORED_SORT,
        });
        await panel.handleInner({
            type: 'saveFilter', panelGeneration: 1, schemaHash: 'h', filter: STORED_FILTER,
        });
        expect(sortSet).toEqual([]);
        expect(filterSet).toEqual([]);
    });

    it('keeps a saveSort at or above the forget epoch (a fresh post-cancel pref, #552)', async () => {
        const { panel, sortSet } = await makePanel();
        panel.lastForgetGen.set('h', 1);
        await panel.handleInner({
            type: 'saveSort', panelGeneration: 1, schemaHash: 'h', sort: STORED_SORT,
        });
        await panel.handleInner({
            type: 'saveSort', panelGeneration: 2, schemaHash: 'h', sort: STORED_SORT,
        });
        // >= keeps the same-generation and newer saves.
        expect(sortSet).toEqual([STORED_SORT, STORED_SORT]);
    });

    it('serializes an in-flight save ahead of a forget clear so the pref is not resurrected (#552)', async () => {
        const { panel, sortSet } = await makePanel();
        // Gate the in-flight save inside the chain so the forget's clear is
        // enqueued behind it; FIFO must run the save first, then the clear.
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => { release = r; });
        const origSave = panel.sortStore.save;
        panel.sortStore.save = async (p: string, h: string, s: SortState) => {
            await gate;
            await origSave(p, h, s);
        };
        const savePromise = panel.handleInner({
            type: 'saveSort', panelGeneration: 0, schemaHash: 'h', sort: STORED_SORT,
        });
        const forgetPromise = panel.forgetPersistedPrefs('h');
        release();
        await Promise.all([savePromise, forgetPromise]);
        // Clear ran last → cancelled pref does not survive.
        expect(sortSet.at(-1)).toBe('cleared');
    });

    it('in-chain epoch recheck drops a save when a forget is recorded while it waits in the chain (#552)', async () => {
        const { panel, sortSet } = await makePanel();
        // Seed the chain with a gated task so the save cannot start running yet.
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => { release = r; });
        panel.prefStoreChain = panel.prefStoreChain.then(() => gate);
        const savePromise = panel.handleInner({
            type: 'saveSort', panelGeneration: 0, schemaHash: 'h', sort: STORED_SORT,
        });
        // The fast-path passed (epoch unset); record the forget while the save is
        // still queued behind the gate, so only the in-chain recheck can catch it.
        panel.lastForgetGen.set('h', 1);
        release();
        await savePromise;
        expect(sortSet).toEqual([]);
    });

    it('preserves a fresh save enqueued after a forget clear (clear-before-fresh ordering, #552)', async () => {
        const { panel, sortSet } = await makePanel();
        panel.generation = 1;
        // Forget enqueues its clear first (epoch 1); the fresh save (gen 1) is
        // enqueued after and must survive.
        const forgetPromise = panel.forgetPersistedPrefs('h');
        const savePromise = panel.handleInner({
            type: 'saveSort', panelGeneration: 1, schemaHash: 'h', sort: STORED_SORT,
        });
        await Promise.all([forgetPromise, savePromise]);
        expect(sortSet.at(-1)).toEqual(STORED_SORT);
    });

    it('a rejecting save op does not stall a later save (chain tail isolation, #552)', async () => {
        const { panel, sortSet } = await makePanel();
        // Schema "A" rejects, "B" succeeds. Keyed by schema (not by reassignment)
        // so the verdict does not depend on when the deferred chain op runs.
        panel.sortStore.save = async (_p: string, h: string, s: SortState) => {
            if (h === 'A') throw new Error('boom');
            sortSet.push(s);
        };
        const p1 = panel.handleInner({
            type: 'saveSort', panelGeneration: 0, schemaHash: 'A', sort: STORED_SORT,
        }).catch(() => undefined);
        const p2 = panel.handleInner({
            type: 'saveSort', panelGeneration: 0, schemaHash: 'B', sort: STORED_SORT,
        });
        await Promise.all([p1, p2]);
        // B's save still ran despite A's rejection (chain tail isolated).
        expect(sortSet).toEqual([STORED_SORT]);
    });

    it('clearAndForgetNaturalOrder records the epoch, clears, and a fresh post-cancel save survives (#552)', async () => {
        const { panel, sortSet } = await makePanel();
        panel.generation = 0;
        await panel.clearAndForgetNaturalOrder('h');
        // Epoch recorded at the bumped (post-cancel) generation.
        expect(panel.lastForgetGen.get('h')).toBe(1);
        expect(sortSet).toContain('cleared');
        // A fresh post-cancel save at the new generation is kept.
        await panel.handleInner({
            type: 'saveSort', panelGeneration: 1, schemaHash: 'h', sort: STORED_SORT,
        });
        expect(sortSet.at(-1)).toEqual(STORED_SORT);
    });

    it('saves a sort/filter normally when no forget is pending for its schema (control)', async () => {
        const { panel, sortSet, filterSet } = await makePanel();
        await panel.handleInner({
            type: 'saveSort', panelGeneration: 0, schemaHash: 'h', sort: STORED_SORT,
        });
        await panel.handleInner({
            type: 'saveFilter', panelGeneration: 0, schemaHash: 'h', filter: STORED_FILTER,
        });
        expect(sortSet).toEqual([STORED_SORT]);
        expect(filterSet).toEqual([STORED_FILTER]);
    });

    it('persists an empty saveSort/saveFilter as a clear (#552 persistPrefMutation clear branch)', async () => {
        const { panel, sortSet, filterSet } = await makePanel();
        await panel.handleInner({
            type: 'saveSort', panelGeneration: 0, schemaHash: 'h', sort: EMPTY_SORT,
        });
        await panel.handleInner({
            type: 'saveFilter', panelGeneration: 0, schemaHash: 'h', filter: EMPTY_FILTER,
        });
        // Empty keys/entries take the clear branch, not save.
        expect(sortSet).toEqual(['cleared']);
        expect(filterSet).toEqual(['cleared']);
    });

    it('drops a saveSort/saveFilter when its persist-* setting is disabled (#552 gating)', async () => {
        const { panel, sortSet, filterSet } = await makePanel();
        panel.settings = { persistSort: false, persistFilters: false, defaultDigits: 3 };
        await panel.handleInner({
            type: 'saveSort', panelGeneration: 0, schemaHash: 'h', sort: STORED_SORT,
        });
        await panel.handleInner({
            type: 'saveFilter', panelGeneration: 0, schemaHash: 'h', filter: STORED_FILTER,
        });
        expect(sortSet).toEqual([]);
        expect(filterSet).toEqual([]);
    });

    it('drops a saveSort with an empty schemaHash (#552 gating)', async () => {
        const { panel, sortSet } = await makePanel();
        await panel.handleInner({
            type: 'saveSort', panelGeneration: 0, schemaHash: '', sort: STORED_SORT,
        });
        expect(sortSet).toEqual([]);
    });
});
