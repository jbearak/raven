import { describe, test, expect } from 'bun:test';
import { render_tsv } from '../../editors/vscode/src/data-viewer/tsv';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';

const cols: ColumnSchema[] = [
    { name: 'i', arrowType: 'Int32', isInteger: true, dictionaryShipped: false },
    { name: 'v', arrowType: 'Float64', isInteger: false, dictionaryShipped: false },
    { name: 'f', arrowType: 'Dictionary<Int32, Utf8>', isInteger: false,
        dictionaryShipped: true, dictionary: ['low', 'med', 'high'] },
    { name: 'lab', arrowType: 'Float64', isInteger: false, dictionaryShipped: false,
        valueLabels: { '1': 'one', '2': 'two' } },
];
const dictionaries = { 2: cols[2].dictionary! };

describe('render_tsv', () => {
    test('plain values, tab-separated', () => {
        const rows = [
            [1, 1.5, 0, 1] as any,
            [2, 2.25, 1, 2] as any,
        ];
        const tsv = render_tsv(rows, [0, 1, 2, 3], cols, dictionaries, false, false, 3);
        // factor codes off → 0+1=1, 1+1=2; lab without labelsOn shows 1/2 raw
        expect(tsv).toBe('1\t1.5\t1\t1\n2\t2.25\t2\t2');
    });

    test('Labels on swaps dictionary index for level', () => {
        const rows = [[1, 1.5, 2, 1] as any];
        const tsv = render_tsv(rows, [0, 1, 2, 3], cols, dictionaries, true, false, 3);
        expect(tsv).toBe('1\t1.5\thigh\tone');
    });

    test('Format on rounds floats but not integers or factor codes', () => {
        const rows = [[1, 1.234567, 0, 1] as any];
        const tsv = render_tsv(rows, [0, 1, 2, 3], cols, dictionaries, false, true, 2);
        // Integer 'i' unaffected; float 'v' rounded to 2; factor 'f' shows
        // 1-based code; value-labelled 'lab' (Float64) is rounded since
        // Labels=off → no label substitution kicks in.
        expect(tsv).toBe('1\t1.23\t1\t1.00');
    });

    test('NaN / Inf / Date / ts sentinels render as readable strings', () => {
        const rows = [
            [{ _: 'nan' }, { _: 'inf' }, { _: '-inf' }, { _: 'date', v: '2024-01-01' }] as any,
            [null, { _: 'ts', v: '2024-01-01T12:00:00Z' }, { _: 'trunc', v: 'long…' }, 'plain'] as any,
        ];
        const tsv = render_tsv(rows, [0, 1, 0, 0], cols, dictionaries, false, false, 3);
        expect(tsv).toBe(
            'NaN\tInf\t-Inf\t2024-01-01\n\t2024-01-01T12:00:00Z\tlong…\tplain',
        );
    });

    test('embedded tabs / newlines in cell values are spaced out', () => {
        const labelCol: ColumnSchema = {
            name: 'note', arrowType: 'Utf8', isInteger: false,
            dictionaryShipped: false,
        };
        const rows = [['hi\tthere\nyou'] as any];
        const tsv = render_tsv(rows, [0], [labelCol], {}, false, false, 3);
        expect(tsv).toBe('hi there you');
    });

    test('null cells become empty strings', () => {
        const rows = [[null, null] as any];
        const tsv = render_tsv(rows, [0, 1], cols, dictionaries, false, false, 3);
        expect(tsv).toBe('\t');
    });

    test('high-cardinality dictionary uses resolvedLabels when Labels on', () => {
        const bigDict: ColumnSchema = {
            name: 'zip', arrowType: 'Dictionary<Int32, Utf8>',
            isInteger: false, dictionaryShipped: false,
        };
        const rows = [[5] as any, [7] as any];
        const resolved = { 0: { 5: 'zip-005', 7: 'zip-007' } };
        const tsv = render_tsv(
            rows, [0], [bigDict], {}, true, false, 3, resolved,
        );
        expect(tsv).toBe('zip-005\nzip-007');
    });

    test('high-cardinality dictionary missing a label falls back to 1-based code', () => {
        const bigDict: ColumnSchema = {
            name: 'zip', arrowType: 'Dictionary<Int32, Utf8>',
            isInteger: false, dictionaryShipped: false,
        };
        const rows = [[5] as any];
        const tsv = render_tsv(
            rows, [0], [bigDict], {}, true, false, 3, {},
        );
        expect(tsv).toBe('6');  // 5 + 1
    });

    test('includeHeader prepends a tab-separated row of column names', () => {
        const rows = [
            [1, 1.5, 0, 1] as any,
            [2, 2.25, 1, 2] as any,
        ];
        const tsv = render_tsv(
            rows, [0, 1, 2, 3], cols, dictionaries, false, false, 3, {}, true,
        );
        expect(tsv).toBe('i\tv\tf\tlab\n1\t1.5\t1\t1\n2\t2.25\t2\t2');
    });

    test('includeHeader honors the colIndices order, not schema order', () => {
        const rows = [[2.25, 1] as any];
        // Copy columns in reverse: v then i.
        const tsv = render_tsv(
            rows, [1, 0], cols, dictionaries, false, false, 3, {}, true,
        );
        expect(tsv).toBe('v\ti\n2.25\t1');
    });

    test('includeHeader sanitizes tabs / newlines in column names', () => {
        const dirty: ColumnSchema = {
            name: 'has\ttab\nname', arrowType: 'Utf8', isInteger: false,
            dictionaryShipped: false,
        };
        const rows = [['x'] as any];
        const tsv = render_tsv(
            rows, [0], [dirty], {}, false, false, 3, {}, true,
        );
        expect(tsv).toBe('has tab name\nx');
    });

    test('includeHeader on empty rows still emits the header line', () => {
        const tsv = render_tsv(
            [], [0, 1], cols, dictionaries, false, false, 3, {}, true,
        );
        expect(tsv).toBe('i\tv');
    });
});
