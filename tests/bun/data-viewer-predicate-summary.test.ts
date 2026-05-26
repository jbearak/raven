/**
 * predicate-summary — short human strings used by the chip strip and
 * accessibility labels. Pure; depends only on schema metadata.
 */
import { describe, test, expect } from 'bun:test';
import { summarizePredicate } from '../../editors/vscode/src/data-viewer/webview/predicate-summary';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';
import type { FilterPredicate } from '../../editors/vscode/src/data-viewer/messages';

const NUM: ColumnSchema = {
    name: 'mpg', arrowType: 'Float64', isInteger: false, dictionaryShipped: false,
};
const STR: ColumnSchema = {
    name: 'name', arrowType: 'Utf8', isInteger: false, dictionaryShipped: false,
};
const FACTOR: ColumnSchema = {
    name: 'cyl', arrowType: 'Dictionary<Int32, Utf8>', isInteger: false,
    dictionary: ['4', '6', '8'], dictionaryShipped: true,
};
const DATE: ColumnSchema = {
    name: 'd', arrowType: 'Date<DAY>', isInteger: false, dictionaryShipped: false,
};
const BOOL: ColumnSchema = {
    name: 'b', arrowType: 'Bool', isInteger: false, dictionaryShipped: false,
};

function sum(p: FilterPredicate, col: ColumnSchema): string {
    return summarizePredicate(p, col);
}

describe('summarizePredicate', () => {
    test('isEmpty / isNotEmpty', () => {
        expect(sum({ kind: 'isEmpty' }, NUM)).toBe('mpg is empty');
        expect(sum({ kind: 'isNotEmpty' }, NUM)).toBe('mpg is not empty');
    });
    test('numCompare', () => {
        expect(sum({ kind: 'numCompare', op: '>', value: 20 }, NUM)).toBe('mpg > 20');
        expect(sum({ kind: 'numCompare', op: '<=', value: 0 }, NUM)).toBe('mpg ≤ 0');
        expect(sum({ kind: 'numCompare', op: '!=', value: 6 }, NUM)).toBe('mpg ≠ 6');
    });
    test('numBetween', () => {
        expect(sum({ kind: 'numBetween', lo: 1, hi: 5, inclusive: true }, NUM)).toBe('mpg 1–5');
        expect(sum({ kind: 'numBetween', lo: 1, hi: 5, inclusive: false }, NUM))
            .toBe('mpg (1, 5)');
        expect(sum({ kind: 'numNotBetween', lo: 1, hi: 5, inclusive: true }, NUM))
            .toBe('mpg not in 1–5');
    });
    test('setIn / setNotIn (factor)', () => {
        expect(sum({ kind: 'setIn', values: ['low', 'high'] }, FACTOR))
            .toBe('cyl ∈ {low, high}');
        expect(sum({ kind: 'setNotIn', values: ['low'] }, FACTOR))
            .toBe('cyl ∉ {low}');
    });
    test('strCompare and strContains', () => {
        expect(sum({ kind: 'strCompare', op: '=', value: 'foo', caseSensitive: false }, STR))
            .toBe('name = "foo"');
        expect(sum({ kind: 'strContains', value: 'foo', caseSensitive: false, negate: false }, STR))
            .toBe('name contains "foo"');
        expect(sum({ kind: 'strContains', value: 'foo', caseSensitive: false, negate: true }, STR))
            .toBe('name not contains "foo"');
        expect(sum({ kind: 'strRegex', pattern: '^f', caseSensitive: false }, STR))
            .toBe('name matches /^f/i');
        expect(sum({ kind: 'strRegex', pattern: '^F', caseSensitive: true }, STR))
            .toBe('name matches /^F/');
    });
    test('strStartsWith / strEndsWith', () => {
        expect(sum({ kind: 'strStartsWith', value: 'foo', caseSensitive: false }, STR))
            .toBe('name starts with "foo"');
        expect(sum({ kind: 'strEndsWith', value: 'bar', caseSensitive: false }, STR))
            .toBe('name ends with "bar"');
    });
    test('dateCompare and dateBetween', () => {
        expect(sum({ kind: 'dateCompare', op: '<', value: '2024-01-01' }, DATE))
            .toBe('d < 2024-01-01');
        expect(sum({ kind: 'dateBetween', lo: '2024-01-01', hi: '2024-12-31', inclusive: true }, DATE))
            .toBe('d 2024-01-01–2024-12-31');
    });
    test('bool', () => {
        expect(sum({ kind: 'bool', value: true }, BOOL)).toBe('b is true');
        expect(sum({ kind: 'bool', value: false }, BOOL)).toBe('b is false');
    });
    test('truncates long set summaries with +N more', () => {
        const values = ['a', 'b', 'c', 'd', 'e', 'f'];
        expect(sum({ kind: 'setIn', values }, FACTOR))
            .toBe('cyl ∈ {a, b, c, d +2 more}');
    });
});
