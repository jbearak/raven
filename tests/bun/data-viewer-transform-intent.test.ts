import { describe, expect, test } from 'bun:test';
import {
    createIntentRequestState,
    filterEntriesForNextRequest,
    filterStateForRequestedEntries,
    sortKeysForNextRequest,
    nextSortKeysForColumn,
    requestFilterIntent,
    requestSortIntent,
    shouldAcceptAppliedResponse,
    shouldAcceptInteractiveResponse,
    shouldAcceptSortResponse,
    sortStateForRequestedKeys,
} from '../../editors/vscode/src/data-viewer/webview/transform-intent';
import type { FilterEntry } from '../../editors/vscode/src/data-viewer/messages';

describe('data viewer webview transform intent', () => {
    test('plain sort replaces the current keys', () => {
        expect(nextSortKeysForColumn(
            [{ columnIndex: 0, direction: 'asc' }],
            1,
            'desc',
            false,
        )).toEqual([{ columnIndex: 1, direction: 'desc' }]);
    });

    test('append sort adds a new column after the pending key', () => {
        expect(nextSortKeysForColumn(
            [{ columnIndex: 0, direction: 'asc' }],
            1,
            'desc',
            true,
        )).toEqual([
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'desc' },
        ]);
    });

    test('rapid sort requests compose from the latest pending keys', () => {
        const state = createIntentRequestState();
        const first = requestSortIntent(
            state,
            [{ columnIndex: 0, direction: 'asc' }],
            true,
        );
        expect(nextSortKeysForColumn(
            sortKeysForNextRequest([], state.latestSortIntent),
            1,
            'desc',
            true,
        )).toEqual([
            { columnIndex: 0, direction: 'asc' },
            { columnIndex: 1, direction: 'desc' },
        ]);
        expect(first.requestId).toBe(1);
    });

    test('repeating the current single-column sort is a no-op', () => {
        expect(nextSortKeysForColumn(
            [{ columnIndex: 0, direction: 'asc' }],
            0,
            'asc',
            false,
        )).toBeUndefined();
    });

    test('requested keys become optimistic sort state immediately', () => {
        expect(sortStateForRequestedKeys(
            [{ columnIndex: 1, direction: 'desc' }],
            false,
        )).toEqual({
            keys: [{ columnIndex: 1, direction: 'desc' }],
            labelsOnWhenSorted: false,
        });
    });

    test('sort host responses older than the latest optimistic request are stale', () => {
        expect(shouldAcceptSortResponse(8, 7, false)).toBe(false);
        expect(shouldAcceptSortResponse(8, 8, false)).toBe(true);
        expect(shouldAcceptSortResponse(8, 9, false)).toBe(false);
        expect(shouldAcceptSortResponse(null, 7, false)).toBe(false);
        expect(shouldAcceptSortResponse(null, -1, true)).toBe(true);
        expect(shouldAcceptSortResponse(8, -1, true)).toBe(false);
    });

    test('interactive status responses require the latest request id exactly', () => {
        expect(shouldAcceptInteractiveResponse(8, 7)).toBe(false);
        expect(shouldAcceptInteractiveResponse(8, 8)).toBe(true);
        expect(shouldAcceptInteractiveResponse(8, 9)).toBe(false);
        expect(shouldAcceptInteractiveResponse(null, 8)).toBe(false);
    });

    test('applied responses from persistence are stale while an interactive request is pending', () => {
        expect(shouldAcceptAppliedResponse(null, -1, true)).toBe(true);
        expect(shouldAcceptAppliedResponse(9, -1, true)).toBe(false);
        expect(shouldAcceptAppliedResponse(9, 9, false)).toBe(true);
        expect(shouldAcceptAppliedResponse(9, 8, false)).toBe(false);
    });

    test('rapid filter requests compose from the latest pending entries', () => {
        const state = createIntentRequestState();
        const first: FilterEntry = {
            id: 'a',
            columnIndex: 0,
            predicate: { kind: 'numCompare', op: '>', value: 2 },
            enabled: true,
            includeMissing: false,
        };
        const second: FilterEntry = {
            id: 'b',
            columnIndex: 1,
            predicate: { kind: 'strContains', value: 'x', caseSensitive: false, negate: false },
            enabled: true,
            includeMissing: false,
        };

        const firstRequest = requestFilterIntent(state, [first], true);
        const nextBase = filterEntriesForNextRequest([], state.latestFilterIntent);
        const secondRequest = requestFilterIntent(state, [...nextBase, second], true);
        const next = secondRequest.filter;

        expect(firstRequest.requestId).toBe(1);
        expect(secondRequest.requestId).toBe(2);
        expect(next.entries.map(e => e.id)).toEqual(['a', 'b']);
        expect(next.labelsOnWhenFiltered).toBe(true);
    });

    test('pending set-membership filter values are cloned for request composition', () => {
        const values = [1, 2];
        const first: FilterEntry = {
            id: 'a',
            columnIndex: 0,
            predicate: { kind: 'setIn', values },
            enabled: true,
            includeMissing: false,
        };
        const pending = filterStateForRequestedEntries([first], true);
        values.push(3);
        const base = filterEntriesForNextRequest([], pending);
        expect((base[0].predicate as any).values).toEqual([1, 2]);
        (base[0].predicate as any).values.push(4);
        expect((pending.entries[0].predicate as any).values).toEqual([1, 2]);
    });
});
