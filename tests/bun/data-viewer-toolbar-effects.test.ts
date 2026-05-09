import { describe, test, expect } from 'bun:test';
import {
    hasFormatEffectCol,
    hasLabelsEffectCol,
    hasFormatEffect,
    hasLabelsEffect,
} from '../../editors/vscode/src/data-viewer/webview/toolbar-effects';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';

const col = (over: Partial<ColumnSchema>): ColumnSchema => ({
    name: 'x',
    arrowType: 'Utf8',
    isInteger: false,
    dictionaryShipped: false,
    ...over,
});

describe('hasFormatEffectCol', () => {
    test('Float64 non-integer: true', () => {
        expect(hasFormatEffectCol(col({ arrowType: 'Float64' }))).toBe(true);
    });
    test('Float32 non-integer: true', () => {
        expect(hasFormatEffectCol(col({ arrowType: 'Float32' }))).toBe(true);
    });
    test('Int32 (isInteger=true): false', () => {
        expect(hasFormatEffectCol(col({ arrowType: 'Int32', isInteger: true }))).toBe(false);
    });
    test('Utf8: false', () => {
        expect(hasFormatEffectCol(col({ arrowType: 'Utf8' }))).toBe(false);
    });
    test('Date32: false', () => {
        expect(hasFormatEffectCol(col({ arrowType: 'Date32' }))).toBe(false);
    });
    test('Timestamp[us]: false', () => {
        expect(hasFormatEffectCol(col({ arrowType: 'Timestamp<MICROSECOND>' }))).toBe(false);
    });
    test('Bool: false', () => {
        expect(hasFormatEffectCol(col({ arrowType: 'Bool' }))).toBe(false);
    });
    test('Decimal128: false (falls through to stringify)', () => {
        expect(hasFormatEffectCol(col({ arrowType: 'Decimal128' }))).toBe(false);
    });
    test('Dictionary<Int32, Utf8>: false (handled by Labels branch)', () => {
        expect(hasFormatEffectCol(
            col({ arrowType: 'Dictionary<Int32, Utf8>', dictionaryShipped: true }),
        )).toBe(false);
    });
});

describe('hasLabelsEffectCol', () => {
    test('shipped dictionary: true', () => {
        expect(hasLabelsEffectCol(
            col({ arrowType: 'Dictionary<Int32, Utf8>', dictionaryShipped: true }),
        )).toBe(true);
    });
    test('high-cardinality dictionary (not shipped): true', () => {
        expect(hasLabelsEffectCol(
            col({ arrowType: 'Dictionary<Int32, Utf8>', dictionaryShipped: false }),
        )).toBe(true);
    });
    test('haven_labelled with non-empty valueLabels: true', () => {
        expect(hasLabelsEffectCol(
            col({ arrowType: 'Float64', valueLabels: { '1': 'one' } }),
        )).toBe(true);
    });
    test('haven_labelled with empty valueLabels: false', () => {
        expect(hasLabelsEffectCol(
            col({ arrowType: 'Float64', valueLabels: {} }),
        )).toBe(false);
    });
    test('plain Float64: false', () => {
        expect(hasLabelsEffectCol(col({ arrowType: 'Float64' }))).toBe(false);
    });
    test('plain Utf8: false', () => {
        expect(hasLabelsEffectCol(col({ arrowType: 'Utf8' }))).toBe(false);
    });
    test('column with variableLabel only (no valueLabels): false', () => {
        expect(hasLabelsEffectCol(
            col({ arrowType: 'Float64', variableLabel: 'Mileage' }),
        )).toBe(false);
    });
});

describe('whole-table predicates', () => {
    test('hasFormatEffect true on first Float column', () => {
        const cols = [
            col({ arrowType: 'Int32', isInteger: true }),
            col({ arrowType: 'Float64' }),
            col({ arrowType: 'Utf8' }),
        ];
        expect(hasFormatEffect(cols)).toBe(true);
    });
    test('hasFormatEffect false when no Float column', () => {
        const cols = [
            col({ arrowType: 'Int32', isInteger: true }),
            col({ arrowType: 'Utf8' }),
            col({ arrowType: 'Dictionary<Int32, Utf8>', dictionaryShipped: true }),
        ];
        expect(hasFormatEffect(cols)).toBe(false);
    });
    test('hasLabelsEffect false when no Dictionary or valueLabels', () => {
        const cols = [
            col({ arrowType: 'Int32', isInteger: true }),
            col({ arrowType: 'Float64' }),
        ];
        expect(hasLabelsEffect(cols)).toBe(false);
    });
    test('hasLabelsEffect true with mixed columns', () => {
        const cols = [
            col({ arrowType: 'Int32', isInteger: true }),
            col({ arrowType: 'Float64', valueLabels: { '0': 'zero' } }),
        ];
        expect(hasLabelsEffect(cols)).toBe(true);
    });
    test('both predicates false on empty array', () => {
        expect(hasFormatEffect([])).toBe(false);
        expect(hasLabelsEffect([])).toBe(false);
    });
});
