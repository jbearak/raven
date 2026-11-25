import { describe, test, expect } from 'bun:test';
import {
    hasDigitsEffectCol,
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

describe('a float with a source format', () => {
    const fmt = (format: string, isInteger: boolean) => col({ arrowType: 'Float64', format, isInteger });
    // The format rounds what is stored (`DOLLAR8` shows 12.75 as `$13`),
    // so the toggle must stay available to show the stored value.
    test('zero-decimal formats keep Format, with or without the trailing dot', () => {
        for (const f of ['DOLLAR8', 'DOLLAR8.', 'F8.0', 'F8', '8.', '%9.0f', 'COMMA10.0', 'Z3.', 'PCT5']) {
            expect([f, hasFormatEffectCol(fmt(f, true))]).toEqual([f, true]);
            expect([f, hasDigitsEffectCol(fmt(f, true))]).toEqual([f, false]);
        }
    });
    test('a recognized format with decimals keeps Format and ignores digits', () => {
        for (const f of ['DOLLAR10.2', '%9.2f', 'PERCENT8.1', '%9.3g']) {
            expect([f, hasFormatEffectCol(fmt(f, false))]).toEqual([f, true]);
            expect([f, hasDigitsEffectCol(fmt(f, false))]).toEqual([f, false]);
        }
    });
    test('an unrecognized format falls back to digits', () => {
        expect(hasFormatEffectCol(fmt('BEST12', false))).toBe(true);
        expect(hasDigitsEffectCol(fmt('BEST12', false))).toBe(true);
    });
    test('a format that only declares whole numbers changes nothing', () => {
        // `FIX8` and `N8` mark the column integer but aren't display formats.
        for (const f of ['FIX8', 'N8.']) {
            expect([f, hasFormatEffectCol(fmt(f, true))]).toEqual([f, false]);
            expect([f, hasDigitsEffectCol(fmt(f, true))]).toEqual([f, false]);
        }
    });
    test('a format on an integer column is not applied', () => {
        const c = col({ arrowType: 'Int32', isInteger: true, format: 'DOLLAR8' });
        expect(hasFormatEffectCol(c)).toBe(false);
        expect(hasDigitsEffectCol(c)).toBe(false);
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
