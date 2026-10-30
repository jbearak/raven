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

export function StatusLine({ store, nrow, ncol, nrowFiltered, loading }: {
    store: RangeStore;
    nrow: number;
    ncol: number;
    nrowFiltered: number | undefined;
    loading: boolean;
}) {
    const range = useSyncExternalStore(store.subscribe, store.get);
    const text = loading ? '' : describeStatusLine(nrow, ncol, nrowFiltered, range);
    return <div className="status-line" aria-live="off">{text}</div>;
}
