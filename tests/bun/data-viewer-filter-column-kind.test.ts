/**
 * filter-column-kind — pure classification of a ColumnSchema into the
 * editor's ColKind, and the per-kind predicate option lists. No React,
 * types-only imports, so it runs under bun directly.
 */
import { describe, test, expect } from 'bun:test';
import { colKind, kindOptions, labelledNumericChoices } from '../../editors/vscode/src/data-viewer/webview/filter-column-kind';
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

const LBL_FLOAT = col({ name: 'lbl', arrowType: 'Float64', valueLabels: { '1': 'low', '2': 'mid', '3': 'high' } });
const LBL_INT = col({ name: 'rating', arrowType: 'Int32', isInteger: true, valueLabels: { '1': 'zebra', '2': 'apple', '3': 'mango' } });

describe('colKind — labelled numeric', () => {
    test('numeric Arrow type + valueLabels → labelledNumeric', () => {
        expect(colKind(LBL_FLOAT)).toBe('labelledNumeric');
        expect(colKind(LBL_INT)).toBe('labelledNumeric');
    });
    test('numeric WITHOUT valueLabels stays numeric', () => {
        expect(colKind(col({ name: 'x', arrowType: 'Int32', isInteger: true }))).toBe('numeric');
    });
});

describe('kindOptions — labelledNumeric is hybrid, set-membership first', () => {
    test('lists setIn first and includes numeric predicates', () => {
        const vals = kindOptions('labelledNumeric').map(o => o.value);
        expect(vals).toEqual([
            'setIn', 'setNotIn', 'numCompare', 'numBetween', 'numNotBetween', 'isEmpty', 'isNotEmpty',
        ]);
    });
});

describe('labelledNumericChoices', () => {
    test('maps valueLabels to {code,label}, sorted by numeric code ascending', () => {
        expect(labelledNumericChoices(LBL_INT)).toEqual([
            { code: 1, label: 'zebra' },
            { code: 2, label: 'apple' },
            { code: 3, label: 'mango' },
        ]);
    });
    test('sorts out-of-order and string-keyed codes numerically (not lexically)', () => {
        const c = col({ name: 'q', arrowType: 'Float64', valueLabels: { '10': 'ten', '2': 'two', '1': 'one' } });
        expect(labelledNumericChoices(c).map(x => x.code)).toEqual([1, 2, 10]);
    });
    test('returns [] when there are no value labels', () => {
        expect(labelledNumericChoices(col({ name: 'x', arrowType: 'Int32' }))).toEqual([]);
    });
});
