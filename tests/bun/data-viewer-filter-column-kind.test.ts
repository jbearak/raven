/**
 * filter-column-kind — pure classification of a ColumnSchema into the
 * editor's ColKind, and the per-kind predicate option lists. No React,
 * types-only imports, so it runs under bun directly.
 */
import { describe, test, expect } from 'bun:test';
import { colKind, kindOptions } from '../../editors/vscode/src/data-viewer/webview/filter-column-kind';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';

function col(partial: Partial<ColumnSchema> & Pick<ColumnSchema, 'name' | 'arrowType'>): ColumnSchema {
    return { isInteger: false, dictionaryShipped: false, ...partial };
}

const PLAIN_NUM = col({ name: 'x', arrowType: 'Int32', isInteger: true });
const FLOAT = col({ name: 'y', arrowType: 'Float64' });
const FACTOR = col({ name: 'f', arrowType: 'Dictionary<Int32, Utf8>', dictionary: ['a', 'b'], dictionaryShipped: true });
const STR = col({ name: 's', arrowType: 'Utf8' });
const STR_LBL = col({ name: 'answer', arrowType: 'Utf8', valueLabels: { Y: 'Apple' } });
const BOOL = col({ name: 'b', arrowType: 'Bool' });
const DATE = col({ name: 'd', arrowType: 'Date<DAY>' });
const TS = col({ name: 'ts', arrowType: 'Timestamp<MICROSECOND, UTC>' });

describe('colKind — stable classifications', () => {
    test('plain numeric', () => {
        expect(colKind(PLAIN_NUM)).toBe('numeric');
        expect(colKind(FLOAT)).toBe('numeric');
    });
    test('factor (dictionary)', () => expect(colKind(FACTOR)).toBe('factor'));
    test('value-labelled string stays factor', () => expect(colKind(STR_LBL)).toBe('factor'));
    test('plain string', () => expect(colKind(STR)).toBe('string'));
    test('bool', () => expect(colKind(BOOL)).toBe('bool'));
    test('date and timestamp', () => {
        expect(colKind(DATE)).toBe('date');
        expect(colKind(TS)).toBe('date');
    });
});

describe('kindOptions — shape per kind', () => {
    test('numeric offers compare/between + universal', () => {
        const vals = kindOptions('numeric').map(o => o.value);
        expect(vals).toEqual(['numCompare', 'numBetween', 'numNotBetween', 'isEmpty', 'isNotEmpty']);
    });
    test('factor offers set-membership + universal', () => {
        const vals = kindOptions('factor').map(o => o.value);
        expect(vals).toEqual(['setIn', 'setNotIn', 'isEmpty', 'isNotEmpty']);
    });
    test('string / bool / date each end with the universal pair', () => {
        for (const k of ['string', 'bool', 'date'] as const) {
            const vals = kindOptions(k).map(o => o.value);
            expect(vals.slice(-2)).toEqual(['isEmpty', 'isNotEmpty']);
        }
    });
});
