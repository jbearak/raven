/**
 * Compile-time + runtime sanity for the FilterState / FilterPredicate
 * discriminated unions. If this file type-checks and runs, the protocol
 * surface exists in the right shape; per-predicate evaluation is covered
 * by the filter-engine tests.
 */
import { describe, test, expect } from 'bun:test';
import {
    EMPTY_FILTER,
    type FilterEntry,
    type FilterPredicate,
    type FilterState,
} from '../../editors/vscode/src/data-viewer/messages';

describe('EMPTY_FILTER', () => {
    test('has no entries and records labelsOnWhenFiltered = true', () => {
        expect(EMPTY_FILTER.entries).toEqual([]);
        expect(EMPTY_FILTER.labelsOnWhenFiltered).toBe(true);
    });
});

describe('FilterPredicate discriminants', () => {
    test('every documented kind is constructible', () => {
        const ps: FilterPredicate[] = [
            { kind: 'isEmpty' },
            { kind: 'isNotEmpty' },
            { kind: 'numCompare', op: '=', value: 1 },
            { kind: 'numBetween', lo: 0, hi: 1, inclusive: true },
            { kind: 'numNotBetween', lo: 0, hi: 1, inclusive: true },
            { kind: 'setIn', values: ['a', 1] },
            { kind: 'setNotIn', values: ['a'] },
            { kind: 'strCompare', op: '=', value: 'x', caseSensitive: false },
            { kind: 'strContains', value: 'x', caseSensitive: false, negate: false },
            { kind: 'strStartsWith', value: 'x', caseSensitive: false },
            { kind: 'strEndsWith', value: 'x', caseSensitive: false },
            { kind: 'strRegex', pattern: '.+', caseSensitive: false },
            { kind: 'dateCompare', op: '<', value: '2024-01-01' },
            { kind: 'dateBetween', lo: '2024-01-01', hi: '2024-12-31', inclusive: true },
            { kind: 'dateNotBetween', lo: '2024-01-01', hi: '2024-12-31', inclusive: true },
            { kind: 'bool', value: true },
        ];
        expect(ps.length).toBe(16);
        for (const p of ps) {
            switch (p.kind) {
                case 'isEmpty':
                case 'isNotEmpty':
                case 'numCompare':
                case 'numBetween':
                case 'numNotBetween':
                case 'setIn':
                case 'setNotIn':
                case 'strCompare':
                case 'strContains':
                case 'strStartsWith':
                case 'strEndsWith':
                case 'strRegex':
                case 'dateCompare':
                case 'dateBetween':
                case 'dateNotBetween':
                case 'bool':
                    break;
                default: {
                    const _exhaustive: never = p;
                    throw new Error(`unhandled kind: ${(_exhaustive as { kind: string }).kind}`);
                }
            }
        }
    });
});

describe('FilterEntry / FilterState shape', () => {
    test('can build a representative state', () => {
        const entry: FilterEntry = {
            id: '1',
            columnIndex: 0,
            predicate: { kind: 'numCompare', op: '>', value: 10 },
            enabled: true,
            includeMissing: false,
        };
        const state: FilterState = {
            entries: [entry],
            labelsOnWhenFiltered: true,
        };
        expect(state.entries[0].predicate.kind).toBe('numCompare');
    });
});
