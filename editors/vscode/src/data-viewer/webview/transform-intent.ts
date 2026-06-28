import {
    EMPTY_FILTER,
    EMPTY_SORT,
    type FilterEntry,
    type FilterState,
    type SortKey,
    type SortState,
} from '../messages';

function cloneFilterEntry(entry: FilterEntry): FilterEntry {
    const predicate = entry.predicate.kind === 'setIn' || entry.predicate.kind === 'setNotIn'
        ? { ...entry.predicate, values: [...entry.predicate.values] }
        : { ...entry.predicate };
    return {
        ...entry,
        predicate: predicate as FilterEntry['predicate'],
    };
}

export function sortStateForRequestedKeys(
    keys: readonly SortKey[],
    labelsOn: boolean,
): SortState {
    if (keys.length === 0) return EMPTY_SORT;
    return {
        keys: keys.map(k => ({ ...k })),
        labelsOnWhenSorted: labelsOn,
    };
}

export function nextSortKeysForColumn(
    currentKeys: readonly SortKey[],
    sourceIndex: number,
    direction: 'asc' | 'desc',
    append: boolean,
): SortKey[] | undefined {
    const existing = currentKeys.findIndex(k => k.columnIndex === sourceIndex);
    if (!append) {
        if (existing >= 0
            && currentKeys.length === 1
            && currentKeys[0].direction === direction) {
            return undefined;
        }
        return [{ columnIndex: sourceIndex, direction }];
    }
    if (existing >= 0) {
        if (currentKeys[existing].direction === direction) return undefined;
        return currentKeys.map((k, i) =>
            i === existing ? { ...k, direction } : { ...k });
    }
    return [...currentKeys.map(k => ({ ...k })), { columnIndex: sourceIndex, direction }];
}

export function sortKeysForNextRequest(
    currentKeys: readonly SortKey[],
    latestRequestedSort: SortState | null,
): SortKey[] {
    return (latestRequestedSort?.keys ?? currentKeys).map(k => ({ ...k }));
}

export function filterStateForRequestedEntries(
    entries: readonly FilterEntry[],
    labelsOn: boolean,
): FilterState {
    if (entries.length === 0) return EMPTY_FILTER;
    return {
        entries: entries.map(cloneFilterEntry),
        labelsOnWhenFiltered: labelsOn,
    };
}

export function filterEntriesForNextRequest(
    currentEntries: readonly FilterEntry[],
    latestRequestedFilter: FilterState | null,
): FilterEntry[] {
    return (latestRequestedFilter?.entries ?? currentEntries).map(cloneFilterEntry);
}

export function shouldAcceptAppliedResponse(
    latestRequestId: number | null,
    responseRequestId: number,
    fromPersistence: boolean,
): boolean {
    return fromPersistence
        ? latestRequestId === null
        : shouldAcceptInteractiveResponse(latestRequestId, responseRequestId);
}

export function shouldAcceptSortResponse(
    latestRequestId: number | null,
    responseRequestId: number,
    fromPersistence: boolean,
): boolean {
    return shouldAcceptAppliedResponse(latestRequestId, responseRequestId, fromPersistence);
}

export function shouldAcceptInteractiveResponse(
    latestRequestId: number | null,
    responseRequestId: number,
): boolean {
    return latestRequestId !== null && responseRequestId === latestRequestId;
}

export type IntentRequestState = {
    nextRequestId: number;
    latestSortIntent: SortState | null;
    latestFilterIntent: FilterState | null;
};

export function createIntentRequestState(): IntentRequestState {
    return {
        nextRequestId: 0,
        latestSortIntent: null,
        latestFilterIntent: null,
    };
}

export function requestSortIntent(
    state: IntentRequestState,
    keys: readonly SortKey[],
    labelsOn: boolean,
): { requestId: number; keys: SortKey[]; sort: SortState } {
    const sort = sortStateForRequestedKeys(keys, labelsOn);
    state.latestSortIntent = sort;
    return {
        requestId: ++state.nextRequestId,
        keys: sort.keys.map(k => ({ ...k })),
        sort,
    };
}

export function requestFilterIntent(
    state: IntentRequestState,
    entries: readonly FilterEntry[],
    labelsOn: boolean,
): { requestId: number; entries: FilterEntry[]; filter: FilterState } {
    const filter = filterStateForRequestedEntries(entries, labelsOn);
    state.latestFilterIntent = filter;
    return {
        requestId: ++state.nextRequestId,
        entries: filter.entries.map(cloneFilterEntry),
        filter,
    };
}
