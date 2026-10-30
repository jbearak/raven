/**
 * The status line under the grid ("Rows 1–40 of 10,000,000 · 12 cols"),
 * the only component that re-renders on scroll. It subscribes to the
 * visible-range store App updates from its scroll callback, so the
 * viewport lives in a ref and scrolling never renders App.
 */
import { useSyncExternalStore, type MutableRefObject } from 'react';
import { describeStatusLine, type VisibleRange } from './grid-model';

export type RangeStore = {
    subscribe: (listener: () => void) => () => void;
    get: () => VisibleRange;
    emit: () => void;
};

export type VersionStore = {
    subscribe: (listener: () => void) => () => void;
    get: () => number;
    emit: () => void;
};

/** A subscribable counter, bumped with `emit` (rows arriving). */
export function createVersionStore(): VersionStore {
    const listeners = new Set<() => void>();
    let version = 0;
    return {
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        get: () => version,
        emit: () => { version++; for (const l of listeners) l(); },
    };
}

/** A subscribable view of a visible-range ref. */
export function createRangeStore(ref: MutableRefObject<VisibleRange>): RangeStore {
    const listeners = new Set<() => void>();
    return {
        subscribe: listener => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        get: () => ref.current,
        emit: () => { for (const l of listeners) l(); },
    };
}

export function StatusLine({ store, nrow, ncol, nrowFiltered, loading, rowsStore, selectionText }: {
    store: RangeStore;
    nrow: number;
    ncol: number;
    nrowFiltered: number | undefined;
    loading: boolean;
    /** Bumped when rows arrive, so the selection summary re-reads them. */
    rowsStore?: VersionStore;
    /** The selection summary (`6 cells · Σ 120.4 · mean 20.07`). */
    selectionText?: () => string;
}) {
    const range = useSyncExternalStore(store.subscribe, store.get);
    useSyncExternalStore(rowsStore?.subscribe ?? noSubscribe, rowsStore?.get ?? noVersion);
    const text = loading ? '' : describeStatusLine(nrow, ncol, nrowFiltered, range);
    const sel = loading ? '' : selectionText?.() ?? '';
    return (
        <div className="status-line" aria-live="off">
            <span className="status-line-range">{text}</span>
            {sel && <span className="status-line-selection" title="Selection: cells, missing, sum and mean of the loaded numeric cells">{sel}</span>}
        </div>
    );
}

const noSubscribe = () => () => {};
const noVersion = () => 0;
